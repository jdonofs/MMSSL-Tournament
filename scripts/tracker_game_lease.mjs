// The database half of "this game is mine".
//
// The local lock (scripts/tracker_persistence.mjs) keeps two bridges on ONE
// machine off the same game and can never do more than that: a second laptop
// signed into the same project sees no lock file. This is the other half --
// a row in `tracker_game_leases`, renewed while the game is being played, with
// a fencing epoch that every write carries so a bridge which lost its lease
// cannot go on writing as though it had not.
//
// DEGRADING IS DELIBERATE AND LOUD, AND ONLY EVER IN ONE DIRECTION. The lease
// functions arrive in a migration that has to be applied to production by a
// person. Until it is, the RPC does not exist, and a bridge that refused to run
// without it would stop tracking games over a migration nobody had run yet. So
// a database with NO lease functions is reported as `unavailable` with the
// exact reason, the bridge says out loud that cross-machine exclusion is NOT in
// force, and the local lock carries on doing what it can.
//
// THAT IS THE ONLY STATE THAT DEGRADES. "I had this game and lost it" is not
// the same fact as "this database cannot express ownership", and the earlier
// version of this file collapsed the two: losing the lease set `held = false`,
// writeCredentials() then returned a NULL owner, and a null owner was exactly
// the shape tracker_lease_assert() waved through as an unleased repair caller.
// A bridge that had been told, in so many words, that another process owned the
// game went on writing plate appearances into it -- fencing disabled by the
// very event fencing exists for. The states are now distinct (`lost`,
// `expired`, `released`, `unavailable`), only `unavailable` yields unleased
// credentials, and every other non-held state THROWS at the write instead of
// producing a weaker credential. The explicit repair route is
// `unleasedTrackerCredentials(reason)` below: a caller that means to write
// without a lease has to say so and say why.

import os from 'node:os'
import crypto from 'node:crypto'

// Long enough that an ordinary hitch -- a slow Supabase round trip, a GC pause,
// a laptop briefly asleep -- does not drop a lease mid-game; short enough that
// a crashed bridge's game is reclaimable inside a couple of minutes.
export const DEFAULT_LEASE_TTL_SECONDS = 90
export const DEFAULT_RENEW_INTERVAL_MS = 25000

// PostgREST reports a function that does not exist as PGRST202, and a schema
// cache that has not been reloaded as PGRST203. Postgres itself says 42883.
// Any of the three means "this deployment has not run the migration", which is
// a different thing from "the lease is held by someone else".
//
// THE MESSAGE TEST IS NARROW ON PURPOSE. A bare /does not exist/ also matches
// `column "tracker_event_key" does not exist` (42703) and `relation
// "tracker_game_leases" does not exist` (42P01) -- two entirely different
// deployment faults that were both being reported as "the migration has not
// run" and then silently degraded around. Only a FUNCTION being absent is
// eligible for the degraded path; everything else is a real failure and is
// thrown.
function isMissingFunction(error) {
  const code = String(error?.code || '')
  if (code === 'PGRST202' || code === 'PGRST203' || code === '42883') return true
  // A code that names a different fault settles it: never fall back on those.
  if (code) return false
  return /could not find the function|function [^ ]* does not exist/i.test(String(error?.message || ''))
}

function isStaleLeaseError(error) {
  return /stale tracker lease|expired tracker lease|no tracker lease exists|unleased tracker write/i
    .test(String(error?.message || ''))
}

/**
 * The five states a tracker's ownership of a game can be in.
 *
 * They are deliberately five rather than a boolean. `unavailable` is a
 * statement about the DATABASE (no lease functions) and is the only one that
 * may write without a fencing token; the other three failures are statements
 * about THIS process and must never produce a credential at all.
 */
export const LEASE_STATUS = {
  UNKNOWN: 'unknown',
  HELD: 'held',
  LOST: 'lost',
  EXPIRED: 'expired',
  RELEASED: 'released',
  UNAVAILABLE: 'unavailable',
}

const REFUSING_STATUS = {
  [LEASE_STATUS.LOST]: 'this bridge no longer owns the game',
  [LEASE_STATUS.EXPIRED]: 'this bridge let its lease expire',
  [LEASE_STATUS.RELEASED]: 'this bridge released the game',
  [LEASE_STATUS.UNKNOWN]: 'this bridge has not taken the lease',
}

/** Thrown instead of handing back a credential that would not be fenced. */
export class TrackerLeaseLostError extends Error {
  constructor(message, { status, reason = null, ownerId = null, epoch = null } = {}) {
    super(message)
    this.name = 'TrackerLeaseLostError'
    this.status = status
    this.reason = reason
    this.ownerId = ownerId
    this.epoch = epoch
    // Read by the bridge the same way a database refusal is: both mean the
    // scoring fact was NOT written and must not be retried through a weaker
    // path.
    this.code = 'TRACKER_LEASE_NOT_HELD'
  }
}

export function isLeaseNotHeldError(error) {
  return error?.code === 'TRACKER_LEASE_NOT_HELD' || error?.name === 'TrackerLeaseLostError'
}

