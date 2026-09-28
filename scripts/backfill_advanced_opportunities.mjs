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
import { fielderCoversPa } from '../src/utils/fielderStints.js'
import { calculateOutsForPa } from '../src/utils/defensiveEfficiency.js'
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
    && fielderCoversPa(row, pa)
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
      // Inferred from the result where the row predates outs_on_play, exactly
      // as buildRunExpectancy does. Reading a null as zero left every
      // hand-scored plate appearance at nought out, which made a two-out
      // inning look like a fresh one: double-play opportunities were created
      // where a force play was already impossible, and every one of them was
      // priced from the wrong base/out state.
      outsByHalf.set(halfKey, Math.min(3, outsBefore
        + Math.max(0, calculateOutsForPa(pa.result, pa.outs_on_play))))
    }
  }

  const [doublePlayCount, runnerCount] = await Promise.all([
    upsertMany(supabase, 'double_play_opportunities', doublePlays, 'competition_type,game_id,pa_id'),
    upsertMany(supabase, 'runner_opportunities', runnerOpportunities, 'competition_type,game_id,pa_id,runner_id,target_base'),
  ])
  // An upsert alone cannot un-build an opportunity. When the eligibility rule
  // or the base/out accounting changes, rows this run no longer builds are
  // left behind priced from the state that no longer applies -- 20 of the 44
  // double plays in the table were built when a null outs_on_play read as
  // nought out, so they claimed a force at first in innings that already had
  // two away.
  //
  // ONLY where the plate appearance is still here to judge. Games whose plate
  // appearances have been deleted (2766-2768, 2811-2814) keep every fact they
  // have: "not constructible" there means the evidence is gone, not that the
  // opportunity never existed.
  const knownPas = new Set(sources.flatMap((source) => source.pas.map((pa) => `${source.type}:${pa.id}`)))
  // Each table is pruned on its OWN natural key, and asked only for the
  // columns it has: a double play is one row per plate appearance, a runner
  // opportunity one row per runner and destination.
  const prunable = [
    {
      table: 'double_play_opportunities',
      columns: 'id,competition_type,pa_id',
      key: (row) => `${row.competition_type}:${row.pa_id}`,
      built: doublePlays,
    },
    {
      table: 'runner_opportunities',
      columns: 'id,competition_type,pa_id,runner_id,target_base',
      key: (row) => `${row.competition_type}:${row.pa_id}:${row.runner_id}:${row.target_base}`,
      built: runnerOpportunities,
    },
  ]
  const removed = await Promise.all(prunable.map(async ({ table, columns, key, built }) => {
    const wanted = new Set(built.map(key))
    const { data, error } = await fetchAllRows(() => supabase.from(table).select(columns))
    if (error) throw error
    const stale = (data || [])
      .filter((row) => knownPas.has(`${row.competition_type}:${row.pa_id}`) && !wanted.has(key(row)))
      .map((row) => row.id)
    for (let index = 0; index < stale.length; index += 200) {
      const { error: deleteError } = await supabase.from(table).delete().in('id', stale.slice(index, index + 200))
      if (deleteError) throw deleteError
    }
    return stale.length
  }))
  const modelSummary = await recomputeAdvancedMetrics(supabase)
  return {
    doublePlayOpportunities: doublePlayCount,
    runnerOpportunities: runnerCount,
    staleDoublePlaysRemoved: removed[0],
    staleRunnerOpportunitiesRemoved: removed[1],
    modelSummary,
  }
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
