// Exports the lineup the site already holds for the current game into the
// shape Mario Super Sluggers wants, so scripts/mss_autoteam.py can apply it
// without anyone retyping a roster into a second tool.
//
// This is the site half of the MSS-AutoTeam replacement. It deliberately owns
// every name/index table, because the Python half drives menus and memory and
// should never need to know what a character is called -- it receives resolved
// MSS indices and nothing else. Keeping the tables on one side of the boundary
// is the whole reason there is a boundary.
//
// Usage:
//   node scripts/export_mss_lineup.mjs                    # prints JSON
//   node scripts/export_mss_lineup.mjs --out lineup.json  # writes a file
//
// Config (env vars, same file the tracker bridge already uses):
//   VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY     - reused from the main .env
//   TRACKER_BRIDGE_EMAIL / TRACKER_BRIDGE_PASSWORD - a Supabase login with
//     scorebook_access or is_commissioner (RLS requires it)
//   MSS_GAME_TABLE    - optional 'games' or 'season_schedule'; pins which table
//     MSS_GAME_ID is an id in, for the case where both hold that number
//   MSS_GAME_ID       - optional; otherwise the single game currently set to
//     stats_source='tracker' is used, exactly as the tracker bridge resolves it.
//     A pinned id must still be a game waiting to be played; MSS_ALLOW_FINISHED=1
//     lifts that.
//   MSS_STARS / MSS_ITEMS - 1/0 overrides; the site does not model these
//   MSS_MII_MAP       - path to a JSON map of Mii colour -> MSS roster index
//                       (default scripts/mss_mii_map.json when it exists)

import fs from 'node:fs'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { CAPTAIN_TEAM_MAP } from '../src/utils/teamIdentity.js'
import { normalizeRegulationInnings } from '../src/utils/gameRules.js'
import {
  CAPTAIN_CHAR_INDEXES,
  CHAR_INDEX_BY_MSS_NAME,
  CHAR_LIST,
  FIRST_MII_INDEX,
  POSITIONS,
  SITE_NAME_TO_MSS_NAME,
  STADIUMS,
  stadiumTimeOfDay,
} from './mss_roster.mjs'

// -- MSS tables -------------------------------------------------------------
// The game's own orderings live in scripts/mss_roster.mjs, shared with the
// calibration planner. None of them may be reordered.

const CAPTAIN_NAME_BY_LOGO_KEY = Object.fromEntries(
  Object.entries(CAPTAIN_TEAM_MAP).map(([name, meta]) => [meta.logoKey, name]),
)

// -- env --------------------------------------------------------------------
function loadEnvFile(filePath) {
  const env = {}
  if (!fs.existsSync(filePath)) return env
  fs.readFileSync(filePath, 'utf8').split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex <= 0) return
    env[trimmed.slice(0, eqIndex).trim()] = trimmed.slice(eqIndex + 1).trim()
  })
  return env
}

const env = {
  ...loadEnvFile(path.resolve('.env')),
  ...loadEnvFile(path.resolve('.env.tracker-bridge')),
  ...process.env,
}

const SUPABASE_URL = env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = env.VITE_SUPABASE_ANON_KEY
const BRIDGE_EMAIL = env.TRACKER_BRIDGE_EMAIL
const BRIDGE_PASSWORD = env.TRACKER_BRIDGE_PASSWORD

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (check .env).')
}
if ((!BRIDGE_EMAIL || !BRIDGE_PASSWORD) && !env.MSS_EXPORT_ACCESS_TOKEN) {
  throw new Error(
    'Missing TRACKER_BRIDGE_EMAIL / TRACKER_BRIDGE_PASSWORD. Reuse the '
    + '.env.tracker-bridge file the tracker bridge already reads.',
  )
}

// The launcher has just signed in to pick the game. Reuse that session for
// this child process instead of paying for the same login again. Standalone
// exports still sign in normally.
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY,
  env.MSS_EXPORT_ACCESS_TOKEN
    ? { accessToken: async () => env.MSS_EXPORT_ACCESS_TOKEN }
    : undefined)

