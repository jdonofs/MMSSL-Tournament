export const PLAYER_SKILL_TIERS = {
  jason: { tier: 1, tournamentWins: 1, tournamentAppearances: 1, skillScore: 1.0 },
  may: { tier: 1, tournamentWins: 1, tournamentAppearances: 1, skillScore: 1.0 },
  nick: { tier: 2, tournamentWins: 0, tournamentAppearances: 1, skillScore: 0.78 },
  aidan: { tier: 3, tournamentWins: 0, tournamentAppearances: 0, skillScore: 0.55 },
  donovan: { tier: 3, tournamentWins: 0, tournamentAppearances: 0, skillScore: 0.55 },
  justin: { tier: 4, tournamentWins: 0, tournamentAppearances: 0, skillScore: 0.25 },
}

export const CAPTAIN_TEAM_MAP = {
  Mario: { logoKey: 'mario-fireballs', teamName: 'Mario Fireballs' },
  Luigi: { logoKey: 'luigi-knights', teamName: 'Luigi Knights' },
  Peach: { logoKey: 'peach-monarchs', teamName: 'Peach Monarchs' },
  Daisy: { logoKey: 'daisy-flowers', teamName: 'Daisy Flowers' },
  Wario: { logoKey: 'wario-muscles', teamName: 'Wario Muscles' },
  Waluigi: { logoKey: 'waluigi-symbiants', teamName: 'Waluigi Spitballs' },
  Yoshi: { logoKey: 'yoshi-eggs', teamName: 'Yoshi Eggs' },
  Birdo: { logoKey: 'birdo-bows', teamName: 'Birdo Bows' },
  'Donkey Kong': { logoKey: 'dk-wilds', teamName: 'DK Wilds' },
  'Diddy Kong': { logoKey: 'diddy-monkeys', teamName: 'Diddy Monkeys' },
  Bowser: { logoKey: 'bowser-monsters', teamName: 'Bowser Monsters' },
  'Bowser Jr.': { logoKey: 'bowser-rookies', teamName: 'Bowser Rookies' },
  'Bowser Jr': { logoKey: 'bowser-rookies', teamName: 'Bowser Rookies' },
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

// Returns the team's chosen primary color, falling back to the player's
// personal color for teams that haven't set one yet.
export function getTeamPrimaryColor(team, fallbackColor) {
  return (team?.team_primary_color ?? team?.teamPrimaryColor) || fallbackColor || null
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

// Returns the short abbreviation for a team (e.g. "CLE"), falling back to
// the mascot/short name for teams that haven't set one yet.
export function getTeamAbbreviation(team) {
  const abbreviation = team?.team_abbreviation ?? team?.teamAbbreviation
  if (abbreviation) return abbreviation

  return getTeamShortName(team)
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
  const teamName = captainIdentity?.teamName || null

  if (!teamLogoKey && !teamName) return null

  return {
    playerId: pick.player_id,
    captainCharacterId: pick.character_id || null,
    captainCharacterName: characterName,
    teamName,
    teamLogoKey,
    draftPickId: pick.id,
  }
}

// playerProfilesByPlayerId: { [playerId]: { team_name, team_logo_url } }
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

  // Merge player universal profiles and per-tournament logo overrides
  for (const [playerId, base] of Object.entries(firstPicksByPlayer)) {
    const profile = playerProfilesByPlayerId[playerId]
    const tournamentLogoUrl = logoUrlsByPlayerId[playerId]
    firstPicksByPlayer[playerId] = {
      ...base,
      // Universal team name takes priority over captain-derived name
      teamName: profile?.team_name || base.teamName,
      teamMascot: profile?.team_mascot || null,
      teamLocation: profile?.team_location || null,
      teamAbbreviation: profile?.team_abbreviation || null,
      teamPrimaryColor: profile?.team_primary_color || null,
      teamSecondaryColor: profile?.team_secondary_color || null,
      // Priority: per-tournament override > universal logo > keep existing
      teamLogoUrl: tournamentLogoUrl || profile?.team_logo_url || base.teamLogoUrl || null,
    }
  }

  return firstPicksByPlayer
}
