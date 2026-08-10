export function getForcedRunnerIds(runners = {}) {
  const { first, second, third } = runners
  const ids = ['batter']
  if (first) ids.push('first')
  if (first && second) ids.push('second')
  if (first && second && third) ids.push('third')
  return ids
}

export function shouldNullifyRunsOnInningEndingForce({
  inningEnds = false,
  assignments = [],
  runnersAtStart = {},
} = {}) {
  if (!inningEnds) return false
  const outs = assignments.filter((assignment) => assignment.destination === 'out')
  if (!outs.length) return false
  const forcedIds = new Set(getForcedRunnerIds(runnersAtStart))
  return outs.every((assignment) => forcedIds.has(assignment.id))
}
