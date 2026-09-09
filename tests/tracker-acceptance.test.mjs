// End-to-end acceptance for an automatically tracked game.
//
//   npm run test:acceptance
//
// WHAT RUNS. Two recorded games are replayed through the real pipeline, start
// to finish, with no emulator, no tracker executable and no Supabase:
//
//   saved tracker log     -> scripts/live_tracker_bridge.mjs   (parse, score)
//                         -> scripts/tracker_scoring_persistence.mjs (journal, write)
//                         -> scripts/tracker_betting_sync.mjs  (live odds, settle)
//   saved 60 Hz capture   -> scripts/ingest_player_tracking.mjs (postgame facts)
//   the resulting rows    -> src/utils/statReconciliation.js   (official selection)
//                         -> src/utils/statsCalculator.js      (aggregation)
//
// Only three things are injected: the database (an in-memory fake), `spawn`
// (so the saved log arrives on the stdout the tracker .exe would have written
// it to), and the run directory. Everything between is production code.
//
// WHAT THE EXPECTATIONS ARE. tests/fixtures/tracker-acceptance-expected.json
// holds literal values taken from the workbook the tracker executable itself
// wrote at the final out, from counting the tracker's own log lines, and from
// arithmetic on the fixture's own wagers. The workbook is deliberately kept
// out of the bridge's input (TRACKER_OUTPUT_DIR is an empty directory), so it
// remains an independent observation rather than a copy of the output.
//
// WHOSE GAMES THESE ARE. Nobody's. Both recordings are standalone calibration
// exhibitions with a null game id in their capture headers; every player, team
// and game identity here is invented for this suite and named `acceptance-*`.
//
// WHAT THIS CANNOT ESTABLISH. See the limits at the bottom of this file.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test, { after, before } from 'node:test'
import { createServer } from 'vite'

import {
  dedupeStatRows,
  getStatGameKey,
  reconcileStatSource,
  selectPitchesForPlateAppearances,
} from '../src/utils/statReconciliation.js'
import { normalizeSeasonRowsByGameId, normalizeSeasonScheduleRows } from '../src/utils/seasonGameIds.js'
import {
  CHARACTER_ID_BY_NAME,
  GAME_ID,
  PLAYERS,
  RECORDINGS,
  SEASON_TEAMS,
  SOURCE_ID,
  buildAcceptanceWorld,
  readRecordingPairing,
  repoPath,
} from './helpers/trackerAcceptanceWorld.mjs'
import {
  SCORING_TABLES,
  ingestRecording,
  problemMessages,
  replayRecording,
} from './helpers/trackerAcceptanceRun.mjs'
import {
  cleanupRunDirectories,
  isCollectorSpawn,
  makeRunDirectory,
  shutdownBridge,
  startBridge,
} from './helpers/trackerBridgeReplay.mjs'
import {
  markUnresolvedPlayResolved,
  operatorCorrectionFields,
} from '../src/utils/trackerUnresolvedPlays.js'

const expected = JSON.parse(fs.readFileSync(repoPath('tests', 'fixtures', 'tracker-acceptance-expected.json'), 'utf8'))

// The half-inning boundary the restart variant cuts at: the line after
// "Changing sides!" at the end of the top of the sixth.
const TOURNAMENT_RESTART_LINE = 22772
// A complete plate appearance (Blue Pianta's two-run home run in the bottom of
// the first), used as the block that gets delivered twice.
const TOURNAMENT_DUPLICATE_BLOCK = [1499, 1984]

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
const {
  buildCharacterHistory,
  filterRunEventsForCharacter,
  summarizeBatting,
  summarizePitching,
} = await vite.ssrLoadModule('/src/utils/statsCalculator.js')
after(() => vite.close())
after(() => cleanupRunDirectories())

// ── the pipeline runs once; every test below reads its output ───────────────

const world = buildAcceptanceWorld()
const runs = {}

before(async () => {
  runs.tournament = await replayRecording(world, 'tournament')
  runs.tournamentIngest = await ingestRecording(world, 'tournament')
  runs.season = await replayRecording(world, 'season')
  runs.seasonIngest = await ingestRecording(world, 'season')
  writePipelineRowsForBrowser(world)
}, { timeout: 300_000 })

const OUTPUT_DIR = repoPath('tmp', 'tracker-acceptance')

// The browser check must render THESE rows, not a hand-written copy of them.
function writePipelineRowsForBrowser(db) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'pipeline-rows.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), tables: db.db }, null, 1),
  )
}

function official(competitionType) {
  const db = world.db
  if (competitionType === 'season') {
    return reconcileStatSource({
      games: normalizeSeasonScheduleRows(db.season_schedule),
      plateAppearances: normalizeSeasonRowsByGameId(db.season_plate_appearances),
      pitchingStints: normalizeSeasonRowsByGameId(db.season_pitching_stints),
      pitches: normalizeSeasonRowsByGameId(db.season_pitches),
      runs: normalizeSeasonRowsByGameId(db.season_runs_scored),
      gameFielders: normalizeSeasonRowsByGameId(db.season_game_fielders),
    })
  }
  return reconcileStatSource({
    games: db.games,
    plateAppearances: db.plate_appearances,
    pitchingStints: db.pitching_stints,
    pitches: db.pitches,
    runs: db.runs_scored,
    gameFielders: db.game_fielders,
  })
}

function battingLine(scope, name) {
  const characterId = CHARACTER_ID_BY_NAME[name]
  const pas = scope.plateAppearances.filter((row) => row.character_id === characterId)
  const summary = summarizeBatting(pas, filterRunEventsForCharacter(scope.runs, characterId, scope.plateAppearances))
  return {
    games: summary.games,
    pa: summary.plateAppearances,
    ab: summary.atBats,
    hits: summary.hits,
    walks: summary.walks,
    hbp: summary.hbp,
    strikeouts: summary.strikeouts,
    totalBases: summary.totalBases,
    runs: summary.runs,
    rbi: summary.rbi,
    homeRuns: summary.homeRuns,
  }
}