// Mirrors the tracker bridge: a tournament game and a season game live in
// different tables but describe the same thing, so both are searched.
const SOURCES = [
  {
    gamesTable: 'games',
    rosterTable: 'draft_picks',
    teamLineups: 'team_lineups',
    teamLineupsSourceField: 'tournament_id',
    sourceIdField: 'tournament_id',
    sourceTable: 'tournaments',
    // TournamentGameSessionProvider: mercy is on unless the tournament says false.
    mercyDefault: true,
    openStatuses: ['pending', 'active'],
  },
  {
    gamesTable: 'season_schedule',
    rosterTable: 'season_roster',
    teamLineups: 'season_team_lineups',
    teamLineupsSourceField: 'season_id',
    sourceIdField: 'season_id',
    sourceTable: 'seasons',
    // SeasonGameSessionProvider: mercy is off unless explicitly true.
    mercyDefault: false,
    openStatuses: ['scheduled', 'in_progress'],
  },
]

// The auto-resolve path below can only ever pick an open game -- it filters on
// openStatuses. An explicit MSS_GAME_ID skips that filter entirely, which is
// how a finished game gets picked by hand and its lineup applied to a fresh
// match. Nothing downstream would complain: a completed game has perfectly
// good lineups, so the run looks like it worked. Hence the same check, made
// explicit, with a way past it for the case where re-applying an old game's
// lineup is genuinely what you want.
function assertGameIsOpen(row, source) {
  if (env.MSS_ALLOW_FINISHED === '1') return
  if (source.openStatuses.includes(row.status)) return
  throw new Error(
    `Game ${row.id} has status '${row.status}', not one of `
    + `${source.openStatuses.join('/')}, so it is not a game waiting to be played. `
    + 'Pick a scheduled game, or set MSS_ALLOW_FINISHED=1 if you really do want '
    + "this one's lineup.",
  )
}

async function resolveTargetGame() {
  const targetId = env.MSS_GAME_ID || env.TRACKER_GAME_ID
  // Which of the two tables that id lives in, when the caller already knows.
  // `games` and `season_schedule` number their rows independently, so one
  // integer can name a game in each -- and searching them in a fixed order and
  // taking the first hit means this file and the caller that chose the game
  // can resolve the same id to different fixtures, both looking like they
  // worked. scripts/mss_autogame.mjs passes the table it picked from.
  const targetTable = env.MSS_GAME_TABLE || null
  if (targetTable && !SOURCES.some((source) => source.gamesTable === targetTable)) {
    throw new Error(
      `MSS_GAME_TABLE must be one of ${SOURCES.map((s) => s.gamesTable).join(', ')}, not "${targetTable}".`,
    )
  }
  if (targetId) {
    if (!Number.isInteger(Number(targetId)) || Number(targetId) < 1) {
      throw new Error(`MSS_GAME_ID must be a positive whole number, not "${targetId}".`)
    }
    const found = []
    for (const source of SOURCES) {
      if (targetTable && source.gamesTable !== targetTable) continue
      const { data, error } = await supabase
        .from(source.gamesTable).select('*').eq('id', Number(targetId)).maybeSingle()
      if (error) throw error
      if (data) found.push({ row: data, source })
    }
    if (found.length > 1) {
      throw new Error(
        `Game id ${targetId} exists in both ${found.map(({ source }) => source.gamesTable).join(' and ')}. `
        + 'Set MSS_GAME_TABLE to say which.',
      )
    }
    if (found.length === 1) {
      assertGameIsOpen(found[0].row, found[0].source)
      return found[0]
    }
    throw new Error(`No game with id ${targetId} in ${targetTable || 'games or season_schedule'}.`)
  }

  const candidates = []
  for (const source of SOURCES) {
    if (targetTable && source.gamesTable !== targetTable) continue
    const { data, error } = await supabase
      .from(source.gamesTable).select('*')
      .eq('stats_source', 'tracker').in('status', source.openStatuses)
    if (error) throw error
    for (const row of data || []) candidates.push({ row, source })
  }
  if (candidates.length === 0) {
    throw new Error(
      "No game is set to stats_source='tracker' right now. Toggle a game into "
      + 'Tracker mode on the site first, or set MSS_GAME_ID.',
    )
  }
  if (candidates.length > 1) {
    throw new Error(
      `Multiple games are in Tracker mode (${candidates.map((c) => c.row.id).join(', ')}). `
      + 'Set MSS_GAME_ID to disambiguate.',
    )
  }
  return candidates[0]
}

