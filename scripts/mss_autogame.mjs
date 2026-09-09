// One command: pick a game, and play it.
//
// Three tools already existed and each did its part well, but the seams
// between them were all manual -- pick a game on the site, toggle it into
// Tracker mode, export the lineup, run the autoteam script, remember to start
// the bridge before the first pitch. This runs the whole path:
//
//   node scripts/mss_autogame.mjs
//
//   1. lists the games waiting to be played and asks which one
//   2. exports its lineup            (scripts/export_mss_lineup.mjs)
//   3. sets that game to stats_source='tracker' if it is not already
//   4. starts the tracker bridge     (scripts/live_tracker_bridge.mjs)
//   5. drives MSS's menus and writes both teams  (scripts/mss_autoteam.py)
//
// Steps 4 and 5 overlap on purpose, and the overlap is the only interesting
// part of this file. The bridge's own startup -- signing in, loading the
// roster, repairing live state -- takes seconds, and none of them need the
// game to exist yet; the tracker .exe is the only piece that does, because it
// reads the live match out of memory as it initialises. So the bridge is
// started early and told to hold its .exe (TRACKER_LAUNCH_SIGNAL), autoteam
// blocks until the match reaches its first pitch (--wait-for-live), and the
// signal file is written the moment it reports that. The tracker then starts
// against a live game with none of the sign-in latency in front of it.
//
// FIVE STAGES, AND THEY ARE NOT THE SAME CLAIM. A running process is not a
// ready one, and this file is careful about which of these it has actually
// been told:
//
//   spawned      the bridge process exists. Proves nothing else.
//   initialised  the bridge signed in, took the game lock, loaded the roster,
//                repaired live state, and is now holding the tracker. It
//                announces this by writing <signal>.ready, and until that
//                file exists a "the tracker is running" claim is a guess.
//   game live    autoteam saw the ball sitting at a byte-exact pitch reset.
//                It says so with `MSS_AUTOTEAM_MATCH_LIVE confirmed`; on a
//                timeout it hands off anyway and says `unconfirmed`, which
//                is reported here as the weaker thing it is.
//   attached     the tracker .exe launched. Only the bridge sees this.
//   recording    the 60 Hz collector has SAMPLED frames off a running game
//                and FLUSHED them to its .bin. The bridge holds the tracker
//                until it has that evidence (or gives up saying why) and
//                publishes it at <signal>.recording, which this file waits on
//                before it tells anyone the game is ready to play.
//
// Usage:
//   node scripts/mss_autogame.mjs                       # pick from a list
//   node scripts/mss_autogame.mjs --game 2706           # skip the picker
//   node scripts/mss_autogame.mjs --stadium "Mario Stadium"
//   node scripts/mss_autogame.mjs --dry-run             # pick + export only
//   node scripts/mss_autogame.mjs --no-tracker          # set the game up, no bridge
//   node scripts/mss_autogame.mjs -- --nav-preset safe  # rest goes to autoteam
//
// Config: the same .env / .env.tracker-bridge the exporter and the bridge
// already read. Nothing new to set up.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'
import { fileURLToPath } from 'node:url'
import { trackerGameLockPath, trackerGameLockOwner } from './tracker_persistence.mjs'

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url))
const EXPORTER = path.join(SCRIPTS, 'export_mss_lineup.mjs')
const AUTOTEAM = path.join(SCRIPTS, 'mss_autoteam.py')
const BRIDGE = path.join(SCRIPTS, 'live_tracker_bridge.mjs')

// Printed by mss_autoteam.py once the ball reaches its first pitch reset. A
// token rather than a phrase so the handoff survives the next time that
// script's wording is improved -- see MATCH_LIVE_MARKER there.
//
// The token carries a status word: `confirmed` when a pitch reset was
// actually seen, `unconfirmed` when the wait timed out and autoteam handed
// off regardless. A bare token with no word is read as unconfirmed, because
// that is the reading that cannot overstate what happened -- and it is what
// an older mss_autoteam.py prints.
export const MATCH_LIVE_MARKER = 'MSS_AUTOTEAM_MATCH_LIVE'
const MATCH_LIVE_PATTERN = new RegExp(`^${MATCH_LIVE_MARKER}(?:\\s+(\\S+))?\\s*$`)
// The gameplay hold, printed by the same script. An autoteam that predates the
// hold prints neither, which is reported as "not held" rather than assumed to
// be fine: not holding is the behaviour this replaced.
export const GAMEPLAY_HELD_MARKER = 'MSS_AUTOTEAM_GAMEPLAY_HELD'
export const GAMEPLAY_RESUMED_MARKER = 'MSS_AUTOTEAM_GAMEPLAY_RESUMED'
const GAMEPLAY_HELD_PATTERN = new RegExp(`^${GAMEPLAY_HELD_MARKER}(?:\\s+\\S+)?\\s*$`)
const GAMEPLAY_RESUMED_PATTERN = new RegExp(`^${GAMEPLAY_RESUMED_MARKER}\\s+(\\S+)(?:\\s+([\\d.]+))?\\s*$`)

// How long to wait for the bridge to say it finished its own startup. This is
// dead time only in the sense that the menus are not being driven yet; it buys
// the guarantee that nothing touches the emulator behind a bridge that already
// died on a bad login or a held game lock.
const DEFAULT_BRIDGE_READY_TIMEOUT_MS = 60000

// How long to wait, after the handoff, for the bridge to publish the 60 Hz
// collector's recording evidence. The bridge's own wait
// (TRACKER_CAPTURE_READY_TIMEOUT_MS, 30 s) is what actually bounds this; the
// extra 20 s covers the collector's own startup before that wait begins, and
// the file is written on failure too, so this deadline is a backstop for a
// bridge that died rather than a normal ending.
const DEFAULT_RECORDING_TIMEOUT_MS = 50000

// How long after mss_autoteam.py exits its stdout pipe may stay open before
// this stops waiting for the rest of its output. See runAutoteam().
const STDOUT_DRAIN_GRACE_MS = 2000

// ── env ─────────────────────────────────────────────────────────────────────
function loadEnvFile(filePath) {
  const loaded = {}
  if (!fs.existsSync(filePath)) return loaded
  fs.readFileSync(filePath, 'utf8').split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex <= 0) return
    loaded[trimmed.slice(0, eqIndex).trim()] = trimmed.slice(eqIndex + 1).trim()
  })
  return loaded
}

export function loadEnv() {
  return {
    ...loadEnvFile(path.resolve('.env')),
    ...loadEnvFile(path.resolve('.env.tracker-bridge')),
    ...process.env,
  }
}

