//! Open-addressing hash table keyed by pairs of doubles with a 32-bit payload, the
//! counterpart of `KeyTable` in `src/kernels/ts.ts`. Keys compare like JavaScript `===`
//! on numbers: `-0` equals `0`, and NaN equals nothing (callers handle NaN keys before
//! reaching the table). Which slot a key lands in never affects kernel output.

const K1: u64 = 0x9e37_79b9_7f4a_7c15;
const K2: u64 = 0xc2b2_ae3d_27d4_eb4f;

#[inline]
fn hash(a: u64, b: u64) -> u64 {
    (a.wrapping_mul(K1) ^ b).wrapping_mul(K2)
}

/// Bits of `v` with `-0` folded into `0`, so equal numbers have equal bits.
#[inline]
pub fn key_bits(v: f64) -> u64 {
    (v + 0.0).to_bits()
}

/// `a` of an empty slot: a NaN bit pattern, which [`key_bits`] of a key that is not NaN
/// never produces.
const EMPTY: u64 = u64::MAX;

/// Key and payload side by side, so a probe touches one cache line instead of three.
#[derive(Clone, Copy)]
struct Slot {
    a: u64,
    b: u64,
    val: u32,
}

const EMPTY_SLOT: Slot = Slot {
    a: EMPTY,
    b: 0,
    val: 0,
};

/// Tables start at most this large (slots) and double as keys arrive: kernels often see
/// far fewer distinct keys than elements, and a table that fits in cache is much faster.
const MAX_INITIAL_SLOTS: usize = 1 << 14;

pub struct KeyTable {
    slots: Vec<Slot>,
    shift: u32,
    len: usize,
}

impl KeyTable {
    /// A table for up to about `expected` keys: it starts at most [`MAX_INITIAL_SLOTS`]
    /// slots and grows past that as needed.
    pub fn new(expected: usize) -> Self {
        let mut cap = 16usize;
        while cap < expected.saturating_mul(2) && cap < MAX_INITIAL_SLOTS {
            cap *= 2;
        }
        Self::with_capacity(cap)
    }

    fn with_capacity(cap: usize) -> Self {
        KeyTable {
            slots: vec![EMPTY_SLOT; cap],
            shift: 64 - cap.trailing_zeros(),
            len: 0,
        }
    }

    #[inline]
    fn home(&self, a: u64, b: u64) -> usize {
        (hash(a, b) >> self.shift) as usize
    }

    #[cold]
    fn grow(&mut self) {
        let mut next = KeyTable::with_capacity(self.slots.len() * 2);
        let mask = next.slots.len() - 1;
        for slot in &self.slots {
            if slot.a == EMPTY {
                continue;
            }
            let mut j = next.home(slot.a, slot.b);
            while next.slots[j].a != EMPTY {
                j = (j + 1) & mask;
            }
            next.slots[j] = *slot;
        }
        next.len = self.len;
        *self = next;
    }

    /// The payload of `(a, b)` (as [`key_bits`] of numbers that are not NaN), inserted with
    /// payload 0 if absent.
    #[inline]
    pub fn payload(&mut self, a: u64, b: u64) -> &mut u32 {
        debug_assert!(a != EMPTY, "NaN keys never reach the table");
        if (self.len + 1) * 2 > self.slots.len() {
            self.grow();
        }
        let mask = self.slots.len() - 1;
        let mut i = self.home(a, b);
        loop {
            let slot = self.slots[i];
            if slot.a == a && slot.b == b {
                return &mut self.slots[i].val;
            }
            if slot.a == EMPTY {
                break;
            }
            i = (i + 1) & mask;
        }
        self.slots[i] = Slot { a, b, val: 0 };
        self.len += 1;
        &mut self.slots[i].val
    }
}

/// One key occurrence for [`FirstSeen`]: `idx` is the element, `bits` its style bit (or,
/// for a key seen before the switch, every bit seen so far, with `idx` [`SEEN`]).
#[derive(Clone, Copy, Default)]
struct Entry {
    a: u64,
    b: u64,
    bits: u32,
    idx: u32,
}

const SEEN: u32 = u32::MAX;

/// Keys a [`FirstSeen`] answers from its table before deferring to partitions.
const DIRECT_KEYS: usize = 1 << 13;
/// Target entries per partition: their table then fits in the first cache levels.
const PARTITION_ENTRIES: usize = 2048;

/// Which elements are the first, in index order, to carry each `(a, b, bit)` key: the
/// rule `payload & bit == 0 ⇒ keep, payload |= bit` of the kernels, answered the same.
///
/// While few distinct keys have been seen it answers at once from a [`KeyTable`]. Past
/// [`DIRECT_KEYS`] a table lookup is a cache miss more often than not, so it defers:
/// every later occurrence goes, by hash, into one of the partitions of about
/// [`PARTITION_ENTRIES`] entries (in index order within each), and every partition is
/// then resolved with a small table that stays in cache. Which slot or partition a key
/// lands in never changes an answer.
pub struct FirstSeen {
    table: KeyTable,
    expected: usize,
    /// Top bits of the hash that pick a partition (0: a single one).
    part_bits: u32,
    parts: Vec<Vec<Entry>>,
}

impl FirstSeen {
    /// For about `expected` occurrences.
    pub fn new(expected: usize) -> Self {
        FirstSeen {
            table: KeyTable::new(expected.min(DIRECT_KEYS)),
            expected,
            part_bits: 0,
            parts: Vec::new(),
        }
    }

    #[inline]
    fn part(&self, a: u64, b: u64) -> usize {
        if self.part_bits == 0 {
            0
        } else {
            (hash(a, b) >> (64 - self.part_bits)) as usize
        }
    }

