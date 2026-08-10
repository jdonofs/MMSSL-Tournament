// Game 2223: Kings (away, A) @ Bompkins (home, B). Short/clean game for rollup testing
// (reuses Green Dry Bones, Fire Bro, Dark Bones, who each already played in games 1/2).
const P = { B: 'BALL', S: 'SWING', L: 'LOOK', F: 'FOUL', H: 'HBP' }
const seq = (s) => [...s].map((c) => P[c])

export const plan = [
  { id: 1, half: 'T1', batter: 'Dark Bones', inplay: { result: '1B', chain: ['CF'] }, final: '1B' },
  { id: 2, half: 'T1', batter: 'Bowser Jr.', pitches: seq('SSS'), final: 'K', kType: 'KS' },
  { id: 3, half: 'T1', batter: 'Kritter', inplay: { result: 'GO', chain: ['SS', '1B'] }, final: 'GO' },
  { id: 3.5, half: 'T1', batter: 'King K. Rool', pitches: seq('SSS'), final: 'K', kType: 'KS' },

  { id: 4, half: 'B1', batter: 'Green Dry Bones', inplay: { result: '1B', chain: ['CF'] }, final: '1B' },
  { id: 5, half: 'B1', batter: 'Fire Bro', inplay: { result: '2B', chain: ['LF'], dests: [['Green Dry Bones', 'Home']] }, final: '2B' },
  { id: 6, half: 'B1', batter: 'Donkey Kong', pitches: seq('LLL'), final: 'K', kType: 'KL' },
  { id: 6.3, half: 'B1', batter: 'Yellow Pianta', pitches: seq('SSS'), final: 'K', kType: 'KS' },
  { id: 6.6, half: 'B1', batter: 'Red Toad', inplay: { result: 'GO', chain: ['SS', '1B'] }, final: 'GO' },

  { id: 7, half: 'T2', batter: 'Blue Kritter', inplay: { result: 'GO', chain: ['SS', '1B'] }, final: 'GO' },
  { id: 8, half: 'T2', batter: 'Mario', inplay: { result: 'FO', chain: ['CF'] }, final: 'FO' },
  { id: 8.5, half: 'T2', batter: 'Funky Kong', pitches: seq('SSS'), final: 'K', kType: 'KS' },

  { id: 10, half: 'B2', batter: 'Blue Pianta', inplay: { result: 'GO', chain: ['SS', '1B'] }, final: 'GO' },
  { id: 11, half: 'B2', batter: 'Blue Toad', pitches: seq('SSS'), final: 'K', kType: 'KS' },
  { id: 12, half: 'B2', batter: 'Peach', inplay: { result: 'FO', chain: ['CF'] }, final: 'FO' },

  { id: 14, half: 'T3', batter: 'Daisy', inplay: { result: 'GO', chain: ['SS', '1B'] }, final: 'GO' },
  { id: 15, half: 'T3', batter: 'Yellow Toad', inplay: { result: 'FO', chain: ['CF'] }, final: 'FO' },
  { id: 15.5, half: 'T3', batter: 'Dark Bones', pitches: seq('SSS'), final: 'K', kType: 'KS' },

  { id: 16, half: 'B3', batter: 'Wiggler', pitches: seq('SSS'), final: 'K', kType: 'KS' },
  { id: 17, half: 'B3', batter: 'Green Dry Bones', inplay: { result: 'GO', chain: ['SS', '1B'] }, final: 'GO' },
  { id: 18, half: 'B3', batter: 'Fire Bro', inplay: { result: 'FO', chain: ['CF'] }, final: 'FO' },
]

export const EXPECTED = { finalScore: { away: 0, home: 1 }, winner: 'Bompkins' }
