export const STADIUM_ORDER = [
  'Mario Stadium',
  "Luigi's Mansion",
  'Peach Ice Garden',
  'Daisy Cruiser',
  'Wario City',
  'Yoshi Park',
  'DK Jungle',
  'Bowser Jr. Playroom',
  'Bowser Castle',
]

export const STADIUM_NAME_TO_KEY = {
  'Mario Stadium': 'mario_stadium',
  "Luigi's Mansion": 'luigis_mansion',
  'Peach Ice Garden': 'peach_ice_garden',
  'Daisy Cruiser': 'daisy_cruiser',
  'Wario City': 'wario_city',
  'Yoshi Park': 'yoshi_park',
  'DK Jungle': 'dk_jungle',
  'Bowser Jr. Playroom': 'bowser_jr_playroom',
  'Bowser Castle': 'bowser_castle',
}

const STADIUM_LOGO_PATHS = {
  'Mario Stadium': '/stadiums/mario_stadium_en.png',
  "Luigi's Mansion": '/stadiums/luigis_mansion_en.png',
  'Peach Ice Garden': '/stadiums/peach_ice_garden_en.png',
  'Daisy Cruiser': '/stadiums/daisy_cruiser_en.png',
  'Wario City': '/stadiums/wario_city_en.png',
  'Yoshi Park': '/stadiums/yoshi_park_en.png',
  'DK Jungle': '/stadiums/dk_jungle_en.png',
  'Bowser Jr. Playroom': '/stadiums/bowser_jr_playroom_en.png',
  'Bowser Castle': '/stadiums/bowser_castle_en.png',
  Entrance: '/stadiums/entrance_en.png',
}

export function getOrderedStadiums(stadiums = []) {
  const order = new Map(STADIUM_ORDER.map((name, index) => [name, index]))
  return [...stadiums].sort((a, b) => (order.get(a.name) ?? 999) - (order.get(b.name) ?? 999))
}

export function getStadiumKeyByName(name) {
  if (!name) return null
  return STADIUM_NAME_TO_KEY[name] ?? null
}

export const STADIUM_KEY_TO_NAME = Object.fromEntries(
  Object.entries(STADIUM_NAME_TO_KEY).map(([name, key]) => [key, name]),
)

export function getStadiumNameByKey(key) {
  if (!key) return null
  return STADIUM_KEY_TO_NAME[key] ?? null
}

// stadium_game_log (tournaments) and season_stadium_game_log (seasons) are historical-only
// append tables, and they store the stadium reference differently (stadium_id vs. stadium
// name text). These are the only valid select() columns for each table. Import these rather
// than hand-writing the select string, since a hardcoded mismatch 400s the query silently in
// a Promise.all and can wipe an entire page's stats (see useCharacterProfileData.js).
export const STADIUM_GAME_LOG_SELECT = 'game_id,stadium_id'
export const SEASON_STADIUM_GAME_LOG_SELECT = 'game_id,stadium'

export function buildStadiumKeyByGameId(games = [], stadiums = [], stadiumLog = []) {
  const stadiumNameById = Object.fromEntries(
    stadiums.map((stadium) => [String(stadium.id), stadium.name]),
  )
  const result = {}

  games.forEach((game) => {
    const gameId = String(game.id)
    const stadiumName = game.stadium
      || stadiumNameById[String(game.stadium_id)]
      || null
    const stadiumKey = getStadiumKeyByName(stadiumName)
    if (stadiumKey) result[gameId] = stadiumKey
  })

  stadiumLog.forEach((entry) => {
    const gameId = String(entry.game_id)
    if (result[gameId]) return
    const stadiumName = entry.stadium
      || stadiumNameById[String(entry.stadium_id)]
      || null
    const stadiumKey = getStadiumKeyByName(stadiumName)
    if (stadiumKey) result[gameId] = stadiumKey
  })

  return result
}

export function normalizeIsNightForStadium(stadium, isNight) {
  if (!stadium) return Boolean(isNight)
  if (stadium.night_only) return true
  if (stadium.day_only) return false
  return Boolean(isNight)
}

export function stadiumTimeToggleDisabled(stadium) {
  return Boolean(stadium?.night_only || stadium?.day_only)
}

export function getStadiumTimeLabel(stadium, isNight) {
  return normalizeIsNightForStadium(stadium, isNight) ? 'Night' : 'Day'
}

export function getChaosStars(level = 0) {
  const normalized = Math.max(0, Math.min(4, Number(level || 0)))
  return '★'.repeat(normalized) + '☆'.repeat(4 - normalized)
}

export function getChaosTagColors(level = 0) {
  const normalized = Number(level || 0)
  if (normalized >= 4) {
    return { background: 'rgba(239,68,68,0.16)', border: 'rgba(239,68,68,0.45)', color: '#FCA5A5' }
  }
  if (normalized >= 3) {
    return { background: 'rgba(245,158,11,0.16)', border: 'rgba(245,158,11,0.45)', color: '#FCD34D' }
  }
  if (normalized >= 1) {
    return { background: 'rgba(59,130,246,0.16)', border: 'rgba(59,130,246,0.45)', color: '#93C5FD' }
  }
  return { background: 'rgba(148,163,184,0.14)', border: 'rgba(148,163,184,0.38)', color: '#CBD5E1' }
}

export function getStadiumSpriteStyle(name, extra = {}) {
  const directPath = STADIUM_LOGO_PATHS[name]
  if (directPath) {
    return {
      backgroundImage: `url('${directPath}')`,
      backgroundRepeat: 'no-repeat',
      backgroundSize: 'contain',
      backgroundPosition: 'center',
      ...extra,
    }
  }

  const rowIndex = Math.max(0, STADIUM_ORDER.indexOf(name))
  const rowPercent = STADIUM_ORDER.length > 1 ? (rowIndex / (STADIUM_ORDER.length - 1)) * 100 : 0
  return {
    backgroundImage: "url('/stadiums/stadium-logos.png')",
    backgroundRepeat: 'no-repeat',
    backgroundSize: '300% 900%',
    backgroundPosition: `0% ${rowPercent}%`,
    ...extra,
  }
}
