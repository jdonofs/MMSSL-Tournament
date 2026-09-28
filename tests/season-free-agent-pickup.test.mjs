// Season free-agent pickups commit as one transaction or not at all.
//
// The page used to make a pickup in three requests and stop at the first
// failure with the earlier ones committed: a failed drop left ten active
// players, a failed waiver insert left the swap applied with no waiver. Every
// test here goes through the page's own client call
// (src/utils/seasonFreeAgentPickup.js) into the real migration applied to
// PGlite, and checks the roster and waivers the database ends up holding.
//
// THE SEASON TABLES ARE A RECONSTRUCTION. tests/fixtures/season-pickup-baseline.sql
// says what it was built from; nothing here is evidence the function runs
// against production's own DDL or RLS.
//
// SERIALIZED, NOT CONCURRENT. PGlite is a single connection, so "two teams
// claim the same free agent" and "the same request twice" run one after the
// other. That proves the function re-validates against committed rows and
// refuses what can no longer apply. It does not prove the advisory locks make
// two simultaneous transactions on a multi-connection PostgreSQL wait for each
// other; that has not been exercised.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createTrackerTestDatabase, databaseAvailable } from './helpers/trackerTestDatabase.mjs'
import { createPgliteSupabase } from './helpers/pgliteSupabase.mjs'
import {
  SEASON_PICKUP_MIGRATION,
  isMissingSeasonPickupFunction,
  submitSeasonFreeAgentPickup,
} from '../src/utils/seasonFreeAgentPickup.js'
import {
  SEASON_TRANSACTION_ADMIN_MIGRATION,
  reverseSeasonFreeAgentPickup,
} from '../src/utils/seasonTransactionAdmin.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SEASON_FIXTURE = path.join(HERE, 'fixtures', 'season-pickup-baseline.sql')

const HAVE_DATABASE = await databaseAvailable()
const skip = HAVE_DATABASE
  ? false
  : 'no local Postgres: @electric-sql/pglite is not installed (npm install)'

const SEASON_ID = 71
const OWNER_AUTH = '00000000-0000-4000-8000-000000000001'
const RIVAL_AUTH = '00000000-0000-4000-8000-000000000002'
const OUTSIDER_AUTH = '00000000-0000-4000-8000-000000000003'

// The first name of each is the captain: the team's earliest drafted row.
const OWNER_ROSTER = ['Mario', 'Luigi', 'Peach', 'Daisy', 'Yoshi', 'Birdo', 'Wario', 'Waluigi', 'Toad']
const RIVAL_ROSTER = ['Bowser', 'Bowser Jr.', 'Donkey Kong', 'Diddy Kong', 'Dixie Kong', 'Funky Kong', 'King Boo', 'Petey Piranha', 'Toadette']
const FREE_AGENTS = ['Boo', 'Dry Bones']
const ON_WAIVERS = 'Blooper'

async function seedRoster(db, teamId, names) {
  const ids = {}
  for (const [index, name] of names.entries()) {
    ids[name] = await db.value(
      `insert into season_roster (season_id, team_id, character_name, acquired_via, is_active, created_at)
       values ($1, $2, $3, 'draft', true, timestamptz '2026-08-11 00:00:00+00' + make_interval(secs => $4))
       returning id`,
      [SEASON_ID, teamId, name, index])
  }
  return ids
}

async function world(t, { migrate = true } = {}) {
  const db = await createTrackerTestDatabase({
    beforeMigrations: (conn) => conn.exec(fs.readFileSync(SEASON_FIXTURE, 'utf8')),
    migrations: migrate ? [
      path.basename(SEASON_PICKUP_MIGRATION),
      path.basename(SEASON_TRANSACTION_ADMIN_MIGRATION),
    ] : [],
  })
  t.after(() => db.close())

  const players = {}
  for (const [name, auth, isCommissioner] of [['pickup-owner', OWNER_AUTH, true], ['pickup-rival', RIVAL_AUTH, false], ['pickup-outsider', OUTSIDER_AUTH, false]]) {
    players[name] = await db.value('insert into players (name, auth_user_id, is_commissioner) values ($1, $2, $3) returning id', [name, auth, isCommissioner])
  }
  for (const name of [...OWNER_ROSTER, ...RIVAL_ROSTER, ...FREE_AGENTS, ON_WAIVERS]) {
    await db.query('insert into characters (name) values ($1)', [name])
  }
  await db.query('insert into seasons (id, name, status) values ($1, $2, $3)', [SEASON_ID, 'TEST', 'active'])
  const ownerTeam = await db.value(
    'insert into season_teams (season_id, player_id, team_name) values ($1, $2, $3) returning id',
    [SEASON_ID, players['pickup-owner'], 'Owners'])
  const rivalTeam = await db.value(
    'insert into season_teams (season_id, player_id, team_name) values ($1, $2, $3) returning id',
    [SEASON_ID, players['pickup-rival'], 'Rivals'])
  const rosterIds = {
    ...await seedRoster(db, ownerTeam, OWNER_ROSTER),
    ...await seedRoster(db, rivalTeam, RIVAL_ROSTER),
  }
  await db.query(
    `insert into season_waivers (season_id, claiming_character, source_team_id, status, expires_at)
     values ($1, $2, $3, 'active', now() + interval '3 days')`,
    [SEASON_ID, ON_WAIVERS, rivalTeam])

  return {
    db,
    supabase: createPgliteSupabase(db),
    ownerTeam,
    rivalTeam,
    rosterIds,
    // What PostgREST does per request: the caller's JWT subject, read by auth.uid().
    as: (authUserId) => db.query("select set_config('request.jwt.claim.sub', $1, false)", [authUserId ?? '']),
  }
}

