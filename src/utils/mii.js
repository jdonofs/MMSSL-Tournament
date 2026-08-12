export const MII_COLOR_OPTIONS = [
  'Red',
  'Orange',
  'Yellow',
  'Light Green',
  'Dark Green',
  'Light Blue',
  'Dark Blue',
  'Pink',
  'Purple',
  'Brown',
  'White',
  'Black',
]

const CHEMISTRY_NAME_ALIASES = {
  'Light-Blue Yoshi': 'Light Blue Yoshi',
}

export function isMiiCharacter(characterOrName) {
  if (!characterOrName) return false
  if (typeof characterOrName === 'string') return characterOrName === 'Mii' || characterOrName.endsWith(' Mii')
  return characterOrName.name === 'Mii' || characterOrName.displayName?.endsWith(' Mii')
}

export function formatCharacterDisplayName(name, miiColor) {
  if (name === 'Mii' && miiColor) return `${miiColor} Mii`
  return name
}

export function getCharacterChemistryName(name, miiColor = null) {
  if (name === 'Mii' && miiColor) return `${miiColor} Mii`
  return CHEMISTRY_NAME_ALIASES[name] || name
}

const COLOR_PREFIX_ABBREVIATIONS = {
  'Light-Blue': 'LB',
  'Light Blue': 'LB',
  'Dark Green': 'DG',
  'Dark Blue': 'DB',
  'Light Green': 'LG',
  'Yellow': 'Y',
  'Green': 'G',
  'Brown': 'Br',
  'Purple': 'P',
  'Orange': 'O',
  'Black': 'Bk',
  'White': 'W',
  'Gray': 'Gr',
  'Red': 'R',
  'Blue': 'B',
  'Pink': 'Pk',
}

// Shortens the color-prefix portion of color-variant character names (e.g. "Light-Blue Yoshi" ->
// "LB Yoshi") for tight display spots like team roster tables. Leaves uncolored names untouched.
export function shortenCharacterName(name) {
  if (!name) return name
  for (const [long, short] of Object.entries(COLOR_PREFIX_ABBREVIATIONS)) {
    if (name.startsWith(`${long} `)) return `${short} ${name.slice(long.length + 1)}`
  }
  return name
}
