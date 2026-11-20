/**
 * Small helpers that most integrations end up writing: HTML escaping for tooltips,
 * reading CSS custom properties for canvas colours, and noticing a theme switch.
 *
 * @module
 */

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** Escape text for interpolation into HTML (`tooltipHtml` tooltips). */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c])
}

/**
 * HTML for a small hover card: a title, an optional subtitle and label/value rows, every
 * value escaped. Styled by `skeinmap/style.css` (`.skeinmap-card-*`).
 */
export function tooltipCard(title: string, rows: [string, string][] = [], subtitle?: string): string {
  return (
    `<div class="skeinmap-card-title">${escapeHtml(title)}</div>` +
    (subtitle ? `<div class="skeinmap-card-sub">${escapeHtml(subtitle)}</div>` : '') +
    rows
      .map(
        ([k, v]) => `<div class="skeinmap-card-row"><span>${escapeHtml(k)}</span><span>${escapeHtml(v)}</span></div>`,
      )
      .join('')
  )
}

/**
 * The computed value of a CSS custom property (`cssVar('--accent')`), trimmed. Canvases
 * cannot resolve `var(--x)` themselves, so style tables are built from resolved values.
 * Bare HSL channel triplets (`210 40% 50%`, a common design-token format) are wrapped
 * into `hsl(...)`. Returns `fallback` outside the browser or when unset.
 */
export function cssVar(name: string, fallback = '', element?: Element): string {
  if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') return fallback
  const raw = getComputedStyle(element ?? document.documentElement)
    .getPropertyValue(name)
    .trim()
  if (!raw) return fallback
  return /^-?[\d.]+(deg)?\s+[\d.]+%\s+[\d.]+%(\s*\/\s*[\d.]+%?)?$/.test(raw) ? `hsl(${raw})` : raw
}

export interface ObserveThemeOptions {
  /** Element to watch. Default `document.documentElement`. */
  target?: Element
  /** Attributes whose change means "the theme changed". Default `class`, `data-theme`, `style`. */
  attributes?: string[]
  /** Also react to the OS colour scheme (`prefers-color-scheme`). Default true. */
  colorScheme?: boolean
}

/**
 * Call `callback` when the theme changes — an attribute on the root element, or the OS
 * colour scheme. Typically `observeTheme(() => layer.restyle())`. Returns the unsubscribe.
 */
export function observeTheme(callback: () => void, options: ObserveThemeOptions = {}): () => void {
  const stops: (() => void)[] = []
  if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
    const observer = new MutationObserver(() => callback())
    observer.observe(options.target ?? document.documentElement, {
      attributes: true,
      attributeFilter: options.attributes ?? ['class', 'data-theme', 'style'],
    })
    stops.push(() => observer.disconnect())
  }
  if (options.colorScheme !== false && typeof matchMedia !== 'undefined') {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => callback()
    mq.addEventListener?.('change', onChange)
    stops.push(() => mq.removeEventListener?.('change', onChange))
  }
  return () => {
    for (const s of stops) s()
  }
}

/**
 * Memoise a derived value (a style table) on a key that is cheap to read — by default
 * the root element's `class` and `data-theme` — so a repaint does not re-resolve a dozen
 * CSS variables while the theme is unchanged.
 */
export function memoByTheme<T>(resolve: () => T, key: () => string = defaultThemeKey): () => T {
  let cache: { key: string; value: T } | null = null
  return () => {
    const k = key()
    if (cache && cache.key === k) return cache.value
    const value = resolve()
    if (typeof document !== 'undefined') cache = { key: k, value }
    return value
  }
}

function defaultThemeKey(): string {
  if (typeof document === 'undefined') return ''
  const root = document.documentElement
  return `${root.className}|${root.getAttribute('data-theme') ?? ''}`
}
