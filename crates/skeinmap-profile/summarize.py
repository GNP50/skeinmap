#!/usr/bin/env python3
"""Summarise a spanscope profile written by skeinmap-profile: per span, calls, mean
inclusive and self time (ms) and share of all self time; with a second profile, the
speed-up of each span's mean inclusive time.

    python3 summarize.py profile.json [baseline.json]
"""
import json
import sys


def roots(path):
    """Median duration (ms) of the roots of each traced function, by attributes."""
    p = json.load(open(path))
    names = {s["id"]: s["name"] for s in p["spans"]}
    by = {}
    for r in p["roots"]:
        attrs = ",".join(f"{k}={v}" for k, v in sorted((r.get("attributes") or {}).items()))
        key = names[r["span"]].split("::")[-1].removeprefix("root_") + (f" [{attrs}]" if attrs else "")
        by.setdefault(key, []).append(r["duration_ns"] / 1e6)
    return {k: sorted(v)[len(v) // 2] for k, v in by.items()}


def table(path):
    p = json.load(open(path))
    names = {s["id"]: s["name"] for s in p["spans"]}
    rows = {}
    for node in p["graph"]["nodes"]:
        rows[names[node["span"]]] = node
    return rows


cur = table(sys.argv[1])
base = table(sys.argv[2]) if len(sys.argv) > 2 else None
total_self = sum(n["self_ns"] for n in cur.values())
head = f"{'span':40} {'calls':>6} {'mean ms':>9} {'self ms':>9} {'self %':>7}"
if base:
    head += f" {'base ms':>9} {'speed-up':>8}"
print(head)
for name, n in sorted(cur.items(), key=lambda kv: -kv[1]["self_ns"]):
    mean = n["total_ns"] / n["calls"] / 1e6
    line = f"{name:40} {n['calls']:>6} {mean:>9.3f} {n['self_ns'] / n['calls'] / 1e6:>9.3f} {100 * n['self_ns'] / total_self:>6.1f}%"
    if base and name in base:
        b = base[name]
        bm = b["total_ns"] / b["calls"] / 1e6
        line += f" {bm:>9.3f} {bm / mean if mean else 0:>7.2f}x"
    print(line)

print()
cur_r = roots(sys.argv[1])
base_r = roots(sys.argv[2]) if base else None
print(f"{'root (median)':40} {'ms':>9}" + (f" {'base ms':>9} {'speed-up':>8}" if base else ""))
for k in sorted(cur_r):
    line = f"{k:40} {cur_r[k]:>9.3f}"
    if base_r and k in base_r:
        line += f" {base_r[k]:>9.3f} {base_r[k] / cur_r[k]:>7.2f}x"
    print(line)
