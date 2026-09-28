// How the run_speed impact analysis attributes a change, and how it explains
// the absence of one.
//
//   node --test tests/run-speed-impact-attribution.test.mjs
//
// NO DATABASE. `diffModelled`, `attributeImpact` and `classifyNoChange` are
// pure, so these hand them modelled rows directly.
//
// THE BUG THESE EXIST FOR. `arm_run_value` is the NEGATION of
// `runner_run_value` on the same row -- the model computes it that way -- so
// adding the two across the league gives zero on every dataset, always. The
// earlier report summed them and reported the total as the impact, which turns
// "two different players moved in opposite directions" into "nothing happened".
// The league total is not wrong; it is just not a finding, and it was standing
// in for one.
//
// The other half is the absence case. "Neither corrected character appears"
// was printed for every zero, including the zeros where one of them did appear
// and something else was responsible.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  attributeImpact,
  classifyNoChange,
  diffModelled,
  formatText,
} from '../scripts/analyze_run_speed_correction_impact.mjs'

// One modelled opportunity, before and after. `runner_run_value` and
// `arm_run_value` mirror each other exactly, as the real model produces them.
function opportunity({
  id, runner, runnerPlayer, fielder, fielderPlayer,
  attemptBefore = 0.4, attemptAfter = 0.4, runnerValueBefore = 0, runnerValueAfter = 0,
  modelVersion = 'sluggers-advanced-v2+decision:runner-decision-v1',
}) {
  const shared = {
    id,
    competition_type: 'season',
    pa_id: 1000 + id,
    opportunity_type: 'first_to_third_on_single',
    runner_character_id: runner,
    runner_player_id: runnerPlayer,
    responsible_fielder_character_id: fielder,
    responsible_fielder_player_id: fielderPlayer,
    responsible_fielder_position: 'CF',
    model_version: modelVersion,
  }
  return [
    {
      ...shared,
      expected_attempt_probability: attemptBefore,
      expected_success_probability: 0.7,
      runner_run_value: runnerValueBefore,
      arm_run_value: -runnerValueBefore,
    },
    {
      ...shared,
      expected_attempt_probability: attemptAfter,
      expected_success_probability: 0.7,
      runner_run_value: runnerValueAfter,
      arm_run_value: -runnerValueAfter,
    },
  ]
}

function split(pairs) {
  return { before: pairs.map((pair) => pair[0]), after: pairs.map((pair) => pair[1]) }
}

// ─── The cancelling case ─────────────────────────────────────────────────────

// TWO ROWS, FOUR PEOPLE, AND A LEAGUE TOTAL OF ZERO ON BOTH SIDES.
//
//   row 1  runner 37 gains 0.25, fielder 91 loses 0.25
//   row 2  runner 42 loses 0.25, fielder 55 gains 0.25
//
// Runner side sums to zero. Arm side sums to zero. Runner plus arm sums to
// zero. And four different players moved by a quarter of a run each, which is
// the only thing anybody reading this report wants to know.
test('deltas that cancel league-wide are still reported per player', () => {
  const { before, after } = split([
    opportunity({
      id: 1, runner: 37, runnerPlayer: 'p-dry', fielder: 91, fielderPlayer: 'p-yoshi',
      attemptBefore: 0.40, attemptAfter: 0.55, runnerValueBefore: 0, runnerValueAfter: 0.25,
    }),
    opportunity({
      id: 2, runner: 42, runnerPlayer: 'p-para', fielder: 55, fielderPlayer: 'p-mario',
      attemptBefore: 0.60, attemptAfter: 0.45, runnerValueBefore: 0, runnerValueAfter: -0.25,
    }),
  ])
  const { changes } = diffModelled(before, after)
  assert.equal(changes.length, 2)

  const impact = attributeImpact(changes)

  // The totals really do cancel. That is the trap, stated as a fact.
  assert.equal(Math.abs(impact.runnerTotal) < 1e-12, true, 'runner side cancels league-wide')
  assert.equal(Math.abs(impact.armTotal) < 1e-12, true, 'arm side cancels league-wide')
  assert.equal(Math.abs(impact.runnerTotal + impact.armTotal) < 1e-12, true)

  // ...and four distinct people moved anyway.
  assert.equal(impact.runnerBeneficiaries, 2)
  assert.equal(impact.armBeneficiaries, 2)

  const runner = (id) => impact.runnerSide.find((row) => String(row.characterId) === String(id))
  const fielder = (id) => impact.armSide.find((row) => String(row.characterId) === String(id))
  assert.ok(Math.abs(runner(37).runValueDelta - 0.25) < 1e-12, 'runner 37 gained a quarter run')
  assert.ok(Math.abs(runner(42).runValueDelta + 0.25) < 1e-12, 'runner 42 lost a quarter run')
  assert.ok(Math.abs(fielder(91).runValueDelta + 0.25) < 1e-12, 'fielder 91 lost a quarter run')
  assert.ok(Math.abs(fielder(55).runValueDelta - 0.25) < 1e-12, 'fielder 55 gained a quarter run')

  // The player ids travel with the totals; a character id alone cannot be
  // joined to a WAR row.
  assert.equal(runner(37).playerId, 'p-dry')
  assert.equal(fielder(55).playerId, 'p-mario')
})

