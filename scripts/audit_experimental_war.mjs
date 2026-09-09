// Read-only audit of the same inputs and model used by Stats > Experimental WAR.
import fs from 'node:fs'
import { createAdvancedMetricsClient } from './recompute_advanced_metrics.mjs'
import { fetchAllRows } from '../src/utils/fetchAllRows.js'
import { buildExperimentalWar } from '../src/utils/experimentalWar.js'

const db = await createAdvancedMetricsClient()
try {
  const tables = ['games', 'season_schedule', 'season_teams', 'characters', 'players', 'plate_appearances', 'season_plate_appearances', 'pitching_stints', 'season_pitching_stints', 'game_fielders', 'season_game_fielders', 'runner_opportunities', 'double_play_opportunities', 'fielding_opportunities']
  const data = Object.fromEntries(await Promise.all(tables.map(async (table) => {
    const result = await fetchAllRows(() => db.from(table).select('*'))
    if (result.error) throw new Error(`${table}: ${result.error.message}`)
    return [table, result.data || []]
  })))
  const owners = new Map(data.season_teams.map((row) => [String(row.id), row.player_id]))
  const seasonRows = (table) => data[table].map((row) => ({ ...row, game_id: `season-${row.game_id}` }))
  const model = buildExperimentalWar({
    games: [...data.games, ...data.season_schedule.map((row) => ({ ...row, id: `season-${row.id}`, tournament_id: row.season_id }))],
    characters: data.characters,
    plateAppearances: [...data.plate_appearances, ...seasonRows('season_plate_appearances')],
    pitchingStints: [...data.pitching_stints, ...seasonRows('season_pitching_stints')],
    gameFielders: [...data.game_fielders, ...seasonRows('season_game_fielders').map((row) => ({ ...row, player_id: owners.get(String(row.team_id)) ?? row.player_id }))],
    runnerOpportunities: data.runner_opportunities,
    doublePlayOpportunities: data.double_play_opportunities,
    fieldingOpportunities: data.fielding_opportunities,
  })
  const named = (rows, source) => rows.map((row) => ({ ...row, name: source.find((entry) => String(entry.id) === row.id)?.name ?? row.id })).sort((a, b) => b.war - a.war)
  const report = { generatedAt: new Date().toISOString(), ...model, players: named(model.players, data.players), characters: named(model.characters, data.characters) }
  const total = (rows) => rows.reduce((sum, row) => sum + row.war, 0)
  const expected = model.cohorts.reduce((sum, row) => sum + (row.expectedWar ?? 0), 0)
  if (Math.abs(total(model.players) - expected) > 1e-8 || Math.abs(total(model.characters) - expected) > 1e-8) throw new Error('WAR totals did not reconcile')
  fs.writeFileSync('data/calibration/experimental-war.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ version: model.version, includedGames: model.includedGames, excludedGames: model.excludedGames, playerTotal: total(model.players), characterTotal: total(model.characters), expected, players: report.players.map(({ name, war, positionWar, pitchingWar, coverage }) => ({ name, war, positionWar, pitchingWar, coverage })), leadingCharacters: report.characters.slice(0, 5).map(({ name, war, coverage }) => ({ name, war, coverage })) }, null, 2))
} finally { await db.auth.signOut({ scope: 'local' }) }
