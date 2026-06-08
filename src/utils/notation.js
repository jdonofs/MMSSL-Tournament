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
