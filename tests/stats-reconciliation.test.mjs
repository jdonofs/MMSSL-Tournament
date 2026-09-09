import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test, { after } from 'node:test'
import { createServer } from 'vite'

import { fetchAllRows } from '../src/utils/fetchAllRows.js'
import { normalizeSeasonRowsByGameId, normalizeSeasonScheduleRows } from '../src/utils/seasonGameIds.js'
import {
  dedupeStatRows,
  getStatPaKey,
  reconcileStatSource,
  selectPitchesForPlateAppearances,
  selectStatRowsForScope,
} from '../src/utils/statReconciliation.js'

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
const {
  buildCharacterHistory,
  buildFieldingChances,
  buildPitchParticipantIndex,
  filterRunEventsForCharacter,
  filterRunEventsForPlayer,
  inningsAsDecimal,
  outsFromInningsPitched,
  summarizeBatting,
  summarizeDefensiveEfficiency,
  summarizePitching,
} = await vite.ssrLoadModule('/src/utils/statsCalculator.js')
after(() => vite.close())

const fixture = JSON.parse(await readFile(new URL('./fixtures/stats-reconciliation-snapshot.json', import.meta.url), 'utf8'))
const charactersByName = Object.fromEntries(fixture.characters.map((character) => [character.name, character]))
const seasonTeamPlayerById = Object.fromEntries(fixture.season_teams.map((team) => [String(team.id), team.player_id]))

const tournament = reconcileStatSource({
  games: fixture.games,
  plateAppearances: fixture.plate_appearances,
  pitchingStints: fixture.pitching_stints,
  pitches: fixture.pitches,
  runs: fixture.runs_scored,
  gameFielders: fixture.game_fielders,
})
const seasonGames = normalizeSeasonScheduleRows(fixture.season_schedule)
const season = reconcileStatSource({
  games: seasonGames,
  plateAppearances: normalizeSeasonRowsByGameId(fixture.season_plate_appearances),
  pitchingStints: normalizeSeasonRowsByGameId(fixture.season_pitching_stints),
  pitches: normalizeSeasonRowsByGameId(fixture.season_pitches),
  runs: normalizeSeasonRowsByGameId(fixture.season_runs_scored),
  gameFielders: normalizeSeasonRowsByGameId(fixture.season_game_fielders),
})

function assertBatting(actual, expected) {
  assert.deepEqual({
    games: actual.games,
    pa: actual.plateAppearances,
    ab: actual.atBats,
    hits: actual.hits,
    walks: actual.walks,
    hbp: actual.hbp,
    strikeouts: actual.strikeouts,
    total_bases: actual.totalBases,
    runs: actual.runs,
    rbi: actual.rbi,
  }, {
    games: expected.games,
    pa: expected.pa,
    ab: expected.ab,
    hits: expected.hits,
    walks: expected.walks,
    hbp: expected.hbp,
    strikeouts: expected.strikeouts,
    total_bases: expected.total_bases,
    runs: expected.runs,
    rbi: expected.rbi,
  })
  assert.equal(actual.avg, expected.avg)
  assert.equal(actual.obp, expected.obp)
  assert.equal(actual.slg, expected.slg)
  assert.equal(actual.obp + actual.slg, expected.ops)
}

test('completed persisted tracker game contributes its independently tallied batting line once', () => {
  const pas = tournament.plateAppearances.filter((pa) => pa.game_id === 7 && pa.player_id === 'player-a')
  const runs = filterRunEventsForPlayer(tournament.runs, 'player-a', pas)
  assertBatting(summarizeBatting(pas, runs), fixture.expected.tournament_101_team_alpha)
  assert.equal(tournament.coverage.plateAppearances.deduplicated, 1)
  assert.equal(tournament.coverage.runs.deduplicated, 1)
})

test('active, reopened, excluded, abandoned and scheduled rows never enter official totals', () => {
  assert.deepEqual(tournament.games.map((game) => game.id), [7, 12])
  assert.equal(tournament.plateAppearances.some((pa) => [8, 9, 10, 11].includes(pa.game_id)), false)
  assert.deepEqual(season.games.map((game) => game.id), ['season-7'])
  assert.equal(season.coverage.games.excludedNonFinal, 2)
})

