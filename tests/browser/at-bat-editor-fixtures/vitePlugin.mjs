import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const redirects = [
  [/(^|[\\/])supabaseClient(\.js)?$/, path.join(here, 'supabaseClient.js')],
  [/(^|[\\/])context[\\/](Auth|Toast)Context(\.jsx)?$/, path.join(here, 'contexts.jsx')],
]

export function atBatEditorFixturePlugin() {
  return {
    name: 'at-bat-editor-fixture',
    enforce: 'pre',
    resolveId(source) {
      if (source.startsWith('\0')) return null
      const normalized = source.replace(/\?.*$/, '')
      for (const [pattern, target] of redirects) {
        if (pattern.test(normalized)) return target
      }
      return null
    },
  }
}
