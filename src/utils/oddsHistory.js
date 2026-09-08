// Odds history: what a market was worth at each recorded observation.
//
// `game_odds` / `season_game_odds` are mutated in place, so nothing about a
// market's past survives there. Migration 20260906180000 adds append-only
// `game_odds_history` / `season_game_odds_history`; this module holds the pure
// logic on both sides of it — building the snapshot rows the recorder writes,
// and turning what comes back into a series the UI can render.
//
// Three rules the rest of the feature depends on:
//
//   * A series is a single market, identified by (game_id, bet_type,
//     target_entity). Two characters' hit props, or two different bet types,
//     are never merged, and the two sides of one market are kept as separate
//     labelled series rather than concatenated into one line.
//   * A line move is an event, not a continuation. When the line changes, the
//     odds either side of the change price different propositions and are
//     reported as such.
//   * The earliest row is the FIRST RECORDED OBSERVATION, never "opening
//     odds". Markets priced before the table existed have no history, and this
//     module never invents one.

export const ODDS_HISTORY_TABLES = {
  tournament: 'game_odds_history',
  season: 'season_game_odds_history',
}

// The priced fields a change is measured on. Deliberately the same list
// `scripts/tracker_betting_sync.mjs` compares before it decides to persist, so
// "the market moved" means one thing across the whole feature.
export const ODDS_SNAPSHOT_FIELDS = [
  'line',
  'odds_home', 'odds_away',
  'odds_over', 'odds_under',
  'odds_yes', 'odds_no',
  'predicted_probability',
  'is_locked',
]

export function getOddsHistoryTable(sourceType) {
  return sourceType === 'season' ? ODDS_HISTORY_TABLES.season : ODDS_HISTORY_TABLES.tournament
}

export function buildMarketKey(row = {}) {
  return `${row.bet_type}::${row.target_entity || 'game'}`
}

function normalizeValue(value) {
  if (value == null || value === '') return null
  if (typeof value === 'boolean') return value
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : value
}

export function buildOddsValuesFingerprint(row = {}) {
  return ODDS_SNAPSHOT_FIELDS
    .map((field) => {
      const value = normalizeValue(row[field])
      return `${field}=${value == null ? '' : value}`
    })
    .join('|')
}

export function oddsSnapshotValuesMatch(left = {}, right = {}) {
  return buildOddsValuesFingerprint(left) === buildOddsValuesFingerprint(right)
}

// The game as of this observation. Never a ticket's placement context — the
// two are different facts and the receipt keeps them apart.
export function buildObservationGameContext(game = {}, { isSeason = false } = {}) {
  const awayScore = isSeason ? game.away_score : game.team_a_runs
  const homeScore = isSeason ? game.home_score : game.team_b_runs
  const liveState = game.live_state || null
  const inning = liveState?.inning ?? game.current_inning ?? null
  const isTop = liveState?.isTop ?? liveState?.is_top ?? game.is_top_inning ?? null
  return {
    inning: inning == null ? null : Number(inning),
    is_top_inning: isTop == null ? null : Boolean(isTop),
    away_score: awayScore == null ? null : Number(awayScore),
    home_score: homeScore == null ? null : Number(homeScore),
    game_status: game.status ?? null,
  }
}

// One insert payload per market whose priced values differ from the newest
// observation already on record. `latestByKey` is the newest stored row per
// market key; when a market has none, this is its first recorded observation
// and `previous_observation_id` stays null.
export function buildOddsHistoryRows({
  rows = [],
  latestByKey = {},
  gameId,
  gameContext = {},
  source = 'tracker_sync',
  observedAt = null,
} = {}) {
  const timestamp = observedAt || new Date().toISOString()
  const payload = []

  rows.forEach((row) => {
    if (!row?.bet_type) return
    const key = buildMarketKey(row)
    const previous = latestByKey[key] || null
    if (previous && oddsSnapshotValuesMatch(previous, row)) return

    payload.push({
      game_id: gameId ?? row.game_id ?? null,
      game_odds_id: row.id ?? null,
      bet_type: row.bet_type,
      target_entity: row.target_entity ?? null,
      previous_observation_id: previous?.id ?? null,
      line: row.line ?? null,
      odds_home: row.odds_home ?? null,
      odds_away: row.odds_away ?? null,
      odds_over: row.odds_over ?? null,
      odds_under: row.odds_under ?? null,
      odds_yes: row.odds_yes ?? null,
      odds_no: row.odds_no ?? null,
      predicted_probability: row.predicted_probability ?? null,
      is_locked: Boolean(row.is_locked),
      ...gameContext,
      source,
      change_key: buildOddsValuesFingerprint(row),
      observed_at: timestamp,
    })
  })

  return payload
}

