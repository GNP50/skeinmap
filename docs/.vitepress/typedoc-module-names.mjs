// TypeDoc plugin: name each entry point after its import specifier ("skeinmap",
// "skeinmap/leaflet", …) instead of its file name ("index", "leaflet", …).
import { Converter, ReflectionKind } from 'typedoc'

/** @param {import('typedoc').Application} app */
export function load(app) {
  app.converter.on(Converter.EVENT_RESOLVE_BEGIN, (context) => {
    for (const mod of context.project.getReflectionsByKind(ReflectionKind.Module)) {
      mod.name = mod.name === 'index' ? 'skeinmap' : `skeinmap/${mod.name}`
    }
  })
}
