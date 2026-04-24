import characterImages from '../data/characterImages.json'

const imageEntries = characterImages.map((entry) => ({
  ...entry
}))

const aliases = {
  'Light Blue Yoshi': 'Light-Blue Yoshi'
}

function normalizeName(name = '') {
  return aliases[name] || name
}

export const characterImageList = imageEntries

export const characterImageMap = Object.fromEntries(
  imageEntries.map((entry) => [entry.name, entry.publicPath])
)

export const characterImageMetaMap = Object.fromEntries(
  imageEntries.map((entry) => [entry.name, entry])
)

export function getCharacterImage(name) {
  return characterImageMap[normalizeName(name)] || null
}

export function getCharacterImageMeta(name) {
  return characterImageMetaMap[normalizeName(name)] || null
}

export function hasCharacterImage(name) {
  return Boolean(getCharacterImage(name))
}
