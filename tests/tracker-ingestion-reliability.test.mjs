import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ingestPlayerTrackingSession } from '../scripts/ingest_player_tracking.mjs'
import { createLiveTrackingPersistence } from '../scripts/tracker_live_tracking_persistence.mjs'
import { onlyActiveTrackingFacts, supersededTrackingPlayIds } from '../src/utils/activeTrackingVersions.js'
import { createTrackerFakeSupabase } from './helpers/trackerFakeSupabase.mjs'

function writeFixture(dir, { competitionType = 'tournament', quarantined = false, playCount = 1 } = {}) {
  const stem = path.join(dir, `${competitionType}-capture`)
  fs.writeFileSync(`${stem}.json`, JSON.stringify({
    game_id: 12,
    competition_type: competitionType,
    source_id: competitionType === 'season' ? 7 : 3,
    park: 'mario-stadium',
    format: 'MSSTRK02',
    recorded_utc: '20260905T120000Z',
    frames: 600,
    missed_frames: 0,
    duration_seconds: 10,
    checksum_sha256: 'fixture-checksum',
    fielder_pointers_left_region: quarantined,
  }))
  const play = {
    inning: 1, inning_half: 0, batter_id: 2,
    contact_timer: 100, pitch_release_timer: 80, dead_ball_timer: 140,
    batted_ball_class: 'fair_in_play', fair_or_foul: 'fair',
    contact_at: [0, 0, -10], first_touch: { by: 'P', character_id: 2, frame: 120, at: [0, 1, -10] },
    primary_fielder: 'P', caught_in_flight: false,
    fielders: {
      P: { character_id: 2, pitch_release_start: [0, 0, -1], start: [0, 0, -1], end: [0, 0, -9], path_units: 8, fielded: true },
      C: { character_id: 2, pitch_release_start: [0, 0, 1], start: [0, 0, 1], end: [0, 0, 1], path_units: 0, fielded: false },
    },
    runners: {
      BAT: { character_id: 2, start: [0, 0, 0], end: [10, 0, 0], path_units: 10, five_foot_splits_s: {} },
    },
    throws: [{ sequence: 1, thrower_position: 'P', thrower_character_id: 2, receiver_position: 'C', receiver_character_id: 2 }],
  }
  fs.writeFileSync(`${stem}.plays.jsonl`, Array.from({ length: playCount }, (_, index) => (
    JSON.stringify({ ...play, contact_timer: 100 + index, dead_ball_timer: 140 + index })
  )).join('\n'))
  return stem
}

function initialTables(type = 'tournament') {
  const paTable = type === 'season' ? 'season_plate_appearances' : 'plate_appearances'
  const fielderTable = type === 'season' ? 'season_game_fielders' : 'game_fielders'
  return {
    [paTable]: [{
      id: 50, game_id: 12, pa_number: 1, inning: 1, result: '1B', trajectory: 'G',
      character_id: 31, player_id: 'batter-owner', runner_assignments: [], tracker_contact_seq: 1,
    }],
    [fielderTable]: [
      { id: 1, game_id: 12, team_id: type === 'season' ? 101 : 'def-owner', character: 'Donkey Kong', position: 1, inning_from: 1 },
      { id: 2, game_id: 12, team_id: type === 'season' ? 101 : 'def-owner', character: 'Donkey Kong', position: 2, inning_from: 1 },
    ],
    characters: [{ id: 31, name: 'Donkey Kong' }],
    season_teams: type === 'season' ? [{ id: 101, player_id: 'def-owner' }] : [],
    tracking_sessions: [], tracking_plays: [], fielding_opportunities: [], movement_metrics: [], tracking_throws: [],
    runner_opportunities: [], double_play_opportunities: [],
  }
}

test('tournament dry-run writes the complete raw fact set and is safe to repeat', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-ingest-t-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixture(dir)
  const client = createTrackerFakeSupabase(initialTables())
  const first = await ingestPlayerTrackingSession(client, { session: stem, recompute: false, warn: () => {} })
  const second = await ingestPlayerTrackingSession(client.restart(), { session: stem, recompute: false, warn: () => {} })
  assert.equal(first.status, 'ingested')
  assert.equal(second.alreadyComplete, true)
  assert.equal(client.db.tracking_plays.length, 1)
  assert.equal(client.db.fielding_opportunities.length, 2)
  assert.equal(client.db.movement_metrics.length, 3)
  assert.equal(client.db.tracking_throws.length, 1)
  assert.equal(client.db.tracking_sessions[0].source_id, 3)
})

test('postgame ingest restates mixed slap and charge evidence pitch by pitch', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-ingest-swings-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixture(dir)
  const common = {
    inning: 1, inning_half: 0, batter_id: 2, batter: 'Donkey Kong', batter_index: 0,
    offer: 'swing', swing_mode_source: 'swing_charge_frames_rise',
    plate_x_units: 0.2, plate_y_units: 1.0, plate_z_units: 0.01,
    pitch_zone: 'in', pitch_zone_source: 'horizontal_zone_v1', is_chase: false,
  }
  fs.writeFileSync(`${stem}.pitches.jsonl`, [
    {
      ...common, pitch_timer: 80, pitch_in_pa: 1, outcome: 'strike', contact: false,
      swing_mode: 'charge', swing_charge_frames: 21,
      swing_charge_release_timing_frames: 33,
      fielding_star_meter_spent: 50,
    },
    {
      ...common, pitch_timer: 100, pitch_in_pa: 2, outcome: 'contact', contact: true,
      swing_mode: 'slap', swing_charge_frames: 0,
      swing_charge_release_timing_frames: null,
    },
  ].map(JSON.stringify).join('\n'))

  const tables = initialTables()
  tables.pitches = [
    { id: 'pitch-1', game_id: 12, pa_id: 50, pitch_number_pa: 1, result: 'swinging_miss' },
    { id: 'pitch-2', game_id: 12, pa_id: 50, pitch_number_pa: 2, result: 'in_play', is_star_pitch: true },
  ]
  const client = createTrackerFakeSupabase(tables)
  const result = await ingestPlayerTrackingSession(client, {
    session: stem, recompute: false, warn: () => {},
  })

  assert.equal(result.pitchEvidenceRows, 2)
  assert.equal(client.db.pitches[0].result, 'swinging_miss', 'scoring result is not rewritten')
  assert.equal(client.db.pitches[0].swing_mode, 'charge')
  assert.equal(client.db.pitches[0].swing_charge_frames, 21)
  assert.equal(client.db.pitches[0].is_star_pitch, true)
  assert.equal(client.db.pitches[1].result, 'in_play', 'scoring result is not rewritten')
  assert.equal(client.db.pitches[1].swing_mode, 'slap')
  assert.equal(client.db.pitches[1].swing_charge_frames, 0)
  assert.equal(client.db.pitches[1].is_star_pitch, true, 'absent meter evidence does not erase a live flag')
})

