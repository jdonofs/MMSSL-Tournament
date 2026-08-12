export function assembleNotation(trajectory, position) {
  if (!trajectory || !position) return ''
  const chain = Array.isArray(position) ? position : [position]
  if (!chain.length) return ''
  return `${trajectory}${chain.join('-')}`
}

// errorPositions accepts a single position or an array — every position
// passed gets its own "-E<n>" suffix segment, so a play where more than one
// fielder booted it (e.g. a relay throw both misplayed) can be recorded as
// "6-4-E6-E4" rather than only ever crediting one fielder.
export function assembleErrorNotation(trajectory, position, errorPositions) {
  const base = assembleNotation(trajectory, position)
  const positions = (Array.isArray(errorPositions) ? errorPositions : (errorPositions ? [errorPositions] : []))
    .filter((p) => p != null && p !== '')
  if (!base || !positions.length) return base
  return `${base}${positions.map((p) => `-E${p}`).join('')}`
}

// Inverse of assembleNotation/assembleErrorNotation: recovers the ordered
// fielder chain from a saved notation string (e.g. "G6-3" -> ['6','3'],
// "G6-3-E3" -> ['6','3']). Drops the leading trajectory letter and any
// error suffix segment(s).
export function parseFielderChainFromNotation(notation) {
  if (!notation) return []
  const rest = notation.slice(1)
  if (!rest) return []
  return rest.split('-').filter((segment) => segment && !/^E/i.test(segment))
}

// Recovers every "-E<n>" error segment from a saved notation string (e.g.
// "6-4-E6-E4" -> ['6', '4']) — the positions of every fielder charged with an
// error on the play, in the order they were marked.
export function parseErrorPositionsFromNotation(notation) {
  if (!notation) return []
  const matches = notation.match(/-E(\d+)/g) || []
  return matches.map((segment) => segment.slice(2))
}

const RESULT_LABELS = {
  '1B': 'Single',
  '2B': 'Double',
  '3B': 'Triple',
  HR: 'Home Run',
  IPHR: 'Inside-the-Park HR',
  BB: 'Walk',
  HBP: 'Hit By Pitch',
  K: 'Strikeout',
  GO: 'Groundout',
  FO: 'Flyout',
  LO: 'Lineout',
  DP: 'Double Play',
  TP: 'Triple Play',
  SF: 'Sac Fly',
  SH: 'Sac Bunt',
  FC: "Fielder's Choice",
  ROE: 'Reached on Error',
}

export function formatResultName(result) {
  return RESULT_LABELS[result] || result || 'Unknown'
}

// A batted-ball out's plain result code (GO/DP/FC/...) doesn't say who
// touched the ball — hit_notation already carries that as a trajectory
// letter plus fielder chain (e.g. "G6-3"). For display we want the fielder
// chain alone (e.g. "6-3"), paired with a readable result name.
export function formatPaResultLabel(pa = {}) {
  const label = formatResultName(pa.result)
  const chain = parseFielderChainFromNotation(pa.hit_notation)
  return chain.length ? `${label} (${chain.join('-')})` : label
}

const PITCH_RESULT_LABELS = {
  ball: 'Ball',
  looking: 'Called Strike',
  swinging_miss: 'Swinging Strike',
  strike_unknown: 'Strike (Swing Unknown)',
  foul: 'Foul',
  hbp: 'Hit By Pitch',
  in_play: 'In Play',
}

export function formatPitchResultLabel(result) {
  return PITCH_RESULT_LABELS[result] || result || 'Unknown'
}