test('the runner and the fielder on one row are never merged into one figure', () => {
  const { before, after } = split([
    opportunity({
      id: 1, runner: 37, runnerPlayer: 'p-dry', fielder: 91, fielderPlayer: 'p-yoshi',
      attemptBefore: 0.4, attemptAfter: 0.6, runnerValueBefore: 0, runnerValueAfter: 0.3,
    }),
  ])
  const impact = attributeImpact(diffModelled(before, after).changes)
  // One row, two beneficiaries, equal and opposite.
  assert.equal(impact.runnerSide.length, 1)
  assert.equal(impact.armSide.length, 1)
  assert.ok(impact.runnerSide[0].runValueDelta > 0)
  assert.ok(impact.armSide[0].runValueDelta < 0)
  assert.notEqual(String(impact.runnerSide[0].characterId), String(impact.armSide[0].characterId))
})

test('a row with no identity on one side is grouped, not dropped', () => {
  const { before, after } = split([
    opportunity({
      id: 1, runner: 37, runnerPlayer: 'p-dry', fielder: null, fielderPlayer: null,
      attemptBefore: 0.4, attemptAfter: 0.6, runnerValueBefore: 0, runnerValueAfter: 0.3,
    }),
  ])
  const impact = attributeImpact(diffModelled(before, after).changes)
  assert.equal(impact.armSide.length, 1)
  assert.equal(impact.armSide[0].unattributed, true, 'neither half of the identity is known')
  assert.equal(impact.armSide[0].characterKnown, false)
  assert.equal(impact.armSide[0].playerKnown, false)
  assert.equal(impact.distinctFielderCharacters, 0, 'an unknown id is not a distinct character')
  // Dropping it would make the per-player totals disagree with the row totals.
  assert.ok(Math.abs(impact.armSide[0].runValueDelta - impact.armTotal) < 1e-12)
})

test('aggregation keeps full precision; only presentation rounds', () => {
  // Three rows whose deltas are individually below any sane display precision
  // and which sum to something visible. Rounding into the record first would
  // have summed three zeroes.
  const tiny = 0.0000004
  const { before, after } = split([1, 2, 3].map((id) => opportunity({
    id, runner: 37, runnerPlayer: 'p-dry', fielder: 91, fielderPlayer: 'p-yoshi',
    attemptBefore: 0.4, attemptAfter: 0.4 + tiny,
    runnerValueBefore: 0, runnerValueAfter: tiny,
  })))
  const impact = attributeImpact(diffModelled(before, after).changes)
  assert.equal(impact.runnerSide[0].rows, 3)
  assert.ok(Math.abs(impact.runnerSide[0].runValueDelta - (3 * tiny)) < 1e-15,
    `expected ${3 * tiny}, got ${impact.runnerSide[0].runValueDelta}`)
  assert.notEqual(impact.runnerSide[0].runValueDelta, 0)
})

test('a row whose values did not move is not a change', () => {
  const { before, after } = split([
    opportunity({ id: 1, runner: 37, runnerPlayer: 'p-dry', fielder: 91, fielderPlayer: 'p-y' }),
  ])
  const { changes } = diffModelled(before, after)
  assert.deepEqual(changes, [])
  const impact = attributeImpact(changes)
  assert.equal(impact.runnerBeneficiaries, 0)
  assert.equal(impact.armBeneficiaries, 0)
})

// ─── A beneficiary is a character AND a player ───────────────────────────────
//
// THE DEFECT THESE PIN. Keying on the character id alone, and keeping the first
// player id seen, merged two owners of the same character into one row under
// one of their names -- and because the two moved in opposite directions, that
// row read zero. It is the same cancellation this file exists to prevent,
// happening one level below the one it was watching.