function pickup(w, { season = SEASON_ID, team = w.ownerTeam, add = 'Boo', drop = 'Toad', dropRosterId } = {}) {
  return submitSeasonFreeAgentPickup(w.supabase, {
    seasonId: season,
    teamId: team,
    addCharacter: add,
    dropRosterId: dropRosterId ?? w.rosterIds[drop],
  })
}

async function snapshot(db) {
  return {
    roster: await db.rows('select id, team_id, character_name, acquired_via, is_active from season_roster order by id'),
    waivers: await db.rows('select id, claiming_character, source_team_id, status, denied_team_ids from season_waivers order by id'),
  }
}

async function activeNames(db, teamId) {
  const rows = await db.rows(
    'select character_name from season_roster where team_id = $1 and is_active is distinct from false order by character_name',
    [teamId])
  return rows.map((row) => row.character_name)
}

test('a pickup adds the free agent, keeps the dropped row as history and puts him on waivers', { skip }, async (t) => {
  const w = await world(t)
  await w.as(OWNER_AUTH)

  const outcome = await pickup(w)
  assert.equal(outcome.ok, true, outcome.message)
  assert.equal(outcome.status, 'applied')

  const active = await activeNames(w.db, w.ownerTeam)
  assert.equal(active.length, 9)
  assert.ok(active.includes('Boo'))
  assert.ok(!active.includes('Toad'))
  assert.deepEqual(
    await w.db.one("select acquired_via, is_active from season_roster where team_id = $1 and character_name = 'Boo'", [w.ownerTeam]),
    { acquired_via: 'free_agent', is_active: true })
  assert.deepEqual(
    await w.db.one('select team_id, is_active from season_roster where id = $1', [w.rosterIds.Toad]),
    { team_id: w.ownerTeam, is_active: false })

  const waivers = await w.db.rows(
    `select source_team_id, status, denied_team_ids,
            expires_at between now() + interval '6 days 23 hours' and now() + interval '7 days 1 hour' as one_week
       from season_waivers where claiming_character = 'Toad'`)
  assert.deepEqual(waivers, [{ source_team_id: w.ownerTeam, status: 'active', denied_team_ids: [], one_week: true }])
  assert.deepEqual(await activeNames(w.db, w.rivalTeam), [...RIVAL_ROSTER].sort())
})

test('a failure at any write leaves the roster and waivers exactly as they were', { skip }, async (t) => {
  const w = await world(t)
  await w.as(OWNER_AUTH)
  await w.db.exec(`
    create function inject_pickup_failure() returns trigger language plpgsql as $$
    begin
      raise exception 'injected failure at %', tg_argv[0];
    end
    $$;`)

  const before = await snapshot(w.db)
  for (const [step, timing, table] of [
    ['the roster insert', 'before insert', 'season_roster'],
    ['the drop', 'before update', 'season_roster'],
    ['the waiver insert', 'before insert', 'season_waivers'],
  ]) {
    await w.db.exec(`create trigger inject_pickup_failure ${timing} on ${table}
                     for each row execute function inject_pickup_failure('${step}')`)
    const outcome = await pickup(w)
    assert.equal(outcome.ok, false, step)
    assert.match(outcome.message, new RegExp(`injected failure at ${step}`))
    assert.deepEqual(await snapshot(w.db), before, `a failure at ${step} left part of the pickup behind`)
    await w.db.exec(`drop trigger inject_pickup_failure on ${table}`)
  }

  assert.equal((await pickup(w)).ok, true, 'the same pickup goes through once nothing is injected')
})

