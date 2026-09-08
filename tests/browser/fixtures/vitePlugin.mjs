import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

const REDIRECTS = [
  [/(^|[\\/])supabaseClient(\.js)?$/, path.join(here, 'supabaseClient.js')],
  [/(^|[\\/])context[\\/](Auth|Season|Tournament|Toast)Context(\.jsx)?$/, path.join(here, 'contexts.jsx')],
]

// Redirects the modules that would otherwise reach the network. Matching on the
// import specifier keeps it working for the relative paths the app actually
// uses ('../supabaseClient', '../context/AuthContext').
export function bettingFixturePlugin() {
  return {
    name: 'betting-ui-fixture',
    enforce: 'pre',
    resolveId(source) {
      if (source.startsWith('\0')) return null
      const normalized = source.replace(/\?.*$/, '')
      for (const [pattern, target] of REDIRECTS) {
        if (pattern.test(normalized)) return target
      }
      return null
    },
  }
}