const pair = (runValueDelta, {
  runner = 37, runnerPlayer = 'p-a', fielder = 91, fielderPlayer = 'f-a',
} = {}) => ({
  runner_character_id: runner,
  runner_player_id: runnerPlayer,
  responsible_fielder_character_id: fielder,
  responsible_fielder_player_id: fielderPlayer,
  deltas: { runner: runValueDelta, arm: -runValueDelta },
})

const find = (rows, characterId, playerId) => rows.find((row) => (
  String(row.characterId) === String(characterId)
  && String(row.playerId) === String(playerId)
))

test('the same character owned by two players is two runner beneficiaries', () => {
  const impact = attributeImpact([
    pair(0.25, { runner: 37, runnerPlayer: 'player-a' }),
    pair(-0.25, { runner: 37, runnerPlayer: 'player-b' }),
  ])
  assert.equal(impact.runnerBeneficiaries, 2, 'one row per character/player pair')
  assert.equal(impact.distinctRunnerCharacters, 1, 'and it is still one character')
  assert.equal(impact.distinctRunnerPlayers, 2)

  const a = find(impact.runnerSide, 37, 'player-a')
  const b = find(impact.runnerSide, 37, 'player-b')
  assert.ok(a && b, 'both owners survive')
  assert.ok(Math.abs(a.runValueDelta - 0.25) < 1e-12)
  assert.ok(Math.abs(b.runValueDelta + 0.25) < 1e-12)
  assert.equal(a.rows, 1)
  assert.equal(b.rows, 1)
  // The old behaviour, stated so it cannot come back quietly.
  assert.notEqual(impact.runnerSide.length, 1, 'must not collapse to one entry')
})

test('the same character owned by two players is two arm beneficiaries', () => {
  const impact = attributeImpact([
    pair(-0.25, { fielder: 91, fielderPlayer: 'f-a' }),
    pair(0.25, { fielder: 91, fielderPlayer: 'f-b' }),
  ])
  assert.equal(impact.armBeneficiaries, 2)
  assert.equal(impact.distinctFielderCharacters, 1)
  assert.equal(impact.distinctFielderPlayers, 2)
  assert.ok(Math.abs(find(impact.armSide, 91, 'f-a').runValueDelta - 0.25) < 1e-12)
  assert.ok(Math.abs(find(impact.armSide, 91, 'f-b').runValueDelta + 0.25) < 1e-12)
})

test('one player using two characters stays two beneficiaries', () => {
  const impact = attributeImpact([
    pair(0.4, { runner: 37, runnerPlayer: 'player-a' }),
    pair(-0.4, { runner: 42, runnerPlayer: 'player-a' }),
  ])
  assert.equal(impact.runnerBeneficiaries, 2)
  assert.equal(impact.distinctRunnerPlayers, 1, 'one player')
  assert.equal(impact.distinctRunnerCharacters, 2, 'two characters')
  assert.ok(Math.abs(find(impact.runnerSide, 37, 'player-a').runValueDelta - 0.4) < 1e-12)
  assert.ok(Math.abs(find(impact.runnerSide, 42, 'player-a').runValueDelta + 0.4) < 1e-12)
})

test('the same player and character across rows DO accumulate', () => {
  const impact = attributeImpact([
    pair(0.1, { runner: 37, runnerPlayer: 'player-a' }),
    pair(0.2, { runner: 37, runnerPlayer: 'player-a' }),
  ])
  assert.equal(impact.runnerBeneficiaries, 1)
  assert.equal(impact.runnerSide[0].rows, 2)
  assert.ok(Math.abs(impact.runnerSide[0].runValueDelta - 0.3) < 1e-12)
})

// A MISSING ID IS NOT A WILDCARD. "Character 37, owner unknown" is a different
// beneficiary from "character 37, owner player-a", and merging them would
// credit runs to a named player that nobody attributed to them.
test('a missing player id is its own beneficiary, not folded into a known one', () => {
  const impact = attributeImpact([
    pair(0.25, { runner: 37, runnerPlayer: 'player-a' }),
    pair(0.5, { runner: 37, runnerPlayer: null }),
  ])
  assert.equal(impact.runnerBeneficiaries, 2)
  assert.equal(impact.distinctRunnerCharacters, 1)
  assert.equal(impact.distinctRunnerPlayers, 1, 'only the resolved player counts')

  const known = find(impact.runnerSide, 37, 'player-a')
  const unknown = impact.runnerSide.find((row) => row.characterKnown && !row.playerKnown)
  assert.ok(Math.abs(known.runValueDelta - 0.25) < 1e-12,
    'the named player must not inherit the unattributed runs')
  assert.ok(Math.abs(unknown.runValueDelta - 0.5) < 1e-12)
  assert.equal(unknown.characterId, 37)
  assert.equal(unknown.playerId, null)
  assert.equal(unknown.unattributed, false, 'the character IS known; only the owner is not')
})

