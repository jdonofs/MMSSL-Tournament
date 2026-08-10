import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

const env = readFileSync(new URL('../../../.env', import.meta.url), 'utf8')
const get = (k) => env.match(new RegExp(`${k}=(.*)`))[1].trim()
export const supabase = createClient(get('VITE_SUPABASE_URL'), get('VITE_SUPABASE_ANON_KEY'))

export async function all(table, build = (q) => q) {
  const page = 1000
  let from = 0
  const rows = []
  for (;;) {
    const { data, error } = await build(supabase.from(table).select('*')).range(from, from + page - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    rows.push(...data)
    if (data.length < page) return rows
    from += page
  }
}