test('ingestion does not persist a knocked-loose ball as a throw fact', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-ingest-loose-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixture(dir)
  const plays = fs.readFileSync(`${stem}.plays.jsonl`, 'utf8').split('\n').map(JSON.parse)
  plays[0].throws.unshift({
    sequence: 1, is_throw: false, event_type: 'knocked_loose',
    thrower_position: 'P', thrower_character_id: 2,
    receiver_position: 'C', receiver_character_id: 2, peak_speed_mph: 20,
  })
  plays[0].throws[1].sequence = 2
  fs.writeFileSync(`${stem}.plays.jsonl`, plays.map(JSON.stringify).join('\n'))
  const client = createTrackerFakeSupabase(initialTables())
  const result = await ingestPlayerTrackingSession(client, {
    session: stem, recompute: false, warn: () => {},
  })
  assert.equal(result.throws, 1)
  assert.equal(client.db.tracking_throws.length, 1)
  assert.equal(client.db.tracking_throws[0].throw_sequence, 2)
})

test('ingestion carries normalized gimmick luck into the tracking play quality', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-ingest-gimmick-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixture(dir)
  const play = JSON.parse(fs.readFileSync(`${stem}.plays.jsonl`, 'utf8'))
  play.table_stuns = [{ by: 'P', character_id: 2, frame: 112, t: 1.2 }]
  fs.writeFileSync(`${stem}.plays.jsonl`, JSON.stringify(play))

  const tables = initialTables()
  tables.plate_appearances[0].pitcher_player_id = 'def-owner'
  tables.plate_appearances[0].pitcher_id = 31
  const client = createTrackerFakeSupabase(tables)
  await ingestPlayerTrackingSession(client, { session: stem, recompute: false, warn: () => {} })

  const [event] = client.db.tracking_plays[0].quality.gimmick_events
  assert.equal(event.type, 'table_stun')
  assert.equal(event.beneficiary_player_id, 'batter-owner')
  assert.equal(event.unlucky_player_id, 'def-owner')
  assert.equal(event.affected_position, 'P')
  assert.equal(event.affected_character_id, 31)
})

test('ingestion persists descriptive stadium incidents beside the luck events', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-ingest-incidents-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixture(dir)
  const play = JSON.parse(fs.readFileSync(`${stem}.plays.jsonl`, 'utf8'))
  // PRODUCER-SHAPED. A freeze as derive_player_metrics.py writes one, and a
  // manhole knockdown under the deriver's own `manhole_water` spelling -- the
  // two populations the site could not see at all.
  play.freezes = [{ by: 'C', character_id: 2, character: 'Donkey Kong', t: 1.0, frames: 120, seconds: 2.002 }]
  play.knockdowns = [{ by: 'P', character_id: 2, character: 'Donkey Kong', t: 0.5, frame: 130, frames: 79, hazard: 'manhole_water' }]
  fs.writeFileSync(`${stem}.plays.jsonl`, JSON.stringify(play))

  const tables = initialTables()
  tables.plate_appearances[0].pitcher_player_id = 'def-owner'
  tables.plate_appearances[0].pitcher_id = 31
  const client = createTrackerFakeSupabase(tables)
  await ingestPlayerTrackingSession(client, { session: stem, recompute: false, warn: () => {} })

  const { stadium_incidents: incidents, gimmick_events: luck } = client.db.tracking_plays[0].quality
  assert.equal(incidents.length, 2, 'the freeze and the knockdown are both incidents')
  const freeze = incidents.find((row) => row.type === 'player_freeze')
  const manhole = incidents.find((row) => row.type === 'manhole_water_knockdown')
  assert.ok(freeze && manhole)
  // The victim is the character the stadium actually touched, resolved at game
  // time -- never the beneficiary or unlucky side of the luck event.
  assert.equal(freeze.victim.position, 'C')
  assert.equal(freeze.victim.characterId, 31)
  assert.equal(freeze.victim.playerId, 'def-owner')
  assert.equal(freeze.duration_seconds, 2.002)
  // A freeze that carried only a relative time still got an absolute frame.
  assert.ok(Number.isFinite(freeze.frame))
  assert.equal(manhole.cause.confidence, 'flag_named')

  // The freeze reaches the descriptive contract and, correctly, NOT luck: the
  // deriver never named what froze him in this capture.
  assert.ok(!luck.some((row) => row.type === 'player_freeze'))
  assert.ok(luck.some((row) => row.type === 'manhole_water_knockdown'),
    'the manhole knockdown now survives the alias that used to drop it')
})

test('season dry-run maps season team ids back to player ids consistently', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-ingest-s-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixture(dir, { competitionType: 'season' })
  const client = createTrackerFakeSupabase(initialTables('season'))
  await ingestPlayerTrackingSession(client, { session: stem, recompute: false, warn: () => {} })
  assert.equal(client.db.tracking_sessions[0].competition_type, 'season')
  assert.equal(client.db.tracking_sessions[0].source_id, 7)
  assert.ok(client.db.fielding_opportunities.every((row) => row.fielder_player_id === 'def-owner'))
})

test('a mid-inning position change does not hand the earlier play to the new fielder', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-ingest-move-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixture(dir, { competitionType: 'season' })
  const tables = initialTables('season')
  tables.season_plate_appearances[0].defensive_team_id = 101
  // Game 2766: Toadette caught one in RF, then Red Pianta moved to RF in the
  // same inning. The bridge rewrites the inning-1 rows, so the scorebook now
  // says Red Pianta held the position the capture saw Donkey Kong play.
  tables.season_game_fielders = [
    // The batting side is listed first and fields the same character, so a
    // lookup that ignores the team credits the wrong owner.
    { id: 9, game_id: 12, team_id: 202, character: 'Donkey Kong', position: 1, inning_from: 1 },
    { id: 1, game_id: 12, team_id: 101, character: 'Red Pianta', position: 1, inning_from: 1 },
    { id: 2, game_id: 12, team_id: 101, character: 'Donkey Kong', position: 3, inning_from: 1 },
    { id: 3, game_id: 12, team_id: 101, character: 'Toadette', position: 2, inning_from: 1 },
  ]
  tables.characters.push({ id: 71, name: 'Red Pianta' }, { id: 56, name: 'Toadette' })
  tables.season_teams.push({ id: 202, player_id: 'bat-owner' })
  const client = createTrackerFakeSupabase(tables)
  await ingestPlayerTrackingSession(client, { session: stem, recompute: false, warn: () => {} })
  const pitcher = client.db.fielding_opportunities.find((row) => row.position === 'P')
  assert.equal(pitcher.fielder_character_id, 31, 'the capture saw Donkey Kong at P')
  assert.equal(pitcher.fielder_player_id, 'def-owner')
  const [throwRow] = client.db.tracking_throws
  assert.equal(throwRow.thrower_character_id, 31)
  assert.equal(throwRow.thrower_player_id, 'def-owner')
})

test('interrupted child-row insertion resumes without deleting committed facts', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-ingest-resume-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixture(dir)
  const tables = initialTables()
  const first = createTrackerFakeSupabase(tables, {
    failures: [{ table: 'fielding_opportunities', action: 'insert', mode: 'before', times: 3 }],
  })
  await assert.rejects(
    ingestPlayerTrackingSession(first, { session: stem, recompute: false, warn: () => {} }),
    (error) => error.message === 'failure before write',
  )
  assert.equal(first.db.tracking_plays.length, 1)
  assert.equal(first.db.fielding_opportunities.length, 0)

  const summary = await ingestPlayerTrackingSession(first.restart(), { session: stem, recompute: false, warn: () => {} })
  assert.equal(summary.status, 'ingested')
  assert.equal(first.db.tracking_plays.length, 1)
  assert.equal(first.db.fielding_opportunities.length, 2)
})