test('a missing character id with a known player is also its own beneficiary', () => {
  const impact = attributeImpact([
    pair(0.25, { runner: 37, runnerPlayer: 'player-a' }),
    pair(0.5, { runner: null, runnerPlayer: 'player-a' }),
  ])
  assert.equal(impact.runnerBeneficiaries, 2)
  assert.equal(impact.distinctRunnerPlayers, 1)
  assert.equal(impact.distinctRunnerCharacters, 1)
  const orphan = impact.runnerSide.find((row) => !row.characterKnown)
  assert.ok(Math.abs(orphan.runValueDelta - 0.5) < 1e-12)
  assert.ok(Math.abs(find(impact.runnerSide, 37, 'player-a').runValueDelta - 0.25) < 1e-12)
})

test('a missing player id on the arm side is kept apart too', () => {
  const impact = attributeImpact([
    pair(-0.25, { fielder: 91, fielderPlayer: 'f-a' }),
    pair(-0.5, { fielder: 91, fielderPlayer: null }),
  ])
  assert.equal(impact.armBeneficiaries, 2)
  assert.ok(Math.abs(find(impact.armSide, 91, 'f-a').runValueDelta - 0.25) < 1e-12)
  const unknown = impact.armSide.find((row) => row.characterKnown && !row.playerKnown)
  assert.ok(Math.abs(unknown.runValueDelta - 0.5) < 1e-12)
})

// THE REPRODUCTION FROM THE REVIEW, end to end and with both sides.
test('deltas that cancel per character remain visible per beneficiary', () => {
  const impact = attributeImpact([
    pair(0.25, { runner: 37, runnerPlayer: 'player-a', fielder: 91, fielderPlayer: 'f-a' }),
    pair(-0.25, { runner: 37, runnerPlayer: 'player-b', fielder: 91, fielderPlayer: 'f-b' }),
  ])
  // Everything that could be summed to zero, is zero.
  assert.ok(Math.abs(impact.runnerTotal) < 1e-12)
  assert.ok(Math.abs(impact.armTotal) < 1e-12)
  const perCharacter = impact.runnerSide
    .filter((row) => String(row.characterId) === '37')
    .reduce((total, row) => total + row.runValueDelta, 0)
  assert.ok(Math.abs(perCharacter) < 1e-12, 'the character nets out too')

  // And four beneficiaries moved by a quarter run each.
  assert.equal(impact.runnerBeneficiaries, 2)
  assert.equal(impact.armBeneficiaries, 2)
  for (const row of [...impact.runnerSide, ...impact.armSide]) {
    assert.ok(Math.abs(row.runValueDelta) > 0.2,
      `${row.key} should carry a visible delta, got ${row.runValueDelta}`)
  }
})

test('a character id that is the string "none" does not collide with a missing one', () => {
  const impact = attributeImpact([
    pair(0.25, { runner: 'none', runnerPlayer: 'p' }),
    pair(0.5, { runner: null, runnerPlayer: 'p' }),
  ])
  assert.equal(impact.runnerBeneficiaries, 2)
  assert.ok(Math.abs(find(impact.runnerSide, 'none', 'p').runValueDelta - 0.25) < 1e-12)
})

// ─── Why nothing moved ───────────────────────────────────────────────────────

test('no corrected runner anywhere is one reason, and says so', () => {
  const reason = classifyNoChange({
    rowsWithCorrectedRunner: 0,
    fittedRowsWithCorrectedRunner: 0,
    correctionsPending: [{ name: 'Dry Bones' }],
  })
  assert.equal(reason.reason, 'no-corrected-runner')
  assert.match(reason.text, /no opportunity row has a corrected character as its runner/)
})