// -- Miis -------------------------------------------------------------------
// The site models every Mii as the single character "Mii" plus a colour, while
// MSS addresses Miis by their position in the console's Mii Plaza database.
// Nothing in either dataset can bridge that -- the colour is a site concept and
// the roster index is a per-console fact -- so it has to be stated once, by
// hand, and after that it is just a lookup. An unmapped Mii is a hard error
// rather than a guess, because guessing puts a stranger's Mii on the field and
// the run still looks like it worked.
function loadMiiMap() {
  const configured = env.MSS_MII_MAP
    ? path.resolve(env.MSS_MII_MAP)
    : path.resolve('scripts/mss_mii_map.json')
  if (!fs.existsSync(configured)) return { byPlayer: {}, byColor: {} }
  const parsed = JSON.parse(fs.readFileSync(configured, 'utf8'))
  if (!parsed || typeof parsed !== 'object') return { byPlayer: {}, byColor: {} }
  return {
    byPlayer: parsed.byPlayer || {},
    // A bare object is read as byColor, which is what this file used to be.
    byColor: parsed.byColor || (parsed.byPlayer ? {} : parsed),
  }
}

const MII_MAP = loadMiiMap()

// -- the console's own Mii list ---------------------------------------------
// A Mii is identified here by NAME, and the name is read off the Wii's Mii
// database rather than typed into the map as a number. Two reasons, and the
// second is the load-bearing one.
//
// Counting positions in a menu by hand is miserable and goes stale the moment
// a Mii is added. That is the obvious reason.
//
// The real one is that a wrong answer here is otherwise silent. There are two
// RFL_DB.dat files on this machine -- the standard install's and the portable
// one the running Dolphin actually uses -- and they hold DIFFERENT Miis: 4 in
// one, 29 in the other. A hand-typed offset of 20 is a perfectly good number
// against both and means a different person in each, so the run would look
// like it worked and field a stranger. Resolving "garfield" by name cannot do
// that: the wrong database has no garfield in it and says so.
const RFL_MAGIC = 'RNOD'
const RFL_FIRST_ENTRY = 0x04
const RFL_ENTRY_BYTES = 0x4A
const RFL_NAME_OFFSET = 0x02
const RFL_NAME_BYTES = 20 // 10 UTF-16BE characters

function miiDatabasePath() {
  if (env.MSS_MII_DB) return path.resolve(env.MSS_MII_DB)
  const appData = env.APPDATA || process.env.APPDATA
  if (appData) {
    const standard = path.join(appData, 'Dolphin Emulator', 'Wii', 'shared2', 'menu', 'FaceLib', 'RFL_DB.dat')
    if (fs.existsSync(standard)) return standard
  }
  return null
}

// Entries are fixed-width and the list is dense from the front, so a Mii's
// offset is simply its entry number. Trailing slots are zeroed or 0x7FFF
// padding and are skipped rather than counted -- counting them would shift
// every offset after the first gap.
function loadMiiDatabase() {
  const dbPath = miiDatabasePath()
  if (!dbPath || !fs.existsSync(dbPath)) return { path: dbPath, miis: [] }
  const data = fs.readFileSync(dbPath)
  if (data.subarray(0, 4).toString('latin1') !== RFL_MAGIC) {
    throw new Error(`${dbPath} is not a Wii Mii database (expected magic ${RFL_MAGIC}).`)
  }
  const miis = []
  for (let index = 0; ; index += 1) {
    const start = RFL_FIRST_ENTRY + index * RFL_ENTRY_BYTES
    if (start + RFL_ENTRY_BYTES > data.length) break
    const raw = data.subarray(start + RFL_NAME_OFFSET, start + RFL_NAME_OFFSET + RFL_NAME_BYTES)
    const name = raw.swap16().toString('utf16le').split('\u0000')[0].trim()
    // 0x7FFF is the padding a cleared slot is filled with; an empty name is an
    // unused slot. Either way the real list has ended.
    if (!name || name.charCodeAt(0) === 0x7FFF) break
    miis.push({ index, name })
  }
  return { path: dbPath, miis }
}

let MII_DB = null
function miiDatabase() {
  if (!MII_DB) MII_DB = loadMiiDatabase()
  return MII_DB
}

// Names are stored exactly as they were typed on the Wii -- this console's
// Garfield is "garfield" -- so matching is case-insensitive. Anything else
// turns a capital letter into a missing Mii.
function miiOffsetByName(name) {
  const wanted = String(name).trim().toLowerCase()
  const hit = miiDatabase().miis.find((mii) => mii.name.toLowerCase() === wanted)
  return hit ? hit.index : null
}

function describeMiiDatabase() {
  const db = miiDatabase()
  if (!db.path) {
    return 'No Mii database found. Set MSS_MII_DB to the RFL_DB.dat of the Dolphin '
      + 'install you actually play on, e.g. '
      + 'D:\\Wii\\Dolphin-x64\\User\\Wii\\shared2\\menu\\FaceLib\\RFL_DB.dat'
  }
  if (!db.miis.length) return `${db.path} holds no Miis.`
  return `${db.path} holds ${db.miis.length} Miis: `
    + db.miis.map((mii) => mii.name).join(', ')
}

