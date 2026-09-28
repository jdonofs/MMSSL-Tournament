import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * Renders the real RawValueTable with no database behind it.
 *
 * Same shape as tests/browser/auth-fixtures/vitePlugin.mjs: the Supabase client
 * is redirected to a stub that throws, so the fixture cannot reach a network
 * and does not need credentials of any kind.
 */
export function scoutingFixturePlugin() {
  return {
    name: 'scouting-report-fixture',
    enforce: 'pre',
    resolveId(source) {
      if (source.startsWith('\0')) return null
      const normalized = source.replace(/\?.*$/, '')
      if (/(^|[\/])supabaseClient(\.js)?$/.test(normalized)) {
        return path.join(here, 'supabaseClient.js')
      }
      return null
    },
  }
}