function pitchingLine(scope, name) {
  const characterId = CHARACTER_ID_BY_NAME[name]
  const summary = summarizePitching(scope.pitchingStints.filter((row) => row.character_id === characterId))
  return {
    innings: summary.innings,
    strikeouts: summary.strikeouts,
    runsAllowed: summary.runsAllowed,
    earnedRuns: summary.earnedRuns,
    walks: summary.walks,
    homeRunsAllowed: summary.homeRunsAllowed,
  }
}

function withoutAudit(row) {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith('_')))
}

function settledLedger(competitionType) {
  const tables = SCORING_TABLES[competitionType]
  return Object.fromEntries(world.db[tables.ledger]
    .filter((row) => String(row.reason).startsWith('bet_settled:'))
    .map((row) => [String(row.bet_id), Number(row[tables.ledgerChange])]))
}

// ── the recordings are the ones this suite says they are ───────────────────

test('each recording is a matched log / capture / workbook set', () => {
  for (const competitionType of ['tournament', 'season']) {
    const recording = RECORDINGS[competitionType]
    const pairing = readRecordingPairing(recording)
    const expectation = expected[competitionType].recording

    assert.equal(pairing.logStartedUtc, expectation.logStartedUtc)
    assert.equal(pairing.captureUtc, expectation.captureStamp)
    assert.equal(pairing.savedWorkbook, expectation.savedWorkbook)
    assert.equal(pairing.captureHeader.park, expectation.park)
    assert.ok(fs.existsSync(recording.workbook), `missing workbook ${recording.workbook}`)
    assert.ok(fs.existsSync(`${recording.capture}.plays.jsonl`), 'missing derived plays')

    // The collector started while the session log was already open, and within
    // a couple of minutes of it. A drifted pairing would be replaying one
    // game's log against another game's capture.
    const logStart = Date.parse(pairing.logStartedUtc)
    const captureStart = Date.parse(
      pairing.captureUtc.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'),
    )
    assert.ok(captureStart > logStart, 'the capture must start after the session log opened')
    assert.ok(captureStart - logStart < 120_000, 'the capture must start within two minutes of the log')

    // Neither recording belongs to a league game, and this suite must not
    // imply otherwise.
    assert.equal(pairing.captureHeader.game_id, null)
    assert.equal(pairing.captureHeader.competition_type, null)
  }
})

// ── the game each pipeline produced ────────────────────────────────────────

test('the tournament game finishes with the score the tracker recorded', () => {
  const game = world.db.games[0]
  const want = expected.tournament
  assert.equal(runs.tournament.finished, true)
  assert.equal(game.status, want.game.status)
  assert.equal(game.team_a_runs, want.game.teamARuns)
  assert.equal(game.team_b_runs, want.game.teamBRuns)
  assert.equal(game.final_inning, want.game.finalInning)
  assert.equal(game.is_extra_innings, want.game.isExtraInnings)
  // Team A is the away side and the away side batted first. The winner is the
  // home team, which is the half of this that used to be inverted.
  assert.equal(game.winner_player_id, PLAYERS.tournamentHome.id)
  assert.equal(game.team_a_runs, want.workbookLineScore.away.final)
  assert.equal(game.team_b_runs, want.workbookLineScore.home.final)
})

test('the season game finishes with the score the tracker recorded', () => {
  const game = world.db.season_schedule[0]
  const want = expected.season
  assert.equal(runs.season.finished, true)
  assert.equal(game.status, want.game.status)
  assert.equal(game.away_score, want.game.awayScore)
  assert.equal(game.home_score, want.game.homeScore)
  assert.equal(game.final_inning, want.game.finalInning)
  assert.equal(game.winner_team_id, SEASON_TEAMS.home.id)
  assert.equal(game.away_score, want.workbookLineScore.away.final)
  assert.equal(game.home_score, want.workbookLineScore.home.final)
})

test('a team name is never on two sides at once', () => {
  // The bridge's own published mapping. It held "Spitballs":"B" from the
  // roster and "Waluigi Spitballs":"A" from the game header at the same time,
  // which is how the score reached the wrong team.
  for (const [competitionType, teams] of [
    ['tournament', RECORDINGS.tournament],
    ['season', RECORDINGS.season],
  ]) {
    const tables = SCORING_TABLES[competitionType]
    const mapping = world.db[tables.live][0]?.team_mapping || {}
    for (const side of ['away', 'home']) {
      const expectedSide = side === 'away' ? 'A' : 'B'
      assert.equal(mapping[teams[side].trackerTeam], expectedSide, `${teams[side].trackerTeam} is side ${expectedSide}`)
      assert.equal(mapping[teams[side].scoreboardName], expectedSide, `${teams[side].scoreboardName} is side ${expectedSide}`)
    }
    // The tracker's short team name and its scoreboard name are the same
    // string for some teams, so the map is not always four entries -- but no
    // entry may contradict another.
    const sides = new Set(Object.values(mapping))
    assert.deepEqual([...sides].sort(), ['A', 'B'])
  }
})