// A map entry is a Mii's name, its menu position, or both.
//
// Both is the useful form, and the reason is that the two numbers are not the
// same. MSS's Mii MENU is not the console's RFL_DB.dat list: counted off the
// screen on this console, page 3 begins with 'family guy' at position 21 while
// RFL_DB has it at index 19, and every Mii checked sits one later in the menu
// than in the file. Something occupies the front of the game's list that is
// not in the database, and the file's last Mii never appears -- which is also
// why the last page shows nine faces and an empty slot rather than ten.
//
// That +1 is measured on one console and explained by nothing, so it is not
// applied as a rule. What the map holds is the position someone actually read
// off the screen, and the name is kept beside it as the thing that can be
// checked: a wrong MSS_MII_DB stops the run, and a menuOffset that has drifted
// from the name's place in the file is reported rather than silently trusted.
//
// A bare name still works and means "use the file's index", which is right on
// any console where the two agree. A bare number means "trust me".
function offsetFromMapEntry(entry, describeKey) {
  if (typeof entry === 'number') return entry
  if (typeof entry === 'string') return offsetFromMapEntry({ name: entry }, describeKey)
  if (!entry || typeof entry !== 'object') return null

  let fromName = null
  if (entry.name) {
    fromName = miiOffsetByName(entry.name)
    if (fromName == null) {
      throw new Error(
        `${describeKey} names the Mii "${entry.name}", which is not on this console.\n`
        + `${describeMiiDatabase()}\n`
        + 'Either the name is spelled differently on the Wii, or MSS_MII_DB points '
        + 'at the wrong Dolphin install -- a machine can easily have more than one, '
        + 'holding different Miis.',
      )
    }
  }

  if (entry.menuOffset == null) return fromName
  if (fromName != null && fromName !== entry.menuOffset) {
    warn(
      `${describeKey}: "${entry.name}" is index ${fromName} in the Mii database but `
      + `menuOffset says ${entry.menuOffset}. Using ${entry.menuOffset}, since that is `
      + 'the position read off the game\'s own menu. If Miis have been added or '
      + 'deleted on the Wii since, re-count the menu and update it.',
    )
  }
  return entry.menuOffset
}

function resolveMiiIndex(playerName, playerId, miiColor) {
  // By player first. The site models a Mii as one character plus a colour, but
  // colour is not recorded anywhere that matters: season_roster has no such
  // column at all, and draft_picks.mii_color is null on every row in the
  // database. A Mii belongs to a PERSON, so that is what the map keys on.
  for (const key of [playerName, playerId]) {
    if (!key) continue
    const entry = MII_MAP.byPlayer[key]
      ?? Object.entries(MII_MAP.byPlayer)
        .find(([name]) => name.toLowerCase() === String(key).toLowerCase())?.[1]
    if (entry != null) {
      const offset = offsetFromMapEntry(entry, `byPlayer["${key}"]`)
      if (offset != null) return FIRST_MII_INDEX + offset
    }
  }
  if (miiColor) {
    const entry = MII_MAP.byColor[miiColor]
    if (entry != null) {
      const offset = offsetFromMapEntry(entry, `byColor["${miiColor}"]`)
      // The map states a Mii's offset among the Miis, which is what the Wii's
      // own Mii Plaza list shows; the game's roster index is that offset past
      // the built-in cast.
      if (offset != null) return FIRST_MII_INDEX + offset
    }
  }
  return null
}

// -- character resolution ---------------------------------------------------
function toMssCharIndex(siteName, miiColor, owner = {}) {
  if (siteName === 'Mii') {
    const index = resolveMiiIndex(owner.playerName, owner.playerId, miiColor)
    if (index == null) {
      const who = owner.playerName || owner.playerId || 'someone'
      throw new Error(
        `${who} has a Mii in their lineup, but no Mii is mapped to them.\n\n`
        + 'Say which one in scripts/mss_mii_map.json:\n\n'
        + `  { "byPlayer": { "${owner.playerName || 'PlayerName'}": "garfield" } }\n\n`
        + 'The value is the Mii\'s name as it is spelled on the Wii.\n'
        + describeMiiDatabase(),
      )
    }
    return index
  }
  const mssName = SITE_NAME_TO_MSS_NAME[siteName] || siteName
  const index = CHAR_INDEX_BY_MSS_NAME[mssName]
  if (index == null) {
    throw new Error(
      `Character "${siteName}" has no match in MSS's roster. If the site has `
      + 'added a character, map it in SITE_NAME_TO_MSS_NAME.',
    )
  }
  return index
}