export function buildLatestObservationsByKey(rows = []) {
  const latest = {}
  rows.forEach((row) => {
    const key = buildMarketKey(row)
    const current = latest[key]
    if (!current) {
      latest[key] = row
      return
    }
    const currentTime = new Date(current.observed_at || 0).getTime()
    const rowTime = new Date(row.observed_at || 0).getTime()
    if (rowTime > currentTime || (rowTime === currentTime && Number(row.id || 0) > Number(current.id || 0))) {
      latest[key] = row
    }
  })
  return latest
}

// PostgREST reports a missing table as 42P01 / PGRST205 depending on version.
// Either way the feature must degrade to "history unavailable", not break.
export function isMissingOddsHistoryTableError(error) {
  if (!error) return false
  const code = String(error.code || '')
  if (code === '42P01' || code === 'PGRST205' || code === 'PGRST205'.toLowerCase()) return true
  const message = String(error.message || '').toLowerCase()
  return (
    message.includes('does not exist')
    || message.includes('could not find the table')
    || message.includes('schema cache')
  )
}

export function isDuplicateObservationError(error) {
  if (!error) return false
  if (String(error.code || '') === '23505') return true
  const message = String(error.message || '').toLowerCase()
  return message.includes('duplicate key value')
}

const SIDE_FIELDS = {
  moneyline: [['odds_home', 'Home'], ['odds_away', 'Away']],
  run_line: [['odds_home', 'Home'], ['odds_away', 'Away']],
  over_under: [['odds_over', 'Over'], ['odds_under', 'Under']],
  hit_prop: [['odds_over', 'Over'], ['odds_under', 'Under']],
  hr_prop: [['odds_over', 'Over'], ['odds_under', 'Under']],
  k_prop: [['odds_over', 'Over'], ['odds_under', 'Under']],
  first_inning_run: [['odds_yes', 'Yes'], ['odds_no', 'No']],
}

export function getMarketSideFields(betType, labels = {}) {
  const fields = SIDE_FIELDS[betType] || [['odds_home', 'Home'], ['odds_away', 'Away']]
  return fields.map(([field, fallbackLabel]) => ({
    field,
    side: field.replace('odds_', ''),
    label: fallbackLabel === 'Home' ? (labels.home || 'Home')
      : fallbackLabel === 'Away' ? (labels.away || 'Away')
        : fallbackLabel,
  }))
}

function numeric(value) {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

// Orders one market's observations and turns consecutive pairs into explicit
// changes. Opposing sides stay separate; a line move is flagged so the UI can
// refuse to compare odds across it.
export function summarizeMarketHistory(observations = [], { betType, labels = {}, acceptedTerms = null } = {}) {
  const ordered = [...observations].sort((a, b) => {
    const delta = new Date(a.observed_at || 0) - new Date(b.observed_at || 0)
    return delta !== 0 ? delta : Number(a.id || 0) - Number(b.id || 0)
  })

  if (!ordered.length) {
    return {
      observationCount: 0,
      first: null,
      latest: null,
      changes: [],
      lineChangeCount: 0,
      sides: getMarketSideFields(betType, labels),
      acceptedTerms,
    }
  }

  const sides = getMarketSideFields(betType || ordered[0].bet_type, labels)
  const changes = []
  let lineChangeCount = 0

  ordered.forEach((observation, index) => {
    const previous = index === 0 ? null : ordered[index - 1]
    const line = numeric(observation.line)
    const previousLine = previous ? numeric(previous.line) : null
    const lineChanged = Boolean(previous) && previousLine !== line
    if (lineChanged) lineChangeCount += 1

    changes.push({
      id: observation.id,
      isFirstRecorded: index === 0,
      observedAt: observation.observed_at || null,
      line,
      previousLine,
      lineChanged,
      isLocked: Boolean(observation.is_locked),
      lockChanged: Boolean(previous) && Boolean(previous.is_locked) !== Boolean(observation.is_locked),
      context: {
        inning: observation.inning ?? null,
        isTopInning: observation.is_top_inning ?? null,
        awayScore: observation.away_score ?? null,
        homeScore: observation.home_score ?? null,
        status: observation.game_status ?? null,
      },
      sides: sides.map((side) => {
        const odds = numeric(observation[side.field])
        const previousOdds = previous ? numeric(previous[side.field]) : null
        return {
          ...side,
          odds,
          previousOdds,
          // Odds on either side of a line move price different propositions,
          // so no delta is reported across one.
          delta: previous && !lineChanged && odds != null && previousOdds != null ? odds - previousOdds : null,
          changed: Boolean(previous) && odds !== previousOdds,
        }
      }),
    })
  })

  return {
    observationCount: ordered.length,
    first: changes[0],
    latest: changes[changes.length - 1],
    changes,
    lineChangeCount,
    sides,
    acceptedTerms,
  }
}

// Groups a game's observations into one series per market.
export function groupObservationsByMarket(rows = []) {
  const byKey = new Map()
  rows.forEach((row) => {
    const key = buildMarketKey(row)
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(row)
  })
  return byKey
}
