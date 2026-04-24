const SPRITE_SHEET_PATH = '/characters/mss-character-icons.png'

const SHEET_WIDTH = 834
const SHEET_HEIGHT = 469
const CELL_WIDTH = 49
const CELL_HEIGHT = 52
const CELL_INSET = 1

const aliases = {
  'Light Blue Yoshi': 'Light-Blue Yoshi',
}

const spriteCells = {
  Mario: [0, 0],
  Luigi: [0, 1],
  Peach: [0, 2],
  Daisy: [0, 3],
  Wario: [0, 4],
  Waluigi: [0, 5],
  Yoshi: [0, 6],
  'Blue Yoshi': [0, 7],
  'Light-Blue Yoshi': [0, 8],
  'Pink Yoshi': [0, 9],
  'Red Yoshi': [0, 10],
  'Yellow Yoshi': [0, 11],
  Birdo: [0, 12],
  'Donkey Kong': [0, 13],
  'Diddy Kong': [0, 14],
  Bowser: [0, 15],
  'Bowser Jr.': [0, 16],
  'Baby Mario': [1, 0],
  'Baby Luigi': [1, 1],
  'Baby Peach': [1, 2],
  'Baby Daisy': [1, 3],
  'Baby DK': [1, 4],
  Goomba: [1, 5],
  Paragoomba: [1, 6],
  Koopa: [1, 7],
  Paratroopa: [1, 8],
  'Red Koopa': [1, 9],
  'Red Toad': [1, 10],
  'Blue Toad': [1, 11],
  'Green Toad': [1, 12],
  'Purple Toad': [1, 13],
  'Yellow Toad': [1, 14],
  Toadette: [1, 15],
  Toadsworth: [1, 16],
  'Shy Guy': [2, 0],
  'Blue Shy Guy': [2, 1],
  'Gray Shy Guy': [2, 2],
  'Green Shy Guy': [2, 3],
  'Yellow Shy Guy': [2, 4],
  Boo: [2, 5],
  'King Boo': [2, 6],
  'Blue Pianta': [2, 7],
  'Red Pianta': [2, 8],
  'Yellow Pianta': [2, 9],
  'Blue Noki': [2, 10],
  'Green Noki': [2, 11],
  'Red Noki': [2, 12],
  'Dry Bones': [2, 13],
  'Dark Bones': [2, 14],
  Magikoopa: [2, 15],
  'Green Magikoopa': [2, 16],
  'Red Magikoopa': [3, 0],
  'Yellow Magikoopa': [3, 1],
  'Monty Mole': [3, 2],
  Blooper: [3, 3],
  'Petey Piranha': [3, 4],
  Wiggler: [3, 5],
  'Dixie Kong': [3, 6],
  'Funky Kong': [3, 7],
  'Tiny Kong': [3, 8],
  'King K. Rool': [3, 9],
  Kritter: [3, 10],
  'Blue Kritter': [3, 11],
  'Brown Kritter': [3, 12],
  'Red Kritter': [3, 13],
  Mii: [3, 14],
  'Green Paratroopa': [5, 10],
  'Hammer Bro': [5, 11],
  'Fire Bro': [5, 12],
  'Boomerang Bro': [5, 13],
  'Blue Dry Bones': [7, 1],
  'Green Dry Bones': [7, 2],
}

function normalizeName(name = '') {
  return aliases[name] || name
}

export function getCharacterSpriteMeta(name) {
  const cell = spriteCells[normalizeName(name)]
  if (!cell) return null

  const [row, col] = cell
  return {
    name: normalizeName(name),
    sheetPath: SPRITE_SHEET_PATH,
    sheetWidth: SHEET_WIDTH,
    sheetHeight: SHEET_HEIGHT,
    sourceX: col * CELL_WIDTH + CELL_INSET,
    sourceY: row * CELL_HEIGHT + CELL_INSET,
    sourceWidth: CELL_WIDTH - CELL_INSET * 2,
    sourceHeight: CELL_HEIGHT - CELL_INSET * 2,
  }
}