test('process stops after committed fielding, movement, throw, or runner writes recover cleanly', async (t) => {
  const cases = [
    ['fielding_opportunities', 'insert'],
    ['movement_metrics', 'insert'],
    ['tracking_throws', 'insert'],
    ['runner_opportunities', 'update'],
  ]
  for (const [table, action] of cases) {
    await t.test(`${table} ${action}`, async (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-ingest-crash-'))
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
      const stem = writeFixture(dir)
      const tables = initialTables()
      if (table === 'runner_opportunities') {
        tables.runner_opportunities.push({
          id: 70, competition_type: 'tournament', game_id: 12, pa_id: 50,
          origin_base: 'first', target_base: 'second',
        })
      }
      const first = createTrackerFakeSupabase(tables, {
        failures: [{ table, action, mode: 'throwAfter' }],
      })
      await assert.rejects(
        ingestPlayerTrackingSession(first, { session: stem, recompute: false, warn: () => {} }),
        /process stopped after commit/,
      )
      const summary = await ingestPlayerTrackingSession(first.restart(), {
        session: stem, recompute: false, warn: () => {},
      })
      assert.equal(summary.status, 'ingested')
      assert.equal(first.db.tracking_plays.length, 1)
      assert.equal(first.db.fielding_opportunities.length, 2)
      assert.equal(first.db.movement_metrics.length, 3)
      assert.equal(first.db.tracking_throws.length, 1)
      assert.equal(new Set(first.db[fieldingTableName(table)].map((row) => row.id)).size, first.db[fieldingTableName(table)].length)
    })
  }
})

function fieldingTableName(table) {
  return ['fielding_opportunities', 'movement_metrics', 'tracking_throws'].includes(table)
    ? table : 'runner_opportunities'
}

test('advanced recomputation failure preserves raw facts and an explicit resumable stage', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-ingest-model-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixture(dir)
  const client = createTrackerFakeSupabase(initialTables())
  await assert.rejects(ingestPlayerTrackingSession(client, {
    session: stem,
    warn: () => {},
    recomputeFn: async () => { throw new Error('model unavailable') },
  }), /Raw tracking facts were saved/)
  // The raw half landed and the derived half is recorded as unfinished. The
  // status alone cannot say that -- matching fact counts read as a finished
  // ingest -- so the stage is what the retry reads.
  assert.equal(client.db.tracking_sessions[0].status, 'ingested')
  assert.equal(client.db.tracking_sessions[0].quality.derived_stage, 'recompute')
  assert.equal(client.db.tracking_plays.length, 1)
  assert.equal(client.db.fielding_opportunities.length, 2)
  let recomputations = 0
  const resumed = await ingestPlayerTrackingSession(client.restart(), {
    session: stem, warn: () => {}, recomputeFn: async () => { recomputations += 1; return { ok: true } },
  })
  assert.equal(recomputations, 1, 'the retry finishes the stage the failure left behind')
  assert.equal(resumed.resumedStage, 'recompute')
  assert.equal(client.db.tracking_sessions[0].status, 'ingested')
  assert.equal(client.db.tracking_sessions[0].quality.derived_stage, null)
  assert.equal(client.db.tracking_plays.length, 1, 'nothing was re-imported')
})

test('a smaller replacement is refused while the completed ingest remains untouched', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-ingest-replace-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixture(dir)
  const client = createTrackerFakeSupabase(initialTables())
  await ingestPlayerTrackingSession(client, { session: stem, recompute: false, warn: () => {} })
  const changed = JSON.parse(fs.readFileSync(`${stem}.plays.jsonl`, 'utf8'))
  fs.writeFileSync(`${stem}.plays.jsonl`, JSON.stringify({ ...changed, contact_timer: 999 }))
  await assert.rejects(
    ingestPlayerTrackingSession(client.restart(), { session: stem, recompute: false, warn: () => {} }),
    /Refusing to replace completed tracking session/,
  )
  fs.writeFileSync(`${stem}.plays.jsonl`, '')
  await assert.rejects(
    ingestPlayerTrackingSession(client.restart(), { session: stem, recompute: false, warn: () => {} }),
    /Refusing to replace completed tracking session/,
  )
  assert.equal(client.db.tracking_sessions[0].status, 'ingested')
  assert.equal(client.db.tracking_plays.length, 1)
})


// A model of the two session-versioning functions, over the fake's own table.
//
// The SQL itself -- the partial unique index that allows exactly one active
// version, the refusal to activate an unfinished one, the single-statement
// pointer move -- is tested against a real Postgres in
// tests/tracker-database-guarantees.test.mjs. What these two tests establish is
// the INGEST wiring: that a changed replacement is built beside the good
// session, that the good one stays active until the new one is finished, and
// that a replacement which dies halfway leaves the original in place.
function installSessionVersioning(client) {
  client.setRpcHandler('tracker_begin_session_replacement', (args) => {
    const previous = client.db.tracking_sessions.find(
      (row) => String(row.id) === String(args.p_session_id))
    if (!previous) throw new Error(`no session ${args.p_session_id}`)
    const version = client.db.tracking_sessions.filter(
      (row) => row.raw_stem === previous.raw_stem).reduce(
      (max, row) => Math.max(max, Number(row.version) || 1), 0) + 1
    const created = {
      ...args.p_payload,
      id: client.db.tracking_sessions.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1,
      version,
      is_active: false,
      replaces_session_id: previous.id,
    }
    client.db.tracking_sessions.push(created)
    return { session_id: created.id, version, replaces: previous.id, session: created }
  })
  client.setRpcHandler('tracker_activate_session_version', (args) => activateVersionModel(client, args))
  return client
}

// The activation itself, separated from the handler that installs it, so a test
// can commit the transaction and then lose the response -- which is a different
// failure from the transaction not happening, and is resumed differently.
function activateVersionModel(client, args) {
  {
    const candidate = client.db.tracking_sessions.find(
      (row) => String(row.id) === String(args.p_session_id))
    if (!candidate) throw new Error(`no session ${args.p_session_id}`)
    if (candidate.status !== 'ingested') {
      throw new Error('only a finished ingest replaces a finished ingest')
    }
    const previous = client.db.tracking_sessions.find(
      (row) => row.raw_stem === candidate.raw_stem && row.is_active !== false && row.id !== candidate.id)
    if (previous) {
      previous.is_active = false
      previous.superseded_by = candidate.id
    }
    candidate.is_active = true
    // The official links move WITH the pointer, in the real function's own
    // single transaction. Modelled here only so these tests can assert that
    // the ingest staged them rather than writing them as it went -- the
    // transaction itself is tested in tests/tracker-session-replacement.test.mjs.
    const plays = client.db.tracking_plays.filter(
      (row) => String(row.tracking_session_id) === String(candidate.id))
    for (const play of plays) {
      for (const pa of client.db.plate_appearances || []) {
        if (String(pa.id) !== String(play.pa_id)) continue
        pa.tracking_session_id = candidate.id
        pa.tracking_contact_frame = play.contact_frame
      }
      for (const table of ['runner_opportunities', 'double_play_opportunities']) {
        for (const row of client.db[table] || []) {
          if (String(row.pa_id) === String(play.pa_id)) row.tracking_play_id = play.id
        }
      }
    }
    for (const measured of args.p_official_links?.runner_opportunities || []) {
      const row = (client.db.runner_opportunities || []).find(
        (entry) => String(entry.id) === String(measured.id))
      if (row) Object.assign(row, measured)
    }
    return {
      activated: true,
      session_id: candidate.id,
      superseded: previous?.id ?? null,
      runner_opportunities_measured: (args.p_official_links?.runner_opportunities || []).length,
    }
  }
}

