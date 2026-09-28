// supabase/migrations/20260921130000_character_run_speed_corrections.sql,
// against a real PostgreSQL.
//
//   node --test tests/character-run-speed-migration.test.mjs
//
// THE MIGRATION IS NOT APPLIED ANYWHERE BY THIS FILE except to a PGlite
// database created fresh in this process and thrown away at the end of each
// test. Nothing here reaches Supabase, and the production ledger is untouched.
//
// WHY A TEST AND NOT A HAND-RUN CHECK. This migration's whole value is in what
// it REFUSES: it names its targets, checks the value it expects to find, stops
// rather than guessing when the data is not what it was written against, and
// leaves the similarly-named siblings (Blue Dry Bones, Dark Bones, Green Dry
// Bones, Paratroopa) alone. Those behaviours were verified by reading the SQL
// and running it once by hand, which establishes nothing about the next time it
// is edited. Each of them is a case below.
//
// ROLLBACK, AND THE EXECUTION ASSUMPTION IT DEPENDS ON. Two different levels,
// and only the first is a property of the file:
//
//   WITHIN the corrections, which are one `do $$` block and therefore one
//   statement, a refusal on the second character undoes the first character's
//   update. That holds however the file is submitted.
//
//   ACROSS the file, a post-condition failure also undoes both corrections --
//   but only because these tests submit the whole file as ONE multi-statement
//   query. Postgres runs a simple Query message containing several statements
//   as a single implicit transaction, so the post-condition aborting takes the
//   corrections with it. PGlite's `exec` sends it that way and so does psql's
//   simple protocol. A runner that split the file into separate round trips
//   would commit the corrections and then fail the post-condition on its own,
//   leaving the file half applied. That is an assumption about the RUNNER, not
//   a guarantee of the SQL.
//
// Both levels are pinned below. The last test is the case that removes the
// dependency: wrapped in an explicit begin/commit, as every migration here is
// applied to production, the guarantee no longer rests on how the runner
// chunks the file.

import test from 'node:test'
import assert from 'node:assert/strict'

import { createTrackerTestDatabase, databaseAvailable, migrationSql } from './helpers/trackerTestDatabase.mjs'

const MIGRATION = '20260921130000_character_run_speed_corrections.sql'
const HAVE_DATABASE = await databaseAvailable()
const skip = HAVE_DATABASE
  ? false
  : 'no local Postgres: @electric-sql/pglite is not installed (npm install)'

// The rows as production holds them today, read once with
// `supabase db query --linked` and written down here so the test says what it
// was written against. If production ever diverges, the migration's own
// refusal is what catches it -- not this fixture.
const PRODUCTION_RUN_SPEEDS = [
  ['Dry Bones', 40],
  ['Green Paratroopa', 64],
  ['Paratroopa', 52],
  ['Blue Dry Bones', 50],
  ['Dark Bones', 50],
  ['Green Dry Bones', 57],
  // An unrelated row, to show the update does not reach past its names.
  ['Yoshi', 90],
]

async function characterWorld(t, overrides = {}) {
  // No tracker migrations: this one touches a single table and the tracker
  // schema is irrelevant to it.
  const db = await createTrackerTestDatabase({ migrations: [] })
  t.after(() => db.close())
  await db.exec('alter table characters add column run_speed integer')
  for (const [name, runSpeed] of PRODUCTION_RUN_SPEEDS) {
    await db.query('insert into characters (name, run_speed) values ($1, $2)',
      [name, name in overrides ? overrides[name] : runSpeed])
  }
  return db
}

async function speeds(db) {
  const rows = await db.rows('select name, run_speed from characters order by name')
  return Object.fromEntries(rows.map((row) => [row.name, row.run_speed]))
}

const apply = (db) => db.exec(migrationSql(MIGRATION))
// `exec` rather than the helper's `fails`, which prepares a single statement:
// this file is two `do $$` blocks and Postgres will not prepare two commands at
// once. `exec` sends the whole file as one simple Query, which is the execution
// assumption the header names -- and the assumption the across-the-file
// rollback below depends on.
async function applyFails(db) {
  try {
    await db.exec(migrationSql(MIGRATION))
    return null
  } catch (error) {
    return error
  }
}

test('the correction lands on both rows and reaches no others', { skip }, async (t) => {
  const db = await characterWorld(t)
  await apply(db)

  const after = await speeds(db)
  assert.equal(after['Dry Bones'], 50, 'Dry Bones holds the run_speed-50 constant the game holds')
  assert.equal(after['Green Paratroopa'], 52, 'Green Paratroopa holds ordinary Paratroopa\'s row')
  // The names this file could plausibly have matched, and did not.
  assert.equal(after['Paratroopa'], 52)
  assert.equal(after['Blue Dry Bones'], 50)
  assert.equal(after['Dark Bones'], 50)
  assert.equal(after['Green Dry Bones'], 57)
  assert.equal(after['Yoshi'], 90)
})