test('per-inning run rows reproduce the workbook line score', () => {
  for (const competitionType of ['tournament', 'season']) {
    const tables = SCORING_TABLES[competitionType]
    const recording = RECORDINGS[competitionType]
    const want = expected[competitionType].workbookLineScore
    const awayPlayers = new Set(recording.away.roster.map((name) => CHARACTER_ID_BY_NAME[name]))
    const byInning = { away: Array(9).fill(0), home: Array(9).fill(0) }
    for (const run of world.db[tables.runs]) {
      const side = awayPlayers.has(run.scoring_character_id) ? 'away' : 'home'
      byInning[side][Number(run.inning) - 1] += 1
    }
    if (competitionType === 'season') {
      assert.deepEqual(byInning.away, want.away.byInning)
      assert.deepEqual(byInning.home, want.home.byInning)
    } else {
      // The tournament recording has one plate appearance whose outcome the
      // tracker never stated; the bridge refuses to score it and its run goes
      // with it. Every other inning matches exactly.
      assert.deepEqual(byInning.home, want.home.byInning)
      assert.deepEqual(byInning.away, [0, 0, 0, 0, 2, 0, 0, 0, 3])
      assert.equal(
        want.away.byInning.reduce((a, b) => a + b, 0) - byInning.away.reduce((a, b) => a + b, 0),
        1,
        'exactly one run row is missing, and it belongs to the skipped plate appearance',
      )
    }
  }
})

// ── what was persisted, and how many times ─────────────────────────────────

for (const competitionType of ['tournament', 'season']) {
  test(`${competitionType} persisted row counts match the independent counts`, () => {
    const tables = SCORING_TABLES[competitionType]
    const want = expected[competitionType].persisted
    assert.equal(world.db[tables.pas].length, want.plateAppearances)
    assert.equal(world.db[tables.pitches].length, want.pitches)
    assert.equal(world.db[tables.runs].length, want.runs)
    assert.equal(world.db[tables.stints].length, want.pitchingStints)
    assert.equal(world.db[tables.fielders].length, want.gameFielders)
    assert.equal(world.db[tables.lineups].length, want.lineups)
    assert.equal(world.db[tables.odds].length, want.oddsRows)
  })

  test(`${competitionType} plate appearances, pitches and runs each survive exactly once`, () => {
    const tables = SCORING_TABLES[competitionType]
    const pas = world.db[tables.pas]
    const numbers = pas.map((row) => Number(row.pa_number))
    assert.equal(new Set(numbers).size, pas.length, 'pa_number is unique')
    assert.deepEqual([...numbers].sort((a, b) => a - b), numbers.map((_, index) => index + 1), 'pa_number has no gaps')

    const contacts = pas.map((row) => row.tracker_contact_seq).filter((seq) => seq != null)
    assert.equal(new Set(contacts).size, contacts.length, 'one plate appearance per tracker contact')

    const pitchKeys = world.db[tables.pitches].map((row) => `${row.pa_id}:${row.pitch_number_pa}`)
    assert.equal(new Set(pitchKeys).size, pitchKeys.length, 'one pitch per (pa_id, pitch_number_pa)')

    const runKeys = world.db[tables.runs].map((row) => `${row.pa_id}:${row.scoring_player_id}:${row.scoring_character_id}`)
    assert.equal(new Set(runKeys).size, runKeys.length, 'one run per (pa_id, scorer)')

    const paIds = new Set(pas.map((row) => String(row.id)))
    assert.ok(world.db[tables.pitches].every((row) => paIds.has(String(row.pa_id))), 'no orphaned pitch')
    assert.ok(world.db[tables.runs].every((row) => paIds.has(String(row.pa_id))), 'no orphaned run')
  })

  test(`${competitionType} every plate appearance the tracker stated a result for was written`, () => {
    const want = expected[competitionType]
    const skipped = runs[competitionType].messages.filter((line) => /skipping stat write/.test(line))
    assert.equal(skipped.length, want.skippedPlateAppearances)
    // Every refusal is reported by name, so nothing disappears quietly.
    for (const line of skipped) assert.match(line, /plate appearance \(vs\. .+\)/)
    assert.equal(
      world.db[SCORING_TABLES[competitionType].pas].length + skipped.length,
      want.trackerLogCounts.matchupLines,
      'every pitcher-vs-batter header is either a written plate appearance or a reported refusal',
    )
  })
}

