import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, type DefaultTheme } from 'vitepress'

/**
 * Site base path. `/` for a site served at the root of a domain; set `DOCS_BASE` (with
 * leading and trailing slashes, e.g. `/skeinmap/`) when it is served from a sub-path.
 */
const base = normaliseBase(process.env.DOCS_BASE ?? '/')

function normaliseBase(value: string): string {
  let b = value.trim() || '/'
  if (!b.startsWith('/')) b = `/${b}`
  if (!b.endsWith('/')) b = `${b}/`
  return b
}

/** The API reference sidebar written by `npm run docs:api` (TypeDoc), when present. */
function apiSidebar(): DefaultTheme.SidebarItem[] {
  const file = fileURLToPath(new URL('../api/typedoc-sidebar.json', import.meta.url))
  if (!existsSync(file)) {
    return [{ text: 'Run "npm run docs:api" to build the API reference', link: '/guide/contributing' }]
  }
  const items = JSON.parse(readFileSync(file, 'utf8')) as DefaultTheme.SidebarItem[]
  // TypeDoc nests the sub-path entry points under the main one ("skeinmap" →
  // "skeinmap/leaflet"); list every entry point at the top level instead.
  const out: DefaultTheme.SidebarItem[] = []
  for (const mod of items) {
    const children = mod.items ?? []
    const own = children.filter((c) => !isModule(c))
    const nested = children.filter(isModule)
    out.push({ ...mod, items: own.length > 0 ? own : undefined, collapsed: false })
    for (const sub of nested) {
      out.push({ ...sub, text: `${mod.text}/${sub.text}`, collapsed: true })
    }
  }
  return out
}

/** A module entry links to a folder (`…/leaflet/`); members link to `.md` pages. */
function isModule(item: DefaultTheme.SidebarItem): boolean {
  return !!item.link && item.link.endsWith('/')
}

const guide: DefaultTheme.SidebarItem[] = [
  {
    text: 'Guide',
    items: [
      { text: 'Getting started', link: '/guide/getting-started' },
      { text: 'Bundlers and frameworks', link: '/guide/frameworks' },
      { text: 'GeoJSON, graphs and edge shapes', link: '/guide/interop' },
      { text: 'Performance', link: '/guide/performance' },
      { text: 'Content Security Policy', link: '/guide/csp' },
      { text: 'Contributing', link: '/guide/contributing' },
    ],
  },
  {
    text: 'Concepts',
    items: [
      { text: 'Scenes', link: '/concepts/scene' },
      { text: 'Styles and themes', link: '/concepts/styles' },
      { text: 'Picking, hover and tooltips', link: '/concepts/picking' },
      { text: 'Selection', link: '/concepts/selection' },
      { text: 'Filters', link: '/concepts/filters' },
      { text: 'Clustering', link: '/concepts/clustering' },
      { text: 'Labels', link: '/concepts/labels' },
      { text: 'Rendering', link: '/concepts/rendering' },
      { text: 'WebAssembly kernels', link: '/concepts/wasm' },
      { text: 'Adapters', link: '/concepts/adapters' },
    ],
  },
  { text: 'Demo', link: '/demo' },
]

export default defineConfig({
  title: 'skeinmap',
  description:
    'Draw and interact with very large node–link graphs on one canvas: WebGL2 or Canvas 2D, WebAssembly hot paths with a TypeScript fallback, adapters for Leaflet, MapLibre GL and React.',
  base,
  lang: 'en-US',
  cleanUrls: false,
  lastUpdated: false,
  // The demo is a separate app copied into public/demo/ by scripts/build-demo.mjs.
  ignoreDeadLinks: [/^\.?\/demo\//],
  head: [['meta', { name: 'theme-color', content: '#2563eb' }]],
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started', activeMatch: '^/guide/' },
      { text: 'Concepts', link: '/concepts/scene', activeMatch: '^/concepts/' },
      { text: 'API', link: '/api/', activeMatch: '^/api/' },
      { text: 'Demo', link: '/demo' },
    ],
    sidebar: {
      '/guide/': guide,
      '/concepts/': guide,
      '/demo': guide,
      '/api/': [{ text: 'API reference', link: '/api/', items: apiSidebar() }],
    },
    search: { provider: 'local' },
    outline: { level: [2, 3] },
    footer: { message: 'Released under the MIT License.' },
    // A repository link (socialLinks, editLink) goes here once the repository is public.
  },
})