// -- team assembly ----------------------------------------------------------
// A team is nine rows of [charIndex, battingSlot, fieldingSlot]. Row order is
// batting order here; main.py let it be roster-entry order and then treated row
// zero as the captain, which is an accident of its GUI rather than a rule, so
// the captain is resolved explicitly instead.
function buildTeam({ label, playerId, playerName, teamLogoKey, lineup, characterById, miiColorByCharacterId }) {
  const lineupOrder = lineup?.lineupOrder || []
  const fieldingPositions = lineup?.fieldingPositions || {}

  if (lineupOrder.length !== 9) {
    throw new Error(
      `${label} (${playerName || playerId}) has ${lineupOrder.length} batters in its `
      + `${lineup?.derived ? 'roster' : 'saved lineup'}, not 9. `
      + 'Open the roster page on the site and save a full lineup first.',
    )
  }

  const positionByCharacterId = new Map()
  for (const [positionId, characterId] of Object.entries(fieldingPositions)) {
    positionByCharacterId.set(String(characterId), positionId)
  }

  const slots = lineupOrder.map((characterId, battingSlot) => {
    const character = characterById.get(String(characterId))
    if (!character) {
      throw new Error(`${label} batting slot ${battingSlot + 1} references unknown character id ${characterId}.`)
    }
    const positionId = positionByCharacterId.get(String(characterId))
    if (!positionId) {
      throw new Error(
        `${label}: ${character.name} is in the batting order but has no fielding position. `
        + 'Assign all nine positions on the site and save.',
      )
    }
    const fieldingSlot = POSITIONS.indexOf(positionId)
    if (fieldingSlot === -1) {
      throw new Error(`${label}: unknown fielding position "${positionId}" for ${character.name}.`)
    }
    const miiColor = miiColorByCharacterId.get(String(characterId)) || null
    return {
      battingSlot,
      fieldingSlot,
      positionId,
      charIndex: toMssCharIndex(character.name, miiColor, { playerName, playerId }),
      siteName: character.name,
      characterId,
      miiColor,
    }
  })

  const assignedPositions = new Set(slots.map((slot) => slot.fieldingSlot))
  if (assignedPositions.size !== 9) {
    throw new Error(
      `${label} does not cover all nine fielding positions -- `
      + `${9 - assignedPositions.size} are doubled up or missing.`,
    )
  }

  return { label, playerId, playerName, slots, captainSlot: resolveCaptainSlot(label, teamLogoKey, slots) }
}

// MSS stores a captain as an index into its twelve-long captain list. The site
// already knows each team's captain -- team_logo_key is set from it when the
// first pick is made -- so that is the answer when it is present. Falling back
// to the first captain-eligible batter keeps a team with no logo working, and
// a team with no eligible character at all is rejected rather than silently
// given someone else's captain.
function resolveCaptainSlot(label, teamLogoKey, slots) {
  const namedCaptain = CAPTAIN_NAME_BY_LOGO_KEY[teamLogoKey]
  if (namedCaptain) {
    const charIndex = CHAR_INDEX_BY_MSS_NAME[SITE_NAME_TO_MSS_NAME[namedCaptain] || namedCaptain]
    const captainSlot = CAPTAIN_CHAR_INDEXES.indexOf(charIndex)
    if (captainSlot !== -1) return captainSlot
  }
  for (const slot of slots) {
    const captainSlot = CAPTAIN_CHAR_INDEXES.indexOf(slot.charIndex)
    if (captainSlot !== -1) return captainSlot
  }
  throw new Error(
    `${label} has no captain-eligible character and no team logo to derive one from. `
    + 'MSS requires a captain per team.',
  )
}

// Warnings go to stderr because the payload itself goes to stdout -- a caller
// doing `node export_mss_lineup.mjs | ...` must still get clean JSON.
function warn(message) {
  console.error(`export_mss_lineup: ${message}`)
}

// The order the roster page falls back to when a team has never explicitly
// saved a lineup. Copied from reconcileSavedLineup() in Roster.jsx and
// SeasonRoster.jsx, and it must stay in step with them: batting order is
// roster order, and the first nine characters fill these positions in turn.
const LINEUP_POSITIONS = [
  'pitcher', 'catcher', 'firstBase', 'secondBase', 'thirdBase',
  'shortStop', 'leftField', 'centerField', 'rightField',
]

