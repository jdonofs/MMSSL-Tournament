// Answering a play the tracker could not score.
//
// TWO THINGS WERE WRONG AND BOTH ARE HERE. The editor opened the APPEND page
// and let the normal draft effect overwrite the selection, so a Top-5 play with
// two pitches and a runner on second opened as Bottom 9, the wrong batter, the
// wrong pitcher, no pitches and empty bases. And the save was four client
// writes in a deliberate order, so a failure after the first left a plate
// appearance holding the unresolved play's tracker_event_key -- which the
// unique index then used to refuse every retry, blocking the only path that
// could close the gap.
//
// The context half is pure functions over the editor's own derivation and is
// tested directly. The save half is one database function and is tested against
// a real PostgreSQL. The page itself -- selecting a result and saving it -- is
// tests/at-bat-correction-browser.mjs.

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'

import {
  createTrackerTestDatabase,
  databaseAvailable,
  seedCollidingGames,
} from './helpers/trackerTestDatabase.mjs'
import { createPgliteSupabase } from './helpers/pgliteSupabase.mjs'
import {
  correctionContext,
  correctionInsertionIndex,
  draftPitchesFromEvidence,
  recordUnresolvedPlayCorrection,
} from '../src/utils/trackerUnresolvedPlays.js'

// The editor's own derivation, loaded the way tests/tracker-acceptance.test.mjs
// loads src/: trackerGameState.js imports its neighbours without extensions,
// which Vite resolves and node does not. Reimplementing it here would test a
// copy rather than the thing the page uses.
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
after(() => vite.close())
const { deriveGameStateAtIndex } = await vite.ssrLoadModule('/src/utils/trackerGameState.js')

const HAVE_DATABASE = await databaseAvailable()
const skip = HAVE_DATABASE
  ? false
  : 'no local Postgres: @electric-sql/pglite is not installed (npm install)'

// ── where the answer belongs ────────────────────────────────────────────────

const GAME = { id: 4242, innings: 9, team_a_player_id: 'away-gm', team_b_player_id: 'home-gm' }
const LINEUPS = [
  ...Array.from({ length: 9 }, (_, index) => ({
    id: `a${index}`, player_id: 'away-gm', batting_order: index + 1, character_id: 100 + index,
  })),
  ...Array.from({ length: 9 }, (_, index) => ({
    id: `h${index}`, player_id: 'home-gm', batting_order: index + 1, character_id: 200 + index,
  })),
]

// A game played out to the bottom of the ninth, three outs per half-inning,
// with the fifth-inning top half one out short -- the play the tracker could
// not score is the missing one.
function playedGame() {
  const pas = []
  let paNumber = 1
  for (let half = 0; half < 18; half++) {
    const outsThisHalf = half === 8 ? 2 : 3      // half 8 == top of the 5th
    for (let out = 0; out < outsThisHalf; out++) {
      pas.push({
        id: paNumber, game_id: 4242, pa_number: paNumber, result: 'GO', outs_on_play: 1,
        player_id: half % 2 === 0 ? 'away-gm' : 'home-gm',
        character_id: half % 2 === 0 ? 100 : 200,
      })
      paNumber += 1
    }
  }
  return pas
}

const UNRESOLVED = {
  id: '11111111-1111-1111-1111-111111111111',
  competition_type: 'tournament',
  game_id: 4242,
  tracker_event_key: 'tracker-pa:red-noki:3',
  inning: 5,
  half: 'top',
  batter_name: 'Red Noki',
  batter_character_id: 7051,
  pitcher_name: 'Shy Guy',
  pitcher_character_id: 7040,
  reason: 'No result could be determined from the tracker log',
  evidence: {
    outs_before_pa: 2,
    pitches: [
      { type: 'fastball', balls_before: 0, strikes_before: 0 },
      { type: 'curveball', balls_before: 1, strikes_before: 0 },
    ],
    runners_before: { first: null, second: { characterId: 7051, playerId: 'away-gm' }, third: null },
    observed_runs: [{ scorer: 'Red Noki' }],
  },
  status: 'open',
}

test('the slot is the game\'s own Top 5, not the end of the list', () => {
  const pas = playedGame()
  const deriveAt = (index) => deriveGameStateAtIndex(pas, GAME, LINEUPS, index, [])
  const slot = correctionInsertionIndex({ unresolved: UNRESOLVED, paCount: pas.length, deriveAt })

  const atSlot = deriveAt(slot)
  assert.equal(atSlot.inning, 5)
  assert.equal(atSlot.isTop, true)
  assert.equal(atSlot.outsInHalf, 2, 'and at the out count the tracker actually saw')
  assert.notEqual(slot, pas.length, 'the append page is where this used to open')

  // The end of the list, which is what the editor used to show, is a different
  // game situation entirely.
  const atEnd = deriveAt(pas.length)
  assert.equal(atEnd.inning, 9)
  assert.equal(atEnd.isTop, false)
})

