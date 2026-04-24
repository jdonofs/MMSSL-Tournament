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
  Waluigi: { logoKey: 'waluigi-symbiants', teamName: 'Waluigi Symbiants' },
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

export function getCaptainIdentityFromName(characterName) {
  return CAPTAIN_TEAM_MAP[characterName] || null
}

export function isCaptainCharacterName(characterName) {
  return Boolean(getCaptainIdentityFromName(characterName))
}

export function buildTournamentTeamIdentityMap(draftPicks = [], charactersById = {}) {
  const firstPicksByPlayer = {}

  draftPicks
    .filter((pick) => pick?.player_id)
    .slice()
    .sort((a, b) => Number(a.pick_number || 0) - Number(b.pick_number || 0))
    .forEach((pick) => {
      if (firstPicksByPlayer[pick.player_id]) return
      if (!pick.character_id) return
      const characterName = charactersById[pick.character_id]?.name
      const captainIdentity = getCaptainIdentityFromName(characterName)
      if (!captainIdentity) return
      firstPicksByPlayer[pick.player_id] = {
        playerId: pick.player_id,
        captainCharacterId: pick.character_id,
        captainCharacterName: characterName,
        teamName: captainIdentity.teamName,
        teamLogoKey: captainIdentity.logoKey,
        draftPickId: pick.id,
      }
    })

  return firstPicksByPlayer
}