async function fetchLineup(source, sourceId, playerId) {
  const { data, error } = await supabase
    .from(source.teamLineups)
    .select('lineup_order, fielding_positions')
    .eq(source.teamLineupsSourceField, sourceId)
    .eq('player_id', playerId)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  return {
    lineupOrder: Array.isArray(data.lineup_order) ? data.lineup_order : [],
    fieldingPositions: data.fielding_positions && typeof data.fielding_positions === 'object'
      ? data.fielding_positions
      : {},
    derived: false,
  }
}

// A team's roster in the order the site lists it: created_at for a season,
// pick_number for a tournament. Season rosters name a character rather than
// referencing one, so they need the characters table to resolve; tournament
// draft picks already carry character_id.
async function fetchRosterCharacterIds(source, sourceId, playerId, characterIdByName) {
  if (source.rosterTable === 'draft_picks') {
    const { data, error } = await supabase
      .from('draft_picks').select('character_id, pick_number')
      .eq('tournament_id', sourceId).eq('player_id', playerId).order('pick_number')
    if (error) throw error
    return (data || []).map((pick) => pick.character_id).filter((id) => id != null)
  }

  // season_roster is keyed by team, not by player, so the team has to be
  // looked up first -- and is_active matters, since a dropped character stays
  // on the table as a row.
  const { data: team, error: teamError } = await supabase
    .from('season_teams').select('id')
    .eq('season_id', sourceId).eq('player_id', playerId).maybeSingle()
  if (teamError) throw teamError
  if (!team) return []
  const { data, error } = await supabase
    .from(source.rosterTable).select('character_name, is_active, created_at')
    .eq('season_id', sourceId).eq('team_id', team.id).order('created_at')
  if (error) throw error
  return (data || [])
    .filter((entry) => entry.is_active !== false)
    .map((entry) => characterIdByName.get(entry.character_name))
    .filter((id) => id != null)
}

// What the roster page shows a team that has never saved a lineup. The page
// derives this rather than storing it, so a team can look perfectly set up on
// the site with no row behind it -- which is exactly what happened when only
// two of six season-71 teams turned out to have rows. Exporting the derived
// default is what "the lineup the site already holds" actually means; the
// alternative was refusing games whose lineups are visible on screen.
async function deriveLineup(source, sourceId, playerId, characterIdByName) {
  const rosterIds = await fetchRosterCharacterIds(source, sourceId, playerId, characterIdByName)
  if (!rosterIds.length) return null
  const fieldingPositions = {}
  rosterIds.slice(0, LINEUP_POSITIONS.length).forEach((characterId, index) => {
    fieldingPositions[LINEUP_POSITIONS[index]] = characterId
  })
  return { lineupOrder: rosterIds, fieldingPositions, derived: true }
}

// mii_color is recorded on draft_picks only; season_roster stores a character
// name and no colour, so a season Mii resolves to null here and fails loudly
// in toMssCharIndex rather than quietly picking a Mii.
async function fetchMiiColors(source, playerIds) {
  const byCharacterId = new Map()
  if (source.rosterTable !== 'draft_picks') return byCharacterId
  const { data, error } = await supabase
    .from('draft_picks').select('player_id, character_id, mii_color').in('player_id', playerIds)
  if (error) throw error
  for (const pick of data || []) {
    if (pick.mii_color) byCharacterId.set(String(pick.character_id), pick.mii_color)
  }
  return byCharacterId
}

// The two game tables name their teams completely differently: `games` stores
// player ids inline, while `season_schedule` stores season_teams ids and has to
// be joined through. Both then run through home_away_swapped, which flips which
// side is away without touching the underlying columns -- and since MSS's
// team1/team2 are away/home, missing that swap silently reverses both teams.
async function resolveSides(source, row) {
  let awayPlayerId
  let homePlayerId
  const logoKeyByPlayerId = new Map()

  if (source.gamesTable === 'games') {
    awayPlayerId = row.team_a_player_id
    homePlayerId = row.team_b_player_id
  } else {
    const { data: teams, error } = await supabase
      .from('season_teams').select('id, player_id, team_logo_key')
      .in('id', [row.away_team_id, row.home_team_id])
    if (error) throw error
    const byTeamId = new Map((teams || []).map((team) => [String(team.id), team]))
    awayPlayerId = byTeamId.get(String(row.away_team_id))?.player_id ?? null
    homePlayerId = byTeamId.get(String(row.home_team_id))?.player_id ?? null
    for (const team of teams || []) {
      if (team.player_id) logoKeyByPlayerId.set(String(team.player_id), team.team_logo_key)
    }
  }

  if (row.home_away_swapped) {
    [awayPlayerId, homePlayerId] = [homePlayerId, awayPlayerId]
  }
  return { awayPlayerId, homePlayerId, logoKeyByPlayerId }
}