test('the context is the play\'s own, and its evidence is preserved', () => {
  const pas = playedGame()
  const deriveAt = (index) => deriveGameStateAtIndex(pas, GAME, LINEUPS, index, [])
  const slot = correctionInsertionIndex({ unresolved: UNRESOLVED, paCount: pas.length, deriveAt })
  const context = correctionContext(UNRESOLVED, deriveAt(slot))

  assert.equal(context.matchesEvidence, true)
  assert.equal(context.halfLabel, 'Top 5')
  assert.equal(context.outsInHalf, 2)
  assert.equal(context.runnersBefore.second.characterId, 7051, 'the runner the tracker saw')
  assert.equal(context.runnersBefore.first, null)
  assert.equal(context.battingPlayerId, 'away-gm')

  const pitches = draftPitchesFromEvidence(UNRESOLVED)
  assert.equal(pitches.length, 2)
  assert.deepEqual(pitches.map((pitch) => pitch.pitch_type), ['fastball', 'curveball'])
  assert.deepEqual(pitches.map((pitch) => pitch.pitch_number_pa), [1, 2])
})

test('a play the recorded at-bats cannot place is reported, not papered over', () => {
  const pas = playedGame()
  const deriveAt = (index) => deriveGameStateAtIndex(pas, GAME, LINEUPS, index, [])
  // A twelfth-inning play in a game whose recorded outs never reach the twelfth.
  const impossible = { ...UNRESOLVED, inning: 12, half: 'bottom' }
  const slot = correctionInsertionIndex({ unresolved: impossible, paCount: pas.length, deriveAt })
  assert.equal(slot, pas.length, 'it falls back to the end rather than inventing a slot')
  const context = correctionContext(impossible, deriveAt(slot))
  assert.equal(context.matchesEvidence, false)
  assert.equal(context.evidenceHalfLabel, 'Bot 12')
  // And the derivation still governs the teams and lineups, so the page cannot
  // show one half-inning's label over another half-inning's lineup.
  assert.equal(context.halfLabel, 'Bot 9')
})

// ── writing the answer ──────────────────────────────────────────────────────

async function correctionWorld(t) {
  const db = await createTrackerTestDatabase()
  t.after(() => db.close())
  const seeded = await seedCollidingGames(db)
  const supabase = createPgliteSupabase(db)
  // Four recorded at-bats; the unresolved play belongs between the second and
  // the third.
  for (let number = 1; number <= 4; number++) {
    await db.query(
      `insert into plate_appearances (game_id, pa_number, result, player_id, character_id,
                                      tracker_event_key)
       values ($1, $2, 'GO', $3, $4, $5)`,
      [seeded.gameId, number, seeded.away.id, seeded.batter.id, `contact:${number}`])
  }
  const unresolved = await db.one(
    `insert into tracker_unresolved_plays (competition_type, game_id, tracker_event_key,
                                           inning, half, batter_name, reason)
     values ('tournament', $1, 'tracker-pa:red-noki:3', 5, 'top', 'Red Noki', $2) returning *`,
    [seeded.gameId, 'No result could be determined from the tracker log'])
  return { db, supabase, unresolved, ...seeded }
}

function correctionPa(w) {
  return {
    game_id: w.gameId,
    player_id: w.away.id,
    character_id: w.batter.id,
    pitcher_id: w.pitcher.id,
    pitcher_player_id: w.home.id,
    inning: 5,
    result: '1B',
  }
}

test('the correction lands at its chronological slot and renumbers what follows', { skip }, async (t) => {
  const w = await correctionWorld(t)
  const { data, error } = await recordUnresolvedPlayCorrection(w.supabase, {
    competitionType: 'tournament',
    unresolved: w.unresolved,
    pa: correctionPa(w),
    pitches: [{ game_id: w.gameId, pitch_number_pa: 1, pitch_result: 'in_play' }],
    runs: [{ game_id: w.gameId, scoring_player_id: w.away.id, scoring_character_id: w.batter.id }],
    paNumber: 3,
    note: 'Recorded in the At-Bat editor as 1B',
  })
  assert.equal(error, null)
  assert.equal(data.pa_number, 3)
  assert.equal(Number(data.renumbered), 2, 'the two at-bats after it moved up')

  const ordered = await w.db.rows(
    'select pa_number, result, tracker_event_key from plate_appearances where game_id = $1 order by pa_number',
    [w.gameId])
  assert.deepEqual(ordered.map((row) => row.tracker_event_key), [
    'contact:1', 'contact:2', 'tracker-pa:red-noki:3', 'contact:3', 'contact:4',
  ])
  assert.equal(await w.db.value(
    'select correction_source from plate_appearances where tracker_event_key = $1',
    ['tracker-pa:red-noki:3']), 'operator')
  assert.equal(await w.db.value('select count(*) from pitches where pa_id = $1', [data.pa_id]), 1)
  assert.equal(await w.db.value('select count(*) from runs_scored where pa_id = $1', [data.pa_id]), 1)

  const closed = await w.db.one('select status, resolved_pa_id, resolution_note from tracker_unresolved_plays')
  assert.equal(closed.status, 'resolved')
  assert.equal(Number(closed.resolved_pa_id), Number(data.pa_id))
  assert.match(closed.resolution_note, /as 1B/)
})