test('a roster that moves under the pickup is refused, never left at ten', { skip }, async (t) => {
  const w = await world(t)
  await w.as(OWNER_AUTH)
  // Stands in for an award landing on this team mid-pickup: the extra row
  // appears between the pre-write count and the commit.
  await w.db.exec(`
    create function inject_concurrent_award() returns trigger language plpgsql as $$
    begin
      insert into season_roster (season_id, team_id, character_name, acquired_via, is_active)
      values (new.season_id, new.source_team_id, 'Dry Bones', 'waiver', true);
      return new;
    end
    $$;
    create trigger inject_concurrent_award after insert on season_waivers
      for each row execute function inject_concurrent_award();`)

  const before = await snapshot(w.db)
  const outcome = await pickup(w)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'roster_changed')
  assert.deepEqual(await snapshot(w.db), before)
})

test('a stale drop target changes nothing', { skip }, async (t) => {
  const w = await world(t)
  await w.as(OWNER_AUTH)

  // A row on another team, as from a page that has not seen a trade.
  let before = await snapshot(w.db)
  let outcome = await pickup(w, { dropRosterId: w.rosterIds.Bowser })
  assert.equal(outcome.reason, 'stale_drop')
  assert.deepEqual(await snapshot(w.db), before)

  // A row this team already dropped, from a page that has not reloaded.
  assert.equal((await pickup(w, { add: 'Boo', drop: 'Toad' })).ok, true)
  before = await snapshot(w.db)
  outcome = await pickup(w, { add: 'Dry Bones', drop: 'Toad' })
  assert.equal(outcome.reason, 'stale_drop')
  assert.deepEqual(await snapshot(w.db), before)
})

test('two teams claiming one free agent: the first gets him, the second changes nothing (serialized)', { skip }, async (t) => {
  const w = await world(t)

  await w.as(OWNER_AUTH)
  assert.equal((await pickup(w, { add: 'Boo', drop: 'Toad' })).ok, true)

  await w.as(RIVAL_AUTH)
  const before = await snapshot(w.db)
  let outcome = await pickup(w, { team: w.rivalTeam, add: 'Boo', drop: 'Toadette' })
  assert.equal(outcome.reason, 'not_free_agent')
  assert.deepEqual(await snapshot(w.db), before)
  assert.equal(await w.db.value("select count(*)::int from season_roster where character_name = 'Boo' and is_active"), 1)

  // A player on an open waiver is claimed, not picked up.
  outcome = await pickup(w, { team: w.rivalTeam, add: ON_WAIVERS, drop: 'Toadette' })
  assert.equal(outcome.reason, 'on_waivers')
  assert.deepEqual(await snapshot(w.db), before)
})

test('unauthorized callers change nothing', { skip }, async (t) => {
  const w = await world(t)
  const before = await snapshot(w.db)

  await w.as(null)
  assert.equal((await pickup(w)).reason, 'not_authenticated')
  await w.as(OUTSIDER_AUTH)
  assert.equal((await pickup(w)).reason, 'not_team_owner')
  await w.as(RIVAL_AUTH)
  assert.equal((await pickup(w)).reason, 'not_team_owner')
  await w.as(OWNER_AUTH)
  assert.equal((await pickup(w, { season: SEASON_ID + 1 })).reason, 'team_not_in_season')

  assert.deepEqual(await snapshot(w.db), before)
})

test('the function is executable by signed-in users and not by anon', { skip }, async (t) => {
  const w = await world(t)
  await w.as(OWNER_AUTH)
  const before = await snapshot(w.db)

  await w.db.exec('set role anon')
  const refused = await pickup(w)
  await w.db.exec('reset role')
  assert.equal(refused.ok, false)
  assert.equal(refused.reason, '42501')
  assert.deepEqual(await snapshot(w.db), before)

  await w.db.exec('set role authenticated')
  const allowed = await pickup(w)
  await w.db.exec('reset role')
  assert.equal(allowed.ok, true, allowed.message)
})

test('submitting the same pickup twice applies it once', { skip }, async (t) => {
  const w = await world(t)
  await w.as(OWNER_AUTH)

  const first = await pickup(w)
  const second = await pickup(w)
  assert.equal(first.status, 'applied')
  assert.equal(second.ok, true)
  assert.equal(second.status, 'already_applied')

  assert.equal((await activeNames(w.db, w.ownerTeam)).length, 9)
  assert.equal(await w.db.value("select count(*)::int from season_roster where character_name = 'Boo'"), 1)
  assert.equal(await w.db.value("select count(*)::int from season_waivers where claiming_character = 'Toad'"), 1)
})

test('the captain and a roster that is not nine are refused inside the transaction', { skip }, async (t) => {
  const w = await world(t)
  await w.as(OWNER_AUTH)

  let before = await snapshot(w.db)
  assert.equal((await pickup(w, { drop: 'Mario' })).reason, 'captain_protected')
  assert.deepEqual(await snapshot(w.db), before)

  await w.db.query(
    "insert into season_roster (season_id, team_id, character_name, acquired_via, is_active) values ($1, $2, 'Dry Bones', 'free_agent', true)",
    [SEASON_ID, w.ownerTeam])
  before = await snapshot(w.db)
  assert.equal((await pickup(w)).reason, 'roster_not_nine')
  assert.deepEqual(await snapshot(w.db), before)
})

