// Mario Super Sluggers chemistry table
// Source: https://www.mariowiki.com/Chemistry

// Color variants share chemistry with their base character.
export const CHARACTER_VARIANTS = {
  // Yoshi colors
  'Red Yoshi':        'Yoshi',
  'Blue Yoshi':       'Yoshi',
  'Yellow Yoshi':     'Yoshi',
  'Pink Yoshi':       'Yoshi',
  'Light-Blue Yoshi': 'Yoshi',
  'Light Blue Yoshi': 'Yoshi',
  // Toad colors
  'Red Toad':         'Toad',
  'Blue Toad':        'Toad',
  'Green Toad':       'Toad',
  'Yellow Toad':      'Toad',
  'Purple Toad':      'Toad',
  // Shy Guy colors
  'Red Shy Guy':      'Shy Guy',
  'Blue Shy Guy':     'Shy Guy',
  'Green Shy Guy':    'Shy Guy',
  'Gray Shy Guy':     'Shy Guy',
  'Yellow Shy Guy':   'Shy Guy',
  // Magikoopa colors
  'Red Magikoopa':    'Magikoopa',
  'Blue Magikoopa':   'Magikoopa',
  'Green Magikoopa':  'Magikoopa',
  'Yellow Magikoopa': 'Magikoopa',
  // Kritter colors
  'Red Kritter':      'Kritter',
  'Blue Kritter':     'Kritter',
  'Green Kritter':    'Kritter',
  'Brown Kritter':    'Kritter',
  // Noki colors
  'Red Noki':         'Noki',
  'Blue Noki':        'Noki',
  'Green Noki':       'Noki',
  // Pianta colors
  'Red Pianta':       'Pianta',
  'Blue Pianta':      'Pianta',
  'Yellow Pianta':    'Pianta',
  // Dry Bones colors
  'Dark Bones':       'Dry Bones',
  'Blue Dry Bones':   'Dry Bones',
  'Green Dry Bones':  'Dry Bones',
  // Koopa colors
  'Red Koopa':        'Koopa',
  'Green Koopa':      'Koopa',
  // Paratroopa colors
  'Red Paratroopa':   'Paratroopa',
  'Green Paratroopa': 'Paratroopa',
  // Hammer Bro variants
  'Fire Bro':         'Hammer Bro',
}

// Each color variant also has good chemistry with its same-color Mii.
const VARIANT_MII = {
  'Red Yoshi':        'Red Mii',
  'Blue Yoshi':       'Dark Blue Mii',
  'Yellow Yoshi':     'Yellow Mii',
  'Pink Yoshi':       'Pink Mii',
  'Light-Blue Yoshi': 'Light Blue Mii',
  'Light Blue Yoshi': 'Light Blue Mii',
  'Red Toad':         'Red Mii',
  'Blue Toad':        'Dark Blue Mii',
  'Green Toad':       'Dark Green Mii',
  'Yellow Toad':      'Yellow Mii',
  'Purple Toad':      'Purple Mii',
  'Red Shy Guy':      'Red Mii',
  'Blue Shy Guy':     'Dark Blue Mii',
  'Green Shy Guy':    'Dark Green Mii',
  'Gray Shy Guy':     'Black Mii',
  'Yellow Shy Guy':   'Yellow Mii',
  'Red Magikoopa':    'Red Mii',
  'Blue Magikoopa':   'Dark Blue Mii',
  'Green Magikoopa':  'Dark Green Mii',
  'Yellow Magikoopa': 'Yellow Mii',
  'Red Kritter':      'Red Mii',
  'Blue Kritter':     'Dark Blue Mii',
  'Green Kritter':    'Dark Green Mii',
  'Brown Kritter':    'Brown Mii',
  'Red Noki':         'Red Mii',
  'Blue Noki':        'Dark Blue Mii',
  'Green Noki':       'Dark Green Mii',
  'Red Pianta':       'Red Mii',
  'Blue Pianta':      'Dark Blue Mii',
  'Yellow Pianta':    'Yellow Mii',
  'Dark Bones':       'Red Mii',
  'Blue Dry Bones':   'Dark Blue Mii',
  'Green Dry Bones':  'Dark Green Mii',
  'Red Koopa':        'Red Mii',
  'Green Koopa':      'Dark Green Mii',
  'Red Paratroopa':   'Red Mii',
  'Green Paratroopa': 'Dark Green Mii',
  'Fire Bro':         'Red Mii',
}

