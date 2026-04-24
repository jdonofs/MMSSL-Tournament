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
