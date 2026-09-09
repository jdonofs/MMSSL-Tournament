// Build scorebook-level double-play and extra-base opportunities for all
// historical plate appearances. Motion/throw enrichment is added separately
// when a raw tracking archive exists.

import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fetchAllRows } from '../src/utils/fetchAllRows.js'
import {
  buildDoublePlayOpportunityFromPa,
  buildExtraBaseOpportunitiesFromPa,
  parseFieldingPositions,
} from '../src/utils/advancedDefense.js'
import { createAdvancedMetricsClient, recomputeAdvancedMetrics } from './recompute_advanced_metrics.mjs'

function finite(value, fallback = null) {
  if (value == null || value === '') return fallback
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function groupKey(type, pa) {
  return `${type}:${pa.game_id}:${pa.inning || 1}:${pa.batting_team_id || pa.player_id || 'unknown'}`
}

function activeFielder(rows, pa, position) {
  return rows.find((row) => (
    String(row.game_id) === String(pa.game_id)
    && String(row.team_id) === String(pa.defensive_team_id)
    && Number(row.position) === Number(position)
    && Number(row.inning_from || 1) <= Number(pa.inning || 1)
    && (row.inning_to == null || Number(row.inning_to) >= Number(pa.inning || 1))
  )) || null
}

function identityForFielder(row, charactersByName, seasonTeamPlayerById) {
  if (!row) return null
  return {
    playerId: seasonTeamPlayerById.get(String(row.team_id)) || row.team_id || null,
    characterId: charactersByName.get(String(row.character || '').toLowerCase()) || null,
    position: row.position || null,
  }
}

async function upsertMany(supabase, table, rows, onConflict) {
  let count = 0
  for (let index = 0; index < rows.length; index += 200) {
    const batch = rows.slice(index, index + 200)
    const { error } = await supabase.from(table).upsert(batch, { onConflict })
    if (error) throw error
    count += batch.length
  }
  return count
}

export async function backfillAdvancedOpportunities(supabase) {
  const [tournamentPa, seasonPa, tournamentFielders, seasonFielders, characters, seasonTeams] = await Promise.all([
    fetchAllRows(() => supabase.from('plate_appearances').select('*')),
    fetchAllRows(() => supabase.from('season_plate_appearances').select('*')),
    fetchAllRows(() => supabase.from('game_fielders').select('*')),
    fetchAllRows(() => supabase.from('season_game_fielders').select('*')),
    fetchAllRows(() => supabase.from('characters').select('id,name')),
    fetchAllRows(() => supabase.from('season_teams').select('id,player_id')),
  ])
  const results = [tournamentPa, seasonPa, tournamentFielders, seasonFielders, characters, seasonTeams]
  const failed = results.find((result) => result.error)
  if (failed) throw failed.error
  const charactersByName = new Map((characters.data || []).map((row) => [String(row.name).toLowerCase(), row.id]))
  const seasonTeamPlayerById = new Map((seasonTeams.data || []).map((row) => [String(row.id), row.player_id]))
  const sources = [
    { type: 'tournament', pas: tournamentPa.data || [], fielders: tournamentFielders.data || [], playerMap: new Map() },
    { type: 'season', pas: seasonPa.data || [], fielders: seasonFielders.data || [], playerMap: seasonTeamPlayerById },
  ]
  const doublePlays = []
  const runnerOpportunities = []

  for (const source of sources) {
    const outsByHalf = new Map()
    const sorted = [...source.pas].sort((a, b) => (
      finite(a.game_id, 0) - finite(b.game_id, 0)
      || finite(a.pa_number, 0) - finite(b.pa_number, 0)
    ))
    for (const pa of sorted) {
      const halfKey = groupKey(source.type, pa)
      const outsBefore = outsByHalf.get(halfKey) || 0
      const positions = parseFieldingPositions(pa)
      const first = identityForFielder(activeFielder(source.fielders, pa, positions[0]), charactersByName, source.playerMap)
      const pivot = identityForFielder(activeFielder(source.fielders, pa, positions[1]), charactersByName, source.playerMap)
      const dp = buildDoublePlayOpportunityFromPa(pa, {
        competitionType: source.type,
        outsBefore,
        firstFielder: first,
        pivotFielder: pivot,
      })
      if (dp) doublePlays.push(dp)
      runnerOpportunities.push(...buildExtraBaseOpportunitiesFromPa(pa, {
        competitionType: source.type,
        outsBefore,
        responsibleFielder: first,
      }))
      outsByHalf.set(halfKey, Math.min(3, outsBefore + Math.max(0, finite(pa.outs_on_play, 0))))
    }
  }

  const [doublePlayCount, runnerCount] = await Promise.all([
    upsertMany(supabase, 'double_play_opportunities', doublePlays, 'competition_type,game_id,pa_id'),
    upsertMany(supabase, 'runner_opportunities', runnerOpportunities, 'competition_type,game_id,pa_id,runner_id,target_base'),
  ])
  const modelSummary = await recomputeAdvancedMetrics(supabase)
  return { doublePlayOpportunities: doublePlayCount, runnerOpportunities: runnerCount, modelSummary }
}

async function main() {
  const supabase = await createAdvancedMetricsClient()
  console.log(JSON.stringify(await backfillAdvancedOpportunities(supabase), null, 2))
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