// ── args ────────────────────────────────────────────────────────────────────
// Everything after a bare `--` is forwarded to mss_autoteam.py untouched. That
// script has a dozen flags worth reaching (--nav-preset, --wait-scale,
// --total-miis, --formation-object) and re-declaring them here would mean two
// places to keep in step, with this one silently a version behind.
export function parseArgs(argv) {
  const parsed = { passthrough: [] }
  const separator = argv.indexOf('--')
  const own = separator === -1 ? argv : argv.slice(0, separator)
  if (separator !== -1) parsed.passthrough = argv.slice(separator + 1)

  for (let index = 0; index < own.length; index += 1) {
    const arg = own[index]
    const value = () => {
      const next = own[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`${arg} needs a value.`)
      }
      index += 1
      return next
    }
    // A flag whose value has to be a number is checked HERE rather than where
    // it is used, because Number('') and Number('abc') are both NaN and NaN
    // is falsy: `--game abc` used to fall through the `if (options.gameId)`
    // test and silently open the interactive picker, and `--limit -1` used to
    // reach `listed.slice(0, -1)` and quietly hide the last game on the list.
    const positiveInteger = () => {
      const raw = value()
      const parsedNumber = Number(raw)
      if (!Number.isInteger(parsedNumber) || parsedNumber < 1) {
        throw new Error(`${arg} needs a positive whole number, not "${raw}".`)
      }
      return parsedNumber
    }
    switch (arg) {
      case '--game': parsed.gameId = positiveInteger(); break
      case '--season': case '--tournament': parsed.season = value(); break
      case '--table': parsed.table = value(); break
      case '--stadium': parsed.stadium = value(); break
      case '--lineup': parsed.lineup = value(); break
      case '--filter': parsed.filter = value().toLowerCase(); break
      case '--limit': parsed.limit = positiveInteger(); break
      case '--python': parsed.python = value(); break
      case '--dry-run': parsed.dryRun = true; break
      case '--no-tracker': parsed.noTracker = true; break
      case '--no-claim': parsed.noClaim = true; break
      case '--all': parsed.all = true; break
      case '--help': case '-h': parsed.help = true; break
      default:
        throw new Error(`Unknown option ${arg}. Pass autoteam flags after a bare --.`)
    }
  }
  if (parsed.table && !SOURCES.some((source) => source.gamesTable === parsed.table)) {
    throw new Error(`--table must be one of ${SOURCES.map((s) => s.gamesTable).join(', ')}.`)
  }
  return parsed
}

export const HELP = `node scripts/mss_autogame.mjs [options] [-- autoteam options]

  --game <id>        skip the picker and use this game
  --table <name>     which table that id is in (games | season_schedule);
                     only needed when both hold a game with the same id
  --season <name|id> skip the season question -- name substring or season id
                     (--tournament is the same flag)
  --stadium <name>   stadium for this run (MSS_STADIUM); needed when the
                     schedule has none set
  --lineup <path>    where to write the exported lineup (default lineup.json)
  --filter <text>    only list games whose line contains this
  --limit <n>        how many games to list (default 25)
  --all              list every open game, ignoring --limit
  --python <exe>     python to run mss_autoteam.py with (default: python)
  --dry-run          pick and export, then stop -- reads Supabase and writes
                     the lineup file, but changes nothing in the database and
                     neither the bridge nor the emulator is touched
  --no-tracker       set the game up and start it, but run no bridge; this
                     also skips the wait for the first pitch, since there is
                     no tracker to hand off to
  --no-claim         do not set stats_source='tracker' on the chosen game
  -h, --help         this

Anything after a bare -- is passed straight to mss_autoteam.py, e.g.
  node scripts/mss_autogame.mjs --game 2706 -- --nav-preset safe
`

// ── supabase ────────────────────────────────────────────────────────────────
// The same two-table split the exporter and the bridge both carry: a
// tournament game and a season game describe the same thing in different
// tables, so both are searched and the row remembers which it came from.
export const SOURCES = [
  {
    gamesTable: 'games',
    sourceIdField: 'tournament_id',
    openStatuses: ['pending', 'active'],
    competitionType: 'tournament',
  },
  {
    gamesTable: 'season_schedule',
    sourceIdField: 'season_id',
    openStatuses: ['scheduled', 'in_progress'],
    competitionType: 'season',
  },
]

// What "this competition is over" looks like in each table. Deliberately two
// sets: seasons are marked 'completed' and tournaments 'complete', and writing
// one set that covers both would hide the fact that the two vocabularies
// really are different rather than one being a typo.
const SEASON_FINISHED = new Set(['completed'])
const TOURNAMENT_FINISHED = new Set(['complete'])

export function requireConfig(env) {
  if (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_ANON_KEY) {
    throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (check .env).')
  }
  if (!env.TRACKER_BRIDGE_EMAIL || !env.TRACKER_BRIDGE_PASSWORD) {
    throw new Error(
      'Missing TRACKER_BRIDGE_EMAIL / TRACKER_BRIDGE_PASSWORD. Reuse the '
      + '.env.tracker-bridge file the tracker bridge already reads.',
    )
  }
}

// ── the game list ───────────────────────────────────────────────────────────
// Every open game in both tables, rendered into one line each. The teams are
// resolved through the same joins the exporter uses, including the
// home_away_swapped flip -- the picker has to show the sides the way the
// export will read them, or a swapped game looks like the wrong fixture and
// gets skipped over.
export async function fetchCandidates(supabase) {
  const rows = []
  for (const source of SOURCES) {
    const { data, error } = await supabase
      .from(source.gamesTable).select('*').in('status', source.openStatuses)
    if (error) throw error
    for (const row of data || []) rows.push({ row, source })
  }
  if (!rows.length) return []

  const seasonIds = [...new Set(rows
    .filter((entry) => entry.source.gamesTable === 'season_schedule')
    .map((entry) => entry.row.season_id))]
  const teamIds = [...new Set(rows
    .filter((entry) => entry.source.gamesTable === 'season_schedule')
    .flatMap((entry) => [entry.row.home_team_id, entry.row.away_team_id])
    .filter((id) => id != null))]
  const playerIds = [...new Set(rows
    .filter((entry) => entry.source.gamesTable === 'games')
    .flatMap((entry) => [entry.row.team_a_player_id, entry.row.team_b_player_id])
    .filter((id) => id != null))]
  const tournamentIds = [...new Set(rows
    .filter((entry) => entry.source.gamesTable === 'games')
    .map((entry) => entry.row.tournament_id))]

  const [seasons, teams, players, tournaments] = await Promise.all([
    seasonIds.length
      ? supabase.from('seasons').select('id, name, status').in('id', seasonIds)
      : { data: [] },
    teamIds.length
      ? supabase.from('season_teams').select('id, team_name, player_id').in('id', teamIds)
      : { data: [] },
    playerIds.length
      ? supabase.from('players').select('id, name').in('id', playerIds)
      : { data: [] },
    tournamentIds.length
      ? supabase.from('tournaments').select('id, tournament_number, status, archived').in('id', tournamentIds)
      : { data: [] },
  ])

  const seasonById = new Map((seasons.data || []).map((s) => [String(s.id), s]))
  const teamById = new Map((teams.data || []).map((t) => [String(t.id), t]))
  const playerName = new Map((players.data || []).map((p) => [String(p.id), p.name]))
  // A tournaments table that is absent or unreadable is a cosmetic loss only,
  // so it never stops the listing -- the competition just shows as its id.
  const tournamentById = new Map((tournaments.data || []).map((t) => [String(t.id), t]))

  return rows.filter(({ row, source }) => {
    // A finished competition can still hold unplayed game rows, and they are
    // not games waiting to be played -- they are the ones that stopped
    // mattering when it ended. Tournament 1 is the case that showed this up:
    // it is `complete` and `archived`, its champion is recorded, and two
    // duplicate 'Championship Reset' rows sat at `pending` forever because
    // the reset was never needed. Filtering on the GAME's status alone
    // offered them as the next thing to play.
    //
    // The two tables spell "finished" differently -- seasons say 'completed'
    // (seasonPlayoffs.js), tournaments say 'complete' -- so both spellings
    // are listed rather than one being assumed to cover the other. The
    // `archived` flag is the tournaments table's own "put this away", and is
    // what the site's Navbar already separates on.
    if (source.gamesTable === 'season_schedule') {
      const season = seasonById.get(String(row.season_id))
      return !season || !SEASON_FINISHED.has(season.status)
    }
    const tournament = tournamentById.get(String(row.tournament_id))
    if (!tournament) return true
    return !tournament.archived && !TOURNAMENT_FINISHED.has(tournament.status)
  }).map(({ row, source }) => {
    let away
    let home
    let competition
    let round
    if (source.gamesTable === 'season_schedule') {
      competition = seasonById.get(String(row.season_id))?.name || `season ${row.season_id}`
      round = row.stage || (row.round_number != null ? `R${row.round_number}` : '')
      away = teamById.get(String(row.away_team_id))?.team_name
      home = teamById.get(String(row.home_team_id))?.team_name
    } else {
      // The tournaments table has no name column -- a tournament is known by
      // its number, which is what the site's own Navbar labels it with.
      const number = tournamentById.get(String(row.tournament_id))?.tournament_number
      competition = number != null ? `Tournament ${number}` : `tournament ${row.tournament_id}`
      round = row.stage || row.game_code || ''
      away = playerName.get(String(row.team_a_player_id))
      home = playerName.get(String(row.team_b_player_id))
    }
    if (row.home_away_swapped) [away, home] = [home, away]
    return {
      row,
      source,
      id: row.id,
      competition,
      // Kept beside the name so --season takes either. The name is what you
      // read off the list; the id is what the site's URLs and every other
      // script in here talk in, and having to translate between them to pick
      // a season would be a silly thing to make anyone do.
      competitionId: row[source.sourceIdField],
      round: round || '',
      away: away || '?',
      home: home || '?',
      // games stores a stadiums.id and no name; resolving it just to draw a
      // list is not worth a second round trip, and the exporter resolves it
      // properly a moment later anyway.
      stadium: row.stadium || null,
      status: row.status,
      isTracker: row.stats_source === 'tracker',
    }
  })
}

