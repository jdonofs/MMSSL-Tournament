// A real Postgres for the database guarantees, in this process.
//
// WHY NOT THE FAKE. tests/helpers/trackerFakeSupabase.mjs enforces the natural
// keys the schema is *expected* to hold, which makes it a good model of the
// client's behaviour and no evidence at all about the database's. Unique
// indexes, transaction rollback, `for update` serialization and plpgsql
// functions are precisely the things it cannot establish -- it is a single
// JavaScript object. docs/tracker-acceptance-2026-09-06.md says so in its own
// verification limits.
//
// PGlite is the real PostgreSQL server compiled to WebAssembly. The migrations
// that run here are the same files in supabase/migrations/ that would run
// against production, applied in filename order, and nothing in this module
// reaches Supabase.
//
// WHAT THE BASELINE IS. tests/fixtures/tracker-database-baseline.sql, and its
// own header is the honest description: the subset of the production schema
// the tracker writes, reconstructed from the code, because no DDL for the
// season and tracking tables exists in this repository.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const BASELINE = path.join(REPO, 'tests', 'fixtures', 'tracker-database-baseline.sql')
const MIGRATIONS = path.join(REPO, 'supabase', 'migrations')

// The migrations this suite applies. Named rather than globbed: the directory
// also holds odds and pitch-measurement migrations that alter tables the
// baseline deliberately does not carry, and running those would fail for a
// reason that has nothing to do with what is under test.
export const TRACKER_MIGRATIONS = [
  '20260908120000_tracker_durable_identities.sql',
  '20260908121000_tracker_game_leases.sql',
  '20260908122000_tracker_persist_plate_appearance.sql',
  '20260908123000_tracking_session_versions.sql',
  '20260908124000_tracker_unresolved_plays.sql',
  '20260909120000_tracker_fenced_game_mutations.sql',
  '20260916120000_tracker_default_for_games.sql',
  '20260918130000_tracker_persist_child_ids_are_uuids.sql',
  '20260918132000_tracker_persist_blank_payload_is_not_a_conflict.sql',
  '20260918133000_tracking_session_statuses.sql',
  '20260918134000_tracking_session_uuid_functions.sql',
  '20260922120000_batter_runner_opportunities.sql',
  '20260922233000_user_swing_and_chase_tracking.sql',
]

let pgliteModule = null
let pgcryptoModule = null

/**
 * True when a real Postgres can be started in this process.
 *
 * Reported rather than assumed: a checkout without the dev dependency installed
 * should say the database guarantees were not exercised, not silently pass a
 * suite that tested nothing.
 */
export async function databaseAvailable() {
  if (pgliteModule) return true
  try {
    pgliteModule = await import('@electric-sql/pglite')
    // gen_random_uuid() comes from pgcrypto here, exactly as it does on
    // Supabase -- but PGlite ships its contrib modules as loadable bundles
    // rather than as part of the server, so the extension has to be handed in
    // at startup or `create extension pgcrypto` finds nothing to create.
    pgcryptoModule = await import('@electric-sql/pglite/contrib/pgcrypto')
    return true
  } catch {
    return false
  }
}

export function migrationSql(name) {
  return fs.readFileSync(path.join(MIGRATIONS, name), 'utf8')
}

/**
 * A fresh database with the baseline and every tracker migration applied.
 *
 * `beforeMigrations` runs after the baseline and before the migrations, which
 * is where a test that wants to prove a migration REFUSES bad data (duplicate
 * scoring rows, say) puts that data.
 */
export async function createTrackerTestDatabase({
  beforeMigrations = null,
  migrations = TRACKER_MIGRATIONS,
} = {}) {
  if (!await databaseAvailable()) {
    throw new Error('@electric-sql/pglite is not installed; run npm install')
  }
  const { PGlite } = pgliteModule
  const db = await PGlite.create({ extensions: { pgcrypto: pgcryptoModule.pgcrypto } })
  await db.exec(fs.readFileSync(BASELINE, 'utf8'))
  if (beforeMigrations) await beforeMigrations(db)
  const applied = []
  for (const name of migrations) {
    await db.exec(migrationSql(name))
    applied.push(name)
  }
  return Object.assign(db, {
    appliedMigrations: applied,
    // A tiny convenience so tests read as SQL rather than as result plumbing.
    async rows(sql, params = []) {
      const result = await db.query(sql, params)
      return result.rows
    },
    async one(sql, params = []) {
      const result = await db.query(sql, params)
      return result.rows[0] ?? null
    },
    async value(sql, params = []) {
      const row = await db.query(sql, params)
      const first = row.rows[0]
      return first ? Object.values(first)[0] : null
    },
    // Whether a statement failed, and with what. Used constantly here because
    // most of these guarantees ARE the refusal.
    async fails(sql, params = []) {
      try {
        await db.query(sql, params)
        return null
      } catch (error) {
        return error
      }
    },
  })
}

/** A world with two games that share the number 4242, one per competition. */
export async function seedCollidingGames(db) {
  const [away, home] = await db.rows(
    "insert into players (name) values ('acceptance-away'), ('acceptance-home') returning id, name")
  const [batter, pitcher] = await db.rows(
    "insert into characters (name) values ('acceptance-batter'), ('acceptance-pitcher') returning id, name")
  await db.query('insert into games (id, tournament_id, stats_source) values ($1, $2, $3)',
    [4242, 909, 'tracker'])
  await db.query('insert into season_schedule (id, season_id, stats_source) values ($1, $2, $3)',
    [4242, 909, 'tracker'])
  return { away, home, batter, pitcher, gameId: 4242 }
}
