export function formatPlateAppearanceResult(resultOrPa, strikeoutTypeOverride = null) {
  const result = typeof resultOrPa === 'object' && resultOrPa != null
    ? resultOrPa.result
    : resultOrPa
  const strikeoutType = strikeoutTypeOverride
    ?? (typeof resultOrPa === 'object' && resultOrPa != null ? resultOrPa.strikeout_type : null)

  if (result === 'K') {
    return strikeoutType === 'KL' ? 'ꓘ' : 'K'
  }

  return result || ''
}