test('tournament and season scopes remain isolated when numeric game and PA ids collide', () => {
  const tournament101 = selectStatRowsForScope({
    tournamentRows: tournament.plateAppearances,
    seasonRows: season.plateAppearances,
    tournamentGames: fixture.games,
    seasonGames,
    sourceMode: 'tournaments',
    tournamentId: 101,
  })
  const season201 = selectStatRowsForScope({
    tournamentRows: tournament.plateAppearances,
    seasonRows: season.plateAppearances,
    tournamentGames: fixture.games,
    seasonGames,
    sourceMode: 'seasons',
    seasonId: 201,
  })
  assert.equal(tournament101.length, 11)
  assert.equal(season201.length, 4)
  assertBatting(
    summarizeBatting(season201, filterRunEventsForPlayer(season.runs, 'player-c', season201)),
    fixture.expected.season_201_team_charlie,
  )

  const both = [...tournament.plateAppearances, ...season.plateAppearances]
  const bothPitches = [...tournament.pitches, ...season.pitches]
  const tournamentPaOne = both.filter((pa) => pa.game_id === 7 && pa.id === 1)
  const seasonPaOne = both.filter((pa) => pa.game_id === 'season-7' && pa.id === 1)
  assert.equal(selectPitchesForPlateAppearances(bothPitches, tournamentPaOne).length, 1)
  assert.equal(selectPitchesForPlateAppearances(bothPitches, seasonPaOne).length, 1)
})

test('character, human-player and team totals reconcile without transferring historical ownership', () => {
  const allPas = [...tournament.plateAppearances, ...season.plateAppearances]
  const allStints = [...tournament.pitchingStints, ...season.pitchingStints]
  const allRuns = [...tournament.runs, ...season.runs]
  const history = buildCharacterHistory(allPas, allStints, allRuns)
  const redPianta = history[1].batting
  assertBatting(redPianta, fixture.expected.career_character_red_pianta)

  const tournamentRed = tournament.plateAppearances.filter((pa) => pa.character_id === 1)
  const seasonRed = season.plateAppearances.filter((pa) => pa.character_id === 1)
  assert.equal(new Set(tournamentRed.map((pa) => pa.player_id)).has('player-a'), true)
  assert.equal(new Set(seasonRed.map((pa) => pa.player_id)).has('player-c'), true)

  const alphaPas = tournament.plateAppearances.filter((pa) => pa.player_id === 'player-a')
  const alpha = summarizeBatting(alphaPas, filterRunEventsForPlayer(tournament.runs, 'player-a', alphaPas))
  const characterIds = [...new Set(alphaPas.map((pa) => pa.character_id))]
  const characterLines = characterIds.map((characterId) => {
    const pas = alphaPas.filter((pa) => pa.character_id === characterId)
    return summarizeBatting(pas, filterRunEventsForCharacter(tournament.runs, characterId, pas))
  })
  for (const field of ['plateAppearances', 'atBats', 'hits', 'walks', 'hbp', 'strikeouts', 'totalBases', 'runs', 'rbi']) {
    assert.equal(characterLines.reduce((sum, line) => sum + line[field], 0), alpha[field], field)
  }
})

test('rates are recomputed from career totals, never averaged from rounded event rates', () => {
  const redPas = [...tournament.plateAppearances, ...season.plateAppearances].filter((pa) => pa.character_id === 1)
  const redRuns = filterRunEventsForCharacter([...tournament.runs, ...season.runs], 1, redPas)
  const career = summarizeBatting(redPas, redRuns)
  assert.equal(career.avg, 3 / 5)
  assert.equal(career.obp, 4 / 6)
  assert.notEqual(career.avg, (0.5 + 1) / 2)
})

test('sacrifices, errors, fielder choices, double plays and IPHR follow literal scoring rules', () => {
  const line = summarizeBatting(tournament.plateAppearances.filter((pa) => pa.game_id === 7))
  assert.equal(line.sacrificeFlies, 1)
  assert.equal(line.sacrificeHits, 1)
  assert.equal(line.homeRuns, 1)
  assert.equal(line.totalBases, 7)
  assert.equal(line.atBats, 7)
  assert.equal(line.rbi, 4)
  assert.equal(line.hits, 3)
})

test('persisted rows beat overlapping live summaries and tracker natural keys deduplicate', () => {
  const persisted = fixture.plate_appearances.find((pa) => pa.id === 1)
  const liveSummary = { ...persisted, id: null, row_kind: 'summary', result: 'HR', rbi: 4 }
  const rows = dedupeStatRows([liveSummary, persisted], 'plateAppearances')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].result, '1B')
})

