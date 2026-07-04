export function assembleNotation(trajectory, position) {
  if (!trajectory || !position) return ''
  const chain = Array.isArray(position) ? position : [position]
  if (!chain.length) return ''
  return `${trajectory}${chain.join('-')}`
}

export function assembleErrorNotation(trajectory, position, errorPosition) {
  const base = assembleNotation(trajectory, position)
  if (!base || !errorPosition) return base
  return `${base}-E${errorPosition}`
}

// Inverse of assembleNotation/assembleErrorNotation: recovers the ordered
// fielder chain from a saved notation string (e.g. "G6-3" -> ['6','3'],
// "G6-3-E3" -> ['6','3']). Drops the leading trajectory letter and any
// error suffix segment.
export function parseFielderChainFromNotation(notation) {
  if (!notation) return []
  const rest = notation.slice(1)
  if (!rest) return []
  return rest.split('-').filter((segment) => segment && !/^E/i.test(segment))
}