// THE CASE THE OLD WORDING GOT WRONG. A corrected character IS in the data and
// nothing moved, because none of their rows reaches the fitted model.
test('a corrected character present but unmodelled is a different reason', () => {
  const reason = classifyNoChange({
    rowsWithCorrectedRunner: 4,
    fittedRowsWithCorrectedRunner: 0,
    correctionsPending: [{ name: 'Dry Bones' }],
  })
  assert.equal(reason.reason, 'present-but-unmodelled')
  assert.match(reason.text, /4 opportunity row\(s\) DO have a corrected character/)
  assert.match(reason.text, /context average, which has no runner_speed in it/)
  // It must NOT claim the character is absent.
  assert.doesNotMatch(reason.text, /no opportunity row has a corrected character/)
})

test('an already-corrected column explains a zero without blaming the data', () => {
  const reason = classifyNoChange({
    rowsWithCorrectedRunner: 6,
    fittedRowsWithCorrectedRunner: 6,
    correctionsAlreadyApplied: [{ name: 'Dry Bones' }, { name: 'Green Paratroopa' }],
    correctionsPending: [],
  })
  assert.equal(reason.reason, 'already-corrected')
  assert.match(reason.text, /already holds the corrected value/)
  assert.doesNotMatch(reason.text, /no opportunity row/)
})

test('modelled rows that still produce nothing are flagged as unexpected', () => {
  const reason = classifyNoChange({
    rowsWithCorrectedRunner: 3,
    fittedRowsWithCorrectedRunner: 3,
    correctionsPending: [{ name: 'Dry Bones' }],
  })
  assert.equal(reason.reason, 'modelled-but-identical')
  assert.match(reason.text, /not expected from a non-zero/)
})

// The end-to-end shape of the second requested regression: a corrected
// character appears in the rows, and the modelled values are identical.
test('a corrected runner present with no modelled change reports both facts', () => {
  const { before, after } = split([
    opportunity({
      id: 1, runner: 37, runnerPlayer: 'p-dry', fielder: 91, fielderPlayer: 'p-yoshi',
      modelVersion: 'sluggers-advanced-v2',
    }),
    opportunity({
      id: 2, runner: 37, runnerPlayer: 'p-dry', fielder: 55, fielderPlayer: 'p-mario',
      modelVersion: 'sluggers-advanced-v2',
    }),
  ])
  const { changes, fittedRows } = diffModelled(before, after)
  assert.deepEqual(changes, [], 'nothing moved')
  assert.equal(fittedRows, 0, 'and nothing reached the fitted model')

  const reason = classifyNoChange({
    rowsWithCorrectedRunner: 2,
    fittedRowsWithCorrectedRunner: fittedRows,
    correctionsPending: [{ name: 'Dry Bones' }],
  })
  assert.equal(reason.reason, 'present-but-unmodelled')
  assert.match(reason.text, /2 opportunity row\(s\) DO have a corrected character/)
})

test('fitted rows are counted from the model version, not assumed', () => {
  const { before, after } = split([
    opportunity({ id: 1, runner: 37, runnerPlayer: 'a', fielder: 9, fielderPlayer: 'b' }),
    opportunity({
      id: 2, runner: 42, runnerPlayer: 'c', fielder: 9, fielderPlayer: 'b',
      modelVersion: 'sluggers-advanced-v2',
    }),
  ])
  const { eligibleRows, fittedRows } = diffModelled(before, after)
  assert.equal(eligibleRows, 2, 'both carry an expected attempt probability')
  assert.equal(fittedRows, 1, 'only one carries the decision-model tag')
})

// ─── The rendered report, in the case live data has never produced ───────────
//
// Today's database yields zero changes, so the non-zero branch of the text
// report would first run on the day it mattered. These render it from a
// synthetic report object instead.

