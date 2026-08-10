const P = { B: 'BALL', S: 'SWING', L: 'LOOK', F: 'FOUL', H: 'HBP' }
const seq = (s) => [...s].map((c) => P[c])

// Replay from PA16 onward: same as original through PA19, but Baby DK strikes out
// instead of hitting the go-ahead HR -- flips the winner to Kings (away).
export const plan = [
  { id: 16, half: 'B2', batter: 'Purple Toad', inplay: { result: '1B', chain: ['CF'], dests: [['Red Pianta', '3B']] }, final: '1B' },
  {
    id: 17, half: 'B2', batter: 'Hammer Bro',
    inplay: { result: '3B', chain: ['RF'], dests: [['Red Pianta', 'Home'], ['Purple Toad', 'Home']] },
    final: '3B',
    afterPa: { changePitcher: 'King K. Rool', side: 'A' },
  },
  { id: 18, half: 'B2', batter: 'Brown Kritter', inplay: { result: 'SF', chain: ['CF'], dests: [['Hammer Bro', 'Home']] }, final: 'SF' },
  { id: 19, half: 'B2', batter: 'Luigi', inplay: { result: '1B', chain: ['LF'] }, final: '1B' },
  // CHANGED: Baby DK strikes out instead of hitting the go-ahead HR.
  { id: 20, half: 'B2', batter: 'Baby DK', pitches: seq('SSS'), final: 'K', kType: 'KS' },
  { id: 21, half: 'B2', batter: 'Blue Dry Bones', pitches: seq('SSS'), final: 'K', kType: 'KS' },
  { id: 22, half: 'B2', batter: 'Red Kritter', inplay: { result: 'FO', chain: ['CF'] }, final: 'FO' },

  { id: 23, half: 'T3', batter: 'Kritter', pitches: seq('SSS'), final: 'K', kType: 'KS' },
  { id: 24, half: 'T3', batter: 'King K. Rool', inplay: { result: 'GO', chain: ['SS', '1B'] }, final: 'GO' },
  { id: 25, half: 'T3', batter: 'Blue Kritter', inplay: { result: 'FO', chain: ['CF'] }, final: 'FO' },
]

export const EXPECTED = {
  // Kings 4, Big Ds 3 -- Kings win instead (winner flips from the original Big Ds 5-3).
  finalScore: { away: 4, home: 3 },
  winner: 'Kings',
}
