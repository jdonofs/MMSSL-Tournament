export const PLAYER_SKILL_TIERS = {
  jason: { tier: 1, tournamentWins: 1, tournamentAppearances: 1, skillScore: 1.0 },
  may: { tier: 1, tournamentWins: 1, tournamentAppearances: 1, skillScore: 1.0 },
  nick: { tier: 2, tournamentWins: 0, tournamentAppearances: 1, skillScore: 0.78 },
  aidan: { tier: 3, tournamentWins: 0, tournamentAppearances: 0, skillScore: 0.55 },
  donovan: { tier: 3, tournamentWins: 0, tournamentAppearances: 0, skillScore: 0.55 },
  justin: { tier: 4, tournamentWins: 0, tournamentAppearances: 0, skillScore: 0.25 },
}

export const CAPTAIN_TEAM_MAP = {
  Mario: { logoKey: 'mario-fireballs' },
  Luigi: { logoKey: 'luigi-knights' },
  Peach: { logoKey: 'peach-monarchs' },
  Daisy: { logoKey: 'daisy-flowers' },
  Wario: { logoKey: 'wario-muscles' },
  Waluigi: { logoKey: 'waluigi-symbiants' },
  Yoshi: { logoKey: 'yoshi-eggs' },
  Birdo: { logoKey: 'birdo-bows' },
  'Donkey Kong': { logoKey: 'dk-wilds' },
  'Diddy Kong': { logoKey: 'diddy-monkeys' },
  Bowser: { logoKey: 'bowser-monsters' },
  'Bowser Jr.': { logoKey: 'bowser-rookies' },
  'Bowser Jr': { logoKey: 'bowser-rookies' },
}

export const CAPTAIN_NAMES = Object.keys(CAPTAIN_TEAM_MAP)

export const TEAM_LOGO_SPRITES = {
  'mario-fireballs': { x: 0, y: 0, width: 154, height: 52 },
  'luigi-knights': { x: 154, y: 0, width: 154, height: 52 },
  'peach-monarchs': { x: 308, y: 0, width: 154, height: 52 },
  'daisy-flowers': { x: 462, y: 0, width: 155, height: 52 },
  'wario-muscles': { x: 0, y: 52, width: 154, height: 52 },
  'waluigi-symbiants': { x: 154, y: 52, width: 154, height: 52 },
  'yoshi-eggs': { x: 308, y: 52, width: 154, height: 52 },
  'birdo-bows': { x: 462, y: 52, width: 155, height: 52 },
  'dk-wilds': { x: 0, y: 104, width: 154, height: 52 },
  'diddy-monkeys': { x: 154, y: 104, width: 154, height: 52 },
  'bowser-monsters': { x: 308, y: 104, width: 154, height: 52 },
  'bowser-rookies': { x: 462, y: 104, width: 155, height: 52 },
}

export function normalizePlayerName(name = '') {
  return String(name).trim().toLowerCase()
}

export function getPlayerSkillProfile(playerOrName) {
  const key = normalizePlayerName(typeof playerOrName === 'string' ? playerOrName : playerOrName?.name)
  return PLAYER_SKILL_TIERS[key] || {
    tier: 4,
    tournamentWins: 0,
    tournamentAppearances: 0,
    skillScore: 0.4,
  }
}

// Builds the standard team identity shape from a season_teams row, used to
// drive logos, abbreviations, and team colors across season views.
export function buildSeasonTeamIdentity(team) {
  return {
    teamName: team.team_name,
    teamMascot: team.team_mascot || null,
    teamAbbreviation: team.team_abbreviation || null,
    teamPrimaryColor: team.team_primary_color || null,
    teamSecondaryColor: team.team_secondary_color || null,
    teamLogoKey: team.team_logo_key || null,
    teamLogoUrl: team.logo_url || null,
  }
}

// Returns true if the given CSS color is (effectively) white.
function isWhiteColor(color) {
  if (!color) return false
  const normalized = String(color).trim().toLowerCase()
  if (normalized === 'white' || normalized === '#fff' || normalized === '#ffffff') return true

  const hexMatch = normalized.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/)
  if (hexMatch) {
    const hex = hexMatch[1]
    const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex
    return full === 'ffffff'
  }

  const rgbMatch = normalized.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (rgbMatch) {
    return rgbMatch[1] === '255' && rgbMatch[2] === '255' && rgbMatch[3] === '255'
  }

  return false
}

// Returns the team's chosen primary color, falling back to the player's
// personal color for teams that haven't set one yet. If the resulting color
// is white, the team's secondary color is used instead so text remains
// visible against the site's dark backgrounds.
export function getTeamPrimaryColor(team, fallbackColor) {
  const primary = (team?.team_primary_color ?? team?.teamPrimaryColor) || fallbackColor || null
  if (primary && isWhiteColor(primary)) {
    const secondary = team?.team_secondary_color ?? team?.teamSecondaryColor
    if (secondary) return secondary
  }
  return primary
}

// Returns the short "mascot" form of a team name for compact lists
// (e.g. "Cleveland Kings" -> "Kings"). Falls back to the last word of the
// full name for teams that haven't set an explicit mascot yet.
export function getTeamShortName(team) {
  const mascot = team?.team_mascot ?? team?.teamMascot
  if (mascot) return mascot

  const fullName = team?.team_name ?? team?.teamName
  if (!fullName) return null

  const parts = String(fullName).trim().split(/\s+/)
  return parts[parts.length - 1] || fullName
}