test('a changed replacement is built beside the completed session and takes over at the end', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-ingest-version-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixture(dir, { playCount: 2 })
  const client = installSessionVersioning(createTrackerFakeSupabase(initialTables()))
  const first = await ingestPlayerTrackingSession(client, { session: stem, recompute: false, warn: () => {} })
  assert.equal(client.db.tracking_plays.length, 2)

  // A re-derivation of the same capture that produces a different play stream.
  const rederived = fs.readFileSync(`${stem}.plays.jsonl`, 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line))
  fs.writeFileSync(`${stem}.plays.jsonl`, rederived
    .map((play, index) => JSON.stringify({ ...play, contact_timer: 500 + index }))
    .join('\n'))

  const replacement = await ingestPlayerTrackingSession(
    installSessionVersioning(client.restart()),
    { session: stem, recompute: false, warn: () => {} },
  )
  assert.notEqual(String(replacement.trackingSessionId), String(first.trackingSessionId))
  assert.equal(String(replacement.replacedSessionId), String(first.trackingSessionId))

  const sessions = client.db.tracking_sessions
  assert.equal(sessions.length, 2, 'the previous version is kept, not deleted')
  const previous = sessions.find((row) => String(row.id) === String(first.trackingSessionId))
  const current = sessions.find((row) => String(row.id) === String(replacement.trackingSessionId))
  assert.equal(previous.is_active, false)
  assert.equal(previous.status, 'ingested', 'the superseded version is still a good ingest')
  assert.equal(current.is_active, true)
  assert.equal(current.status, 'ingested')
  // Both trees survive: nothing was deleted to make room for the replacement.
  assert.equal(client.db.tracking_plays.filter(
    (row) => String(row.tracking_session_id) === String(previous.id)).length, 2)
  assert.equal(client.db.tracking_plays.filter(
    (row) => String(row.tracking_session_id) === String(current.id)).length, 2)
})

// Season game 2814: a plate appearance written out of order left six plays
// unjoined, and after renumbering it the same files re-ingested as "already
// complete". The join reads the plate appearances, which the checksum cannot see.
test('an explicit replace rebuilds an unchanged capture against corrected plate appearances', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-ingest-replace-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixture(dir)
  const client = installSessionVersioning(createTrackerFakeSupabase(initialTables()))
  const first = await ingestPlayerTrackingSession(client, { session: stem, recompute: false, warn: () => {} })
  const unchanged = await ingestPlayerTrackingSession(installSessionVersioning(client.restart()),
    { session: stem, recompute: false, warn: () => {} })
  assert.equal(unchanged.alreadyComplete, true)

  const replaced = await ingestPlayerTrackingSession(installSessionVersioning(client.restart()), {
    session: stem, recompute: false, replace: true, warn: () => {},
  })
  assert.equal(replaced.status, 'ingested')
  assert.equal(String(replaced.replacedSessionId), String(first.trackingSessionId))
  const active = client.db.tracking_sessions.filter((row) => row.is_active)
  assert.deepEqual(active.map((row) => String(row.id)), [String(replaced.trackingSessionId)])
})

test('a replacement that fails halfway leaves the previous version active', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-ingest-version-fail-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixture(dir, { playCount: 2 })
  const client = installSessionVersioning(createTrackerFakeSupabase(initialTables()))
  const first = await ingestPlayerTrackingSession(client, { session: stem, recompute: false, warn: () => {} })

  const rederived = fs.readFileSync(`${stem}.plays.jsonl`, 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line))
  fs.writeFileSync(`${stem}.plays.jsonl`, rederived
    .map((play, index) => JSON.stringify({ ...play, contact_timer: 700 + index }))
    .join('\n'))

  const failing = installSessionVersioning(client.restart({
    failures: [{ table: 'tracking_plays', action: 'insert', mode: 'before', times: 50 }],
  }))
  await assert.rejects(
    ingestPlayerTrackingSession(failing, { session: stem, recompute: false, warn: () => {} }),
  )
  const previous = client.db.tracking_sessions.find(
    (row) => String(row.id) === String(first.trackingSessionId))
  // Not `=== true`: a first ingest never sets the flag, and in Postgres the
  // column defaults to true. "Not deactivated" is the claim being made.
  assert.notEqual(previous.is_active, false, 'the good session never stopped being the active one')
  assert.equal(previous.status, 'ingested')
  assert.equal(client.db.tracking_plays.filter(
    (row) => String(row.tracking_session_id) === String(previous.id)).length, 2,
  'and it still has every one of its facts')
  const opened = client.db.tracking_sessions.find(
    (row) => String(row.id) !== String(first.trackingSessionId))
  assert.equal(opened.is_active, false, 'the half-built replacement is inert')
  assert.notEqual(opened.status, 'ingested')
})

test('malformed and quarantined replacements leave existing good data untouched', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-ingest-bad-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixture(dir)
  const client = createTrackerFakeSupabase(initialTables())
  await ingestPlayerTrackingSession(client, { session: stem, recompute: false, warn: () => {} })
  fs.writeFileSync(`${stem}.plays.jsonl`, '{not json}\n')
  await assert.rejects(ingestPlayerTrackingSession(client.restart(), { session: stem, recompute: false, warn: () => {} }), /Unexpected token|property name/)
  assert.equal(client.db.tracking_sessions[0].status, 'ingested')
  assert.equal(client.db.tracking_plays.length, 1)

  writeFixture(dir, { quarantined: true })
  const result = await ingestPlayerTrackingSession(client.restart(), { session: stem, recompute: false, warn: () => {} })
  assert.equal(result.alreadyComplete, true)
  assert.equal(client.db.tracking_sessions[0].status, 'ingested')
  assert.equal(client.db.tracking_plays.length, 1)
})