test('applying it a second time is a notice, not a failure', { skip }, async (t) => {
  const db = await characterWorld(t)
  await apply(db)
  const once = await speeds(db)

  // The `updated = 0` branch has to tell "already applied" apart from "this
  // row is not what I expected", and only the second is an error.
  await apply(db)
  assert.deepEqual(await speeds(db), once, 'a repeat apply changes nothing and raises nothing')
})

test('a row that is not what the file was written against stops the migration', { skip }, async (t) => {
  const db = await characterWorld(t, { 'Dry Bones': 45 })
  const error = await applyFails(db)

  assert.ok(error, 'an unexpected prior value must not be corrected silently')
  assert.match(error.message, /refusing to correct Dry Bones/)
  assert.match(error.message, /expected run_speed 40 and found 45/)
  const after = await speeds(db)
  assert.equal(after['Dry Bones'], 45, 'and the row is left exactly as it was')
  assert.equal(after['Green Paratroopa'], 64, 'nothing else in the block ran')
})

// THE ROLLBACK. Both corrections are one `do $$` block, which is one statement,
// so an exception raised on the second undoes the first. Reading the file does
// not make that obvious and a hand-run check never reached this case -- the
// half-applied state it rules out is exactly the one that would be hardest to
// notice afterwards.
test('a refusal on the second character undoes the first', { skip }, async (t) => {
  const db = await characterWorld(t, { 'Green Paratroopa': 45 })
  const error = await applyFails(db)

  assert.ok(error)
  assert.match(error.message, /refusing to correct Green Paratroopa/)
  const after = await speeds(db)
  assert.equal(after['Dry Bones'], 40,
    'the correction that succeeded is rolled back with the block that failed')
  assert.equal(after['Green Paratroopa'], 45)
})

test('the post-condition fails when a sibling row is not what it should be', { skip }, async (t) => {
  // Both targets are correctable; a row the corrections do not touch is wrong.
  const db = await characterWorld(t, { Paratroopa: 60 })
  const error = await applyFails(db)

  assert.ok(error, 'the post-condition is the migration\'s own check, not a follow-up note')
  assert.match(error.message, /post-condition failed/)
  // Submitted as one multi-statement query, the whole file is one implicit
  // transaction, so the post-condition failing takes the corrections with it.
  // This rules out a half-applied file FOR THAT SUBMISSION MODE, which is what
  // `exec` does and what psql's simple protocol does. It does not rule it out
  // for a runner that sends each statement separately -- the explicit
  // begin/commit in the last test is what covers that case.
  const after = await speeds(db)
  assert.equal(after['Dry Bones'], 40, 'the corrections roll back with the post-condition')
  assert.equal(after['Green Paratroopa'], 64)
  assert.equal(after['Paratroopa'], 60, 'and the row that tripped it is untouched')
})

test('a duplicate name is refused rather than updated twice', { skip }, async (t) => {
  const db = await createTrackerTestDatabase({ migrations: [] })
  t.after(() => db.close())
  await db.exec('alter table characters add column run_speed integer')
  // The unique constraint on name is dropped so the guard can be exercised at
  // all: the migration must not depend on the constraint being there.
  await db.exec('alter table characters drop constraint characters_name_key')
  for (const [name, runSpeed] of PRODUCTION_RUN_SPEEDS) {
    await db.query('insert into characters (name, run_speed) values ($1, $2)', [name, runSpeed])
  }
  await db.query("insert into characters (name, run_speed) values ('Dry Bones', 40)")

  const error = await applyFails(db)
  assert.ok(error)
  assert.match(error.message, /matched 2 rows; names must be unique here/)
})

test('wrapped in a transaction and rolled back, it leaves nothing behind', { skip }, async (t) => {
  // How this migration would be applied to production: inside an explicit
  // transaction, per docs/tracker-validation-console.md. A rollback has to be
  // a complete undo or the ledger and the data can disagree.
  const db = await characterWorld(t)
  const before = await speeds(db)

  await db.exec('begin')
  await db.exec(migrationSql(MIGRATION))
  const inside = await speeds(db)
  assert.equal(inside['Dry Bones'], 50, 'the correction is visible inside the transaction')
  await db.exec('rollback')

  assert.deepEqual(await speeds(db), before, 'and gone after the rollback')
})