// Two calls, two jobs: --filter matches against the untabulated cells, while
// the listing pads them. Sharing one string between the two would make the
// filter depend on how wide the widest team name happened to be.
function candidateCells(entry) {
  return [
    `#${entry.id}`,
    `${entry.competition}${entry.round ? ` ${entry.round}` : ''}`,
    `${entry.away} @ ${entry.home}`,
    entry.stadium || 'no stadium set',
    [entry.status, entry.isTracker ? 'tracker' : null].filter(Boolean).join(', '),
  ]
}

// `games` and `season_schedule` number their rows independently, so the same
// integer can name a tournament game and a season game at once. Everything
// downstream -- this picker, the exporter's MSS_GAME_ID, the bridge's
// TRACKER_GAME_ID -- used to resolve an id by searching the two tables in a
// fixed order and taking the first hit, which is not a choice so much as a
// coin already flipped. Three processes each flipping it separately can also
// disagree: the list shows one fixture and the export applies the other.
//
// So an id that matches in both tables is an error here, and the table
// travels with it from this point on.
export function resolveById(entries, gameId, table) {
  const matches = entries.filter((entry) => entry.id === gameId
    && (!table || entry.source.gamesTable === table))
  if (matches.length > 1) {
    throw new Error(
      `Game id ${gameId} exists in both ${matches.map((m) => m.source.gamesTable).join(' and ')}. `
      + `Say which with --table ${matches[0].source.gamesTable}.`,
    )
  }
  return matches[0] || null
}

// One row by id, from whichever table has it. Only reached for a game that is
// not open, so it deliberately skips the status filter and describes the row
// plainly rather than pretending it is a fixture waiting to be played.
export async function fetchGameById(supabase, gameId, table) {
  const found = []
  for (const source of SOURCES) {
    if (table && source.gamesTable !== table) continue
    const { data, error } = await supabase
      .from(source.gamesTable).select('*').eq('id', gameId).maybeSingle()
    if (error) throw error
    if (!data) continue
    found.push({
      row: data,
      source,
      id: data.id,
      competition: source.gamesTable,
      competitionId: data[source.sourceIdField],
      round: '',
      // Left unresolved on purpose. This branch exists to re-apply a
      // finished game's lineup, and the teams are about to be printed in
      // full by the exporter -- joining them a second time here just to
      // draw a one-line header would be two round trips for a duplicate.
      away: null,
      home: null,
      stadium: data.stadium || null,
      status: data.status,
      isTracker: data.stats_source === 'tracker',
    })
  }
  if (found.length > 1) {
    throw new Error(
      `Game id ${gameId} exists in both ${found.map((m) => m.source.gamesTable).join(' and ')}. `
      + `Say which with --table ${found[0].source.gamesTable}.`,
    )
  }
  return found[0] || null
}

function renderCandidate(entry) {
  return candidateCells(entry).join('  ')
}

// Widths come from what is actually being shown rather than from constants,
// because team names here run from 'Dumbos' to 'Aschlompkin Bompkins' and a
// guessed column either wastes half the line or lets one row shove the rest
// out of alignment.
function renderTable(entries) {
  const rows = entries.map(candidateCells)
  const widths = rows.reduce((acc, cells) => cells.map(
    (cell, index) => Math.max(acc[index] || 0, cell.length),
  ), [])
  return rows.map((cells) => cells
    .map((cell, index) => (index === cells.length - 1 ? `(${cell})` : cell.padEnd(widths[index])))
    .join('  '))
}

function sortCandidates(list) {
  return list.slice().sort((a, b) => {
    if (a.competition !== b.competition) return a.competition.localeCompare(b.competition)
    return a.id - b.id
  })
}

export async function pickGame(supabase, candidates, options, io) {
  const { log } = io
  if (options.gameId) {
    const found = resolveById(candidates, options.gameId, options.table)
    if (found) return found
    // Not being in the open list is not fatal -- a finished game's lineup is
    // a perfectly good thing to re-apply, and the exporter already has an
    // MSS_ALLOW_FINISHED gate for exactly that. Refusing here regardless
    // would mean this wrapper could not reach a case the tool it wraps
    // supports, so the same env var opens the same door.
    if (io.env.MSS_ALLOW_FINISHED === '1') {
      const direct = await fetchGameById(supabase, options.gameId, options.table)
      if (direct) return direct
      throw new Error(`No game with id ${options.gameId} in games or season_schedule.`)
    }
    throw new Error(
      `Game ${options.gameId} is not one of the ${candidates.length} games waiting to `
      + 'be played. Check the id, or set MSS_ALLOW_FINISHED=1 to re-apply a '
      + "finished game's lineup.",
    )
  }

  let listed = sortCandidates(candidates)
  if (options.table) listed = listed.filter((entry) => entry.source.gamesTable === options.table)
  if (options.filter) {
    listed = listed.filter((entry) => renderCandidate(entry).toLowerCase().includes(options.filter))
    if (!listed.length) throw new Error(`Nothing matches --filter ${options.filter}.`)
  }

  const season = await pickCompetition(listed, options, io.ask, log)
  if (season) listed = listed.filter((entry) => entry.competition === season)
  return pickFromList(listed, candidates, options, io.ask, log)
}