function renderReport(overrides = {}) {
  const { changes } = diffModelled(...Object.values(split([
    opportunity({
      id: 1, runner: 37, runnerPlayer: 'p-dry', fielder: 91, fielderPlayer: 'p-yoshi',
      attemptBefore: 0.40, attemptAfter: 0.55, runnerValueBefore: 0, runnerValueAfter: 0.25,
    }),
    opportunity({
      id: 2, runner: 42, runnerPlayer: 'p-para', fielder: 55, fielderPlayer: 'p-mario',
      attemptBefore: 0.60, attemptAfter: 0.45, runnerValueBefore: 0, runnerValueAfter: -0.25,
    }),
  ])).map((rows) => rows))
  const impact = attributeImpact(changes)
  const round = (v) => (v == null ? null : Number(v.toFixed(6)))
  return formatText({
    generatedAt: '2026-09-21T00:00:00.000Z',
    host: 'example.test',
    corrections: [{
      name: 'Dry Bones', from: 40, to: 50, liveValue: 40, state: 'pending',
      profileRunSpeed: 50, fpsFrom: 25.3683, fpsTo: 25.565,
    }],
    directConsumers: [['a/file.mjs', 'REPORTS', 'does something']],
    decisionModel: { model_version: 'runner-decision-v1', status: 'active' },
    impact: {
      totalRows: 17, eligibleRows: 17, fittedRows: 13,
      rowsWithCorrectedRunner: 2, fittedRowsWithCorrectedRunner: 2,
      changedRows: changes.length,
      changes: changes.map((change) => ({
        ...change,
        before: Object.fromEntries(Object.entries(change.before).map(([k, v]) => [k, round(v)])),
        after: Object.fromEntries(Object.entries(change.after).map(([k, v]) => [k, round(v)])),
        deltas: Object.fromEntries(Object.entries(change.deltas).map(([k, v]) => [k, round(v)])),
      })),
      runnerSide: impact.runnerSide.map((row) => ({ ...row, runValueDelta: round(row.runValueDelta) })),
      armSide: impact.armSide.map((row) => ({ ...row, runValueDelta: round(row.runValueDelta) })),
      runnerTotalRunValueDelta: round(impact.runnerTotal),
      armTotalRunValueDelta: round(impact.armTotal),
      runnerBeneficiaries: impact.runnerBeneficiaries,
      armBeneficiaries: impact.armBeneficiaries,
      distinctRunnerCharacters: impact.distinctRunnerCharacters,
      distinctRunnerPlayers: impact.distinctRunnerPlayers,
      distinctFielderCharacters: impact.distinctFielderCharacters,
      distinctFielderPlayers: impact.distinctFielderPlayers,
      noChangeReason: null,
      war: { quantified: false, note: 'NOT QUANTIFIED. needs runsPerWin.' },
      storedNote: 'unchanged until a recompute runs.',
      ...overrides,
    },
    sensitivity: null,
    archive: { sessions: 41, excluded: 18 },
    verifier: [],
    refitExposure: [],
  })
}

test('the rendered report keeps the two sides apart and names the people', () => {
  const out = renderReport()
  assert.match(out, /RUNNER SIDE {2}\(baserunning runs\) {3}2 beneficiaries {2}\(2 characters, 2 players\)/)
  assert.match(out, /ARM SIDE {2}\(fielding runs\) {9}2 beneficiaries {2}\(2 characters, 2 players\)/)
  assert.match(out, /character 37 \/ player p-dry/)
  assert.match(out, /character 55 \/ player p-mario/)
  assert.match(out, /A BENEFICIARY IS A CHARACTER\/PLAYER PAIR/)
  // The cancelling totals are shown, and the arm total is labelled as the
  // mirror of the runner total rather than as a second finding.
  assert.match(out, /runner side total {16}\+?0/)
  assert.match(out, /not a finding/)
  // THE THING THAT MUST NOT APPEAR: a single combined runs figure.
  assert.doesNotMatch(out, /total runner run value moved/)
  assert.doesNotMatch(out, /runs move by/)
})

test('a non-zero impact leaves WAR unquantified rather than dividing by a guess', () => {
  const out = renderReport()
  assert.match(out, /downstream WAR {19}not quantified/)
  assert.match(out, /needs runsPerWin/)
  assert.doesNotMatch(out, /WAR moves by that divided by/)
})

test('a zero impact still quantifies WAR as exactly zero', () => {
  const out = renderReport({
    changedRows: 0,
    changes: [],
    runnerSide: [],
    armSide: [],
    runnerBeneficiaries: 0,
    armBeneficiaries: 0,
    distinctRunnerCharacters: 0,
    distinctRunnerPlayers: 0,
    distinctFielderCharacters: 0,
    distinctFielderPlayers: 0,
    noChangeReason: { reason: 'no-corrected-runner', text: 'no opportunity row has one.' },
    war: { quantified: true, delta: 0, note: 'exactly 0 for every player.' },
  })
  assert.match(out, /no change, because: no-corrected-runner/)
  assert.match(out, /downstream WAR {19}0/)
  assert.match(out, /exactly 0 for every player/)
  assert.doesNotMatch(out, /RUNNER SIDE/)
})