test('a replacement stages its official links instead of writing them as it goes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-ingest-stage-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixture(dir)
  const tables = initialTables()
  tables.runner_opportunities = [{
    id: 900, competition_type: 'tournament', game_id: 12, pa_id: 50,
    origin_base: 'first', target_base: 'second', tracking_play_id: null, runner_speed_mps: null,
  }]
  tables.double_play_opportunities = [{
    id: 901, competition_type: 'tournament', game_id: 12, pa_id: 50, tracking_play_id: null,
  }]
  const client = installSessionVersioning(createTrackerFakeSupabase(tables))
  const first = await ingestPlayerTrackingSession(client, { session: stem, recompute: false, warn: () => {} })
  const firstPlayId = client.db.tracking_plays[0].id
  assert.equal(String(client.db.plate_appearances[0].tracking_session_id), String(first.trackingSessionId))
  assert.equal(String(client.db.runner_opportunities[0].tracking_play_id), String(firstPlayId))

  // A re-derivation, ingested by a client whose tracking_plays insert fails
  // partway: the replacement never reaches activation.
  const rederived = JSON.parse(fs.readFileSync(`${stem}.plays.jsonl`, 'utf8').trim())
  fs.writeFileSync(`${stem}.plays.jsonl`, JSON.stringify({ ...rederived, contact_timer: 900 }))
  const failing = installSessionVersioning(client.restart({
    failures: [{ table: 'fielding_opportunities', action: 'insert', mode: 'before', times: 50 }],
  }))
  await assert.rejects(ingestPlayerTrackingSession(failing, { session: stem, recompute: false, warn: () => {} }))

  // BOTH halves of "the previous valid session survives": its facts, and every
  // official row that points at it.
  assert.equal(String(client.db.plate_appearances[0].tracking_session_id), String(first.trackingSessionId))
  assert.equal(Number(client.db.plate_appearances[0].tracking_contact_frame), 100)
  assert.equal(String(client.db.runner_opportunities[0].tracking_play_id), String(firstPlayId))
  assert.equal(String(client.db.double_play_opportunities[0].tracking_play_id), String(firstPlayId))
})

test('a successful replacement moves the official links exactly once, at the end', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-ingest-relink-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixture(dir)
  const tables = initialTables()
  tables.runner_opportunities = [{
    id: 900, competition_type: 'tournament', game_id: 12, pa_id: 50,
    origin_base: 'first', target_base: 'second', tracking_play_id: null, runner_speed_mps: null,
  }]
  const client = installSessionVersioning(createTrackerFakeSupabase(tables))
  const first = await ingestPlayerTrackingSession(client, { session: stem, recompute: false, warn: () => {} })

  const rederived = JSON.parse(fs.readFileSync(`${stem}.plays.jsonl`, 'utf8').trim())
  fs.writeFileSync(`${stem}.plays.jsonl`, JSON.stringify({ ...rederived, contact_timer: 901 }))
  const replacement = await ingestPlayerTrackingSession(
    installSessionVersioning(client.restart()),
    { session: stem, recompute: false, warn: () => {} },
  )
  assert.notEqual(String(replacement.trackingSessionId), String(first.trackingSessionId))
  const newPlay = client.db.tracking_plays.find(
    (row) => String(row.tracking_session_id) === String(replacement.trackingSessionId))
  assert.equal(String(client.db.plate_appearances[0].tracking_session_id), String(replacement.trackingSessionId))
  assert.equal(Number(client.db.plate_appearances[0].tracking_contact_frame), 901)
  assert.equal(String(client.db.runner_opportunities[0].tracking_play_id), String(newPlay.id))
  // One row per play per version, and one official link. Nothing counted twice.
  assert.equal(client.db.tracking_plays.length, 2)
  assert.equal(client.db.runner_opportunities.length, 1)
})

test('a restart mid-replacement resumes that version instead of opening another', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-ingest-resume-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixture(dir)
  const client = installSessionVersioning(createTrackerFakeSupabase(initialTables()))
  const first = await ingestPlayerTrackingSession(client, { session: stem, recompute: false, warn: () => {} })

  const rederived = JSON.parse(fs.readFileSync(`${stem}.plays.jsonl`, 'utf8').trim())
  fs.writeFileSync(`${stem}.plays.jsonl`, JSON.stringify({ ...rederived, contact_timer: 902 }))
  const failing = installSessionVersioning(client.restart({
    failures: [{ table: 'fielding_opportunities', action: 'insert', mode: 'before', times: 50 }],
  }))
  await assert.rejects(ingestPlayerTrackingSession(failing, { session: stem, recompute: false, warn: () => {} }))
  assert.equal(client.db.tracking_sessions.length, 2, 'version 2 was opened and left unfinished')

  const warnings = []
  const resumed = await ingestPlayerTrackingSession(
    installSessionVersioning(client.restart()),
    { session: stem, recompute: false, warn: (message) => warnings.push(String(message)) },
  )
  assert.equal(client.db.tracking_sessions.length, 2,
    'the second attempt finishes version 2 rather than opening version 3')
  assert.equal(Number(resumed.trackingSessionId),
    Number(client.db.tracking_sessions.find((row) => Number(row.version) === 2).id))
  assert.ok(warnings.some((message) => /resuming the unfinished replacement version 2/.test(message)))
  assert.equal(String(client.db.plate_appearances[0].tracking_session_id), String(resumed.trackingSessionId))
  assert.notEqual(String(resumed.trackingSessionId), String(first.trackingSessionId))
})

test('advanced metrics are recomputed only once the replacement is the active version', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-ingest-recompute-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixture(dir)
  const client = installSessionVersioning(createTrackerFakeSupabase(initialTables()))
  await ingestPlayerTrackingSession(client, { session: stem, recompute: false, warn: () => {} })

  const rederived = JSON.parse(fs.readFileSync(`${stem}.plays.jsonl`, 'utf8').trim())
  fs.writeFileSync(`${stem}.plays.jsonl`, JSON.stringify({ ...rederived, contact_timer: 903 }))
  const seenAtRecompute = []
  await ingestPlayerTrackingSession(installSessionVersioning(client.restart()), {
    session: stem,
    warn: () => {},
    recomputeFn: async (supabase) => {
      // Model inputs are read here. If this ran before activation it would
      // model the OLD version's facts and leave the new version unmodelled --
      // or, worse, model both versions of the same play at once.
      const { data } = await supabase.from('tracking_sessions').select('*')
      seenAtRecompute.push(data.filter((row) => row.is_active !== false).map((row) => Number(row.version)))
      return { modelVersion: 'test' }
    },
  })
  assert.deepEqual(seenAtRecompute, [[2]],
    'recomputation ran once, after the replacement became the active version')
})

test('a replacement whose recomputation fails is finished by the retry, not declared complete', async (t) => {
  // THE REPRODUCTION. A replacement is marked ingested and ACTIVATED before it
  // is recomputed, because recomputation has to read the version that is
  // active. When the recomputation then failed, the next run found a session
  // that was ingested, active, and carrying exactly the fact counts the input
  // expected -- so it returned alreadyComplete and recomputed NOTHING, forever.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-ingest-resume-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixture(dir)
  const client = installSessionVersioning(createTrackerFakeSupabase(initialTables()))
  await ingestPlayerTrackingSession(client, { session: stem, recompute: false, warn: () => {} })

  const rederived = JSON.parse(fs.readFileSync(`${stem}.plays.jsonl`, 'utf8').trim())
  fs.writeFileSync(`${stem}.plays.jsonl`, JSON.stringify({ ...rederived, contact_timer: 903 }))
  await assert.rejects(ingestPlayerTrackingSession(installSessionVersioning(client.restart()), {
    session: stem,
    warn: () => {},
    recomputeFn: async () => { throw new Error('injected recomputation failure') },
  }), /advanced-metric recomputation failed/)

  const active = client.db.tracking_sessions.find((row) => row.is_active !== false)
  assert.equal(Number(active.version), 2, 'the replacement is the active version')
  assert.equal(active.quality.derived_stage, 'recompute', 'and it owes a recomputation')

  const playsBefore = client.db.tracking_plays.length
  let recomputations = 0
  const retry = await ingestPlayerTrackingSession(installSessionVersioning(client.restart()), {
    session: stem,
    warn: () => {},
    recomputeFn: async () => { recomputations += 1; return { modelVersion: 'test' } },
  })
  assert.equal(recomputations, 1, 'the retry finishes the work the failure left behind')
  assert.equal(retry.resumedStage, 'recompute')
  assert.deepEqual(retry.modelSummary, { modelVersion: 'test' })
  assert.equal(client.db.tracking_plays.length, playsBefore, 'the raw facts are preserved, not reimported')
  assert.equal(client.db.tracking_sessions.length, 2, 'and no third version was opened')
  assert.equal(client.db.tracking_sessions.find((row) => row.is_active !== false).quality.derived_stage, null)
})