// Which season/tournament, before which game. Without this step the list is
// one flat run of every open game in the database sorted by competition, and
// with 79 of them the first screen is 25 MSL Season 1 fixtures -- so the TEST
// season and the tournament are not merely inconvenient to reach, they are
// invisible, and the only way to a game in them is to already know its id.
// Raising --limit is not the fix: the answer to "which season" is four
// entries long and asking it directly costs one keystroke.
async function pickCompetition(listed, options, ask, log) {
  const names = [...new Set(listed.map((entry) => entry.competition))]
  if (names.length <= 1) return null

  if (options.season) {
    const wanted = String(options.season).toLowerCase()
    const matches = names.filter((name) => name.toLowerCase().includes(wanted))
    // An id is offered as well as a name because every other script here --
    // and the site's own URLs -- identify a season by its number.
    const byId = listed.find((entry) => String(entry.competitionId) === wanted)
    if (matches.length === 1) return matches[0]
    if (!matches.length && byId) return byId.competition
    if (matches.length > 1) {
      throw new Error(`--season ${options.season} matches ${matches.join(', ')}. Be more specific.`)
    }
    throw new Error(`No open games in a competition matching "${options.season}". Have: ${names.join(', ')}.`)
  }

  // --all asks for everything at once, which is a legitimate way to want this
  // list -- it is only the DEFAULT that needs narrowing.
  if (options.all) return null

  const counts = names.map((name) => ({
    name,
    count: listed.filter((entry) => entry.competition === name).length,
  }))
  const width = Math.max(...counts.map((entry) => entry.name.length))
  log('\nCompetitions with games waiting:\n')
  counts.forEach((entry, index) => {
    log(`  ${String(index + 1).padStart(3)}. ${entry.name.padEnd(width)}  ${entry.count} games`)
  })

  const answer = (await ask('\nWhich one? (number, or Enter for all)  ')).trim()
  if (!answer) return null
  const asNumber = Number(answer)
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= counts.length) {
    return counts[asNumber - 1].name
  }
  const byName = names.find((name) => name.toLowerCase().includes(answer.toLowerCase()))
  if (byName) return byName
  throw new Error(`"${answer}" is not one of 1..${counts.length}.`)
}

async function pickFromList(listed, candidates, options, ask, log) {
  const limit = options.all ? listed.length : (options.limit || 25)
  const shown = listed.slice(0, limit)

  log('\nGames waiting to be played:\n')
  renderTable(shown).forEach((line, index) => {
    log(`  ${String(index + 1).padStart(3)}. ${line}`)
  })
  if (listed.length > shown.length) {
    log(`\n  ...and ${listed.length - shown.length} more. `
      + 'Narrow with --filter, widen with --all, or pass --game <id>.')
  }

  const answer = (await ask('\nWhich game? (list number, or #id)  ')).trim()
  if (!answer) throw new Error('No game picked.')
  // A list number and a game id are both bare integers, so they are told
  // apart by range rather than by syntax: anything that indexes the list is
  // a list number, anything else is tried as an id. "#2706" forces the id
  // reading for the case where a game id really is that small.
  if (/^#/.test(answer)) {
    const byId = resolveById(candidates, Number(answer.slice(1)), options.table)
    if (!byId) throw new Error(`No open game with id ${answer.slice(1)}.`)
    return byId
  }
  const asNumber = Number(answer)
  if (!Number.isInteger(asNumber)) throw new Error(`"${answer}" is not a number.`)
  if (asNumber >= 1 && asNumber <= shown.length) return shown[asNumber - 1]
  // Falls back to the FULL candidate list, not the filtered one -- an id
  // typed here is unambiguous, and refusing it because a --season narrowed
  // the view would be pedantry.
  const byId = resolveById(candidates, asNumber, options.table)
  if (byId) return byId
  throw new Error(`${asNumber} is neither a listed number (1..${shown.length}) nor an open game id.`)
}

// The bridge refuses a TRACKER_GAME_ID whose row is not in Tracker mode, and
// that toggle is otherwise a trip to the site mid-setup. Flipping it here is
// the one write this script makes to Supabase, so it is announced rather than
// silent, and --no-claim leaves it alone.
//
// It happens AFTER the lineup export, not before. The export is where a
// lineup with eight batters, a doubled-up position, an unmapped Mii or no
// stadium is found, and it finds them by failing -- so claiming first meant a
// game that could not be exported was still left flipped into Tracker mode,
// where the site scores it from a tracker that is never going to run.
export async function claimGame(supabase, entry) {
  if (entry.isTracker) return false
  const { error } = await supabase
    .from(entry.source.gamesTable)
    .update({ stats_source: 'tracker' })
    .eq('id', entry.id)
  if (error) {
    throw new Error(
      `Could not set game ${entry.id} to Tracker mode: ${error.message}. `
      + 'Toggle it on the site, or pass --no-claim if it is already set.',
    )
  }
  return true
}