function deriveCompactAbbreviation(name) {
  const words = String(name || '')
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/[^a-z0-9]/gi, ''))
    .filter(Boolean)

  if (!words.length) return null

  if (words.length > 1) {
    const initials = words.map((word) => word[0]).join('').toUpperCase()
    if (initials.length >= 3) return initials.slice(0, 3)

    const filler = words
      .slice(1)
      .join('')
      .slice(1)
      .replace(/[^a-z0-9]/gi, '')
      .toUpperCase()

    return `${initials}${filler}`.slice(0, 3)
  }

  const normalized = words[0].toUpperCase()
  const consonants = normalized.replace(/[AEIOU]/g, '')
  const compact = `${normalized[0] || ''}${consonants.slice(1)}${normalized.replace(/[^AEIOU]/g, '').slice(0, 2)}`.replace(/[^A-Z0-9]/g, '')

  return (compact || normalized).slice(0, Math.min(3, normalized.length))
}

// Returns the short abbreviation for a team (e.g. "CLE"), falling back to
// the mascot/short name for teams that haven't set one yet.
export function getTeamAbbreviation(team) {
  const abbreviation = team?.team_abbreviation ?? team?.teamAbbreviation
  if (abbreviation) return String(abbreviation).trim().toUpperCase()

  return deriveCompactAbbreviation(getTeamShortName(team) || team?.team_name || team?.teamName)
}

export function getCaptainIdentityFromName(characterName) {
  return CAPTAIN_TEAM_MAP[characterName] || null
}

export function isCaptainCharacterName(characterName) {
  return Boolean(getCaptainIdentityFromName(characterName))
}

function buildIdentityFromPick(pick, charactersById = {}) {
  if (!pick?.player_id) return null

  const characterName =
    pick.captain_character_name ||
    charactersById[pick.character_id]?.name ||
    null

  const captainIdentity = getCaptainIdentityFromName(characterName)
  const teamLogoKey = pick.team_logo_key || captainIdentity?.logoKey || null
  if (!teamLogoKey && !characterName) return null

  return {
    playerId: pick.player_id,
    captainCharacterId: pick.character_id || null,
    captainCharacterName: characterName,
    teamLogoKey,
    draftPickId: pick.id,
  }
}

function resolveProfileTeamName(profile) {
  if (!profile) return null

  const explicitName = String(profile.team_name || '').trim()
  if (explicitName) return explicitName

  const derivedName = [profile.team_location, profile.team_mascot]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ')

  return derivedName || null
}

// playerProfilesByPlayerId: { [playerId]: { team_name, team_logo_url, team_primary_color, team_secondary_color, color } }
// logoUrlsByPlayerId: per-tournament overrides from tournament_team_logos
export function buildTournamentTeamIdentityMap(
  draftPicks = [],
  charactersById = {},
  logoUrlsByPlayerId = {},
  playerProfilesByPlayerId = {},
) {
  const firstPicksByPlayer = {}

  draftPicks
    .filter((pick) => pick?.player_id)
    .slice()
    .sort((a, b) => Number(a.pick_number || 0) - Number(b.pick_number || 0))
    .forEach((pick) => {
      if (firstPicksByPlayer[pick.player_id]) return
      if (!pick.character_id) return

      const explicitIdentity = pick.is_captain ? buildIdentityFromPick(pick, charactersById) : null
      if (explicitIdentity) {
        firstPicksByPlayer[pick.player_id] = explicitIdentity
        return
      }

      const inferredIdentity = buildIdentityFromPick(pick, charactersById)
      if (inferredIdentity) {
        firstPicksByPlayer[pick.player_id] = inferredIdentity
      }
    })

  const playerIds = new Set([
    ...Object.keys(firstPicksByPlayer),
    ...Object.keys(playerProfilesByPlayerId),
    ...Object.keys(logoUrlsByPlayerId),
  ])

  const identitiesByPlayerId = {}

  // Merge player custom profiles and per-tournament logo overrides.
  // Captain-derived Mario team names are intentionally ignored here.
  for (const playerId of playerIds) {
    const base = firstPicksByPlayer[playerId] || { playerId }
    const profile = playerProfilesByPlayerId[playerId]
    const tournamentLogoUrl = logoUrlsByPlayerId[playerId]
    const teamName = resolveProfileTeamName(profile)
    const teamLogoUrl = tournamentLogoUrl || profile?.team_logo_url || base.teamLogoUrl || null
    const hasIdentityData = Boolean(
      teamName
      || teamLogoUrl
      || profile?.team_primary_color
      || profile?.team_secondary_color
      || profile?.color
      || profile?.team_abbreviation
      || profile?.team_location
      || profile?.team_mascot
      || base.teamLogoKey
      || base.captainCharacterId
      || base.captainCharacterName,
    )

    if (!hasIdentityData) continue

    identitiesByPlayerId[playerId] = {
      ...base,
      playerId: base.playerId || playerId,
      teamName,
      teamMascot: profile?.team_mascot || null,
      teamLocation: profile?.team_location || null,
      teamAbbreviation: profile?.team_abbreviation || null,
      teamPrimaryColor: profile?.team_primary_color || profile?.color || null,
      teamSecondaryColor: profile?.team_secondary_color || null,
      // Priority: per-tournament override > universal logo > captain/pick logo key
      teamLogoUrl,
    }
  }

  return identitiesByPlayerId
}