test('without the migration the page gets a migration error and nothing is written', { skip }, async (t) => {
  const w = await world(t, { migrate: false })
  await w.as(OWNER_AUTH)
  const before = await snapshot(w.db)

  const outcome = await pickup(w)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'migration_missing')
  assert.ok(outcome.message.includes(SEASON_PICKUP_MIGRATION))
  assert.deepEqual(await snapshot(w.db), before)

  // PostgREST's own wording for the same condition.
  assert.equal(isMissingSeasonPickupFunction({
    code: 'PGRST202',
    message: 'Could not find the function public.season_free_agent_pickup(p_add_character, p_drop_roster_id, p_season_id, p_team_id) in the schema cache',
  }), true)
})

test('a commissioner can reverse a pickup and remove all of its transaction history', { skip }, async (t) => {
  const w = await world(t)
  await w.as(OWNER_AUTH)

  const pickupOutcome = await pickup(w)
  assert.equal(pickupOutcome.ok, true, pickupOutcome.message)
  const addedRosterId = pickupOutcome.result.added.id
  const waiverId = pickupOutcome.result.waiver.id
  await w.db.query(
    `insert into season_waiver_claims
       (waiver_id, season_id, claiming_team_id, dropping_character, priority_order, status)
     values ($1, $2, $3, 'Luigi', 1, 'pending')`,
    [waiverId, SEASON_ID, w.rivalTeam])

  const outcome = await reverseSeasonFreeAgentPickup(w.supabase, {
    seasonId: SEASON_ID,
    addedRosterId,
    waiverId,
  })

  assert.equal(outcome.ok, true, outcome.message)
  assert.equal(outcome.result.status, 'reversed')
  assert.equal(outcome.result.removed_character, 'Boo')
  assert.equal(outcome.result.restored_character, 'Toad')
  assert.deepEqual(await activeNames(w.db, w.ownerTeam), [...OWNER_ROSTER].sort())
  assert.equal(await w.db.value('select count(*)::int from season_roster where id = $1', [addedRosterId]), 0)
  assert.equal(await w.db.value('select count(*)::int from season_waivers where id = $1', [waiverId]), 0)
  assert.equal(await w.db.value('select count(*)::int from season_waiver_claims where waiver_id = $1', [waiverId]), 0)
  assert.equal(await w.db.value('select is_active from season_roster where id = $1', [w.rosterIds.Toad]), true)
})

test('only commissioners can use the reversal and a refusal changes nothing', { skip }, async (t) => {
  const w = await world(t)
  await w.as(OWNER_AUTH)
  const pickupOutcome = await pickup(w)
  const before = await snapshot(w.db)

  await w.as(RIVAL_AUTH)
  const outcome = await reverseSeasonFreeAgentPickup(w.supabase, {
    seasonId: SEASON_ID,
    addedRosterId: pickupOutcome.result.added.id,
    waiverId: pickupOutcome.result.waiver.id,
  })

  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'commissioner_required')
  assert.deepEqual(await snapshot(w.db), before)
})

test('a resolved waiver prevents reversal and an injected failure rolls everything back', { skip }, async (t) => {
  const w = await world(t)
  await w.as(OWNER_AUTH)
  const pickupOutcome = await pickup(w)
  const args = {
    seasonId: SEASON_ID,
    addedRosterId: pickupOutcome.result.added.id,
    waiverId: pickupOutcome.result.waiver.id,
  }

  await w.db.query("update season_waivers set status = 'free_agent' where id = $1", [args.waiverId])
  let before = await snapshot(w.db)
  let outcome = await reverseSeasonFreeAgentPickup(w.supabase, args)
  assert.equal(outcome.reason, 'waiver_resolved')
  assert.deepEqual(await snapshot(w.db), before)

  await w.db.query("update season_waivers set status = 'active' where id = $1", [args.waiverId])
  await w.db.exec(`
    create function inject_reversal_failure() returns trigger language plpgsql as $$
    begin
      if new.id = ${w.rosterIds.Toad} then
        raise exception 'injected restore failure';
      end if;
      return new;
    end
    $$;
    create trigger inject_reversal_failure before update on season_roster
      for each row execute function inject_reversal_failure();`)
  before = await snapshot(w.db)
  outcome = await reverseSeasonFreeAgentPickup(w.supabase, args)
  assert.equal(outcome.ok, false)
  assert.match(outcome.message, /injected restore failure/)
  assert.deepEqual(await snapshot(w.db), before)
})