// Tournament teams keep their identity in a separate table. It is a nicety
// here -- without it resolveCaptainSlot falls back to the first captain-
// eligible batter -- so a missing table must not stop an otherwise fine export.
async function fetchTournamentLogoKeys(source, playerIds) {
  const byPlayerId = new Map()
  if (source.gamesTable !== 'games') return byPlayerId
  const { data, error } = await supabase
    .from('tournament_teams').select('player_id, team_logo_key').in('player_id', playerIds)
  if (error) return byPlayerId
  for (const team of data || []) byPlayerId.set(String(team.player_id), team.team_logo_key)
  return byPlayerId
}

// The two tables record the stadium differently: season_schedule stores the
// name as text, while games stores only a stadiums.id (a uuid) and has no text
// column at all. Both end up as a name, which is what matches MSS -- all nine
// names are spelled identically on both sides, apostrophe included.
async function resolveStadium(row) {
  if (row.stadium) return row.stadium
  if (row.stadium_id) {
    const { data, error } = await supabase
      .from('stadiums').select('name').eq('id', row.stadium_id).maybeSingle()
    if (error) throw error
    if (data?.name) return data.name
  }
  return null
}

// `games` has no innings or mercy_rule column at all, and a season_schedule row
// may leave them null, so reading only the game row sent every tournament game
// to MSS as 3 innings whatever the tournament was set to. The scorebook resolves
// game row first, then the season/tournament; this does the same.
async function resolveRules(source, row) {
  const { data: parent, error } = await supabase
    .from(source.sourceTable).select('innings, mercy_rule')
    .eq('id', row[source.sourceIdField]).maybeSingle()
  if (error) throw error
  const innings = normalizeRegulationInnings(row.innings ?? parent?.innings, 3)
  const mercyRule = row.mercy_rule ?? parent?.mercy_rule ?? source.mercyDefault
  return { innings, mercy: mercyRule === true ? 1 : 0 }
}

// An unset stadium used to fall back to index 0, which is Mario Stadium -- a
// real park, silently substituted for the one the schedule meant. That is the
// worst possible failure here: the run looks like it worked and the game is
// played somewhere else. So a missing stadium stops the export, and MSS_STADIUM
// exists for the case where you genuinely want to pick one by hand.
function resolveStadiumIndex(stadiumName) {
  const override = env.MSS_STADIUM
  const name = override || stadiumName
  if (!name) {
    throw new Error(
      'This game has no stadium set on the schedule, so there is nothing to '
      + 'pick. Set the stadium on the site, or pass MSS_STADIUM="Mario Stadium" '
      + 'to choose one for this run.',
    )
  }
  const index = STADIUMS.indexOf(name)
  if (index === -1) {
    throw new Error(
      `Stadium "${name}" is not one of MSS's nine stadiums: ${STADIUMS.join(', ')}.`,
    )
  }
  return { stadiumName: name, stadiumIndex: index }
}