    /// Whether element `idx` (indices increasing from call to call) is the first with
    /// key `(a, b)` (as [`key_bits`], not NaN) and `bit`: `Some` when known now, `None`
    /// when [`FirstSeen::resolve`] decides.
    #[inline]
    pub fn check(&mut self, a: u64, b: u64, bit: u32, idx: u32) -> Option<bool> {
        if !self.parts.is_empty() {
            let p = self.part(a, b);
            self.parts[p].push(Entry { a, b, bits: bit, idx });
            return None;
        }
        let vals = self.table.payload(a, b);
        let first = *vals & bit == 0;
        *vals |= bit;
        if self.table.len > DIRECT_KEYS {
            self.switch(idx as usize);
        }
        Some(first)
    }

    /// From now on, defer: the keys seen so far go first, as already seen.
    #[cold]
    fn switch(&mut self, idx: usize) {
        let total = self.table.len + self.expected.saturating_sub(idx + 1);
        while (total >> self.part_bits) > PARTITION_ENTRIES && self.part_bits < 16 {
            self.part_bits += 1;
        }
        let count = 1usize << self.part_bits;
        let each = (total >> self.part_bits) + (total >> self.part_bits) / 4 + 16;
        self.parts = (0..count).map(|_| Vec::with_capacity(each)).collect();
        let table = std::mem::replace(&mut self.table, KeyTable::with_capacity(16));
        for slot in &table.slots {
            if slot.a != EMPTY {
                let p = self.part(slot.a, slot.b);
                self.parts[p].push(Entry {
                    a: slot.a,
                    b: slot.b,
                    bits: slot.val,
                    idx: SEEN,
                });
            }
        }
    }

    /// Calls `kept(idx)` for every deferred element that is the first with its key (in no
    /// particular order).
    pub fn resolve(self, mut kept: impl FnMut(u32)) {
        if self.parts.is_empty() {
            return;
        }
        phase!("table::FirstSeen::resolve");
        let part_bits = self.part_bits;
        let largest = self.parts.iter().map(Vec::len).max().unwrap_or(0);
        let mut cap = 16usize;
        while cap < largest * 2 {
            cap *= 2;
        }
        let (mask, cap_bits) = (cap - 1, cap.trailing_zeros());
        // Slot `i` belongs to partition `stamp[i] - 1`: no clearing between partitions.
        let mut stamp = vec![0u32; cap];
        let mut slots = vec![EMPTY_SLOT; cap];
        for (p, entries) in self.parts.iter().enumerate() {
            let generation = p as u32 + 1;
            for e in entries {
                // The partition took the top bits of the hash: the slot uses the next ones.
                let h = hash(e.a, e.b) << part_bits;
                let mut i = (h >> (64 - cap_bits)) as usize;
                loop {
                    let slot = &mut slots[i];
                    if stamp[i] != generation {
                        stamp[i] = generation;
                        *slot = Slot {
                            a: e.a,
                            b: e.b,
                            val: e.bits,
                        };
                        if e.idx != SEEN {
                            kept(e.idx);
                        }
                        break;
                    }
                    if slot.a == e.a && slot.b == e.b {
                        if slot.val & e.bits == 0 && e.idx != SEEN {
                            kept(e.idx);
                        }
                        slot.val |= e.bits;
                        break;
                    }
                    i = (i + 1) & mask;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_inserted_keys_and_grows() {
        let mut t = KeyTable::new(2);
        for i in 0..10_000u64 {
            *t.payload(key_bits(i as f64), key_bits((i * 7) as f64)) = i as u32 + 1;
        }
        for i in 0..10_000u64 {
            assert_eq!(
                *t.payload(key_bits(i as f64), key_bits((i * 7) as f64)),
                i as u32 + 1
            );
        }
        assert_eq!(t.len, 10_000);
        assert_eq!(*t.payload(key_bits(1.0), key_bits(1.0)), 0);
    }

    /// [`FirstSeen`] against the plain rule, with few and with many distinct keys (the
    /// second switches to partitions, carrying several bits per key across).
    #[test]
    fn first_seen_matches_the_payload_rule() {
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for distinct in [5u64, 3000, 40_000, 400_000] {
            let n = 300_000u32;
            let mut want = std::collections::HashMap::new();
            let mut seen = FirstSeen::new(n as usize);
            let mut got = vec![None; n as usize];
            let mut expected = Vec::with_capacity(n as usize);
            for i in 0..n {
                let k = next() % distinct;
                let (a, b) = (key_bits(k as f64), key_bits((k % 7) as f64 - 3.0));
                let bit = 1u32 << (next() % 3);
                let vals: &mut u32 = want.entry((a, b)).or_default();
                expected.push(*vals & bit == 0);
                *vals |= bit;
                got[i as usize] = seen.check(a, b, bit, i);
            }
            let mut pending: Vec<u32> = Vec::new();
            seen.resolve(|i| pending.push(i));
            for &i in &pending {
                assert_eq!(got[i as usize], None, "resolved an answered element");
                got[i as usize] = Some(true);
            }
            let got: Vec<bool> = got.into_iter().map(|g| g == Some(true)).collect();
            assert_eq!(got, expected, "{distinct} distinct keys");
            assert_eq!(pending.is_empty(), (distinct as usize) <= DIRECT_KEYS);
        }
    }

    #[test]
    fn negative_zero_is_zero() {
        let mut t = KeyTable::new(4);
        *t.payload(key_bits(-0.0), key_bits(0.0)) = 5;
        assert_eq!(*t.payload(key_bits(0.0), key_bits(-0.0)), 5);
    }
}
