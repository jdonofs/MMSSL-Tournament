// Game 2221: Bompkins (away, A) @ Mossers (home, B). 3-inning regulation.
const P = { B: 'BALL', S: 'SWING', L: 'LOOK', F: 'FOUL', H: 'HBP' }
const seq = (s) => [...s].map((c) => P[c])

export const HOME_PITCHER_INITIAL = 'Boomerang Bro'
export const AWAY_PITCHER_INITIAL = 'Donkey Kong'

export const plan = [
  // Top 1 (Bompkins bats vs Boomerang Bro)
  { id: 1, half: 'T1', batter: 'Green Dry Bones', pitches: seq('BBBB'), final: 'BB' },
  { id: 2, half: 'T1', batter: 'Fire Bro', inplay: { result: '1B', chain: ['LF'], dests: [['Green Dry Bones', '2B']] }, final: '1B' },
  { id: 3, half: 'T1', batter: 'Donkey Kong', pitches: seq('SSS'), final: 'K', kType: 'KS' },
  { id: 4, half: 'T1', batter: 'Yellow Pianta', inplay: { result: 'SF', chain: ['CF'], dests: [['Green Dry Bones', 'Home']] }, final: 'SF' },
  { id: 5, half: 'T1', batter: 'Red Toad', inplay: { result: 'GO', chain: ['SS', '1B'], dests: [['Fire Bro', '2B']] }, final: 'GO' },

  // Bottom 1 (Mossers bat vs Donkey Kong)
  { id: 6, half: 'B1', batter: 'Wario', inplay: { result: '1B', chain: ['CF'] }, final: '1B' },
  { id: 7, half: 'B1', batter: 'Dry Bones', pitches: seq('LLL'), final: 'K', kType: 'KL' },
  { id: 8, half: 'B1', batter: 'Bowser', inplay: { result: 'E', chain: ['SS'], dests: [['Wario', '3B']] }, final: 'ROE', errorPos: 6 },
  { id: 9, half: 'B1', batter: 'Birdo', inplay: { result: 'HR' }, final: 'HR' },
  { id: 10, half: 'B1', batter: 'King Boo', inplay: { result: 'FO', chain: ['CF'] }, final: 'FO' },
  { id: 11, half: 'B1', batter: 'Boomerang Bro', inplay: { result: 'GO', chain: ['2B', '1B'] }, final: 'GO' },

  // Top 2 (Bompkins bats vs Boomerang Bro -> Waluigi mid-inning)
  { id: 12, half: 'T2', batter: 'Blue Pianta', pitches: seq('H'), final: 'HBP' },
  {
    id: 13, half: 'T2', batter: 'Blue Toad',
    inplay: { result: 'GO', chain: ['SS', '2B'], dests: [['Blue Pianta', 'Out']], batterDest: '1B' },
    final: 'FC',
    afterPa: { changePitcher: 'Waluigi', side: 'B' },
  },
  { id: 14, half: 'T2', batter: 'Peach', inplay: { result: 'GO', chain: ['SS', '2B', '1B'], dests: [['Blue Toad', 'Out']] }, final: 'DP' },

  // Bottom 2 (Mossers bat vs Donkey Kong)
  { id: 15, half: 'B2', batter: 'Mii', inplay: { result: '1B', chain: ['CF'] }, final: '1B' },
  { id: 16, half: 'B2', batter: 'Blooper', inplay: { result: '2B', chain: ['LF'], dests: [['Mii', 'Home']] }, final: '2B' },
  { id: 17, half: 'B2', batter: 'Waluigi', pitches: seq('SSS'), final: 'K', kType: 'KS' },
  { id: 18, half: 'B2', batter: 'Wario', inplay: { result: 'GO', chain: ['SS', '1B'], dests: [['Blooper', '3B']] }, final: 'GO' },
  { id: 19, half: 'B2', batter: 'Dry Bones', inplay: { result: 'FO', chain: ['CF'] }, final: 'FO' },

  // Top 3 (Bompkins bats vs Waluigi)
  { id: 20, half: 'T3', batter: 'Wiggler', inplay: { result: 'GO', chain: ['SS', '1B'] }, final: 'GO' },
  { id: 21, half: 'T3', batter: 'Green Dry Bones', pitches: seq('LLL'), final: 'K', kType: 'KL' },
  { id: 22, half: 'T3', batter: 'Fire Bro', inplay: { result: 'LO', chain: ['SS'] }, final: 'LO' },
  // Mossers already lead entering bottom 3 -> game auto-completed here, B3 not played (confirmed live).
]

export const EXPECTED = {
  finalScore: { away: 1, home: 4 },
  winner: 'Mossers',
  winPitcher: 'Boomerang Bro',
  lossPitcher: 'Donkey Kong',
  savePitcher: 'Waluigi',
  batting: {
    'Green Dry Bones': { pa: 2, ab: 1, h: 0, bb: 1, so: 1, r: 1, rbi: 0 },
    'Fire Bro': { pa: 2, ab: 2, h: 1, so: 0, r: 0, rbi: 0 },
    'Donkey Kong': { pa: 1, ab: 1, h: 0, so: 1, r: 0, rbi: 0 },
    'Yellow Pianta': { pa: 1, ab: 0, h: 0, sf: 1, r: 0, rbi: 1 },
    'Red Toad': { pa: 1, ab: 1, h: 0, r: 0, rbi: 0 },
    'Blue Pianta': { pa: 1, ab: 0, h: 0, hbp: 1, r: 0, rbi: 0 },
    'Blue Toad': { pa: 1, ab: 1, h: 0, r: 0, rbi: 0 },
    'Peach': { pa: 1, ab: 1, h: 0, r: 0, rbi: 0 },
    'Wiggler': { pa: 1, ab: 1, h: 0, r: 0, rbi: 0 },
    'Wario': { pa: 2, ab: 2, h: 1, r: 1, rbi: 0 },
    'Dry Bones': { pa: 2, ab: 2, h: 0, so: 1, r: 0, rbi: 0 },
    'Bowser': { pa: 1, ab: 1, h: 0, r: 1, rbi: 0 },
    'Birdo': { pa: 1, ab: 1, h: 1, hr: 1, r: 1, rbi: 3 },
    'King Boo': { pa: 1, ab: 1, h: 0, r: 0, rbi: 0 },
    'Boomerang Bro': { pa: 1, ab: 1, h: 0, r: 0, rbi: 0 },
    'Mii': { pa: 1, ab: 1, h: 1, r: 1, rbi: 0 },
    'Blooper': { pa: 1, ab: 1, h: 1, r: 0, rbi: 1 },
    'Waluigi': { pa: 1, ab: 1, h: 0, so: 1, r: 0, rbi: 0 },
  },
  pitching: {
    'Boomerang Bro': { outs: 4, h: 4, r: 3, er: 2, bb: 0, hbp: 0, k: 0, hr: 1 }, // T1(3 outs, 1ER via SF-run) + T2 partial(1 out, HBP allowed - no runs charged yet)
    'Waluigi': { outs: 5, h: 0, r: 0, er: 0, bb: 0, hbp: 0, k: 1 }, // rest of T2 (2 outs) + T3 (3 outs)
    'Donkey Kong': { outs: 9, h: 3, r: 4, er: 3, bb: 0, hbp: 0, k: 2, hr: 1 },
  },
}