async function main() {
  if (!env.MSS_EXPORT_ACCESS_TOKEN) {
    const { data: auth, error: authError } = await supabase.auth.signInWithPassword({
      email: BRIDGE_EMAIL, password: BRIDGE_PASSWORD,
    })
    if (authError || !auth?.session) {
      throw new Error(`Supabase sign-in failed: ${authError?.message || 'no session'}`)
    }
  }

  const { row, source } = await resolveTargetGame()
  const sourceId = row[source.sourceIdField]

  const { awayPlayerId, homePlayerId, logoKeyByPlayerId: seasonLogoKeys } = await resolveSides(source, row)
  if (!awayPlayerId || !homePlayerId) {
    throw new Error(`Game ${row.id} does not have both teams assigned yet.`)
  }
  const playerIds = [awayPlayerId, homePlayerId]

  const [{ data: characters, error: charError }, { data: players, error: playerError }] = await Promise.all([
    supabase.from('characters').select('id, name'),
    supabase.from('players').select('id, name').in('id', playerIds),
  ])
  if (charError) throw charError
  if (playerError) throw playerError

  const characterById = new Map((characters || []).map((c) => [String(c.id), c]))
  const playerNameById = new Map((players || []).map((p) => [String(p.id), p.name]))

  const characterIdByName = new Map((characters || []).map((c) => [c.name, c.id]))

  let [awayLineup, homeLineup, miiColorByCharacterId, tournamentLogoKeys, stadiumName] = await Promise.all([
    fetchLineup(source, sourceId, awayPlayerId),
    fetchLineup(source, sourceId, homePlayerId),
    fetchMiiColors(source, playerIds),
    fetchTournamentLogoKeys(source, playerIds),
    resolveStadium(row),
  ])
  const logoKeyByPlayerId = seasonLogoKeys.size ? seasonLogoKeys : tournamentLogoKeys

  const [resolvedAwayLineup, resolvedHomeLineup] = await Promise.all([
    awayLineup || deriveLineup(source, sourceId, awayPlayerId, characterIdByName),
    homeLineup || deriveLineup(source, sourceId, homePlayerId, characterIdByName),
  ])
  awayLineup = resolvedAwayLineup
  homeLineup = resolvedHomeLineup

  for (const [label, lineup, playerId] of [['Away', awayLineup, awayPlayerId], ['Home', homeLineup, homePlayerId]]) {
    const who = playerNameById.get(String(playerId)) || playerId
    if (!lineup) {
      throw new Error(
        `${label} team (${who}) has no saved lineup in ${source.teamLineups} and no `
        + `roster in ${source.rosterTable} to derive one from.`,
      )
    }
    if (lineup.derived) {
      warn(
        `${label} team (${who}) has no saved lineup; using the roster-order default `
        + 'the site shows. Save on its roster page to pin it.',
      )
    }
  }

  const away = buildTeam({
    label: 'Away',
    playerId: awayPlayerId,
    playerName: playerNameById.get(String(awayPlayerId)),
    teamLogoKey: logoKeyByPlayerId.get(String(awayPlayerId)),
    lineup: awayLineup,
    characterById,
    miiColorByCharacterId,
  })
  const home = buildTeam({
    label: 'Home',
    playerId: homePlayerId,
    playerName: playerNameById.get(String(homePlayerId)),
    teamLogoKey: logoKeyByPlayerId.get(String(homePlayerId)),
    lineup: homeLineup,
    characterById,
    miiColorByCharacterId,
  })

  const stadium = resolveStadiumIndex(stadiumName)

  // The site models innings and the mercy rule; it has no concept of stars or
  // items, so those keep MSS's own defaults unless overridden.
  const { innings, mercy } = await resolveRules(source, row)
  const stars = env.MSS_STARS != null ? Number(env.MSS_STARS) : 1
  const items = env.MSS_ITEMS != null ? Number(env.MSS_ITEMS) : 1

  return {
    generatedAt: new Date().toISOString(),
    game: {
      id: row.id,
      table: source.gamesTable,
      sourceId,
      stadium: stadium.stadiumName,
      stadiumIndex: stadium.stadiumIndex,
      // MSS stores day as 0 and night as 1 (main.py's setDay radio buttons).
      // Three parks exist at only one time of day and lose every gimmick when
      // written to the other one, so the schedule's flag is overridden there
      // rather than passed through -- see STADIUM_FIXED_TIME_OF_DAY.
      isNight: stadiumTimeOfDay(stadium.stadiumName, row.is_night),
      homeAwaySwapped: Boolean(row.home_away_swapped),
    },
    // How many Miis the console has. The Mii menu's last page behaves
    // differently from the others, so navigating it needs the count -- and
    // this side already has the database open to resolve names, so making the
    // Python side ask for it again with --total-miis was asking a person to
    // retype something already known. Null when no database is readable,
    // which keeps --total-miis meaningful as an override.
    miiCount: miiDatabase().miis.length || null,
    // [innings, stars, items, mercy] -- the order finalize() writes them in.
    rules: [innings, stars, items, mercy],
    away,
    home,
  }
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

main()
  .then((payload) => {
    const json = `${JSON.stringify(payload, null, 2)}\n`
    const outIndex = process.argv.indexOf('--out')
    if (outIndex !== -1 && process.argv[outIndex + 1]) {
      const outPath = path.resolve(process.argv[outIndex + 1])
      // Temp file plus rename. The reader is another process a moment later,
      // and a lineup truncated by a crash mid-write is a file that parses to
      // the wrong nine batters rather than one that fails to parse.
      const staging = `${outPath}.${process.pid}.tmp`
      fs.writeFileSync(staging, json)
      fs.renameSync(staging, outPath)
      console.error(`Wrote ${outPath}`)
    } else {
      process.stdout.write(json)
    }
    finish(0)
  })
  .catch((error) => {
    console.error(`export_mss_lineup: ${error.message}`)
    finish(1)
  })