// ── child processes ─────────────────────────────────────────────────────────
function runToCompletion(spawnChild, command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnChild(command, args, { stdio: 'inherit', ...options })
    child.on('error', reject)
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

export async function exportLineup(entry, options, io) {
  const outPath = path.resolve(options.lineup || 'lineup.json')
  const childEnv = {
    ...io.childEnv,
    MSS_GAME_ID: String(entry.id),
    // Which of the two tables that id came from. Without it the exporter
    // repeats the same first-hit-wins search and can resolve a shared id to
    // the other table's game -- the picker shows one fixture, the export
    // applies another, and both look like they worked.
    MSS_GAME_TABLE: entry.source.gamesTable,
  }
  if (options.stadium) childEnv.MSS_STADIUM = options.stadium
  const code = await runToCompletion(io.spawn, io.execPath, [io.paths.exporter, '--out', outPath], { env: childEnv })
  if (code !== 0) {
    throw new Error(
      `The lineup export failed (exit ${code}). Nothing has been changed in the game.`,
    )
  }
  return outPath
}

// A bridge already running against this game means the tracker is already
// attached to it. Starting a second one gets as far as the game lock and then
// dies -- but by then this run has flipped the game into Tracker mode, written
// a lineup and started driving menus over a match that is already being
// played. The lock file is the bridge's own, and it is only READ here: an
// entry whose pid is gone is a crashed bridge, not a running one, and the
// bridge clears it itself on the way past.
export function assertNoRunningBridge(entry, io) {
  const lockPath = trackerGameLockPath({
    competitionType: entry.source.competitionType,
    gameId: entry.id,
    directory: io.lockDir,
  })
  const owner = trackerGameLockOwner(lockPath)
  if (!owner) return null
  throw new Error(
    `A tracker bridge (pid ${owner.pid}) already owns ${entry.source.competitionType} game ${entry.id}.\n`
    + `Its lock is ${lockPath}. Stop that bridge before starting another, or pass `
    + '--no-tracker to set this game up without one.',
  )
}

// ── the run ─────────────────────────────────────────────────────────────────
// Built lazily, and that is not a micro-optimisation. A run with --game never
// asks anything, and opening a readline interface on stdin for it put a live
// stdin handle on every non-interactive run -- closing which, one tick before
// process.exit(), crashes node on Windows with a libuv assertion
// (!(handle->flags & UV_HANDLE_CLOSING), src\winsync.c:76). The error was
// printed and then the exit code was 0xC0000409 instead of 1.
function defaultAsk() {
  let rl = null
  const ask = (question) => {
    if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    return new Promise((resolve) => { rl.question(question, resolve) })
  }
  ask.close = () => { rl?.close(); rl = null }
  return ask
}

export async function main(deps = {}) {
  const env = deps.env || loadEnv()
  const io = {
    env,
    childEnv: deps.childEnv || process.env,
    spawn: deps.spawn || spawn,
    execPath: deps.execPath || process.execPath,
    log: deps.log || ((...args) => console.log(...args)),
    logError: deps.logError || ((...args) => console.error(...args)),
    lockDir: deps.lockDir || os.tmpdir(),
    signalDir: deps.signalDir || os.tmpdir(),
    pid: deps.pid || process.pid,
    now: deps.now || (() => Date.now()),
    paths: { exporter: EXPORTER, autoteam: AUTOTEAM, bridge: BRIDGE, ...deps.paths },
    onSignal: deps.onSignal || ((name, handler) => process.on(name, handler)),
    offSignal: deps.offSignal || ((name, handler) => process.off(name, handler)),
    onExit: deps.onExit || ((handler) => process.once('exit', handler)),
    exit: deps.exit || ((code) => process.exit(code)),
    bridgeReadyTimeoutMs: Number(
      deps.bridgeReadyTimeoutMs
      ?? env.MSS_AUTOGAME_BRIDGE_READY_TIMEOUT_MS
      ?? DEFAULT_BRIDGE_READY_TIMEOUT_MS,
    ),
    recordingTimeoutMs: Number(
      deps.recordingTimeoutMs
      ?? env.MSS_AUTOGAME_RECORDING_TIMEOUT_MS
      ?? DEFAULT_RECORDING_TIMEOUT_MS,
    ),
    pollMs: deps.pollMs || 100,
    // Injected so a test writes its diagnostics into its own temp directory
    // rather than into the repository's archive.
    startupRecordDir: deps.startupRecordDir || STARTUP_RECORD_DIR,
    ask: deps.ask || null,
  }
  const { log } = io

  const options = parseArgs(deps.argv || process.argv.slice(2))
  if (options.help) {
    log(HELP)
    return 0
  }
  requireConfig(env)

  const supabase = deps.supabase
    || (deps.createSupabase || ((url, key) => createClient(url, key)))(
      env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY,
    )

  const { error: authError } = await supabase.auth.signInWithPassword({
    email: env.TRACKER_BRIDGE_EMAIL, password: env.TRACKER_BRIDGE_PASSWORD,
  })
  if (authError) throw new Error(`Supabase sign-in failed: ${authError.message}`)

  const candidates = await fetchCandidates(supabase)
  if (!candidates.length && !options.gameId) {
    throw new Error('No games are waiting to be played in either table.')
  }

  const ask = io.ask || defaultAsk()
  let entry
  try {
    entry = await pickGame(supabase, candidates, options, { ...io, ask })
  } finally {
    ask.close?.()
  }

  const where = `${entry.competition}${entry.round ? ` ${entry.round}` : ''}`
  log(entry.away && entry.home
    ? `\nGame ${entry.id}: ${entry.away} @ ${entry.home}  (${where})`
    : `\nGame ${entry.id} (${where}, ${entry.status})`)

  if (options.dryRun) {
    const outPath = await exportLineup(entry, options, io)
    log(`\nDry run: wrote ${outPath}. No database row and no emulator was touched.`)
    return 0
  }

  // Before the first external mutation, not after it. Everything below this
  // line changes something outside this process.
  if (!options.noTracker) assertNoRunningBridge(entry, io)

  const lineupPath = await exportLineup(entry, options, io)
  log(`  lineup exported to ${lineupPath}`)

  if (!options.noClaim && await claimGame(supabase, entry)) {
    log(`  set stats_source='tracker' on ${entry.source.gamesTable} ${entry.id}`)
  }

  return runLaunch({ entry, options, io, lineupPath })
}

// Everything past the point where a child process exists. Split out so that
// every way this can end -- a throw, a failed child, Ctrl+C -- leaves through
// the same finally block, which is the only place that owns cleanup.
async function runLaunch({ entry, options, io, lineupPath }) {
  const { log, logError } = io

  // A fresh path per run. A signal file left behind by a previous run would
  // release this run's tracker immediately, which is precisely the early
  // launch the gate exists to prevent -- so the name is unique and it is
  // removed on the way out either way. <signal>.ready is the bridge's half of
  // the same handshake and is cleaned up with it.
  const signalPath = path.join(io.signalDir, `mss-autogame-${io.pid}-${io.now()}.live`)
  const readyPath = `${signalPath}.ready`
  const recordingPath = `${signalPath}.recording`
  // The file that RELEASES the held game. The bridge writes it once both
  // readers are up; autoteam holds MSS's own pause menu at the pitch reset
  // until it appears. It is separate from <signal>.recording because the two
  // claims are different: recording evidence needs a running game clock and so
  // cannot possibly be produced while play is held.
  const readersPath = `${signalPath}.readers`

  const state = {
    stage: 'starting',
    bridge: null,
    bridgeExited: null,
    bridgeReady: false,
    autoteam: null,
    handedOff: false,
    matchLive: null, // 'confirmed' | 'unconfirmed'
    // 'readers_ready' | 'timeout' | 'not_held' | null (an older autoteam that
    // does not hold at all, which is reported rather than assumed).
    gameplayHold: null,
    gameplayHeldMs: null,
    cancelled: false,
    // What each stage actually cost, in wall-clock milliseconds. Printed at
    // the handoff because the one number nobody has ever had is how long the
    // gap between "go" and "frames on disk" really is.
    timings: {
      startedAt: Date.now(), bridgeReadyMs: null, handoffMs: null,
      recordingMs: null, gameplayHeldMs: null,
    },
  }

  const removeFile = (target) => { try { fs.unlinkSync(target) } catch { /* never written */ } }
  // The signal file outlives this process when the bridge is still using it.
  // The bridge polls for it every 250ms, so between the write and its next
  // poll there is a window in which deleting it strands the bridge for the
  // whole of TRACKER_LAUNCH_SIGNAL_TIMEOUT_MS -- and it then launches the
  // tracker on a timeout anyway, which is the failure the file exists to
  // prevent. So the file is only cleared once nothing is waiting on it.
  const bridgeStillWaiting = () => Boolean(
    state.handedOff && state.bridge && state.bridge.exitCode === null,
  )
  const cleanupFiles = () => {
    removeFile(readyPath)
    removeFile(recordingPath)
    removeFile(readersPath)
    if (!bridgeStillWaiting()) removeFile(signalPath)
  }
  // Belt and braces: a throw that escapes the finally below, or a hard exit,
  // must not leave a live signal file behind in the temp directory.
  io.onExit(cleanupFiles)

  // If a stale file is somehow sitting on this run's path, it is not a
  // handoff -- it is a lie that would release the tracker into a menu. The
  // unique name makes this near-impossible; checking costs one syscall and
  // turns "near-impossible" into "reported".
  if (fs.existsSync(signalPath) || fs.existsSync(readyPath)
      || fs.existsSync(recordingPath) || fs.existsSync(readersPath)) {
    logError(`[autogame] clearing a stale handoff file at ${signalPath}`)
    cleanupFiles()
  }

  // Only ever kills a bridge that is still holding its tracker. Past the
  // handoff there is a tracker .exe underneath it and a game being played, and
  // on Windows kill() is a TerminateProcess -- the bridge's own SIGTERM
  // cleanup would not run, so the tracker would be orphaned rather than
  // stopped. Before the handoff there is nothing under it to orphan.
  const stopBridge = () => {
    if (state.bridge && state.bridge.exitCode === null && !state.handedOff) {
      try { state.bridge.kill() } catch { /* already gone */ }
    }
  }
  // The python child is this process's own, and nothing else will reap it.
  // Ctrl+C in a shared console reaches it too, so this is usually a second
  // delivery of a signal it already had; a programmatic SIGTERM, or a --python
  // wrapper that detaches from the console, is the case where it is the only
  // one and the difference between a stopped child and an orphan.
  const stopAutoteam = () => {
    if (state.autoteam && state.autoteam.exitCode === null) {
      try { state.autoteam.kill() } catch { /* already gone */ }
    }
  }

  const onSignal = () => {
    state.cancelled = true
    logError(`\n[autogame] cancelled during ${state.stage}.`)
    stopAutoteam()
    if (state.handedOff) {
      logError('[autogame] the match was already live, so the bridge and its tracker '
        + 'have been left running. Stop them with Ctrl+C in their own window.')
    } else {
      stopBridge()
      logError('[autogame] the tracker was not started; nothing is recording this game.')
    }
    cleanupFiles()
    // 130 is a cancelled run, not a successful one. Reporting 0 here meant a
    // wrapper could not tell "the game was set up" from "someone stopped it
    // halfway through the menus".
    io.exit(130)
  }
  io.onSignal('SIGINT', onSignal)
  io.onSignal('SIGTERM', onSignal)

  try {
    if (!options.noTracker) {
      state.stage = 'bridge startup'
      log('\nStarting the tracker bridge (it will hold the tracker until the match is live)...')
      state.bridge = io.spawn(io.execPath, [io.paths.bridge], {
        stdio: 'inherit',
        env: {
          ...io.childEnv,
          TRACKER_GAME_ID: String(entry.id),
          // Same reason as MSS_GAME_TABLE on the exporter: the bridge would
          // otherwise resolve a shared id by searching the two tables in a
          // fixed order, and could write a season game's plate appearances
          // into the tournament game that happens to share its number.
          TRACKER_GAME_TABLE: entry.source.gamesTable,
          TRACKER_LAUNCH_SIGNAL: signalPath,
          TRACKER_LAUNCH_READY: readyPath,
          // The recording evidence, published here by the bridge once the 60 Hz
          // collector has frames on disk. Without it this launcher can say the
          // match is live and cannot say anything is being captured.
          TRACKER_LAUNCH_RECORDING: recordingPath,
          // Written the moment BOTH readers are up -- the tracker .exe started
          // and the collector attached. It is what autoteam is holding the
          // pause menu for, so it is the one file on this handshake that a
          // live game is waiting on, and the bridge writes it on failure as
          // well as on success for exactly that reason.
          TRACKER_LAUNCH_READERS: readersPath,
          // Whose handoff it is waiting for. If this process is killed in a
          // way it cannot catch -- TerminateProcess, a closed console window
          // -- nothing on Windows takes the bridge down with it, and it would
          // sit out its five-minute signal timeout and then launch a tracker
          // into whatever is on screen. The bridge watches this pid and gives
          // up instead.
          TRACKER_LAUNCH_OWNER_PID: String(io.pid),
        },
      })
      state.bridge.on('error', (err) => {
        state.bridgeExited = state.bridgeExited ?? { code: 1, error: err }
        logError(`bridge failed to start: ${err.message}`)
      })
      // A bridge that dies during startup -- a bad login, a missing tracker
      // .exe -- otherwise goes unmentioned until the game has been set up and
      // started, at which point there is nothing to be done about it. Its own
      // error has already printed by then; this says what that error COST.
      state.bridge.on('exit', (code) => {
        state.bridgeExited = state.bridgeExited ?? { code }
        if (!state.handedOff) {
          logError(`[autogame] the tracker bridge exited (code ${code}) before the handoff `
            + `-- this game will NOT be tracked. It got as far as: ${state.bridgeReady
              ? 'startup finished, waiting for the first pitch' : 'startup'}.`)
        }
      })

      // "It is running" is not "it is ready". The bridge signs in, takes the
      // game lock, loads the roster and repairs live state before it can hold
      // the tracker, and every one of those can fail. Waiting for it to say so
      // is what keeps a dead bridge from being discovered an hour later, with
      // the game played and nothing recorded.
      const ready = await waitForBridgeReady(state, readyPath, io)
      if (state.cancelled) return 130
      if (!ready.ok) {
        throw new Error(
          `The tracker bridge ${ready.reason}. Nothing has been done to the emulator.\n`
          + 'Its own error is printed above. Fix that and run this again -- the '
          + `lineup at ${lineupPath} is already exported and will be rewritten anyway.`,
        )
      }
      if (ready.warned) {
        logError(`[autogame] WARNING: the bridge has not finished starting up after `
          + `${Math.round(io.bridgeReadyTimeoutMs / 1000)}s, but it is still alive. `
          + 'Continuing; it will still catch the handoff, but it may launch the tracker late.')
      } else {
        state.timings.bridgeReadyMs = Date.now() - state.timings.startedAt
        log('  bridge ready: signed in, game locked, holding the tracker. '
          + `(${state.timings.bridgeReadyMs} ms)`)
      }
    }

    state.stage = 'menu navigation'
    log('\nDriving the menus. Start from the MAIN MENU with the cursor on Exhibition Mode.\n')
    const autoteamCode = await runAutoteam({ state, options, io, lineupPath, signalPath, readersPath })

    if (state.cancelled) return 130

    if (autoteamCode !== 0) {
      throw new Error(
        `mss_autoteam.py exited ${autoteamCode}.`
        + (state.handedOff
          ? ' The match was already live, so the tracker is running and has been left alone.'
          : ' The tracker was not started.')
        + '\nNothing here retries a half-navigated menu: put the game back on the '
        + 'main menu with the cursor on Exhibition Mode and run this again.',
      )
    }

    if (options.noTracker) {
      log('\nGame is set up. --no-tracker, so no bridge was started and no first '
        + 'pitch was waited for.')
      return 0
    }

    // Exit code 0 and no marker is the quiet failure this whole handshake
    // exists to catch: autoteam did its work and never said whether the match
    // came up, so the bridge is still holding a tracker that will launch on a
    // timeout -- against a menu, calibrating on a stale offset, logging a
    // whole game of zeroes without erroring once. Better to stop here and say
    // so while the bridge has nothing underneath it to orphan.
    if (!state.handedOff) {
      stopBridge()
      throw new Error(
        `mss_autoteam.py finished successfully but never reported the first pitch `
        + `(no ${MATCH_LIVE_MARKER} line). The bridge was stopped before it could `
        + 'launch a tracker against an unknown screen, and this game is NOT being '
        + 'tracked.\nIf a passthrough flag after -- changed --stage, that stage does '
        + 'not reach the handoff.',
      )
    }

    if (state.matchLive === 'confirmed') {
      log('\nHanded off on a confirmed pitch reset. The tracker is calibrating against '
        + 'a live game.')
    } else {
      logError('\n[autogame] WARNING: autoteam could NOT confirm a pitch reset and handed '
        + 'off on its timeout. The tracker has been released anyway, which is the right '
        + 'call, but nothing has proved the match is up -- watch the bridge log for '
        + 'the first at-bat, and stop it if the screen is still a menu.')
    }

    // The last claim, and the only one backed by bytes on disk. Everything
    // above proves a process is up; this proves frames are being written.
    const recording = await waitForCaptureRecording(state, recordingPath, io)
    reportRecording(recording, state, io)
    const startupRecord = writeStartupRecord({ entry, state, recording, io, signalPath })
    if (startupRecord) log(`  startup record: ${startupRecord}`)

    // The bridge outlives this script's useful work by an entire game, so from
    // here on this process exists only to hold the signal file's cleanup and to
    // pass Ctrl+C along.
    state.stage = 'game in progress'
    return await new Promise((resolve) => {
      if (state.bridge.exitCode !== null) resolve(state.bridge.exitCode ?? 0)
      else state.bridge.on('exit', (code) => resolve(code ?? 0))
    })
  } finally {
    // One exit path for every ending. Before this existed, a spawn error on
    // the python child threw straight past the bridge and left it running --
    // holding a tracker it would launch, five minutes later, into a menu.
    stopBridge()
    stopAutoteam()
    cleanupFiles()
    io.offSignal('SIGINT', onSignal)
    io.offSignal('SIGTERM', onSignal)
  }
}

// Resolves once the bridge has written its ready file, or died trying. A
// bridge that is merely slow is not an error -- it will still see the signal
// file whenever it gets there, because waitForLaunchSignal() checks for the
// file's existence before it starts polling.
async function waitForBridgeReady(state, readyPath, io) {
  // Wall clock, deliberately not io.now(): that one names the signal file and
  // a test pins it to a constant so the path is predictable, which would make
  // this deadline unreachable.
  const deadline = Date.now() + io.bridgeReadyTimeoutMs
  for (;;) {
    if (fs.existsSync(readyPath)) {
      state.bridgeReady = true
      return { ok: true }
    }
    if (state.bridgeExited) {
      return {
        ok: false,
        reason: state.bridgeExited.error
          ? `could not be started (${state.bridgeExited.error.message})`
          : `exited with code ${state.bridgeExited.code} before it finished starting up`,
      }
    }
    if (state.cancelled) return { ok: false, reason: 'was cancelled while it started up' }
    if (Date.now() >= deadline) return { ok: true, warned: true }
    await new Promise((resolve) => setTimeout(resolve, io.pollMs))
  }
}

// Resolves once the bridge has published the collector's recording evidence,
// or once it is clear none is coming. Unlike waitForBridgeReady this never
// fails the run: by the time it is called the match is live, the tracker has
// been released and a bridge is writing the game's statistics. Losing the 60 Hz
// capture costs the fielding and baserunning half of one game; stopping here
// would cost all of it.
async function waitForCaptureRecording(state, recordingPath, io) {
  const startedAt = Date.now()
  const deadline = startedAt + io.recordingTimeoutMs
  for (;;) {
    if (fs.existsSync(recordingPath)) {
      state.timings.recordingMs = Date.now() - startedAt
      try {
        return {
          ...JSON.parse(fs.readFileSync(recordingPath, 'utf8')),
          waitedMs: state.timings.recordingMs,
        }
      } catch (error) {
        // The file is written atomically, so an unreadable one is a real fault
        // rather than a torn read -- and it still answers the question, which
        // is that nothing has proved a capture.
        return {
          recording: false,
          reason: `unreadable evidence file: ${error.message}`,
          waitedMs: state.timings.recordingMs,
        }
      }
    }
    // A bridge that has exited will never write it. Say that rather than
    // waiting out the whole deadline for a file with no author left.
    if (state.bridgeExited) {
      return {
        recording: false,
        reason: `the bridge exited (code ${state.bridgeExited.code}) before it reported a capture`,
        waitedMs: Date.now() - startedAt,
      }
    }
    if (state.cancelled) {
      return {
        recording: false,
        reason: 'cancelled while waiting for capture evidence',
        waitedMs: Date.now() - startedAt,
      }
    }
    if (Date.now() >= deadline) {
      return {
        recording: false,
        reason: `no capture evidence after ${Math.round(io.recordingTimeoutMs / 1000)}s`,
        waitedMs: Date.now() - startedAt,
      }
    }
    await new Promise((resolve) => setTimeout(resolve, io.pollMs))
  }
}

// Where a run's startup record is kept. Deliberately beside the captures
// rather than in a temp directory: the three artefacts of one game -- the
// tracker log, the 60 Hz capture and the timings between them -- are only
// useful together, and the first two already live under data/.
export const STARTUP_RECORD_DIR = path.resolve('data/tracker_startup')

/**
 * Write down what this launch actually did, once, at the handoff.
 *
 * WHY IT IS WRITTEN AT ALL. Every number here exists only while this process
 * is alive: how long the bridge took to become ready, whether autoteam
 * confirmed a pitch reset or timed out, how long after the handoff the
 * collector had frames on disk, and which log and which capture belong to this
 * game. docs/tracker-launcher-orchestration.md lists "the gap between the
 * handoff and the collector's first frame" as a measurement nobody has taken;
 * this is where it lands. scripts/audit_tracking_archive.mjs currently
 * reconstructs the log/capture pairing from timestamps -- this records it
 * first-hand.
 *
 * Never fatal. A run that cannot write its diagnostics is still a tracked game.
 */
function writeStartupRecord({ entry, state, recording, io, signalPath }) {
  const directory = io.startupRecordDir || STARTUP_RECORD_DIR
  const record = {
    schema_version: 1,
    recorded_at: new Date().toISOString(),
    competition: entry.source.gamesTable === 'season_schedule' ? 'season' : 'tournament',
    game_id: entry.id,
    games_table: entry.source.gamesTable,
    stadium: entry.stadium || null,
    launcher_pid: io.pid,
    handoff_signal: signalPath,
    // Which claim each stage actually established -- see the five stages at the
    // top of this file. `match_live` is two-valued on purpose.
    stages: {
      bridge_ready: state.bridgeReady,
      match_live: state.matchLive,
      handed_off: state.handedOff,
      // Whether the opening play was actually protected, and how. Recorded as
      // its own stage because it is the only one of these that is a claim
      // about the GAME rather than about a process: null is an autoteam with
      // no hold at all, and reads as "not held".
      gameplay_hold: state.gameplayHold,
      capture_recording: Boolean(recording.recording),
      capture_disabled: Boolean(recording.disabled),
    },
    timings_ms: {
      bridge_ready: state.timings.bridgeReadyMs,
      handoff: state.timings.handoffMs,
      gameplay_held: state.timings.gameplayHeldMs,
      capture_after_handoff: recording.waitedMs ?? null,
      collector_first_frames_seconds: recording.firstFramesSeconds ?? null,
    },
    capture: {
      stem: recording.stem ?? null,
      frames: recording.frames ?? null,
      missed_frames: recording.missedFrames ?? null,
      bytes_on_disk: recording.bytesOnDisk ?? null,
      collector_pid: recording.collectorPid ?? null,
      park: recording.park ?? null,
      reason: recording.reason ?? null,
    },
    tracker_log: recording.sessionLogPath ?? null,
  }
  try {
    fs.mkdirSync(directory, { recursive: true })
    const name = `${record.competition}-${entry.id}-${record.recorded_at.replace(/[:.]/g, '-')}.json`
    const target = path.join(directory, name)
    fs.writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`)
    return target
  } catch (error) {
    io.logError(`[autogame] could not write the startup record: ${error.message}`)
    return null
  }
}

// One place that says what the whole startup cost and what is actually
// recording, because these numbers only exist while this process is alive.
function reportRecording(recording, state, io) {
  const { log, logError } = io
  const timing = `bridge ready ${state.timings.bridgeReadyMs ?? 'n/a'} ms, `
    + `handoff ${state.timings.handoffMs ?? 'n/a'} ms, `
    + `capture ${recording.waitedMs ?? 'n/a'} ms after the handoff`
  if (recording.recording) {
    log(`  60 Hz capture CONFIRMED: ${recording.frames} frames and `
      + `${recording.bytesOnDisk} bytes on disk ${recording.firstFramesSeconds}s into the `
      + `session (${recording.stem || 'stem not reported'}).`)
    log(`  timings: ${timing}`)
    return
  }
  if (recording.disabled) {
    log(`  60 Hz capture is off for this run (${recording.reason}). The game is scored `
      + 'either way; it will have no fielding or baserunning measurements.')
    log(`  timings: ${timing}`)
    return
  }
  logError(`\n[autogame] WARNING: nothing has proved the 60 Hz capture is recording `
    + `(${recording.reason || 'no reason reported'}).`)
  logError('[autogame] The game IS being scored -- the at-bat feed and the database do not '
    + 'depend on the collector -- but this game will have no fielding, baserunning or '
    + 'throw measurements unless the collector recovers. Check the bridge window.')
  logError(`[autogame] timings: ${timing}`)
}

function runAutoteam({ state, options, io, lineupPath, signalPath, readersPath }) {
  const { log, logError } = io
  // -u because this stdout is a pipe, and a buffered marker is a marker that
  // arrives after the thing it was supposed to announce.
  //
  // --wait-for-live is only asked for when there is a bridge holding a tracker
  // that the answer releases. With --no-tracker it is up to three minutes of
  // waiting for a handoff that has nowhere to go, which is not what the help
  // text promises.
  const autoteamArgs = ['-u', io.paths.autoteam, '--lineup', lineupPath, '--stage', 'all',
    ...(options.noTracker ? [] : ['--wait-for-live']),
    // Only with a bridge to wait for. --no-tracker has no readers coming, so
    // holding the game would be a pause nobody was ever going to release.
    ...(options.noTracker || !readersPath ? [] : ['--hold-until', readersPath]),
    ...options.passthrough]

  return new Promise((resolve, reject) => {
    const child = io.spawn(options.python || io.env.MSS_PYTHON || 'python', autoteamArgs, {
      stdio: ['inherit', 'pipe', 'inherit'],
    })
    state.autoteam = child

    const onLine = (line) => {
      log(`[autoteam] ${line}`)
      const held = GAMEPLAY_HELD_PATTERN.exec(line.trim())
      if (held) {
        state.gameplayHold = 'holding'
        log('[autogame] gameplay is HELD at the pitch reset while both readers start.')
        return
      }
      const resumed = GAMEPLAY_RESUMED_PATTERN.exec(line.trim())
      if (resumed) {
        state.gameplayHold = resumed[1]
        state.timings.gameplayHeldMs = Math.round(Number(resumed[2] || 0) * 1000)
        if (resumed[1] === 'readers_ready') {
          log(`[autogame] both readers were up ${(Number(resumed[2]) || 0).toFixed(1)}s into the `
            + 'hold; play resumed with the opening pitch protected.')
        } else if (resumed[1] === 'timeout') {
          logError('[autogame] WARNING: the readers did not report ready inside the hold. Play '
            + 'resumed anyway rather than leaving the match paused -- the opening play may not '
            + 'be captured.')
        } else if (resumed[1] === 'readers_failed') {
          // The handshake ARRIVED and said the scoring reader is not running.
          // That is not a slow start and waiting longer cannot fix it, so the
          // hold ends immediately -- and this is the one outcome that has to
          // be said in the launcher's own voice, because the game about to be
          // played will not be recorded by anything.
          logError('[autogame] ERROR: the tracker bridge reported that its scoring reader did '
            + 'NOT start. This game will NOT be scored. Play resumed rather than leaving the '
            + 'match paused; stop here and fix the tracker if the game matters.')
        } else {
          logError('[autogame] WARNING: gameplay was NOT held. The readers are starting against '
            + 'a live game, which is the race this hold exists to remove.')
        }
        return
      }
      const marker = MATCH_LIVE_PATTERN.exec(line.trim())
      if (!marker) return
      // A bare token is an older mss_autoteam.py, which printed the same line
      // whether it saw a pitch reset or gave up waiting for one. Read as the
      // weaker of the two, because the other reading claims something no
      // version of that script ever promised.
      const status = marker[1] === 'confirmed' ? 'confirmed' : 'unconfirmed'
      if (state.handedOff) {
        // Two markers in one run means a stage printed it twice. The tracker
        // is already released; saying so again would read as a second handoff.
        if (status === 'confirmed') state.matchLive = 'confirmed'
        logError(`[autogame] ignoring a repeated ${MATCH_LIVE_MARKER} (${status}); `
          + 'the tracker was released on the first one.')
        return
      }
      state.matchLive = status
      try {
        fs.writeFileSync(signalPath, `${new Date().toISOString()} ${status}\n`)
      } catch (error) {
        // Thrown inside a readline handler, this would be an unhandled
        // rejection and the run would look fine while the bridge sat waiting
        // out its timeout and then launched the tracker into a menu.
        logError(`[autogame] COULD NOT write the handoff file ${signalPath}: ${error.message}. `
          + 'The tracker will not be released; stop the bridge and start over.')
        return
      }
      state.handedOff = true
      state.timings.handoffMs = Date.now() - state.timings.startedAt
      log(status === 'confirmed'
        ? '[autogame] match is live at a pitch reset -- releasing the tracker.'
        : `[autogame] autoteam timed out waiting for the first pitch and handed off `
          + 'anyway -- releasing the tracker, but the match is NOT confirmed live.')
    }

    // Both halves matter. `exit` fires when the process is gone, which can be
    // before its last stdout chunk has been read -- and the marker is often
    // the very last line, so deciding the handoff on `exit` alone raced the
    // signal file into existence after the decision that reads it. Waiting for
    // the stdout stream to close as well makes the line count exact.
    //
    // The wait is bounded because the pipe is not this process's to close: a
    // grandchild that inherited the handle keeps it open after python is gone,
    // and an unbounded wait there would hang a finished run forever. A missed
    // last line is a bad outcome; a launcher that never returns is a worse one,
    // so it says which happened rather than choosing silently.
    let code = null
    let stdoutClosed = false
    let settled = false
    let grace = null
    const settle = () => {
      if (settled || code === null || !stdoutClosed) return
      settled = true
      clearTimeout(grace)
      resolve(code)
    }

    const lines = readline.createInterface({ input: child.stdout })
    lines.on('line', onLine)
    lines.on('close', () => { stdoutClosed = true; settle() })

    child.on('error', reject)
    child.on('exit', (received) => {
      code = received ?? 1
      if (stdoutClosed) return settle()
      grace = setTimeout(() => {
        if (settled) return
        logError(`[autogame] mss_autoteam.py exited ${code} but its output pipe is still `
          + `open after ${STDOUT_DRAIN_GRACE_MS}ms; continuing without the last of it.`)
        stdoutClosed = true
        settle()
      }, STDOUT_DRAIN_GRACE_MS)
      // Never hold the process open for the grace period alone.
      grace.unref?.()
      settle()
    })
  })
}

// process.exit() cannot be called straight after the Supabase client has been
// used. undici's sockets are still being torn down at that moment, and exiting
// into that on Windows aborts node with
//   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:76
// and an exit code of 0xC0000409 -- so a run that meant to report a clean
// failure reports a crash instead, and anything reading the exit code sees
// neither 0 nor 1. Setting exitCode lets the loop drain on its own; the
// unref'd timer is the backstop for the auth client's refresh timer, and only
// fires if something really is still holding the loop open by then.
function finish(code) {
  process.exitCode = code
  const bail = setTimeout(() => process.exit(code), 2000)
  bail.unref?.()
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  main()
    .then((code) => finish(code))
    .catch((error) => {
      console.error(`\nmss_autogame: ${error.message}`)
      finish(1)
    })
}