test('a save that died after the insert is completed by the retry, not blocked by it', { skip }, async (t) => {
  const w = await correctionWorld(t)
  // The first attempt: the plate appearance committed and everything after it
  // was lost. This is the state that used to make the unique event key refuse
  // every retry.
  await w.db.query(
    `insert into plate_appearances (game_id, pa_number, result, tracker_event_key, correction_source)
     values ($1, 5, '1B', 'tracker-pa:red-noki:3', 'operator')`, [w.gameId])
  assert.equal(await w.db.value('select status from tracker_unresolved_plays'), 'open',
    'and the gap is still visible, which was the right half of the old behaviour')

  const { data, error } = await recordUnresolvedPlayCorrection(w.supabase, {
    competitionType: 'tournament',
    unresolved: w.unresolved,
    pa: correctionPa(w),
    pitches: [{ game_id: w.gameId, pitch_number_pa: 1, pitch_result: 'in_play' }],
    runs: [],
    paNumber: 3,
    note: 'Recorded in the At-Bat editor as 1B',
  })
  assert.equal(error, null)
  assert.equal(data.retried, true)
  assert.equal(Number(data.renumbered), 0, 'the row it already had is reused rather than re-slotted')
  assert.equal(await w.db.value('select count(*) from plate_appearances where tracker_event_key = $1',
    ['tracker-pa:red-noki:3']), 1)
  assert.equal(await w.db.value('select count(*) from pitches where pa_id = $1', [data.pa_id]), 1,
    'and the children the first attempt never wrote are there now')
  assert.equal(await w.db.value('select status from tracker_unresolved_plays'), 'resolved')
})

test('an answer is never written over a row the tracker owns', { skip }, async (t) => {
  const w = await correctionWorld(t)
  await w.db.query(
    `insert into plate_appearances (game_id, pa_number, result, tracker_event_key)
     values ($1, 5, 'K', 'tracker-pa:red-noki:3')`, [w.gameId])
  const { error } = await recordUnresolvedPlayCorrection(w.supabase, {
    competitionType: 'tournament',
    unresolved: w.unresolved,
    pa: correctionPa(w),
    paNumber: 3,
  })
  assert.match(String(error?.message), /the tracker already recorded a plate appearance/)
  assert.equal(await w.db.value('select result from plate_appearances where tracker_event_key = $1',
    ['tracker-pa:red-noki:3']), 'K')
  assert.equal(await w.db.value('select status from tracker_unresolved_plays'), 'open')
})

test('a correction naming another game is refused with nothing written', { skip }, async (t) => {
  const w = await correctionWorld(t)
  await w.db.query('insert into games (id, tournament_id, stats_source) values (7777, 909, $1)', ['tracker'])
  const { error } = await recordUnresolvedPlayCorrection(w.supabase, {
    competitionType: 'tournament',
    unresolved: w.unresolved,
    pa: { ...correctionPa(w), game_id: 7777 },
    paNumber: 3,
  })
  assert.match(String(error?.message), /names game 7777/)
  assert.equal(await w.db.value('select count(*) from plate_appearances'), 4)
  assert.equal(await w.db.value('select status from tracker_unresolved_plays'), 'open')
})

test('a replaying bridge leaves the answer exactly as the operator wrote it', { skip }, async (t) => {
  const w = await correctionWorld(t)
  const { data } = await recordUnresolvedPlayCorrection(w.supabase, {
    competitionType: 'tournament',
    unresolved: w.unresolved,
    pa: correctionPa(w),
    pitches: [{ game_id: w.gameId, pitch_number_pa: 1, pitch_result: 'in_play' }],
    runs: [{ game_id: w.gameId, scoring_player_id: w.away.id, scoring_character_id: w.batter.id }],
    paNumber: 3,
  })
  // The bridge, replaying the same log, arrives at the same event key with the
  // nothing it originally had.
  const replay = await w.supabase.rpc('tracker_persist_plate_appearance', {
    p_competition_type: 'tournament',
    p_game_id: w.gameId,
    p_pa: { ...correctionPa(w), result: 'K', tracker_event_key: 'tracker-pa:red-noki:3' },
    p_pitches: [],
    p_runs: [],
    p_owner_id: null,
    p_epoch: null,
    p_unleased_intent: 'test: a replay',
  })
  assert.equal(replay.error, null)
  assert.equal(replay.data.operator_correction, true)
  assert.equal(await w.db.value('select result from plate_appearances where id = $1', [data.pa_id]), '1B')
  assert.equal(await w.db.value('select count(*) from runs_scored where pa_id = $1', [data.pa_id]), 1)
})