test('the tracker log counts this suite quotes are the counts in the file', () => {
  for (const competitionType of ['tournament', 'season']) {
    const text = fs.readFileSync(RECORDINGS[competitionType].trackerLog, 'utf8')
    const want = expected[competitionType].trackerLogCounts
    assert.equal((text.match(/^\d.* \[INFO\] Plate appearance #/gm) || []).length, want.plateAppearanceLines)
    assert.equal((text.match(/recorded a run!/g) || []).length, want.runLines)
    const matchups = (text.match(/^\d.* \[INFO\] .+ vs\. .+$/gm) || []).filter((line) => !line.includes(' @ '))
    assert.equal(matchups.length, want.matchupLines)
  }
})

test('the outs the plate appearances account for equal the outs the game had', () => {
  for (const competitionType of ['tournament', 'season']) {
    const tables = SCORING_TABLES[competitionType]
    const outs = world.db[tables.pas].reduce((total, pa) => total + Number(pa.outs_on_play || 0), 0)
    assert.equal(outs, expected[competitionType].teamOuts)
  }
})

// ── the site's own statistical selection and aggregation ───────────────────

test('official selection takes every completed row and nothing else', () => {
  for (const competitionType of ['tournament', 'season']) {
    const scope = official(competitionType)
    const want = expected[competitionType].persisted
    assert.equal(scope.coverage.games.included, 1)
    assert.equal(scope.coverage.games.excludedNonFinal, 0)
    assert.equal(scope.plateAppearances.length, want.plateAppearances)
    assert.equal(scope.pitches.length, want.pitches)
    assert.equal(scope.runs.length, want.runs)
    assert.equal(scope.coverage.plateAppearances.deduplicated, 0, 'nothing was written twice for the reconciler to drop')
    assert.equal(scope.coverage.plateAppearances.excludedNonFinalOrOrphaned, 0)
    assert.equal(
      selectPitchesForPlateAppearances(scope.pitches, scope.plateAppearances).length,
      want.pitches,
      'every pitch belongs to a selected plate appearance',
    )
  }
})

for (const competitionType of ['tournament', 'season']) {
  test(`${competitionType} batting lines match the tracker's own box score`, () => {
    const scope = official(competitionType)
    for (const [name, want] of Object.entries(expected[competitionType].batting)) {
      assert.deepEqual(battingLine(scope, name), withoutAudit(want), `${competitionType} batting: ${name}`)
    }
  })

  test(`${competitionType} pitching lines match the tracker's own box score`, () => {
    const scope = official(competitionType)
    for (const [name, want] of Object.entries(expected[competitionType].pitching)) {
      assert.deepEqual(pitchingLine(scope, name), withoutAudit(want), `${competitionType} pitching: ${name}`)
    }
  })
}

test('season and tournament identities stay isolated', () => {
  // Both games are id 4242 inside competition 909, in one database.
  assert.equal(world.db.games[0].id, GAME_ID)
  assert.equal(world.db.season_schedule[0].id, GAME_ID)
  assert.equal(world.db.games[0].tournament_id, SOURCE_ID)
  assert.equal(world.db.season_schedule[0].season_id, SOURCE_ID)

  const tournament = official('tournament')
  const season = official('season')
  const keys = new Set([
    ...tournament.plateAppearances.map(getStatGameKey),
    ...season.plateAppearances.map(getStatGameKey),
  ])
  assert.deepEqual([...keys].sort(), ['season:season-4242', 'tournament:4242'])

  // A shared numeric pa_id must not let one competition's pitches be selected
  // for the other's plate appearances.
  const crossed = selectPitchesForPlateAppearances(season.pitches, tournament.plateAppearances)
  assert.equal(crossed.length, 0)

  // Career totals for a character who played in both, on different teams.
  for (const [name, want] of Object.entries(expected.career)) {
    const characterId = CHARACTER_ID_BY_NAME[name]
    const pas = [...tournament.plateAppearances, ...season.plateAppearances]
      .filter((row) => row.character_id === characterId)
    const summary = summarizeBatting(pas, filterRunEventsForCharacter([...tournament.runs, ...season.runs], characterId, pas))
    assert.deepEqual({
      games: summary.games,
      pa: summary.plateAppearances,
      ab: summary.atBats,
      hits: summary.hits,
      totalBases: summary.totalBases,
      runs: summary.runs,
      rbi: summary.rbi,
    }, withoutAudit(want), `career: ${name}`)
    assert.equal(new Set(pas.map((row) => row.player_id)).size, 2, `${name} played for two different owners`)
  }

  // And the per-competition history keeps them apart.
  const history = buildCharacterHistory(
    [...tournament.plateAppearances, ...season.plateAppearances],
    [...tournament.pitchingStints, ...season.pitchingStints],
    [...tournament.runs, ...season.runs],
  )
  assert.ok(history)
})

test('an incomplete game contributes nothing to official totals', () => {
  // The same rows, with the parent game put back to in-progress. Nothing about
  // the rows changes; only the parent's status does.
  const activeGames = world.db.games.map((game) => ({ ...game, status: 'active' }))
  const scope = reconcileStatSource({
    games: activeGames,
    plateAppearances: world.db.plate_appearances,
    pitchingStints: world.db.pitching_stints,
    pitches: world.db.pitches,
    runs: world.db.runs_scored,
    gameFielders: world.db.game_fielders,
  })
  assert.equal(scope.games.length, 0)
  assert.equal(scope.plateAppearances.length, 0)
  assert.equal(scope.pitches.length, 0)
  assert.equal(scope.runs.length, 0)
  assert.equal(
    scope.coverage.plateAppearances.excludedNonFinalOrOrphaned,
    expected.tournament.persisted.plateAppearances,
  )
  assert.deepEqual(battingLine(scope, 'Blue Pianta'), {
    games: 0, pa: 0, ab: 0, hits: 0, walks: 0, hbp: 0, strikeouts: 0,
    totalBases: 0, runs: 0, rbi: 0, homeRuns: 0,
  })
})

test('a repeated tracker write is one fact, not two', () => {
  // The reconciler is the last line of defence if a retry ever does land
  // twice. Feed it the persisted rows plus a copy of one of them carrying a
  // new id and the same tracker contact key.
  const pas = world.db.plate_appearances
  const original = pas.find((row) => row.tracker_contact_seq != null)
  const deduped = dedupeStatRows([...pas, { ...original, id: 99_999 }], 'plateAppearances')
  assert.equal(deduped.length, pas.length)
  assert.ok(deduped.some((row) => row.id === original.id), 'the original durable identity is the one kept')
  assert.ok(!deduped.some((row) => row.id === 99_999))
})

// ── betting ────────────────────────────────────────────────────────────────

for (const competitionType of ['tournament', 'season']) {
  test(`${competitionType} market is priced live and locked at completion`, () => {
    const tables = SCORING_TABLES[competitionType]
    // Priced while the game was still in progress, not only at the end.
    assert.equal(runs[competitionType].atPause.odds, expected[competitionType].persisted.oddsRows)
    assert.ok(runs[competitionType].atPause.plateAppearances > 20, 'the pause is well into the game')
    assert.ok(['active', 'in_progress'].includes(runs[competitionType].atPause.gameStatus))
    const odds = world.db[tables.odds]
    assert.equal(odds.length, expected[competitionType].persisted.oddsRows)
    assert.ok(odds.every((row) => row.is_locked), 'every market is locked once the game is final')
    const marketTypes = new Set(odds.map((row) => row.bet_type))
    for (const type of ['moneyline', 'run_line', 'over_under', 'hr_prop', 'hit_prop', 'k_prop']) {
      assert.ok(marketTypes.has(type), `expected a ${type} market`)
    }
  })

  test(`${competitionType} bets settle once, for the amounts the fixture implies`, () => {
    const tables = SCORING_TABLES[competitionType]
    const statuses = Object.fromEntries(world.db[tables.bets].map((bet) => [String(bet.id), bet.status]))
    assert.deepEqual(statuses, withoutAudit(expected[competitionType].bets))
    assert.deepEqual(settledLedger(competitionType), withoutAudit(expected[competitionType].settledLedger))

    const settledKeys = world.db[tables.ledger]
      .filter((row) => String(row.reason).startsWith('bet_settled:'))
      .map((row) => `${row.bet_id}:${row.reason}`)
    assert.equal(new Set(settledKeys).size, settledKeys.length, 'one settled ledger row per bet')
    // Every bet keeps its placement debit, and nothing was paid twice.
    const placed = world.db[tables.ledger].filter((row) => String(row.reason).startsWith('bet_placed:'))
    assert.equal(placed.length, world.db[tables.bets].length)
    assert.ok(world.db[tables.bets].every((bet) => bet.resolved_at != null))
  })
}

// ── postgame tracking ingestion ────────────────────────────────────────────

for (const competitionType of ['tournament', 'season']) {
  test(`${competitionType} postgame capture ingests once and re-ingests as a no-op`, async () => {
    const want = expected[competitionType].ingestion
    const first = runs[`${competitionType}Ingest`]
    assert.equal(first.warnings.length, 0, first.warnings.join('\n'))
    assert.equal(first.summary.status, 'ingested')
    assert.equal(first.summary.plays, want.plays)
    assert.equal(first.summary.linkedPlays, want.linkedPlays)
    assert.equal(first.summary.fieldingOpportunities, want.fieldingOpportunities)
    assert.equal(first.summary.movementMetrics, want.movementMetrics)
    assert.equal(first.summary.throws, want.throws)

    const before = {
      plays: world.db.tracking_plays.length,
      fielding: world.db.fielding_opportunities.length,
      movement: world.db.movement_metrics.length,
      throws: world.db.tracking_throws.length,
      sessions: world.db.tracking_sessions.length,
    }
    const again = await ingestRecording(world, competitionType)
    assert.equal(again.summary.alreadyComplete, true)
    assert.deepEqual({
      plays: world.db.tracking_plays.length,
      fielding: world.db.fielding_opportunities.length,
      movement: world.db.movement_metrics.length,
      throws: world.db.tracking_throws.length,
      sessions: world.db.tracking_sessions.length,
    }, before)
  })
}

test('a tracking play is never attached to a plate appearance from another batter', () => {
  const paById = new Map()
  for (const row of world.db.plate_appearances) paById.set(`tournament:${row.id}`, row)
  for (const row of world.db.season_plate_appearances) paById.set(`season:${row.id}`, row)
  const sessionType = Object.fromEntries(world.db.tracking_sessions.map((row) => [String(row.id), row.competition_type]))

  let linked = 0
  for (const play of world.db.tracking_plays) {
    if (play.pa_id == null) continue
    linked += 1
    const type = sessionType[String(play.tracking_session_id)]
    const pa = paById.get(`${type}:${play.pa_id}`)
    assert.ok(pa, `tracking play ${play.id} points at a ${type} plate appearance that exists`)
    assert.equal(String(pa.game_id), String(GAME_ID))
    assert.equal(play.join_method, 'inning+batter+order')
  }
  assert.equal(linked, expected.tournament.ingestion.linkedPlays + expected.season.ingestion.linkedPlays)
})

test('the two tracking sessions stay in their own competitions', () => {
  const sessions = world.db.tracking_sessions
  assert.equal(sessions.length, 2)
  assert.deepEqual(sessions.map((row) => row.competition_type).sort(), ['season', 'tournament'])
  assert.ok(sessions.every((row) => row.game_id === GAME_ID && row.status === 'ingested'))
  assert.equal(new Set(sessions.map((row) => row.raw_stem)).size, 2)
})

// ── the three delivery variants ────────────────────────────────────────────
//
// Each replays the tournament recording into its own database and must end at
// exactly the facts the clean run produced.

function durableFacts(db) {
  return {
    plateAppearances: db.plate_appearances.length,
    pitches: db.pitches.length,
    runs: db.runs_scored.length,
    pitchingStints: db.pitching_stints.length,
    status: db.games[0].status,
    teamARuns: db.games[0].team_a_runs,
    teamBRuns: db.games[0].team_b_runs,
    winner: db.games[0].winner_player_id,
    settledLedgerRows: db.points_ledger.filter((row) => String(row.reason).startsWith('bet_settled:')).length,
    betStatuses: db.bets.map((bet) => bet.status).join(','),
  }
}

function cleanRunFacts() {
  const want = expected.tournament
  return {
    plateAppearances: want.persisted.plateAppearances,
    pitches: want.persisted.pitches,
    runs: want.persisted.runs,
    pitchingStints: want.persisted.pitchingStints,
    status: want.game.status,
    teamARuns: want.game.teamARuns,
    teamBRuns: want.game.teamBRuns,
    winner: PLAYERS.tournamentHome.id,
    settledLedgerRows: Object.keys(withoutAudit(want.settledLedger)).length,
    betStatuses: Object.values(withoutAudit(want.bets)).join(','),
  }
}

test('duplicate delivery of a plate appearance writes it once', async () => {
  const duplicateWorld = buildAcceptanceWorld()
  await replayRecording(duplicateWorld, 'tournament', {
    pauseAtLine: TOURNAMENT_DUPLICATE_BLOCK[1],
    replayLines: TOURNAMENT_DUPLICATE_BLOCK,
  })
  assert.deepEqual(durableFacts(duplicateWorld.db), cleanRunFacts())
}, { timeout: 180_000 })

test('a write that commits and then reports failure is transparent', async () => {
  const failingWorld = buildAcceptanceWorld()
  const run = await replayRecording(failingWorld, 'tournament', {
    failures: [
      // The response is lost after the row is committed.
      { table: 'plate_appearances', action: 'insert', mode: 'after', times: 1 },
      // The process is interrupted after the row is committed.
      { table: 'pitches', action: 'insert', mode: 'throwAfter', times: 1 },
      { table: 'runs_scored', action: 'insert', mode: 'after', times: 1 },
    ],
  })
  assert.deepEqual(durableFacts(failingWorld.db), cleanRunFacts())
  // The interruption was reported rather than swallowed...
  assert.ok(run.messages.some((line) => /process stopped after commit/.test(line)))
  // ...and it did not cost the NEXT plate appearance, which is what happened
  // while closing one at-bat and opening the next shared a try block.
  assert.equal(
    run.messages.filter((line) => /skipping stat write/.test(line)).length,
    expected.tournament.skippedPlateAppearances,
  )
}, { timeout: 180_000 })

test('a restart at a half-inning boundary resumes from the journal alone', async () => {
  const restartWorld = buildAcceptanceWorld()
  const first = await replayRecording(restartWorld, 'tournament', {
    toLine: TOURNAMENT_RESTART_LINE,
    stopBeforeFinish: true,
    pauseAtLine: 21_000,
    // Interrupt a write just before the cut, so the journal is left with real
    // unfinished work rather than a tidy boundary.
    failures: [{ table: 'pitches', action: 'insert', mode: 'throwAfter', times: 1 }],
  })
  const journalPath = path.join(first.directory, 'journal', 'tournament-4242.json')
  const atCut = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
  assert.equal(atCut.events.filter((event) => event.stage !== 'complete').length, 1)
  assert.equal(restartWorld.db.games[0].status, 'active')
  const paCountAtCut = restartWorld.db.plate_appearances.length
  assert.ok(paCountAtCut > 40 && paCountAtCut < expected.tournament.persisted.plateAppearances)

  // Nothing survives the restart except the journal file and the database.
  const second = await replayRecording(restartWorld, 'tournament', {
    directory: first.directory,
    fromLine: TOURNAMENT_RESTART_LINE,
    pauseAtFraction: 0.4,
  })
  assert.ok(second.messages.some((line) => /recovered 1 incomplete scoring event/.test(line)))
  assert.deepEqual(durableFacts(restartWorld.db), cleanRunFacts())
  const afterCut = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
  assert.equal(afterCut.events.filter((event) => event.stage !== 'complete').length, 0)
  assert.equal(afterCut.events.length, expected.tournament.persisted.plateAppearances)
}, { timeout: 300_000 })

test('completion waits for the scoring writes it requires', async () => {
  const blockedWorld = buildAcceptanceWorld()
  const run = await replayRecording(blockedWorld, 'tournament', {
    pauseAtFraction: 0.6,
    // Run rows never reach the database from this point on.
    failures: [{ table: 'runs_scored', action: 'insert', mode: 'before', times: 500 }],
    // The game is expected NOT to complete, so this is how long the check
    // spends confirming that rather than how long it waits for success.
    completionTimeoutMs: 5_000,
  })
  assert.equal(run.finished, false)
  assert.equal(blockedWorld.db.games[0].status, 'active', 'the game must not be marked complete')
  assert.ok(blockedWorld.db.runs_scored.length < expected.tournament.persisted.runs)
  // The plate appearances and pitches that did commit are still durable.
  assert.equal(blockedWorld.db.plate_appearances.length, expected.tournament.persisted.plateAppearances)
  assert.equal(blockedWorld.db.pitches.length, expected.tournament.persisted.pitches)
  // Nothing downstream of completion ran.
  assert.ok(blockedWorld.db.bets.every((bet) => bet.status === 'open'))
  assert.equal(blockedWorld.db.points_ledger.filter((row) => String(row.reason).startsWith('bet_settled:')).length, 0)
}, { timeout: 180_000 })


// ── capture readiness before the first pitch ────────────────────────────────
//
// The gap docs/tracker-launcher-orchestration.md left open: nothing could say
// whether the 60 Hz collector was writing frames when the game started. These
// drive the real bridge with the collector enabled, so it is the real
// awaitCaptureRecording() deciding, and the file it publishes is the one
// scripts/mss_autogame.mjs reads.

async function startBridgeWithCollector(world, { collector }) {
  const directory = makeRunDirectory('tracker-capture-')
  const recordingPath = path.join(directory, 'handoff.live.recording')
  const handle = await startBridge({
    supabase: world,
    directory,
    gameId: GAME_ID,
    gamesTable: 'games',
    env: {
      TRACKER_PLAYER_TRACKING: '1',
      TRACKER_LAUNCH_RECORDING: recordingPath,
      // Short, because every failing case here is meant to be settled by an
      // event rather than by the deadline; a test that waited out 30 s would
      // be testing the timer.
      TRACKER_CAPTURE_READY_TIMEOUT_MS: '4000',
    },
    onSpawn: (entry) => { if (isCollectorSpawn(entry)) collector(entry.child) },
  })
  return { ...handle, directory, recordingPath }
}

test('the tracker is held until the collector has frames on disk', async () => {
  const world = buildAcceptanceWorld()
  const evidence = {
    status: 'recording', ready: true, frames: 31, missed_frames: 0, bytes_on_disk: 8412,
    elapsed_s: 0.523, stem: 'data/player_tracking/acceptance-capture', park: 'wario_stadium',
    game_timer: 91234, calibration_status: 'pending',
  }
  const handle = await startBridgeWithCollector(world, {
    collector: (child) => setImmediate(() => child.stdout.write(
      `[capture-ready] ${JSON.stringify(evidence)}\n`)),
  })
  try {
    // The tracker .exe only exists because the wait finished.
    assert.ok(handle.spawn.trackerChild(), 'the tracker was launched')
    const published = JSON.parse(fs.readFileSync(handle.recordingPath, 'utf8'))
    assert.equal(published.recording, true)
    assert.equal(published.frames, 31)
    assert.equal(published.bytesOnDisk, 8412)
    assert.ok(Number.isFinite(published.waitedMs), 'the wait is timed, so a slow start is visible')
    assert.ok(handle.logs.some((line) => /capture confirmed after \d+ms/.test(line)))
  } finally {
    await shutdownBridge(handle.bridge)
  }
}, { timeout: 120_000 })

test('a collector that dies before capturing is reported and the game is still tracked', async () => {
  const world = buildAcceptanceWorld()
  const handle = await startBridgeWithCollector(world, {
    // No dolphin-memory-engine, no running emulator, a bad park: python exits
    // during startup. Waiting that out would delay the first pitch for nothing.
    collector: (child) => setImmediate(() => child.exit(2)),
  })
  try {
    assert.ok(handle.spawn.trackerChild(),
      'the at-bat feed and the database do not depend on the collector; the game is still tracked')
    const published = JSON.parse(fs.readFileSync(handle.recordingPath, 'utf8'))
    assert.equal(published.recording, false)
    assert.match(published.reason, /exited with code 2/)
    assert.ok(handle.logs.some((line) => /the 60 Hz capture is NOT confirmed/.test(line)))
  } finally {
    await shutdownBridge(handle.bridge)
  }
}, { timeout: 120_000 })

test('evidence that proves nothing is not treated as a recording capture', async () => {
  const world = buildAcceptanceWorld()
  const handle = await startBridgeWithCollector(world, {
    // Frames counted, nothing flushed: a buffered writer, which is exactly the
    // overstatement a pid or a "started" line would have made.
    collector: (child) => setImmediate(() => child.stdout.write(
      `[capture-ready] ${JSON.stringify({
        ready: false, reason: 'no bytes written to the capture file',
        frames: 30, bytes_on_disk: 0, elapsed_s: 0.5,
      })}\n`)),
  })
  try {
    const published = JSON.parse(fs.readFileSync(handle.recordingPath, 'utf8'))
    assert.equal(published.recording, false)
    assert.equal(published.reason, 'no bytes written to the capture file')
  } finally {
    await shutdownBridge(handle.bridge)
  }
}, { timeout: 120_000 })

// ── the database game lease ─────────────────────────────────────────────────
//
// The SQL behind these is tested against a real Postgres in
// tests/tracker-database-guarantees.test.mjs. What is under test HERE is the
// bridge: that it takes a lease before it writes anything, refuses to start
// against a game another owner holds, and releases it on a clean stop.

test('a bridge takes the game lease before it writes anything', async () => {
  const world = buildAcceptanceWorld()
  const run = await replayRecording(world, 'tournament', { pauseAtFraction: 0.02 })
  const lease = world.db.tracker_game_leases.find(
    (row) => row.competition_type === 'tournament' && String(row.game_id) === String(GAME_ID))
  assert.ok(lease, 'the game was leased')
  assert.equal(Number(lease.epoch), 1)
  // Released on the way out, so the next bridge over this game does not have
  // to wait out a TTL for a process that stopped cleanly.
  assert.ok(lease.released_at, 'a clean shutdown releases the lease')
  assert.ok(run.messages.some((line) => /game lease acquired/.test(line)))
}, { timeout: 180_000 })

test('a second bridge against a game another owner holds refuses to start', async () => {
  const world = buildAcceptanceWorld()
  // Another machine, still playing. Nothing local can see this: there is no
  // lock file for it, which is the whole reason the lease exists.
  world.db.tracker_game_leases.push({
    competition_type: 'tournament',
    game_id: GAME_ID,
    owner_id: 'another-host:9999:elsewhere',
    epoch: 4,
    acquired_at: new Date().toISOString(),
    renewed_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    released_at: null,
  })
  const before = {
    pas: world.db.plate_appearances.length,
    pitches: world.db.pitches.length,
    runs: world.db.runs_scored.length,
  }
  const directory = makeRunDirectory('tracker-lease-')
  await assert.rejects(
    () => startBridge({
      supabase: world, directory, gameId: GAME_ID, gamesTable: 'games', quiet: true,
    }),
    /already holds tournament game/,
  )
  assert.deepEqual({
    pas: world.db.plate_appearances.length,
    pitches: world.db.pitches.length,
    runs: world.db.runs_scored.length,
  }, before, 'nothing was written by the refused bridge')
  assert.equal(world.db.tracker_game_leases.length, 1, 'and the held lease was not taken')
}, { timeout: 120_000 })

// ── operator corrections ────────────────────────────────────────────────────

test('the play the tracker could not score is recorded as unresolved, not invented', () => {
  const open = (world.db.tracker_unresolved_plays || [])
    .filter((row) => row.competition_type === 'tournament')
  assert.equal(open.length, 1,
    'one real unscored plate appearance -- and not the empty buffers a side change flushes')
  const [row] = open
  assert.equal(row.status, 'open')
  assert.equal(row.competition_type, 'tournament')
  assert.equal(row.inning, 5)
  assert.equal(row.half, 'top')
  assert.equal(row.batter_name, 'Red Noki')
  // The run the tracker announced and could not attribute is recorded as
  // EVIDENCE and is not written to runs_scored. That is why this game holds
  // 17 run rows for an 18-run scoreboard, and the gap is now stated rather
  // than merely missing.
  assert.equal(row.evidence.observed_runs.length, 1)
  assert.equal(world.db.runs_scored.length, expected.tournament.persisted.runs)
})

test('an operator correction survives a replay of the whole game', async () => {
  const world = buildAcceptanceWorld()
  // Stopped before the final out so the game row stays open: a bridge refuses
  // to attach to a completed game, which is the correct behaviour and not what
  // is under test here.
  const first = await replayRecording(world, 'tournament', { stopBeforeFinish: true })
  await shutdownBridge(first.bridge)
  const [unresolved] = world.db.tracker_unresolved_plays
  assert.ok(unresolved, 'the replay left the unresolved play open')

  // The operator's answer, as the At-Bat editor writes it: the verified result
  // and the runner who scored, under the tracker's own event key. The values
  // are synthetic -- this suite does not know what Red Noki actually did, and
  // the fixture deliberately keeps that unknown honest.
  const correction = {
    game_id: GAME_ID,
    pa_number: world.db.plate_appearances.length + 1,
    player_id: unresolved.batter_player_id,
    character_id: unresolved.batter_character_id,
    pitcher_id: unresolved.pitcher_character_id,
    pitcher_player_id: unresolved.pitcher_player_id,
    inning: unresolved.inning,
    result: '1B',
    rbi: 1,
    ...operatorCorrectionFields(unresolved, { userId: null }),
  }
  const { data: savedPa, error } = await world.from('plate_appearances')
    .insert(correction).select().single()
  assert.equal(error, null)
  await world.from('runs_scored').insert({
    game_id: GAME_ID,
    pa_id: savedPa.id,
    inning: unresolved.inning,
    half: unresolved.half,
    scoring_player_id: unresolved.batter_player_id,
    scoring_character_id: CHARACTER_ID_BY_NAME['Blue Yoshi'],
    is_earned_run: true,
  })
  const { error: resolveError } = await markUnresolvedPlayResolved(world, {
    id: unresolved.id, paId: savedPa.id, note: 'synthetic acceptance correction',
  })
  assert.equal(resolveError, null)

  const runsAfterCorrection = world.db.runs_scored.length
  const pasAfterCorrection = world.db.plate_appearances.length

  // Now replay the whole log again into the same database, from scratch: a
  // second bridge process with a NEW run directory and therefore no journal,
  // which is the worst case for a correction -- every plate appearance is
  // re-derived and re-offered.
  const second = await replayRecording(world, 'tournament', {
    pauseAtFraction: 0.4, stopBeforeFinish: true,
  })
  await shutdownBridge(second.bridge)

  const stillThere = world.db.plate_appearances.find((row) => String(row.id) === String(savedPa.id))
  assert.ok(stillThere, 'the correction was not deleted')
  assert.equal(stillThere.result, '1B', 'and it was not overwritten by automatic ingestion')
  assert.equal(stillThere.correction_source, 'operator')
  assert.equal(world.db.runs_scored.length, runsAfterCorrection,
    'the correction was not duplicated')
  assert.equal(world.db.plate_appearances.length, pasAfterCorrection,
    'and neither was the plate appearance')
  const reopened = world.db.tracker_unresolved_plays.find(
    (row) => String(row.id) === String(unresolved.id))
  assert.equal(reopened.status, 'resolved', 'a replay never reopens a play an operator answered')
  assert.ok(second.messages.some((line) => /has already been resolved by an operator/.test(line)))
}, { timeout: 300_000 })

// ── the run itself ─────────────────────────────────────────────────────────

test('nothing in the pipeline reported an unexpected problem', () => {
  for (const competitionType of ['tournament', 'season']) {
    const problems = problemMessages(runs[competitionType].messages)
      .filter((line) => !/skipping stat write/.test(line))
    assert.deepEqual(problems, [], `${competitionType}: ${problems.join('\n')}`)
  }
})

test('the pipeline rows the browser check renders were written by this run', () => {
  const saved = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, 'pipeline-rows.json'), 'utf8'))
  assert.equal(saved.tables.plate_appearances.length, expected.tournament.persisted.plateAppearances)
  assert.equal(saved.tables.season_plate_appearances.length, expected.season.persisted.plateAppearances)
  assert.equal(saved.tables.games[0].team_b_runs, expected.tournament.game.teamBRuns)
  assert.equal(saved.tables.season_schedule[0].home_score, expected.season.game.homeScore)
})

