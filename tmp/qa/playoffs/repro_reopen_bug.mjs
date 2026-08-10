import { supabase, all } from './db.mjs'
import { reopenSeasonPlayoffs } from '../../../src/utils/seasonPlayoffs.js'
import { buildSeasonStandings } from '../../../src/utils/competitionStandings.js'

const seasonId = 55
const gameId = 2202 // Losers R1-1

const season = (await all('seasons', (q) => q.eq('id', seasonId)))[0]
const teams = await all('season_teams', (q) => q.eq('season_id', seasonId))
const schedule = await all('season_schedule', (q) => q.eq('season_id', seasonId))
const bettingLedger = await all('season_betting_ledger', (q) => q.eq('season_id', seasonId))

// Simulate what Scorebook.jsx does before calling onGameReopen: reset the target game.
const { error: resetErr } = await supabase
  .from('season_schedule')
  .update({ status: 'in_progress', winner_team_id: null })
  .eq('id', gameId)
if (resetErr) throw resetErr

const freshSchedule = await all('season_schedule', (q) => q.eq('season_id', seasonId))
const regularSeasonGames = freshSchedule.filter((g) => !g.stage)
const standings = buildSeasonStandings(teams, freshSchedule, bettingLedger)

try {
  const result = await reopenSeasonPlayoffs({
    supabase,
    season,
    standings,
    schedule: freshSchedule,
    seasonTeams: teams,
  })
  console.log('SUCCESS, changed games:', result.map((g) => ({ id: g.id, stage: g.stage, status: g.status })))
} catch (err) {
  console.error('THREW:', err)
}
