const P = { B: 'BALL', S: 'SWING', L: 'LOOK', F: 'FOUL', H: 'HBP' }
const seq = (s) => [...s].map((c) => P[c])

// Finish out game 2222 cleanly from PA16 (current true state: Kings 3, Big Ds 0, 15 PAs
// recorded). No dests referencing Red Pianta (base-runner tracking desynced by the Undo
// bug found earlier) -- just clean outs so the game completes with Kings winning.
export const plan = [
  { id: 16, half: 'B2', batter: 'Purple Toad', inplay: { result: 'GO', chain: ['SS', '1B'] }, final: 'GO' },
  { id: 17, half: 'B2', batter: 'Hammer Bro', pitches: seq('SSS'), final: 'K', kType: 'KS' },
  { id: 18, half: 'B2', batter: 'Brown Kritter', inplay: { result: 'FO', chain: ['CF'] }, final: 'FO' },

  { id: 19, half: 'T3', batter: 'Kritter', pitches: seq('SSS'), final: 'K', kType: 'KS' },
  { id: 20, half: 'T3', batter: 'King K. Rool', inplay: { result: 'GO', chain: ['SS', '1B'] }, final: 'GO' },
  { id: 21, half: 'T3', batter: 'Blue Kritter', inplay: { result: 'FO', chain: ['CF'] }, final: 'FO' },

  { id: 22, half: 'B3', batter: 'Luigi', inplay: { result: 'GO', chain: ['SS', '1B'] }, final: 'GO' },
  { id: 23, half: 'B3', batter: 'Baby DK', pitches: seq('SSS'), final: 'K', kType: 'KS' },
  { id: 24, half: 'B3', batter: 'Blue Dry Bones', inplay: { result: 'FO', chain: ['CF'] }, final: 'FO' },
]

export const EXPECTED = { finalScore: { away: 3, home: 0 }, winner: 'Kings' }