test('a lost activation response is resumed rather than re-ingested', async (t) => {
  // The activation moves the pointer AND the official links in one transaction,
  // so a REPLACEMENT that is active has already applied them -- what was lost
  // is the response, not the work. (Only a replacement: a first ingest's
  // session is active before activation is ever called, which is what the two
  // tests at the end of this file are about.) The stage says so, and the retry
  // finishes from there instead of rebuilding the version.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-ingest-lost-activation-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixture(dir)
  const client = installSessionVersioning(createTrackerFakeSupabase(initialTables()))
  await ingestPlayerTrackingSession(client, { session: stem, recompute: false, warn: () => {} })

  const rederived = JSON.parse(fs.readFileSync(`${stem}.plays.jsonl`, 'utf8').trim())
  fs.writeFileSync(`${stem}.plays.jsonl`, JSON.stringify({ ...rederived, contact_timer: 907 }))
  const lossy = installSessionVersioning(client.restart())
  lossy.setRpcHandler('tracker_activate_session_version', (args) => {
    // The transaction commits; the answer never arrives.
    activateVersionModel(lossy, args)
    return { data: null, error: { code: '08006', message: 'connection reset' } }
  })

  // PostgREST hands the failure back as { code, message }, and the ingest
  // rethrows it as it arrived.
  await assert.rejects(ingestPlayerTrackingSession(lossy, { session: stem, warn: () => {} }),
    (error) => error?.code === '08006')
  const active = client.db.tracking_sessions.find((row) => row.is_active !== false)
  assert.equal(Number(active.version), 2, 'the activation itself committed')
  assert.equal(active.quality.derived_stage, 'activate', 'and the run never got to say so')

  const playsBefore = client.db.tracking_plays.length
  let recomputations = 0
  const retry = await ingestPlayerTrackingSession(installSessionVersioning(client.restart()), {
    session: stem,
    warn: () => {},
    recomputeFn: async () => { recomputations += 1; return { modelVersion: 'test' } },
  })
  assert.equal(retry.resumedStage, 'activate')
  assert.equal(recomputations, 1, 'and carries on to the stage after it')
  assert.equal(client.db.tracking_plays.length, playsBefore, 'without reimporting a single play')
  assert.equal(client.db.tracking_sessions.length, 2, 'and without opening another version')
  assert.equal(client.db.tracking_sessions.find((row) => row.is_active !== false).quality.derived_stage, null)
})

test('a retry promotes raw_ingested before activating the saved facts', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-ingest-status-resume-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixture(dir)
  const client = installSessionVersioning(createTrackerFakeSupabase(initialTables(), {
    failures: [{ table: 'tracking_sessions', action: 'update', mode: 'before',
      when: ({ payload }) => payload?.status === 'ingested', times: 1 }],
  }))
  await assert.rejects(ingestPlayerTrackingSession(client, {
    session: stem, recompute: false, warn: () => {},
  }), (error) => error?.message === 'failure before write')
  assert.equal(client.db.tracking_sessions[0].status, 'raw_ingested')
  assert.equal(client.db.tracking_sessions[0].quality.derived_stage, 'activate')

  const playCount = client.db.tracking_plays.length
  await ingestPlayerTrackingSession(installSessionVersioning(client.restart()), {
    session: stem, recompute: false, warn: () => {},
  })
  assert.equal(client.db.tracking_sessions[0].status, 'ingested')
  assert.equal(client.db.tracking_sessions[0].quality.derived_stage, null)
  assert.equal(client.db.tracking_plays.length, playCount)
})

test('a first ingest applies its official links through the fenced function too', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-ingest-first-links-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixture(dir)
  const client = installSessionVersioning(createTrackerFakeSupabase(initialTables()))
  await ingestPlayerTrackingSession(client, {
    session: stem, recompute: false, warn: () => {},
    lease: { ownerId: 'bridge-a', epoch: 3 },
  })
  const calls = client.rpcCalls.filter((call) => call.name === 'tracker_activate_session_version')
  assert.equal(calls.length, 1,
    'the plate appearance pointer and the opportunity links are one fenced transaction, '
    + 'not an unfenced update per play')
  assert.equal(calls[0].args.p_owner_id, 'bridge-a')
  assert.equal(Number(calls[0].args.p_epoch), 3)
  assert.equal(client.db.plate_appearances[0].tracking_session_id, client.db.tracking_sessions[0].id)
})

test('a database with no versioning function still links a first ingest, the old way', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-ingest-unversioned-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixture(dir)
  // No session-versioning handlers at all: the migration has not been applied.
  const client = createTrackerFakeSupabase(initialTables())
  const summary = await ingestPlayerTrackingSession(client, {
    session: stem, recompute: false, warn: () => {},
  })
  assert.equal(summary.status, 'ingested')
  assert.equal(client.db.plate_appearances[0].tracking_session_id, client.db.tracking_sessions[0].id,
    'the links are written directly, because there is no transaction to put them in')
  assert.equal(client.db.tracking_sessions[0].quality.derived_stage, null)
})

// ── a first ingest's derived half ───────────────────────────────────────────
//
// THE DEFECT. resumeDerivedWork retried the activation with an EMPTY runner
// measurement list, on the reasoning that a session which is active has already
// applied its official links. That holds for a replacement and not for a first
// ingest, whose session is the active one before activation is ever called. So
// a first ingest whose activation failed before it committed was retried with
// nothing to apply, answered `activated`, and had its stage cleared -- losing
// the measured runner kinematics permanently, which is the one part of the
// links the transaction cannot re-derive for itself.

// A play with a runner on first and a throw to second, so the ingest has
// measurements to stage rather than only links it could re-derive.
function writeFixtureWithRunner(dir) {
  const stem = writeFixture(dir)
  const play = JSON.parse(fs.readFileSync(`${stem}.plays.jsonl`, 'utf8').trim())
  play.runners.R1 = {
    character_id: 2, start: [17, 0, 29], end: [30, 0, 30], path_units: 14, sprint_speed_ups: 8,
  }
  play.throws[0].target_base = 'second'
  fs.writeFileSync(`${stem}.plays.jsonl`, JSON.stringify(play))
  return stem
}

function tablesWithRunnerOpportunity() {
  const tables = initialTables()
  tables.runner_opportunities.push({
    id: 91, competition_type: 'tournament', game_id: 12, pa_id: 50,
    origin_base: 'first', target_base: 'second',
  })
  return tables
}

