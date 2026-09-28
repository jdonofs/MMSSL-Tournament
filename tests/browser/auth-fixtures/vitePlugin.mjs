import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

export function authFixturePlugin() {
  return {
    name: 'auth-context-fixture',
    enforce: 'pre',
    resolveId(source) {
      if (source.startsWith('\0')) return null
      const normalized = source.replace(/\?.*$/, '')
      if (/(^|[\\/])supabaseClient(\.js)?$/.test(normalized)) {
        return path.join(here, 'supabaseClient.js')
      }
      if (/(^|[\\/])hooks[\\/]useRealtimeEnabled(\.js)?$/.test(normalized)) {
        return path.join(here, 'realtimeEnabled.js')
      }
      return null
    },
  }
}