export const CHEMISTRY = {
  'Mario':        { good: ['Luigi','Peach','Yoshi','Pianta','Noki','Red Mii'],                                      bad: ['Bowser','Wario','Bowser Jr.','King Boo'] },
  'Luigi':        { good: ['Mario','Daisy','Dark Green Mii'],                                                       bad: ['Waluigi','Boo','King Boo','Dry Bones','Bowser'] },
  'Peach':        { good: ['Daisy','Mario','Toad','Toadette','Toadsworth','Pink Mii'],                              bad: ['Bowser','Birdo'] },
  'Daisy':        { good: ['Peach','Luigi','Birdo','Orange Mii'],                                                   bad: ['Hammer Bro'] },
  'Yoshi':        { good: ['Birdo','Mario','Baby Mario','Baby Luigi','Baby Peach','Baby Daisy','Baby DK','Light Green Mii'], bad: ['Magikoopa','Shy Guy','Boo','King Boo'] },
  'Birdo':        { good: ['Yoshi','Daisy','Shy Guy','Toadette','Petey Piranha','Pink Mii'],                        bad: ['Peach','Tiny Kong','Wario','Blooper','Waluigi'] },
  'Wario':        { good: ['Waluigi','Yellow Mii'],                                                                 bad: ['Mario','Birdo'] },
  'Waluigi':      { good: ['Wario','Purple Mii'],                                                                   bad: ['Luigi','Birdo'] },
  'Donkey Kong':  { good: ['Diddy Kong','Dixie Kong','Funky Kong','Tiny Kong','Brown Mii'],                         bad: ['Kritter','King K. Rool'] },
  'Diddy Kong':   { good: ['Donkey Kong','Dixie Kong','Funky Kong','Tiny Kong'],                                    bad: [] },
  'Dixie Kong':   { good: ['Donkey Kong','Diddy Kong','Funky Kong','Tiny Kong','Baby DK','Pink Mii'],               bad: ['King K. Rool','Kritter','Dry Bones'] },
  'Funky Kong':   { good: ['Donkey Kong','Diddy Kong','Dixie Kong','Tiny Kong','Baby DK','Light Blue Mii'],         bad: ['King K. Rool','Kritter'] },
  'Tiny Kong':    { good: ['Donkey Kong','Diddy Kong','Dixie Kong','Funky Kong','Baby DK','Light Blue Mii'],        bad: ['Birdo','King K. Rool','Kritter'] },
  'King K. Rool': { good: ['Kritter','King Boo','Dark Green Mii'],                                                  bad: ['Bowser','Donkey Kong','Diddy Kong','Dixie Kong','Tiny Kong','Funky Kong','Baby DK'] },
  'Kritter':      { good: ['King K. Rool'],                                                                         bad: ['Donkey Kong','Diddy Kong','Dixie Kong','Tiny Kong','Funky Kong','Baby DK'] },
  'Bowser':       { good: ['Bowser Jr.','Dry Bones','Hammer Bro','Koopa','Paratroopa','Magikoopa','Black Mii'],     bad: ['Mario','Luigi','Peach','Toad','Toadsworth','Toadette','Baby Peach','Baby Daisy','Baby Mario','Baby Luigi','Baby DK','King K. Rool'] },
  'Bowser Jr.':   { good: ['Bowser','Koopa','Hammer Bro','Magikoopa','Black Mii'],                                  bad: ['Mario','Pianta','Noki'] },
  'Toad':         { good: ['Peach','Toadette','Toadsworth','Pianta','Baby Peach'],                                  bad: ['Bowser','Goomba','Paragoomba'] },
  'Toadette':     { good: ['Peach','Birdo','Toad','Toadsworth','Noki','Pink Mii'],                                  bad: [] },
  'Toadsworth':   { good: ['Peach','Toad','Toadette','Pianta','Baby Peach','Brown Mii'],                            bad: ['Paratroopa','Goomba','Paragoomba','Bowser'] },
  'Pianta':       { good: ['Mario','Noki','Toad','Toadsworth'],                                                     bad: ['Petey Piranha','Bowser Jr.','Goomba'] },
  'Noki':         { good: ['Mario','Pianta','Toadette'],                                                            bad: ['Bowser Jr.','Petey Piranha','Hammer Bro'] },
  'Koopa':        { good: ['Bowser','Bowser Jr.','Paratroopa','Goomba','Dry Bones'],                                bad: [] },
  'Paratroopa':   { good: ['Bowser','Koopa','Paragoomba'],                                                          bad: ['Toadsworth'] },
  'Dry Bones':    { good: ['Bowser','Koopa'],                                                                       bad: ['Luigi','Dixie Kong','Baby Peach','Baby Daisy'] },
  'Goomba':       { good: ['Paragoomba','Monty Mole','Koopa','Brown Mii'],                                         bad: ['Toad','Toadette','Toadsworth','Pianta'] },
  'Paragoomba':   { good: ['Goomba','Monty Mole','Paratroopa','Brown Mii'],                                        bad: ['Toad','Toadette','Toadsworth'] },
  'Boo':          { good: ['King Boo','Shy Guy','Magikoopa','Blooper','White Mii'],                                 bad: ['Luigi','Yoshi','Baby Mario','Baby Luigi','Baby Peach','Baby Daisy'] },
  'King Boo':     { good: ['Petey Piranha','Boo','King K. Rool','Wiggler','White Mii'],                             bad: ['Mario','Luigi','Yoshi','Baby Mario','Baby Luigi','Baby Peach','Baby Daisy'] },
  'Hammer Bro':   { good: ['Bowser','Bowser Jr.','Magikoopa','Dark Green Mii'],                                      bad: ['Daisy','Noki'] },
  'Boomerang Bro':{ good: ['Hammer Bro','Dark Blue Mii'],                                                           bad: [] },
  'Magikoopa':    { good: ['Bowser','Bowser Jr.','Hammer Bro','Boo'],                                               bad: ['Yoshi','Baby Mario','Baby Luigi'] },
  'Shy Guy':      { good: ['Birdo','Boo','Monty Mole'],                                                             bad: ['Yoshi','Baby Mario','Baby Luigi','Baby Peach','Baby DK'] },
  'Monty Mole':   { good: ['Goomba','Shy Guy','Paragoomba','Brown Mii'],                                            bad: [] },
  'Blooper':      { good: ['Boo','Petey Piranha','Wiggler','White Mii'],                                            bad: ['Birdo'] },
  'Wiggler':      { good: ['Blooper','Petey Piranha','King Boo','Yellow Mii'],                                      bad: ['Red Mii'] },
  'Petey Piranha':{ good: ['Birdo','King Boo','Wiggler','Blooper','Light Green Mii'],                               bad: ['Pianta','Noki','Baby Mario','Baby Luigi','Baby Peach','Baby Daisy','Baby DK'] },
  'Baby Mario':   { good: ['Yoshi','Baby Luigi','Baby Peach','Baby Daisy','Baby DK','Red Mii'],                     bad: ['Magikoopa','Shy Guy','Boo','King Boo','Bowser','Petey Piranha'] },
  'Baby Luigi':   { good: ['Yoshi','Baby Mario','Baby Peach','Baby Daisy','Baby DK','Dark Green Mii'],              bad: ['Magikoopa','Shy Guy','Boo','King Boo','Bowser','Petey Piranha'] },
  'Baby Peach':   { good: ['Yoshi','Baby Mario','Baby Luigi','Baby Daisy','Baby DK','Toad','Toadsworth','Pink Mii'], bad: ['Petey Piranha','Shy Guy','Boo','King Boo','Dry Bones','Bowser'] },
  'Baby Daisy':   { good: ['Yoshi','Baby Mario','Baby Luigi','Baby Peach','Baby DK','Orange Mii'],                  bad: ['Bowser','Petey Piranha','Boo','King Boo','Dry Bones'] },
  'Baby DK':      { good: ['Yoshi','Baby Mario','Baby Luigi','Baby Peach','Baby Daisy','Dixie Kong','Funky Kong','Tiny Kong','Brown Mii'], bad: ['Bowser','King K. Rool','Kritter','Shy Guy','Petey Piranha'] },
  // Mii characters — good chemistry includes same-color character variants
  'Red Mii':         { good: ['Mario','Baby Mario','Red Shy Guy','Red Toad','Red Magikoopa','Red Pianta','Dark Bones','Fire Bro','Red Kritter','Red Koopa','Red Paratroopa','Red Noki','Red Yoshi'], bad: ['Wiggler'] },
  'Orange Mii':      { good: ['Daisy','Baby Daisy'],                                                                 bad: [] },
  'Yellow Mii':      { good: ['Wario','Wiggler','Yellow Toad','Yellow Pianta','Yellow Yoshi','Yellow Shy Guy','Yellow Magikoopa'], bad: [] },
  'Light Green Mii': { good: ['Yoshi','Petey Piranha'],                                                              bad: [] },
  'Dark Green Mii':  { good: ['Luigi','Baby Luigi','King K. Rool','Hammer Bro','Green Shy Guy','Green Toad','Green Magikoopa','Green Dry Bones','Green Kritter','Green Koopa','Green Paratroopa','Green Noki'], bad: [] },
  'Light Blue Mii':  { good: ['Tiny Kong','Funky Kong','Light-Blue Yoshi'],                                          bad: [] },
  'Dark Blue Mii':   { good: ['Boomerang Bro','Blue Shy Guy','Blue Toad','Blue Magikoopa','Blue Pianta','Blue Dry Bones','Blue Kritter','Blue Noki','Blue Yoshi'], bad: [] },
  'Pink Mii':        { good: ['Peach','Birdo','Baby Peach','Toadette','Dixie Kong','Pink Yoshi'],                    bad: [] },
  'Purple Mii':      { good: ['Waluigi','Purple Toad'],                                                              bad: [] },
  'Brown Mii':       { good: ['Donkey Kong','Toadsworth','Goomba','Paragoomba','Monty Mole','Baby DK','Brown Kritter'], bad: [] },
  'White Mii':       { good: ['Boo','King Boo','Blooper','Dry Bones'],                                               bad: [] },
  'Black Mii':       { good: ['Bowser','Bowser Jr.','Gray Shy Guy'],                                                 bad: [] },
}

export function getChemistry(name) {
  if (CHEMISTRY[name]) return CHEMISTRY[name]
  const base = CHARACTER_VARIANTS[name]
  if (!base || !CHEMISTRY[base]) return { good: [], bad: [] }
  const baseChem = CHEMISTRY[base]
  const mii = VARIANT_MII[name]
  if (!mii) return baseChem
  return { good: [...baseChem.good, mii], bad: baseChem.bad }
}

// Net chemistry score of candidate against a roster of character names
export function chemScore(candidateName, rosterNames) {
  if (!rosterNames || rosterNames.length === 0) return null
  let score = 0
  for (const r of rosterNames) {
    const candidateChem = getChemistry(candidateName)
    const rosterChem = getChemistry(r)
    const good = candidateChem.good.includes(r) || rosterChem.good.includes(candidateName)
    const bad = candidateChem.bad.includes(r) || rosterChem.bad.includes(candidateName)
    if (good && !bad) score++
    if (bad && !good) score--
  }
  return score
}
