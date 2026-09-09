import { requiresInPlayFielderChain } from '../../../utils/runnerAssignment.js'

export function effectiveErrorPositions(state) {
  if (state?.errorFielderPositions?.length) return state.errorFielderPositions
  if (state?.resultType === 'error' && state?.fielderChain?.[0]) return [state.fielderChain[0]]
  return []
}

export function canFinalizeInPlaySelection(state, fieldersByPosition = {}, haveGoodChemistry = () => false) {
  if (!state?.result) return false
  if (state.result === 'HR') return true
  if (state.isBuddyJump) {
    const chain = state.fielderChain || []
    if (chain.length < 2) return false
    const nameA = fieldersByPosition[chain[0]]?.character
    const nameB = fieldersByPosition[chain[1]]?.character
    return haveGoodChemistry(nameA, nameB)
  }
  if (!requiresInPlayFielderChain(state.result)) return true
  return Boolean(state.fielderChain?.length)
}
