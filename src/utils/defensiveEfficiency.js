// Defensive Efficiency Ratio, and the out-count rule it shares with the rest of
// the stats layer.
//
// This lives apart from statsCalculator.js because DER is a leaf computation
// over plate-appearance rows and nothing else, while statsCalculator reaches
// into the field-plotting components for its batted-ball work. Keeping the two
// separate is what lets DER be tested on its own.

export const OUT_RESULTS = new Set(['K', 'GO', 'FO', 'LO', 'DP', 'TP', 'SF', 'SH'])

// Balls that never gave the defence a chance. MLB's definition removes
// strikeouts, walks, hit batsmen and home runs; everything else that reached
// the field is an opportunity whether or not it was converted.
const NON_FIELDABLE_RESULTS = new Set(['K', 'BB', 'HBP', 'HR', 'IPHR'])

export function calculateOutsForPa(result, outsOnPlay = null) {
  if (outsOnPlay != null) return Number(outsOnPlay)
  if (result === 'TP') return 3
  if (result === 'DP') return 2
  if (result === 'FC') return 1 // lead runner is out; batter reaches safely
  if (OUT_RESULTS.has(result)) return 1
  return 0
}

// Team-level only. MLB does not publish an individual DER and neither should
// this: the denominator is every ball hit at the whole defence, so splitting it
// by fielder would credit each of them with the other eight's chances.
//
// A ball reached on an error is a fieldable ball the defence failed to convert,
// so it counts in the denominator and not in the numerator even when the play
// recorded an out elsewhere.
export function summarizeDefensiveEfficiency(plateAppearances = []) {
  const opportunities = plateAppearances.filter((pa) => !NON_FIELDABLE_RESULTS.has(pa.result))
  const converted = opportunities.filter((pa) => (
    !pa.is_error && calculateOutsForPa(pa.result, pa.outs_on_play) > 0
  )).length
  return {
    opportunities: opportunities.length,
    outsConverted: converted,
    defensiveEfficiency: opportunities.length ? converted / opportunities.length : null,
  }
}
