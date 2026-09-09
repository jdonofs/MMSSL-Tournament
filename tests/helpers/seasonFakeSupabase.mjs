import { createFakeSupabase } from './fakeSupabase.mjs'

const ARTIFACT_TABLES = [
  'season_bets',
  'season_lineups',
  'season_plate_appearances',
  'season_pitching_stints',
  'season_pitches',
  'season_game_fielders',
  'season_runs_scored',
  'season_inning_scores',
  'season_game_odds',
  'season_game_settlements',
  'season_stadium_game_log',
]

export function createSeasonFakeSupabase(initialTables = {}, { failures = [] } = {}) {
  const base = createFakeSupabase({
    ...Object.fromEntries(ARTIFACT_TABLES.map((table) => [table, []])),
    season_betting_ledger: [],
    ...initialTables,
  })
  const calls = []
  const counts = new Map()

  return {
    ...base,
    calls,
    from(table) {
      const query = base.from(table)
      const execute = query.execute.bind(query)
      query.execute = async () => {
        const key = `${query.action}:${table}`
        const occurrence = (counts.get(key) || 0) + 1
        counts.set(key, occurrence)
        calls.push({ action: query.action, table, occurrence, payload: query.payload })
        const failure = failures.find((entry) => (
          !entry.used
          && entry.action === query.action
          && entry.table === table
          && Number(entry.occurrence || 1) === occurrence
        ))
        if (failure) {
          failure.used = true
          return { data: null, error: new Error(failure.message || `Injected ${key} failure`) }
        }
        return execute()
      }
      return query
    },
  }
}

export function buildFourTeamSeasonFixture({
  playoffFormat = 'single_elimination',
  seasonStatus = 'active',
} = {}) {
  const season = {
    id: 1,
    name: 'Reliability Season',
    status: seasonStatus,
    playoff_format: playoffFormat,
    innings: 6,
    mercy_rule: false,
    mercy_rule_differential: 10,
  }
  const teams = [1, 2, 3, 4].map((id) => ({
    id,
    season_id: season.id,
    player_id: `player-${id}`,
    team_name: `Team ${id}`,
    wins: 0,
    losses: 0,
  }))
  const matchups = [
    [1, 2, 1],
    [3, 4, 3],
    [1, 3, 1],
    [2, 4, 2],
    [1, 4, 1],
    [2, 3, 2],
  ]
  const schedule = matchups.map(([home, away, winner], index) => ({
    id: index + 1,
    season_id: season.id,
    round_number: Math.floor(index / 2) + 1,
    stage: null,
    home_team_id: home,
    away_team_id: away,
    stadium_picker_team_id: home,
    stadium: 'Mario Stadium',
    is_night: false,
    status: index === matchups.length - 1 ? 'scheduled' : 'completed',
    home_score: index === matchups.length - 1 ? 0 : (winner === home ? 4 : 1),
    away_score: index === matchups.length - 1 ? 0 : (winner === away ? 4 : 1),
    winner_team_id: index === matchups.length - 1 ? null : winner,
    innings: 6,
    mercy_rule: false,
    mercy_rule_differential: 10,
  }))

  return {
    season,
    teams,
    schedule,
    tables: {
      seasons: [season],
      season_teams: teams,
      season_schedule: schedule,
      season_betting_ledger: [],
    },
  }
}

export function rowForStage(client, stage) {
  return client.db.season_schedule.find((game) => game.stage === stage) || null
}

export function playoffRows(client) {
  return client.db.season_schedule.filter((game) => Boolean(game.stage))
}

export function setGameReopened(client, gameId) {
  const game = client.db.season_schedule.find((entry) => String(entry.id) === String(gameId))
  if (!game) throw new Error(`Missing game ${gameId}`)
  Object.assign(game, {
    status: 'in_progress',
    winner_team_id: null,
    final_inning: null,
    is_extra_innings: false,
    live_state: {},
  })
  return { ...game }
}
