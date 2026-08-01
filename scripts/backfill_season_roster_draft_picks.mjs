// One-off backfill: populates round/pick_number/pick_in_round on existing
// season_roster rows that predate migration 054. Only touches rows where
// acquired_via = 'draft' and round is still null, so it's safe to re-run —
// already-backfilled or non-draft (waiver/trade) rows are left alone.
//
// Mirrors the reconstruction logic in src/utils/draftOrder.js
// (normalizeSeasonDraftPicks): within a season, draft rows are ordered by
// created_at to recover pick order, then round/pick_in_round are derived via
// snake draft math using that season's team count.
//
// Usage: node scripts/backfill_season_roster_draft_picks.mjs [--dry-run]

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')
const dryRun = process.argv.includes('--dry-run')

function loadEnvFile(filePath) {
  const env = {}
  const content = fs.readFileSync(filePath, 'utf8')
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) continue
    env[trimmed.slice(0, eqIndex)] = trimmed.slice(eqIndex + 1)
  }
  return env
}

const env = loadEnvFile(path.join(repoRoot, '.env'))
const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)

const { data: seasons, error: seasonsError } = await supabase.from('seasons').select('id, name')
if (seasonsError) throw seasonsError

let totalUpdated = 0

for (const season of seasons) {
  const { data: seasonTeams, error: teamsError } = await supabase
    .from('season_teams')
    .select('id, player_id')
    .eq('season_id', season.id)
  if (teamsError) throw teamsError
  const teamCount = Math.max((seasonTeams || []).length, 1)

  const { data: rosterRows, error: rosterError } = await supabase
    .from('season_roster')
    .select('id, round, pick_number, acquired_via, created_at')
    .eq('season_id', season.id)
    .eq('acquired_via', 'draft')
    .is('round', null)
    .order('created_at', { ascending: true })
  if (rosterError) throw rosterError
  if (!rosterRows || rosterRows.length === 0) continue

  console.log(`Season "${season.name}" (${season.id}): backfilling ${rosterRows.length} rows, teamCount=${teamCount}`)

  for (const [index, row] of rosterRows.entries()) {
    const pickNumber = index + 1
    const round = Math.ceil(pickNumber / teamCount)
    const pickInRound = (index % teamCount) + 1

    if (dryRun) {
      console.log(`  [dry-run] id=${row.id} -> pick_number=${pickNumber} round=${round} pick_in_round=${pickInRound}`)
      continue
    }

    const { error: updateError } = await supabase
      .from('season_roster')
      .update({ pick_number: pickNumber, round, pick_in_round: pickInRound })
      .eq('id', row.id)
    if (updateError) throw updateError
    totalUpdated++
  }
}

console.log(dryRun ? 'Dry run complete.' : `Backfill complete. Updated ${totalUpdated} rows.`)
