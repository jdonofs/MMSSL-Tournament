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
