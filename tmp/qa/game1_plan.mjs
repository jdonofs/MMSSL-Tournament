// Scripted QA game for season 54, game 2144: Bompkins (away, A) @ Dumbos (home, B).
// Each entry: batter, optional pitch prelude, optional inplay spec, and `final`
// (authoritative expected result for the hand-tally simulator in expected.mjs).
//
// Lineups (batting order):
//   A (Bompkins): Mario, Fire Bro, Dark Bones, Dry Bones, Wiggler, Blooper,
//                 Green Paratroopa, Yellow Shy Guy, Yoshi   — pitcher: Dark Bones
//   B (Dumbos):   Blue Pianta, Luigi, Bowser, Red Pianta, Baby DK, Tiny Kong,
//                 Shy Guy, Birdo, Toadette                  — pitcher: Luigi, then Bowser from T2 mid-inning

export const PITCHERS = {
  A: 'Dark Bones',
  B1: 'Luigi',
  B2: 'Bowser', // after mid-T2 change
}

// action shorthand: pitches use B=BALL, S=SWING, L=LOOK, F=FOUL, H=HBP
const P = { B: 'BALL', S: 'SWING', L: 'LOOK', F: 'FOUL', H: 'HBP' }
const seq = (s) => [...s].map((c) => P[c])

export const plan = [
  // ── Top 1 (A bats, Luigi pitching) ─────────────────────────────
  { id: 1, half: 'T1', batter: 'Mario', pitches: seq('BBBB'), final: 'BB' },
  { id: 2, half: 'T1', batter: 'Fire Bro', pitches: seq('B'), inplay: { result: 'HR' }, final: 'HR' },
  { id: 3, half: 'T1', batter: 'Dark Bones', pitches: seq('SSFS'), final: 'K', kType: 'KS' },
  { id: 4, half: 'T1', batter: 'Dry Bones', pitches: seq('L'), inplay: { result: '1B', chain: ['LF'] }, final: '1B' },
  { id: 5, half: 'T1', batter: 'Wiggler', inplay: { result: '2B', chain: ['CF'], dests: [['Dry Bones', '3B']] }, final: '2B' },
  { id: 6, half: 'T1', batter: 'Blooper', inplay: { result: 'SF', chain: ['CF'], dests: [['Dry Bones', 'Home'], ['Wiggler', '2B']] }, final: 'SF' },
  { id: 7, half: 'T1', batter: 'Green Paratroopa', inplay: { result: 'GO', chain: ['SS', '1B'], dests: [['Wiggler', '2B']] }, final: 'GO' },

  // ── Bottom 1 (B bats, Dark Bones pitching) — clean 1-2-3 ───────
  { id: 8, half: 'B1', batter: 'Blue Pianta', pitches: seq('LLL'), final: 'K', kType: 'KL' },
  { id: 9, half: 'B1', batter: 'Luigi', inplay: { result: 'FO', chain: ['CF'] }, final: 'FO' },
  { id: 10, half: 'B1', batter: 'Bowser', pitches: seq('F'), inplay: { result: 'LO', chain: ['SS'] }, final: 'LO' },

  // ── Top 2 (vs Luigi, then Bowser after id 16) ──────────────────
  { id: 11, half: 'T2', batter: 'Yellow Shy Guy', pitches: seq('H'), final: 'HBP' },
  { id: 12, half: 'T2', batter: 'Yoshi', inplay: { result: 'GO', chain: ['SS', '2B'], dests: [['Yellow Shy Guy', 'Out']], batterDest: '1B' }, final: 'FC' },
  { id: 13, half: 'T2', batter: 'Mario', inplay: { result: 'E', chain: ['SS'], dests: [['Yoshi', '2B']] }, final: 'ROE', errorPos: 6 },
  { id: 14, half: 'T2', batter: 'Fire Bro', inplay: { result: '3B', chain: ['RF'], dests: [['Yoshi', 'Home'], ['Mario', 'Home']] }, final: '3B' },
  { id: 15, half: 'T2', batter: 'Dark Bones', inplay: { result: 'IPHR', chain: ['CF'], dests: [['Fire Bro', 'Home']], destsOptional: true }, final: 'IPHR' },
  { id: 16, half: 'T2', batter: 'Dry Bones', inplay: { result: '1B', chain: ['LF'] }, final: '1B', afterPa: { changePitcher: 'Bowser' } },
  { id: 17, half: 'T2', batter: 'Wiggler', inplay: { result: '2B', chain: ['LF'], dests: [['Dry Bones', 'Home']] }, final: '2B' },
  { id: 18, half: 'T2', batter: 'Blooper', pitches: seq('LLFL'), final: 'K', kType: 'KL' },
  { id: 19, half: 'T2', batter: 'Green Paratroopa', inplay: { result: 'GO', chain: ['2B', '1B'], dests: [['Wiggler', '2B']] }, final: 'GO' },

  // ── Bottom 2 (vs Dark Bones) ───────────────────────────────────
  { id: 20, half: 'B2', batter: 'Red Pianta', inplay: { result: 'HR' }, final: 'HR' }, // solo
  { id: 21, half: 'B2', batter: 'Baby DK', inplay: { result: '1B', chain: ['RF'] }, final: '1B' },
  { id: 22, half: 'B2', batter: 'Tiny Kong', inplay: { result: 'GO', chain: ['SS', '2B', '1B'], dests: [['Baby DK', 'Out']] }, final: 'DP' },
  { id: 23, half: 'B2', batter: 'Shy Guy', inplay: { result: '1B', chain: ['CF'] }, final: '1B' },
  { id: 24, half: 'B2', batter: 'Birdo', pitches: seq('LLFL'), final: 'K', kType: 'KL' },

  // ── Top 3 (vs Bowser) — clean 1-2-3 ────────────────────────────
  { id: 25, half: 'T3', batter: 'Yellow Shy Guy', inplay: { result: 'FO', chain: ['CF'] }, final: 'FO' },
  { id: 26, half: 'T3', batter: 'Yoshi', inplay: { result: 'LO', chain: ['SS'] }, final: 'LO' },
  { id: 27, half: 'T3', batter: 'Mario', pitches: seq('SSS'), final: 'K', kType: 'KS' },

  // ── Bottom 3 (vs Dark Bones) — 7 runs to tie 8-8 ───────────────
  { id: 28, half: 'B3', batter: 'Toadette', pitches: seq('BFBBB'), final: 'BB' },
  { id: 29, half: 'B3', batter: 'Blue Pianta', inplay: { result: '1B', chain: ['LF'], dests: [['Toadette', '2B']] }, final: '1B' },
  { id: 30, half: 'B3', batter: 'Luigi', pitches: seq('B'), inplay: { result: 'HR' }, final: 'HR' }, // 3-run
  { id: 31, half: 'B3', batter: 'Bowser', pitches: seq('BBBB'), final: 'BB' },
  { id: 32, half: 'B3', batter: 'Red Pianta', pitches: seq('H'), final: 'HBP' },
  { id: 33, half: 'B3', batter: 'Baby DK', inplay: { result: '1B', chain: ['CF'], dests: [['Bowser', '3B'], ['Red Pianta', '2B']] }, final: '1B' },
  { id: 34, half: 'B3', batter: 'Tiny Kong', inplay: { result: 'HR' }, final: 'HR' }, // grand slam
  { id: 35, half: 'B3', batter: 'Shy Guy', inplay: { result: '1B', chain: ['LF'] }, final: '1B' },
  { id: 36, half: 'B3', batter: 'Birdo', inplay: { result: '1B', chain: ['RF'], dests: [['Shy Guy', '2B']] }, final: '1B' },
  { id: 37, half: 'B3', batter: 'Toadette', inplay: { result: 'LO', chain: ['SS', '2B', '1B'], dests: [['Shy Guy', 'Out'], ['Birdo', 'Out']] }, final: 'TP' },

  // ── Top 4 (extras, vs Bowser) ──────────────────────────────────
  { id: 38, half: 'T4', batter: 'Fire Bro', inplay: { result: '1B', chain: ['LF'] }, final: '1B' },
  { id: 39, half: 'T4', batter: 'Dark Bones', inplay: { result: 'SH', chain: ['P', '1B'], dests: [['Fire Bro', '2B']] }, final: 'SH' },
  { id: 40, half: 'T4', batter: 'Dry Bones', pitches: seq('SFS'), final: 'K', kType: 'KS' },
  { id: 41, half: 'T4', batter: 'Wiggler', inplay: { result: 'GO', chain: ['SS', '1B'], dests: [['Fire Bro', '2B']] }, final: 'GO' },

  // ── Bottom 4 — walk-off ────────────────────────────────────────
  { id: 42, half: 'B4', batter: 'Blue Pianta', inplay: { result: '2B', chain: ['LF'] }, final: '2B' },
  { id: 43, half: 'B4', batter: 'Luigi', inplay: { result: '1B', chain: ['CF'], dests: [['Blue Pianta', 'Home']] }, final: '1B', walkOff: true },
]
