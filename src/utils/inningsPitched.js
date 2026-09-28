// Innings-pitched notation (5.1 = 5 innings and 1 out) to and from outs.
//
// Kept apart from statsCalculator.js, which re-exports both, so that
// pitchingDecisions.js imports nothing Node cannot resolve: the live tracker
// bridge assigns W/L/S at game completion with the same code the scorebook
// uses, and statsCalculator's extensionless imports only resolve under Vite.

export function outsFromInningsPitched(inningsPitched = 0) {
  const innings = Number(inningsPitched || 0)
  const whole = Math.trunc(innings)
  const fraction = Number((innings - whole).toFixed(3))

  if (Math.abs(fraction - 0.1) < 0.001) return whole * 3 + 1
  if (Math.abs(fraction - 0.2) < 0.001) return whole * 3 + 2

  const legacyOuts = Math.round(fraction * 3)
  return whole * 3 + legacyOuts
}

export function inningsPitchedFromOuts(outs = 0) {
  const safeOuts = Math.max(0, Number(outs || 0))
  const wholeInnings = Math.floor(safeOuts / 3)
  const remainingOuts = safeOuts % 3
  return Number(`${wholeInnings}.${remainingOuts}`)
}