/**
 * The explicit, named route for a caller that has no lease and means it.
 *
 * A repair script, a backfill, an operator re-running postgame ingestion by
 * hand. The reason travels into the database, which refuses a null owner that
 * does NOT carry one -- so "no lease" can never again be arrived at by
 * accident, only by writing this call.
 */
export function unleasedTrackerCredentials(reason) {
  const stated = String(reason || '').trim()
  if (!stated) throw new Error('an unleased tracker write has to name its reason')
  return { ownerId: null, epoch: null, status: 'unleased', unleasedIntent: stated }
}

/** A durable, unguessable name for this bridge process. */
export function makeLeaseOwnerId({ host = os.hostname(), pid = process.pid } = {}) {
  return `${host}:${pid}:${crypto.randomUUID()}`
}

export function createTrackerGameLease({
  supabase,
  competitionType,
  gameId,
  ownerId = makeLeaseOwnerId(),
  ttlSeconds = DEFAULT_LEASE_TTL_SECONDS,
  renewIntervalMs = DEFAULT_RENEW_INTERVAL_MS,
  label = null,
  log = () => {},
  now = () => Date.now(),
  setInterval: setIntervalFn = setInterval,
  clearInterval: clearIntervalFn = clearInterval,
} = {}) {
  if (!supabase) throw new Error('a tracker game lease needs a Supabase client')
  if (!competitionType || gameId == null) {
    throw new Error('a tracker game lease needs a competition type and a game id')
  }

  const state = {
    available: null,   // null until the first call decides
    // One word for where ownership stands. `held` below is derived from it so
    // no caller can read a boolean and miss the difference between "nobody can
    // own this" and "somebody else does".
    status: LEASE_STATUS.UNKNOWN,
    epoch: null,
    unavailableReason: null,
    lastRenewedAt: null,
    lostReason: null,
  }
  let renewTimer = null

  function markUnavailable(reason) {
    state.available = false
    state.status = LEASE_STATUS.UNAVAILABLE
    state.unavailableReason = reason
  }

  async function call(fn, args) {
    // A client that cannot call functions at all is the same situation as a
    // database that has none: the guarantee is absent and has to be reported,
    // not thrown.
    if (typeof supabase.rpc !== 'function') {
      markUnavailable('this Supabase client cannot call database functions')
      return { missing: true }
    }
    const { data, error } = await supabase.rpc(fn, args)
    if (error) {
      if (isMissingFunction(error)) {
        markUnavailable(error.message || 'the lease functions are not installed')
        return { missing: true }
      }
      throw error
    }
    state.available = true
    return { data }
  }

  /**
   * Take the lease, or say who has it.
   *
   * `takeover` is an operator's decision to move a live game to this machine,
   * never a retry strategy: the ordinary reason a lease is held is that
   * somebody is playing the game.
   */
  async function acquire({ takeover = false } = {}) {
    const result = await call('tracker_lease_acquire', {
      p_competition_type: competitionType,
      p_game_id: Number(gameId),
      p_owner_id: ownerId,
      p_ttl_seconds: ttlSeconds,
      p_owner_host: os.hostname(),
      p_owner_pid: process.pid,
      p_owner_label: label,
      p_takeover: takeover,
    })
    if (result.missing) {
      log('WARNING: this database has no tracker_game_leases functions, so nothing here '
        + 'can keep a bridge on ANOTHER machine off this game. The local lock still '
        + `refuses a second bridge on this one. (${state.unavailableReason})`)
      return { granted: true, available: false, reason: 'lease_functions_missing' }
    }
    const payload = result.data || {}
    state.epoch = payload.lease?.epoch == null ? null : Number(payload.lease.epoch)
    if (payload.granted) {
      state.status = LEASE_STATUS.HELD
      state.lostReason = null
      state.lastRenewedAt = now()
      log(`game lease ${payload.reason} (epoch ${state.epoch}, owner ${ownerId})`)
    } else {
      state.status = LEASE_STATUS.UNKNOWN
      state.lostReason = `${payload.lease?.owner_id || 'another process'} holds this game`
      log(`game lease REFUSED: ${payload.lease?.owner_id} holds ${competitionType} game ${gameId} `
        + `until ${payload.lease?.expires_at}`)
    }
    return { ...payload, available: true }
  }

  // Renewal, not re-acquisition: a bridge whose lease was taken away has to
  // find that out rather than quietly taking the game back mid-play.
  async function renew() {
    if (state.status !== LEASE_STATUS.HELD || state.available === false) {
      return { granted: state.status === LEASE_STATUS.HELD }
    }
    const result = await call('tracker_lease_renew', {
      p_competition_type: competitionType,
      p_game_id: Number(gameId),
      p_owner_id: ownerId,
      p_epoch: state.epoch,
      p_ttl_seconds: ttlSeconds,
    })
    if (result.missing) return { granted: true, available: false }
    const payload = result.data || {}
    if (!payload.granted) {
      // WHICH failure it is, named. All of them refuse every subsequent write;
      // they are distinguished because the operator's next move differs -- an
      // expired lease can be re-acquired, one another owner holds cannot.
      const lease = payload.lease || null
      if (!lease) {
        state.status = LEASE_STATUS.LOST
        state.lostReason = 'the lease row for this game is gone'
      } else if (lease.released_at) {
        state.status = LEASE_STATUS.RELEASED
        state.lostReason = 'this lease was released'
      } else if (String(lease.owner_id) === String(ownerId)
                 && Number(lease.epoch) === Number(state.epoch)) {
        state.status = LEASE_STATUS.EXPIRED
        state.lostReason = `this lease expired at ${lease.expires_at}`
      } else {
        state.status = LEASE_STATUS.LOST
        state.lostReason = `${lease.owner_id || 'another process'} now owns this game`
      }
      log(`LOST the game lease (${state.status}): ${state.lostReason}. Writes from this `
        + 'bridge are refused from here on -- by this process before they reach the '
        + 'database, and by the database if they somehow do.')
    } else {
      state.status = LEASE_STATUS.HELD
      state.lastRenewedAt = now()
    }
    return payload
  }

  function startRenewing({ onLost = null } = {}) {
    if (renewTimer || state.available === false) return
    renewTimer = setIntervalFn(() => {
      renew()
        .then((payload) => { if (!payload.granted && onLost) onLost(state.lostReason) })
        .catch((error) => log('game lease renewal failed:', error.message))
    }, renewIntervalMs)
    renewTimer.unref?.()
  }

  function stopRenewing() {
    if (!renewTimer) return
    clearIntervalFn(renewTimer)
    renewTimer = null
  }

  async function release() {
    stopRenewing()
    if (state.status !== LEASE_STATUS.HELD || state.available === false) return { released: false }
    state.status = LEASE_STATUS.RELEASED
    state.lostReason = 'this bridge released the game on a clean stop'
    const result = await call('tracker_lease_release', {
      p_competition_type: competitionType,
      p_game_id: Number(gameId),
      p_owner_id: ownerId,
      p_epoch: state.epoch,
    }).catch((error) => {
      log('game lease release failed:', error.message)
      return { data: { released: false } }
    })
    return result.data || { released: false }
  }

  /**
   * Whether the lease has silently run out under a bridge that has not renewed.
   *
   * Renewal is a timer, and a timer that did not fire (a suspended laptop, a
   * blocked event loop) leaves `status` reading `held` past the expiry the
   * database is measuring against. Checked locally so the refusal happens here
   * rather than depending on the round trip that is about to be made.
   */
  function locallyExpired() {
    if (state.status !== LEASE_STATUS.HELD) return false
    if (state.available === false || state.lastRenewedAt == null) return false
    return now() - state.lastRenewedAt > ttlSeconds * 1000
  }

  /**
   * Refuse, by throwing, unless this process may write right now.
   *
   * Called by every bridge mutation -- scoring, live state, game completion,
   * unresolved plays, postgame ingestion -- because "the database will refuse
   * it" is only true of the calls that go through a fenced function, and the
   * live-state upsert, the games-table completion and the unresolved-play row
   * do not.
   */
  function assertWritable(what = 'this write') {
    if (state.available === false) {
      return { ownerId: null, epoch: null, status: LEASE_STATUS.UNAVAILABLE }
    }
    if (locallyExpired()) {
      state.status = LEASE_STATUS.EXPIRED
      state.lostReason = `no successful renewal for more than ${ttlSeconds}s`
    }
    if (state.status === LEASE_STATUS.HELD) {
      return { ownerId, epoch: state.epoch, status: LEASE_STATUS.HELD }
    }
    throw new TrackerLeaseLostError(
      `${what} refused: ${REFUSING_STATUS[state.status] || 'this bridge does not hold the lease'}`
      + `${state.lostReason ? ` (${state.lostReason})` : ''}. `
      + 'A tracker that has lost ownership never downgrades into an unfenced writer.',
      { status: state.status, reason: state.lostReason, ownerId, epoch: state.epoch },
    )
  }

  /**
   * What a write has to carry.
   *
   * Unleased ONLY when the database has no lease functions, and then it says so
   * in `unleasedIntent`, which the database now requires before it will accept
   * a null owner. Every other non-held state throws: see the header.
   */
  function writeCredentials(what = 'this write') {
    const credentials = assertWritable(what)
    if (credentials.status === LEASE_STATUS.UNAVAILABLE) {
      return {
        ownerId: null,
        epoch: null,
        status: LEASE_STATUS.UNAVAILABLE,
        unleasedIntent: `this database has no tracker lease functions (${state.unavailableReason})`,
      }
    }
    return credentials
  }

  return {
    ownerId,
    competitionType,
    gameId,
    get state() { return { ...state, held: state.status === LEASE_STATUS.HELD } },
    get status() { return locallyExpired() ? LEASE_STATUS.EXPIRED : state.status },
    get held() { return state.status === LEASE_STATUS.HELD && !locallyExpired() },
    get available() { return state.available },
    get epoch() { return state.epoch },
    acquire,
    renew,
    release,
    startRenewing,
    stopRenewing,
    writeCredentials,
    assertWritable,
    isStaleLeaseError,
  }
}

export { isMissingFunction, isStaleLeaseError }
