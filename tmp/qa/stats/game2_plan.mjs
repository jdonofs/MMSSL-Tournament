// Game 2222: Kings (away, A) @ Big Ds (home, B). 3-inning regulation.
// Kings bat Top halves vs Petey Piranha (Big Ds' only pitcher, unchanged all game).
// Big Ds bat Bottom halves vs Mario -> King K. Rool (Kings relieve mid-B2).
const P = { B: 'BALL', S: 'SWING', L: 'LOOK', F: 'FOUL', H: 'HBP' }
const seq = (s) => [...s].map((c) => P[c])

export const plan = [
  // Top 1 (Kings bat vs Petey Piranha)
  { id: 1, half: 'T1', batter: 'Dark Bones', inplay: { result: '1B', chain: ['CF'] }, final: '1B' },
  { id: 2, half: 'T1', batter: 'Bowser Jr.', inplay: { result: '2B', chain: ['LF'], dests: [['Dark Bones', 'Home']] }, final: '2B' },
  { id: 3, half: 'T1', batter: 'Kritter', pitches: seq('SSS'), final: 'K', kType: 'KS' },
  { id: 4, half: 'T1', batter: 'King K. Rool', inplay: { result: 'GO', chain: ['SS', '1B'], dests: [['Bowser Jr.', '3B']] }, final: 'GO' },
  { id: 5, half: 'T1', batter: 'Blue Kritter', inplay: { result: 'FO', chain: ['CF'] }, final: 'FO' },

  // Bottom 1 (Big Ds bat vs Mario)
  { id: 6, half: 'B1', batter: 'Blue Dry Bones', inplay: { result: 'GO', chain: ['SS', '1B'] }, final: 'GO' },
  { id: 7, half: 'B1', batter: 'Red Kritter', inplay: { result: '1B', chain: ['RF'] }, final: '1B' },
  { id: 8, half: 'B1', batter: 'Petey Piranha', inplay: { result: 'GO', chain: ['SS', '2B', '1B'], dests: [['Red Kritter', 'Out']] }, final: 'DP' },

  // Top 2 (Kings bat vs Petey Piranha)
  { id: 9, half: 'T2', batter: 'Mario', pitches: seq('LLL'), final: 'K', kType: 'KL' },
  { id: 10, half: 'T2', batter: 'Funky Kong', inplay: { result: '1B', chain: ['CF'] }, final: '1B' },
  { id: 11, half: 'T2', batter: 'Daisy', inplay: { result: 'E', chain: ['SS'], dests: [['Funky Kong', '3B']] }, final: 'ROE', errorPos: 6 },
  { id: 12, half: 'T2', batter: 'Yellow Toad', inplay: { result: '2B', chain: ['RF'], dests: [['Funky Kong', 'Home'], ['Daisy', 'Home']] }, final: '2B' },
  { id: 13, half: 'T2', batter: 'Dark Bones', inplay: { result: 'GO', chain: ['SS', '1B'], dests: [['Yellow Toad', '3B']] }, final: 'GO' },
  { id: 14, half: 'T2', batter: 'Bowser Jr.', inplay: { result: 'FO', chain: ['CF'] }, final: 'FO' },

  // Bottom 2 (Big Ds bat vs Mario -> King K. Rool mid-inning)
  { id: 15, half: 'B2', batter: 'Red Pianta', inplay: { result: '1B', chain: ['LF'] }, final: '1B' },
  { id: 16, half: 'B2', batter: 'Purple Toad', inplay: { result: '1B', chain: ['CF'], dests: [['Red Pianta', '3B']] }, final: '1B' },
  {
    id: 17, half: 'B2', batter: 'Hammer Bro',
    inplay: { result: '3B', chain: ['RF'], dests: [['Red Pianta', 'Home'], ['Purple Toad', 'Home']] },
    final: '3B',
    afterPa: { changePitcher: 'King K. Rool', side: 'A' },
  },
  { id: 18, half: 'B2', batter: 'Brown Kritter', inplay: { result: 'SF', chain: ['CF'], dests: [['Hammer Bro', 'Home']] }, final: 'SF' },
  { id: 19, half: 'B2', batter: 'Luigi', inplay: { result: '1B', chain: ['LF'] }, final: '1B' },
  { id: 20, half: 'B2', batter: 'Baby DK', inplay: { result: 'HR' }, final: 'HR' },
  { id: 21, half: 'B2', batter: 'Blue Dry Bones', pitches: seq('SSS'), final: 'K', kType: 'KS' },
  { id: 22, half: 'B2', batter: 'Red Kritter', inplay: { result: 'FO', chain: ['CF'] }, final: 'FO' },

  // Top 3 (Kings bat vs Petey Piranha)
  { id: 23, half: 'T3', batter: 'Kritter', pitches: seq('SSS'), final: 'K', kType: 'KS' },
  { id: 24, half: 'T3', batter: 'King K. Rool', inplay: { result: 'GO', chain: ['SS', '1B'] }, final: 'GO' },
  { id: 25, half: 'T3', batter: 'Blue Kritter', inplay: { result: 'FO', chain: ['CF'] }, final: 'FO' },
  // Big Ds (home) already lead entering bottom 3 -> expect game auto-completes here.
]

export const EXPECTED = {
  finalScore: { away: 3, home: 5 }, // Kings 3, Big Ds 5
  winner: 'Big Ds',
  winPitcher: 'Petey Piranha', // only Big Ds pitcher all game
  lossPitcher: 'King K. Rool', // charged with Baby DK's HR (PA20), the decisive go-ahead run
  noDecision: 'Mario', // Kings starter, relieved while still leading -- must NOT get the loss
}
