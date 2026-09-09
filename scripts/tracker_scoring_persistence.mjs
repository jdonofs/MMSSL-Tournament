import fs from 'node:fs'
import path from 'node:path'
import {
  insertOneReconciled,
  insertRowsReconciled,
  rowsMatchPayload,
  selectByKey,
} from './tracker_persistence.mjs'

function sourceFields(competitionType, seasonId) {
  return competitionType === 'season' ? { season_id: seasonId } : {}
}

function readJournal(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return { version: 1, events: [] }
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  return { version: 1, events: Array.isArray(parsed?.events) ? parsed.events : [] }
}

function writeJournal(filePath, journal) {
  if (!filePath) return
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`)
  fs.renameSync(temporary, filePath)
}

async function allGamePas(supabase, table, gameId) {
  const { data, error } = await supabase.from(table).select('*').eq('game_id', gameId)
  if (error) throw error
  return data || []
}

function paIdentityFields(payload) {
  return [
    'game_id', 'player_id', 'character_id', 'pitcher_id', 'pitcher_player_id',
    'inning', 'result', 'tracker_contact_seq',
  ].filter((field) => payload[field] !== undefined)
}

// A row an operator supplied the result for is not the tracker's to restate.
// The At-Bat editor writes the correction under the SAME tracker_event_key the
// unresolved play carried, precisely so a later replay finds it -- and a
// replay that then "reconciled" it back to whatever the tracker thought would
// undo the operator's work on every restart.
function isOperatorCorrection(row) {
  return String(row?.correction_source || '') === 'operator'
}

// ── what this deployment's schema can actually do ───────────────────────────
//
// THE FALLBACK USED TO BE A CLAIM, NOT A PATH. When the transactional function
// was absent the writer said, out loud, that it was carrying on through the
// staged journal-reconciled writes -- and then those writes queried
// `tracker_event_key`, a column that arrives in the SAME batch of migrations
// as the function. On a database with neither, every single plate appearance
// failed with 42703 on the first at-bat of the game. "Tracking continues" was
// false in exactly the situation the sentence was written for.
//
// So the schema is asked, once, before it is relied on, and each capability is
// separate: a deployment can have the durable-identity columns without the
// function (partially migrated), or neither (unmigrated), and those are
// different paths rather than one hopeful one.

const PA_CAPABILITY_COLUMNS = ['tracker_event_key', 'tracker_contact_seq', 'correction_source']

// PostgREST answers an unknown column with 42703 (or PGRST204 when it is the
// schema cache that has not seen it). A code that names something else is a
// real failure and is thrown -- a network error must never be read as "this
// column does not exist" and quietly change how the game is written.
function isMissingColumn(error) {
  const code = String(error?.code || '')
  if (code === '42703' || code === 'PGRST204') return true
  if (code) return false
  return /column .* does not exist|could not find the '.*' column/i.test(String(error?.message || ''))
}

// Which of the columns above a failure is complaining about, or null. Used as
// a SECOND source of evidence beside the probe: a Supabase client that does not
// model column projection (a test double, an older postgrest-js) answers the
// probe without ever consulting the column list, and the first staged write is
// then where the truth arrives. Believing that answer is what makes the
// fallback a path rather than a claim.
export function missingCapabilityColumn(error) {
  if (!isMissingColumn(error)) return null
  const message = String(error?.message || '')
  return PA_CAPABILITY_COLUMNS.find((column) => message.includes(column)) || null
}

/**
 * Which durable-identity columns the plate-appearance table actually has.
 *
 * Read-only, one query per column, and cached for the life of the writer.
 */
export async function probePlateAppearanceCapabilities(supabase, table) {
  const capabilities = {}
  for (const column of PA_CAPABILITY_COLUMNS) {
    let query = supabase.from(table).select(column)
    if (typeof query.limit === 'function') query = query.limit(1)
    const { error } = await query
    if (!error) { capabilities[column] = true; continue }
    if (isMissingColumn(error)) { capabilities[column] = false; continue }
    throw error
  }
  return capabilities
}

/**
 * Whether a schema can be tracked into at all, and what is degraded if so.
 *
 * `tracker_contact_seq` is the floor. Without it a contact plate appearance has
 * no database-visible identity whatsoever, so a replay or a restarted bridge
 * would duplicate every at-bat it re-delivered -- and duplicated scoring rows
 * are the one failure this whole path exists to prevent. That is a startup
 * prerequisite, reported before the game starts rather than discovered on the
 * first pitch.
 */
export function describeSchemaCapabilities(capabilities) {
  const supported = capabilities.tracker_contact_seq !== false
  const degraded = []
  if (capabilities.tracker_event_key === false) {
    degraded.push('plate appearances with no contact (a strikeout, a walk, a hit batter) are '
      + 'reconciled through the local journal and the game\'s own PA ordering rather than by a '
      + 'durable key, because this database has no plate_appearances.tracker_event_key '
      + '(20260908120000_tracker_durable_identities.sql)')
  }
  if (capabilities.correction_source === false) {
    degraded.push('an operator correction cannot be recognised, because this database has no '
      + 'plate_appearances.correction_source '
      + '(20260908124000_tracker_unresolved_plays.sql)')
  }
  return {
    supported,
    degraded,
    reason: supported ? null
      : 'this database has no plate_appearances.tracker_contact_seq, so a replayed or restarted '
        + 'bridge cannot tell a re-delivered at-bat from a new one and would duplicate scoring '
        + 'rows. Apply supabase/migrations/ before tracking a game against it.',
  }
}

async function ensurePa(supabase, table, event) {
  const payload = event.pa
  // The event key first: it is the only identity a plate appearance with no
  // contact -- a strikeout, a walk, a hit batter -- has at all.
  const eventKey = payload.tracker_event_key == null
    ? null
    : { game_id: payload.game_id, tracker_event_key: payload.tracker_event_key }
  if (eventKey) {
    const existing = await selectByKey(supabase, table, eventKey)
    const correction = existing.find(isOperatorCorrection)
    if (correction) return correction
    const exact = existing.find((row) => rowsMatchPayload(row, payload, paIdentityFields(payload)))
    if (exact) return exact
    if (existing.length) {
      throw new Error(`${table}: tracker event ${payload.tracker_event_key} conflicts with an existing PA`)
    }
  }
  const contactKey = payload.tracker_contact_seq == null
    ? null
    : { game_id: payload.game_id, tracker_contact_seq: payload.tracker_contact_seq }
  if (contactKey) {
    const existing = await selectByKey(supabase, table, contactKey)
    const correction = existing.find(isOperatorCorrection)
    if (correction) return correction
    const exact = existing.find((row) => rowsMatchPayload(row, payload, paIdentityFields(payload)))
    if (exact) return exact
    if (existing.length) throw new Error(`${table}: tracker contact ${payload.tracker_contact_seq} conflicts with an existing PA`)
  }

  for (let attempt = 0; attempt < 6; attempt++) {
    const rows = await allGamePas(supabase, table, payload.game_id)
    if (event.paId != null) {
      const recorded = rows.find((row) => String(row.id) === String(event.paId))
      if (recorded && rowsMatchPayload(recorded, payload, paIdentityFields(payload))) return recorded
    }
    const numbered = event.paNumber == null ? null : rows.find((row) => (
      Number(row.pa_number) === Number(event.paNumber)
      && rowsMatchPayload(row, payload, paIdentityFields(payload))
    ))
    if (numbered) return numbered

    const next = rows.reduce((max, row) => Math.max(max, Number(row.pa_number) || 0), 0) + 1
    event.paNumber = next
    try {
      const saved = await insertOneReconciled(supabase, table, { ...payload, pa_number: next }, {
        key: contactKey || { game_id: payload.game_id, pa_number: next },
        compareFields: [...paIdentityFields(payload), 'pa_number'],
        attempts: 1,
      })
      return saved.row
    } catch (error) {
      // A stale read racing another writer manifests as a duplicate PA number.
      // Refetch the max and try a new number; all other ambiguous writes are
      // reconciled by insertOneReconciled before reaching here.
      if (attempt === 5 || !/duplicate|unique|different data|23505/i.test(String(error?.message || error))) throw error
    }
  }
  throw new Error(`${table}: could not allocate a durable PA number`)
}

// PostgREST reports a function that is not there as PGRST202/PGRST203 and
// Postgres itself as 42883. Any of them means "this deployment has not run
// 20260908122000_tracker_persist_plate_appearance.sql", which is a different
// thing from the write having failed.
//
// The message test is narrow on purpose. A bare /does not exist/ also matches
// `column "tracker_event_key" does not exist` and `relation "x" does not
// exist`, so a schema fault was being classified as a missing capability and
// silently degraded around. Only a missing FUNCTION is eligible.
function isMissingRpc(error) {
  const code = String(error?.code || '')
  if (code === 'PGRST202' || code === 'PGRST203' || code === '42883') return true
  if (code) return false
  return /could not find the function|function [^ ]* does not exist/i.test(String(error?.message || ''))
}

export function createTrackerScoringPersistence({
  supabase,
  tables,
  competitionType,
  seasonId = null,
  gameId,
  journalPath = null,
  // The transactional path. `auto` uses it when the database has it and falls
  // back -- once, loudly -- when it does not, because the migration that adds
  // it has to be applied to production by a person and a bridge that refused
  // to run without it would stop tracking games over a migration nobody had
  // run yet. false pins the staged client writes.
  transactional = 'auto',
  // What the lease says this bridge may write as. Read at write time rather
  // than at construction: an epoch changes when ownership does, and a lease
  // that has been LOST throws from here rather than returning a weaker
  // credential -- see scripts/tracker_game_lease.mjs.
  leaseCredentials = () => ({ ownerId: null, epoch: null, unleasedIntent: null }),
  log = () => {},
} = {}) {
  if (!supabase || !tables?.plateAppearances || !tables?.pitches || !tables?.runsScored) {
    throw new Error('tracker scoring persistence requires Supabase and all scoring tables')
  }
  const journal = readJournal(journalPath)
  const persistJournal = () => writeJournal(journalPath, journal)
  // null = not asked yet; true/false = settled for the life of this process.
  let rpcAvailable = transactional === false ? false
    : (transactional === true ? true : null)
  let capabilities = null
  let capabilityPromise = null

  async function schemaCapabilities() {
    if (capabilities) return capabilities
    if (!capabilityPromise) {
      capabilityPromise = probePlateAppearanceCapabilities(supabase, tables.plateAppearances)
        .then((probed) => {
          capabilities = probed
          // Said once, here, by whichever path consulted the schema first --
          // the bridge's startup prerequisite or the first staged write. A
          // degraded guarantee that is never printed is indistinguishable from
          // a guarantee that holds.
          for (const note of describeSchemaCapabilities(probed).degraded) log(`WARNING: ${note}`)
          return probed
        })
        .catch((error) => { capabilityPromise = null; throw error })
    }
    return capabilityPromise
  }

  /**
   * The startup prerequisite.
   *
   * Called by the bridge before the game starts, so a database that cannot be
   * tracked into says so while nothing has been played, instead of failing on
   * the first at-bat with a column error the log then reports as a fallback.
   */
  async function assertSchemaSupported() {
    const probed = await schemaCapabilities()
    const verdict = describeSchemaCapabilities(probed)
    if (!verdict.supported) throw new Error(verdict.reason)
    return verdict
  }

  // The payload minus any column this deployment does not have. Without it the
  // staged fallback wrote `tracker_event_key` into a table with no such column
  // and lost every plate appearance in the game.
  function writableRow(row, probed) {
    if (!probed) return row
    const stripped = { ...row }
    for (const column of PA_CAPABILITY_COLUMNS) {
      if (probed[column] === false) delete stripped[column]
    }
    return stripped
  }

  /**
   * One commit for the plate appearance and all of its required children.
   *
   * Returns null when this database has no such function, which is the signal
   * to use the staged writes below. Anything else that goes wrong is a real
   * failure and is thrown: a refused lease, a constraint violation and a
   * rolled-back transaction all mean the scoring fact was NOT written, and
   * quietly retrying them through a weaker path would be the one outcome worse
   * than failing.
   */
  async function persistTransactionally(event, pitches, credentials) {
    if (rpcAvailable === false || typeof supabase.rpc !== 'function') return null
    const { ownerId, epoch, unleasedIntent } = credentials || {}
    const { data, error } = await supabase.rpc('tracker_persist_plate_appearance', {
      p_competition_type: competitionType,
      p_game_id: Number(gameId),
      p_pa: event.pa,
      p_pitches: pitches,
      p_runs: event.runs,
      p_owner_id: ownerId ?? null,
      p_epoch: epoch ?? null,
      p_unleased_intent: unleasedIntent ?? null,
    })
    if (error) {
      if (isMissingRpc(error)) {
        if (rpcAvailable !== false) {
          log('this database has no tracker_persist_plate_appearance(); falling back to the '
            + 'staged journal-reconciled writes. A plate appearance and its runs are then '
            + 'durable but not atomic -- see docs/tracker-persistence-reliability.md.')
        }
        rpcAvailable = false
        return null
      }
      throw error
    }
    rpcAvailable = true
    if (!data?.pa) throw new Error('tracker_persist_plate_appearance returned no plate appearance')
    return data
  }

  /**
   * The staged PA write, with the schema's own answer taken as authoritative.
   *
   * The probe above is the explicit check and is what a real client answers
   * correctly. This is the backstop: if a write still comes back saying a
   * column does not exist, that IS the capability answer, so the column is
   * dropped for the rest of the run and the write is retried once -- rather
   * than failing the plate appearance and every one after it.
   */
  async function ensureStagedPa(stagedEvent, probed, event) {
    try {
      return await ensurePa(supabase, tables.plateAppearances, stagedEvent)
    } catch (error) {
      const column = missingCapabilityColumn(error)
      if (!column || probed[column] === false) throw error
      probed[column] = false
      if (capabilities) capabilities[column] = false
      log(`this database has no ${tables.plateAppearances}.${column}; `
        + `${describeSchemaCapabilities(probed).degraded.join(' ') || 'continuing without it'}`)
      stagedEvent.pa = writableRow(event.pa, probed)
      return ensurePa(supabase, tables.plateAppearances, stagedEvent)
    }
  }

  async function persistEvent(input, { recovering = false } = {}) {
    if (!input?.eventKey) throw new Error('tracker scoring event requires eventKey')
    // BEFORE THE JOURNAL, NOT AFTER IT. A lease this process has lost throws
    // here, so a bridge that has been told another owner holds the game does
    // not even record the intention to write -- which is what a journal entry
    // is, and what would be replayed on the next start.
    const credentials = leaseCredentials('a tracker scoring write') || {}
    let event = journal.events.find((entry) => entry.eventKey === input.eventKey)
    const duplicateDelivery = Boolean(event)
    if (!event) {
      event = {
        ...input,
        // The event key travels into the row, not just the journal. It is what
        // makes a plate appearance with no contact identifiable from the
        // database alone -- see the durable-identities migration.
        pa: {
          ...sourceFields(competitionType, seasonId),
          ...input.pa,
          game_id: gameId,
          tracker_event_key: input.pa?.tracker_event_key ?? input.eventKey,
        },
        pitches: (input.pitches || []).map((row) => ({ ...sourceFields(competitionType, seasonId), ...row, game_id: gameId })),
        runs: (input.runs || []).map((row) => ({ ...sourceFields(competitionType, seasonId), ...row, game_id: gameId })),
        stage: 'journaled',
      }
      journal.events.push(event)
      persistJournal()
    } else if (!recovering && event.stage === 'complete') {
      // A repeated delivery is also a cheap integrity check. Reconcile all
      // dependent rows instead of trusting a stale local "complete" bit.
      event.stage = 'journaled'
    }

    // pitch_number_pa is settled before either path, because it is part of the
    // pitch's durable key and both paths reconcile on it.
    const numberedPitches = event.pitches.map((row, index) => ({
      ...row,
      pitch_number_pa: row.pitch_number_pa ?? index + 1,
    }))

    const committed = await persistTransactionally(event, numberedPitches, credentials)
    if (committed) {
      event.paId = committed.pa.id
      event.paNumber = committed.pa.pa_number
      event.stage = 'complete'
      if (committed.operator_correction) event.operatorCorrection = true
      persistJournal()
      return {
        pa: committed.pa,
        pitches: committed.operator_correction ? 0 : numberedPitches.length,
        runs: committed.operator_correction ? 0 : event.runs.length,
        duplicate: duplicateDelivery,
        transactional: true,
        ...(committed.operator_correction ? { operatorCorrection: true } : {}),
      }
    }

    // The staged path is the one that has to know what this schema carries:
    // the transactional function resolves its own columns server-side.
    const probed = await schemaCapabilities()
    const stagedEvent = {
      ...event,
      pa: writableRow(event.pa, probed),
      get paId() { return event.paId },
      set paId(value) { event.paId = value },
      get paNumber() { return event.paNumber },
      set paNumber(value) { event.paNumber = value },
    }
    const savedPa = await ensureStagedPa(stagedEvent, probed, event)
    event.paId = savedPa.id
    event.paNumber = savedPa.pa_number
    event.stage = 'pa'
    persistJournal()

    // An operator's answer to a play the tracker could not score is the one
    // thing on this path that is not the tracker's to restate. Its children
    // were written by the editor beside it, and re-deriving them from what the
    // tracker guessed would undo the correction on every replay.
    if (isOperatorCorrection(savedPa)) {
      event.stage = 'complete'
      event.operatorCorrection = true
      persistJournal()
      return {
        pa: savedPa, pitches: 0, runs: 0, duplicate: duplicateDelivery, operatorCorrection: true,
      }
    }

    const pitches = numberedPitches.map((row) => ({ ...row, pa_id: savedPa.id }))
    await insertRowsReconciled(supabase, tables.pitches, pitches, {
      keyFields: ['pa_id', 'pitch_number_pa'],
      // pitch_number_game is a display ordinal counted across the whole game,
      // so a replay into a database that already holds these pitches computes a
      // HIGHER one for the same pitch. It is not part of the pitch's identity
      // -- (pa_id, pitch_number_pa) is -- and comparing it turned a correct
      // reconciliation into "durable key already belongs to different data",
      // which then blocked live state and score sync for the rest of the run.
      // The row already in the table was numbered in order and is the right one.
      compareFields: Object.keys(pitches[0] || {}).filter((field) => field !== 'pitch_number_game'),
    })
    event.stage = 'pitches'
    persistJournal()

    await insertRowsReconciled(supabase, tables.runsScored, event.runs.map((row) => ({ ...row, pa_id: savedPa.id })), {
      keyFields: ['pa_id', 'scoring_player_id', 'scoring_character_id'],
    })
    event.stage = 'complete'
    persistJournal()
    return { pa: savedPa, pitches: pitches.length, runs: event.runs.length, duplicate: duplicateDelivery }
  }

  async function recoverPending() {
    const recovered = []
    for (const event of journal.events.filter((entry) => entry.stage !== 'complete')) {
      recovered.push(await persistEvent(event, { recovering: true }))
    }
    return recovered
  }

  async function verifyAll() {
    const verified = []
    for (const event of journal.events) verified.push(await persistEvent(event, { recovering: true }))
    return verified
  }

  return {
    persistEvent,
    recoverPending,
    verifyAll,
    journal,
    assertSchemaSupported,
    schemaCapabilities,
  }
}