test('a first ingest whose activation never committed is retried with its measurements', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-ingest-first-activate-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixtureWithRunner(dir)
  const client = installSessionVersioning(createTrackerFakeSupabase(tablesWithRunnerOpportunity()))

  let staged = null
  const refuseActivation = (target) => target.setRpcHandler(
    'tracker_activate_session_version', (args) => {
      staged = args.p_official_links
      return { data: null, error: { code: '57014', message: 'statement timeout' } }
    })
  refuseActivation(client)
  await assert.rejects(
    ingestPlayerTrackingSession(client, { session: stem, recompute: false, warn: () => {} }),
    (error) => error?.code === '57014')

  assert.deepEqual(staged.runner_opportunities, [{
    id: 91, runner_x: 17, runner_z: 29, runner_speed_mps: 8,
    tracking_throw_id: client.db.tracking_throws[0].id,
    // The opportunity carried no responsible fielder, so the pass also stages
    // the fielder who first secured the ball.
    responsible_fielder_player_id: 'def-owner',
    responsible_fielder_character_id: 31,
    responsible_fielder_position: '1',
  }], 'the first attempt did stage the measurements; the transaction is what failed')
  const session = client.db.tracking_sessions[0]
  assert.equal(session.is_active !== false, true,
    'and the session is active anyway -- a first ingest always is, which is why '
    + 'is_active proves nothing about the links')
  assert.equal(session.quality.derived_stage, 'activate')
  assert.equal(client.db.runner_opportunities[0].runner_x, undefined,
    'nothing measured landed')

  // A retry that is refused again leaves the stage exactly where it was: the
  // work is what clears it, never the attempt.
  const stillFailing = installSessionVersioning(client.restart())
  refuseActivation(stillFailing)
  await assert.rejects(
    ingestPlayerTrackingSession(stillFailing, { session: stem, recompute: false, warn: () => {} }),
    (error) => error?.code === '57014')
  assert.equal(client.db.tracking_sessions[0].quality.derived_stage, 'activate',
    'still owed, and still resumable')

  const playsBefore = client.db.tracking_plays.length
  const retry = await ingestPlayerTrackingSession(installSessionVersioning(client.restart()), {
    session: stem, recompute: false, warn: () => {},
  })
  assert.equal(retry.resumedStage, 'activate')
  const applied = client.rpcCalls.filter(
    (call) => call.name === 'tracker_activate_session_version').at(-1)
  assert.deepEqual(applied.args.p_official_links.runner_opportunities,
    staged.runner_opportunities,
    'the resumed activation carries the same measurements the lost one did, '
    + 'rebuilt from the raw facts rather than remembered')
  assert.deepEqual(client.db.runner_opportunities[0], {
    id: 91, competition_type: 'tournament', game_id: 12, pa_id: 50,
    origin_base: 'first', target_base: 'second',
    tracking_play_id: client.db.tracking_plays[0].id,
    runner_x: 17, runner_z: 29, runner_speed_mps: 8,
    tracking_throw_id: client.db.tracking_throws[0].id,
  })
  assert.equal(client.db.tracking_plays.length, playsBefore, 'and no play was re-ingested')
  assert.equal(client.db.tracking_sessions.length, 1, 'nor any version opened')
  assert.equal(client.db.tracking_sessions[0].quality.derived_stage, null,
    'only now is the stage cleared')
})

test('a first ingest whose direct official-link writes failed is finished by the retry', async (t) => {
  // The same failure on a database with no versioning function, where the links
  // are written one update at a time. The resume used to call an activation
  // that is not there, get null back, ignore it, and clear the stage -- so the
  // plate appearance never got its tracking pointer at all.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-ingest-unversioned-resume-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixtureWithRunner(dir)
  const client = createTrackerFakeSupabase(tablesWithRunnerOpportunity(), {
    failures: [{ table: 'plate_appearances', action: 'update', mode: 'before', times: 3 }],
  })
  await assert.rejects(
    ingestPlayerTrackingSession(client, { session: stem, recompute: false, warn: () => {} }))
  assert.equal(client.db.tracking_sessions[0].quality.derived_stage, 'activate')
  assert.equal(client.db.plate_appearances[0].tracking_session_id, undefined,
    'the pointer never landed')

  const retry = await ingestPlayerTrackingSession(client.restart(), {
    session: stem, recompute: false, warn: () => {},
  })
  assert.equal(retry.resumedStage, 'activate')
  assert.equal(client.db.plate_appearances[0].tracking_session_id, client.db.tracking_sessions[0].id,
    'the direct writes are finished rather than skipped')
  assert.equal(client.db.plate_appearances[0].tracking_contact_frame, 100)
  assert.equal(client.db.runner_opportunities[0].runner_speed_mps, 8,
    'measurements included')
  assert.equal(client.db.runner_opportunities[0].tracking_play_id, client.db.tracking_plays[0].id)
  assert.equal(client.db.tracking_sessions[0].quality.derived_stage, null)
})

// ── Live tracking facts ──────────────────────────────────────────────────────
//
// The bridge writes each joined play during the game into a `live` session
// version, through the same row writer the postgame ingest uses, and the
// postgame ingest replaces that version.

function fixturePlays(stem) {
  return fs.readFileSync(`${stem}.plays.jsonl`, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
}

function liveWriter(client, logs = []) {
  return createLiveTrackingPersistence({
    supabase: client, competitionType: 'tournament', gameId: 12, sourceId: 3,
    log: (message) => logs.push(message),
  })
}

const joinedToFirstPa = () => ({ status: 'joined', pa_number: 1 })

test('live facts are written once per joined play, and only once its plate appearance is saved', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-live-write-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixture(dir, { playCount: 2 })
  const [fair, second] = fixturePlays(stem)
  const foul = { ...second, batted_ball_class: 'foul', fair_or_foul: 'foul' }
  const client = installSessionVersioning(createTrackerFakeSupabase(initialTables()))
  const writer = liveWriter(client)
  const joins = new Map([[fair.contact_timer, { status: 'joined', pa_number: 1 }]])
  const saved = new Map()
  const sync = () => writer.sync({
    stem,
    capture: { frames: 600, missed_frames: 0 },
    plays: [fair, foul],
    joinFor: (play) => joins.get(play.contact_timer) || { status: 'pending' },
    plateAppearanceFor: (paNumber) => saved.get(paNumber),
  })

  assert.equal((await sync()).written, 0, 'a fair ball waits for its plate appearance')
  assert.equal(client.db.tracking_sessions.length, 0, 'and no session is opened for nothing')

  saved.set(1, client.db.plate_appearances[0])
  joins.set(foul.contact_timer, { status: 'joined', pa_number: 1 })
  assert.equal((await sync()).written, 2)
  assert.equal((await sync()).written, 0, 'a play is written once')

  const [session] = client.db.tracking_sessions
  assert.equal(session.status, 'live')
  assert.equal(client.db.tracking_plays.length, 2)
  const byFrame = new Map(client.db.tracking_plays.map((row) => [row.contact_frame, row]))
  assert.equal(byFrame.get(fair.contact_timer).pa_id, 50)
  assert.equal(byFrame.get(foul.contact_timer).pa_id, null, 'a foul is never the at-bat outcome')
  assert.equal(client.db.fielding_opportunities.length, 4)
  assert.equal(client.db.movement_metrics.length, 6)
  assert.equal(client.db.tracking_throws.length, 2)
  assert.equal(client.db.plate_appearances[0].tracking_session_id, undefined,
    'official links wait for the fenced postgame activation')
})