// ── what this suite does NOT establish ─────────────────────────────────────
//
// * THE DATABASE IS A FAKE. It enforces the natural keys the schema is
//   expected to hold and it can lose a response after a commit, but it is one
//   object in one process. Nothing here establishes real transaction
//   atomicity, real constraint enforcement, or exclusion between two machines.
//   The restart variant restarts a module inside this process; it does not
//   show that a bridge on another host would be kept out. That still needs
//   the database-backed lease and the unique constraints
//   docs/tracker-persistence-reliability.md lists.
//
// * THE WORKBOOK IS AN ORACLE, NOT THE TRUTH. Where it and the pipeline
//   disagree, tests/fixtures/tracker-acceptance-expected.json says which is
//   right and why. Its hit and at-bat columns in particular differ by design:
//   a booted ball that let the batter reach is ROE here and a hit there.
//
// * ONE PLATE APPEARANCE IN THE TOURNAMENT RECORDING HAS NO STATED OUTCOME.
//   The bridge refuses to score it and says so; its run goes with it, so
//   runs_scored holds 17 rows for an 18-run game. The scoreboard on the game
//   row is unaffected. Settling that needs an operator or video.
//
// * NO MODEL IS REFIT. Postgame ingestion runs with `recompute: false`, so the
//   Catch Probability / OAA decision ("Baseline required") is untouched.