test('pitching preserves baseball innings, pitch totals, zero-out appearances and missing earned runs', () => {
  const magikoopaStints = tournament.pitchingStints.filter((stint) => stint.character_id === 9)
  const magikoopa = summarizePitching(magikoopaStints)
  const expected = fixture.expected.tournament_101_pitcher_magikoopa
  assert.equal(outsFromInningsPitched(magikoopa.innings), expected.outs)
  assert.equal(inningsAsDecimal(magikoopa.innings), 2)
  assert.equal(magikoopa.hitsAllowed, expected.hits_allowed)
  assert.equal(magikoopa.walks, expected.walks)
  assert.equal(magikoopa.runsAllowed, expected.runs_allowed)
  assert.equal(magikoopa.earnedRuns, expected.earned_runs)
  assert.equal(magikoopa.strikeouts, expected.strikeouts)
  const faced = tournament.plateAppearances.filter((pa) => pa.pitcher_id === 9)
  assert.equal(selectPitchesForPlateAppearances(tournament.pitches, faced).length, expected.pitches)

  const zeroOut = summarizePitching(tournament.pitchingStints.filter((stint) => stint.game_id === 12))
  assert.equal(zeroOut.innings, 0)
  assert.equal(zeroOut.games, 1)
  assert.equal(zeroOut.walks, 1)

  const seasonPitching = summarizePitching(season.pitchingStints)
  assert.equal(seasonPitching.innings, 0.1)
  assert.equal(seasonPitching.earnedRuns, null)
  assert.deepEqual(seasonPitching.coverage.earned_runs, { measured: 0, total: 1 })
  assert.equal(summarizePitching([{ id: 900, game_id: 900, innings_pitched: 0, earned_runs: 0 }]).earnedRuns, 0)
})

test('mid-PA pitcher change uses the final persisted pitch participant without losing earlier pitch totals', () => {
  const pa = tournament.plateAppearances.find((row) => row.game_id === 12)
  const pitches = selectPitchesForPlateAppearances(tournament.pitches, [pa])
  const index = buildPitchParticipantIndex(pitches)
  assert.equal(pitches.length, 4)
  assert.equal(index[getStatPaKey(pa)].pitcherName, 'Luigi')
  assert.equal(tournament.pitchingStints.filter((stint) => stint.game_id === 12).length, 2)
})

test('fielding attribution and team DER reconcile only where persisted evidence supports them', () => {
  const gamePas = tournament.plateAppearances.filter((pa) => pa.game_id === 7)
  const chances = buildFieldingChances(gamePas, tournament.gameFielders, charactersByName)
  const expected = fixture.expected.tournament_101_defense_bravo
  assert.equal(chances.filter((chance) => chance.isError).length, expected.errors)
  assert.equal(chances.filter((chance) => chance.isPutout).length, expected.putouts)
  assert.equal(chances.filter((chance) => chance.isAssist).length, expected.assists)
  const der = summarizeDefensiveEfficiency(gamePas)
  assert.deepEqual(der, {
    opportunities: expected.der_opportunities,
    outsConverted: expected.der_outs_converted,
    defensiveEfficiency: expected.defensive_efficiency,
  })
})

test('ambiguous older PAs and absent pitching measurements stay visibly missing', () => {
  const ambiguous = summarizeBatting([{ id: 700, game_id: 7, result: null }])
  assert.equal(ambiguous.atBats, 0)
  assert.deepEqual(ambiguous.coverage, {
    resolvedPlateAppearances: 0,
    ambiguousPlateAppearances: 1,
    runEvents: 0,
    legacyRunFallbacks: 0,
  })
  const missing = summarizePitching([{ id: 701, game_id: 7, innings_pitched: null, earned_runs: null }])
  assert.equal(missing.innings, null)
  assert.equal(missing.earnedRuns, null)
  assert.equal(missing.era, null)
})

test('recorded-game reference line retains literal HR and total-base semantics', () => {
  const expected = fixture.expected.recorded_reference_red_pianta
  const observed = fixture.recorded_game_excerpt.box_score
  assert.deepEqual(observed, {
    team: 'Monsters', character: 'Red Pianta', pa: 1, ab: 1, runs: 1,
    hits: 1, rbi: 1, home_runs: 1, total_bases: 4,
  })
  const pas = [fixture.recorded_game_excerpt.persisted_pa_projection]
  const line = summarizeBatting(pas)
  assert.equal(line.plateAppearances, expected.pa)
  assert.equal(line.atBats, expected.ab)
  assert.equal(line.hits, expected.hits)
  assert.equal(line.homeRuns, expected.home_runs)
  assert.equal(line.runs, expected.runs)
  assert.equal(line.rbi, expected.rbi)
  assert.equal(line.totalBases, expected.total_bases)
  assert.equal(line.avg, expected.avg)
  assert.equal(line.obp, expected.obp)
  assert.equal(line.slg, expected.slg)
  assert.equal(line.obp + line.slg, expected.ops)
})

test('unbounded stat reads paginate beyond the PostgREST default limit', async () => {
  const source = Array.from({ length: 2005 }, (_, id) => ({ id: id + 1 }))
  const calls = []
  const buildQuery = () => ({
    order() { return this },
    async range(from, to) {
      calls.push([from, to])
      return { data: source.slice(from, to + 1), error: null }
    },
  })
  const result = await fetchAllRows(buildQuery)
  assert.equal(result.error, null)
  assert.equal(result.data.length, 2005)
  assert.deepEqual(calls, [[0, 999], [1000, 1999], [2000, 2999]])
})