test('a live writer stops at the quarantine threshold', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-live-threshold-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixture(dir)
  const client = installSessionVersioning(createTrackerFakeSupabase(initialTables()))
  const result = await liveWriter(client).sync({
    stem, capture: { frames: 900, missed_frames: 100 }, plays: fixturePlays(stem),
    joinFor: joinedToFirstPa, plateAppearanceFor: () => client.db.plate_appearances[0],
  })
  assert.equal(result.written, 0)
  assert.equal(client.db.tracking_plays.length, 0)
})

test('the postgame ingest supersedes the live version and readers see only the postgame facts', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-live-replace-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixture(dir, { playCount: 2 })
  const plays = fixturePlays(stem)
  const client = installSessionVersioning(createTrackerFakeSupabase(initialTables()))
  const writer = liveWriter(client)
  await writer.sync({
    stem, capture: {}, plays: [plays[0]],
    joinFor: joinedToFirstPa, plateAppearanceFor: () => client.db.plate_appearances[0],
  })
  const liveId = writer.sessionId
  assert.ok(liveId)

  const postgame = await ingestPlayerTrackingSession(
    installSessionVersioning(client.restart()), { session: stem, recompute: false, warn: () => {} })
  assert.equal(String(postgame.replacedSessionId), String(liveId), 'a live version is replaced whatever its checksum')
  const live = client.db.tracking_sessions.find((row) => String(row.id) === String(liveId))
  const current = client.db.tracking_sessions.find((row) => String(row.id) === String(postgame.trackingSessionId))
  assert.equal(live.is_active, false)
  assert.equal(current.is_active, true)
  assert.equal(current.status, 'ingested')

  const excluded = supersededTrackingPlayIds(client.db.tracking_sessions, client.db.tracking_plays)
  const visible = onlyActiveTrackingFacts(client.db.fielding_opportunities, excluded)
  assert.equal(visible.length, 4, 'two postgame plays of two fielders, and no live duplicates')

  // A bridge restarted after the postgame pass writes nothing more.
  const lateWriter = liveWriter(client.restart())
  const result = await lateWriter.sync({
    stem, capture: {}, plays,
    joinFor: joinedToFirstPa, plateAppearanceFor: () => client.db.plate_appearances[0],
  })
  assert.equal(result.written, 0)
  assert.match(String(lateWriter.disabledReason), /already ingested/)
})

test('a quarantined postgame capture still retires the live version it replaces', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-live-quarantine-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixture(dir)
  const client = installSessionVersioning(createTrackerFakeSupabase(initialTables()))
  const writer = liveWriter(client)
  await writer.sync({
    stem, capture: {}, plays: fixturePlays(stem),
    joinFor: joinedToFirstPa, plateAppearanceFor: () => client.db.plate_appearances[0],
  })
  assert.equal(client.db.tracking_plays.length, 1)
  writeFixture(dir, { quarantined: true })
  const postgame = await ingestPlayerTrackingSession(
    installSessionVersioning(client.restart()), { session: stem, recompute: false, warn: () => {} })
  assert.equal(postgame.status, 'quarantined')
  const live = client.db.tracking_sessions.find((row) => String(row.id) === String(writer.sessionId))
  const current = client.db.tracking_sessions.find((row) => String(row.id) === String(postgame.trackingSessionId))
  assert.equal(live.is_active, false, 'the live facts from the failed capture are no longer active')
  assert.equal(current.is_active, true)
  assert.equal(current.status, 'quarantined')
  const excluded = supersededTrackingPlayIds(client.db.tracking_sessions, client.db.tracking_plays)
  assert.equal(onlyActiveTrackingFacts(client.db.fielding_opportunities, excluded).length, 0)
})

test('live facts are not written to a database that cannot supersede them', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-live-legacy-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixture(dir)
  const client = createTrackerFakeSupabase(initialTables())
  const legacy = {
    from(table) {
      if (table !== 'tracking_sessions') return client.from(table)
      return {
        select: () => ({
          limit: async () => ({
            data: null,
            error: { code: '42703', message: 'column tracking_sessions.is_active does not exist' },
          }),
        }),
      }
    },
  }
  const writer = liveWriter(legacy)
  const result = await writer.sync({
    stem, capture: {}, plays: fixturePlays(stem),
    joinFor: joinedToFirstPa, plateAppearanceFor: () => client.db.plate_appearances[0],
  })
  assert.equal(result.written, 0)
  assert.match(String(writer.disabledReason), /does not version tracking sessions/)
  assert.equal(client.db.tracking_plays.length, 0)
})

test('a live catch is scored against the other games already in the database', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-live-model-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixture(dir)
  const [play] = fixturePlays(stem)
  // The fixture's catch, given a distance and a hang time so it is modelled,
  // and four earlier chances in the same bucket in another game: three caught.
  const measured = {
    ...play,
    hang_time_s: 1.2,
    caught_in_flight: true,
    fielders: { ...play.fielders, P: { ...play.fielders.P, distance_to_landing_units: 8 } },
  }
  const tables = initialTables()
  tables.fielding_opportunities = [0, 1, 2, 3].map((index) => ({
    id: 1000 + index, tracking_play_id: 5000 + index, competition_type: 'tournament', game_id: 99,
    position: 'P', is_primary: true, actual_out: index < 3,
    distance_needed_m: 8, opportunity_seconds: 1.2, quality: {},
  }))
  const client = installSessionVersioning(createTrackerFakeSupabase(tables))
  await liveWriter(client).sync({
    stem, capture: {}, plays: [measured],
    joinFor: joinedToFirstPa, plateAppearanceFor: () => client.db.plate_appearances[0],
  })
  const row = client.db.fielding_opportunities.find((entry) => entry.is_primary && entry.game_id === 12)
  assert.equal(row.actual_out, true)
  // Three catches in four chances, shrunk toward the position's own 3/4.
  assert.ok(Math.abs(row.expected_out_probability - 0.75) < 1e-9)
  assert.ok(Math.abs(row.outs_above_average - 0.25) < 1e-9)
  assert.equal(row.star_difficulty, 2)
})

test('a superseded version is finished history, not a replacement to resume', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-superseded-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stem = writeFixture(dir, { competitionType: 'season' })
  const client = installSessionVersioning(createTrackerFakeSupabase(initialTables('season')))

  await ingestPlayerTrackingSession(client, { session: stem, recompute: false, warn: () => {} })
  const second = await ingestPlayerTrackingSession(client, {
    session: stem, recompute: false, replace: true, warn: () => {},
  })
  // A third pass must build v3 beside v2, not reach back past it into v1 --
  // which is also inactive, also 'ingested', and carries the same checksum.
  const third = await ingestPlayerTrackingSession(client, {
    session: stem, recompute: false, replace: true, warn: () => {},
  })
  assert.notEqual(third.trackingSessionId, second.trackingSessionId)
  assert.equal(third.replacedSessionId, second.trackingSessionId)
  assert.equal(third.status, 'ingested')
  const versions = client.db.tracking_sessions
  assert.equal(versions.length, 3)
  assert.equal(versions.filter((row) => row.is_active !== false).length, 1)
  assert.equal(versions.find((row) => row.id === third.trackingSessionId).is_active !== false, true)
})
