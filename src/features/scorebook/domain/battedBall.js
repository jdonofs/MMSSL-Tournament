export function normalizeBatterHandedness(handedness) {
  return handedness === 'L' ? 'L' : 'R'
}

export function directionForFielderPosition(position, batterHandedness = 'R') {
  if (position == null) return null
  const handedness = normalizeBatterHandedness(batterHandedness)
  if (['5', '6', '7'].includes(String(position))) return handedness === 'L' ? 'Oppo' : 'Pull'
  if (['1', '2', '8'].includes(String(position))) return 'Center'
  if (['3', '4', '9'].includes(String(position))) return handedness === 'L' ? 'Pull' : 'Oppo'
  return null
}

export function directionForSprayAngle(angleDeg, batterHandedness = 'R') {
  const angle = Number(angleDeg)
  if (!Number.isFinite(angle)) return null
  const handedness = normalizeBatterHandedness(batterHandedness)
  if (angle <= -15) return handedness === 'L' ? 'Oppo' : 'Pull'
  if (angle >= 15) return handedness === 'L' ? 'Pull' : 'Oppo'
  return 'Center'
}

export function resolveBattedBallDirection(position, angleDeg, batterHandedness = 'R') {
  const fromPosition = directionForFielderPosition(position, batterHandedness)
  if (fromPosition) return fromPosition
  return directionForSprayAngle(angleDeg, batterHandedness)
}

export function describeHitLocation(pa = {}) {
  const position = Number(pa.hit_location || pa.error_position || 0)
  const trajectory = String(pa.trajectory || '').toUpperCase()

  if (!position) return ''

  const infieldSpot = {
    1: 'pitcher',
    2: 'catcher',
    3: 'first',
    4: 'second',
    5: 'third',
    6: 'short',
  }
  const outfieldSpot = {
    7: 'left field',
    8: 'center field',
    9: 'right field',
  }

  if (trajectory === 'G') {
    if (position >= 7) return `on the ground to ${outfieldSpot[position] || 'the outfield'}`
    return `to ${infieldSpot[position] || 'the infield'}`
  }
  if (trajectory === 'L') {
    return `to ${outfieldSpot[position] || infieldSpot[position] || 'the field'}`
  }
  if (trajectory === 'F' || trajectory === 'B') {
    return `to ${outfieldSpot[position] || infieldSpot[position] || 'the field'}`
  }

  return `to ${outfieldSpot[position] || infieldSpot[position] || 'the field'}`
}

export function formatPlayResultText(pa = {}) {
  const location = describeHitLocation(pa)
  const suffix = location ? ` ${location}` : ''
  switch (pa.result) {
    case '1B': return `singled${suffix}`
    case '2B': return `doubled${suffix}`
    case '3B': return `tripled${suffix}`
    case 'HR': return `homered${suffix}`
    case 'IPHR': return `hit an inside-the-park homer${suffix}`
    case 'BB': return 'walked'
    case 'HBP': return 'was hit by a pitch'
    case 'SF': return `lifted a sac fly${suffix}`
    case 'SH': return `dropped a sac bunt${suffix}`
    case 'FC': return `reached on a fielder's choice${suffix}`
    case 'ROE': return `reached on an error${suffix}`
    case 'K':
      if (pa.strikeout_type === 'KL') return 'struck out looking'
      if (pa.strikeout_type === 'KS') return 'struck out swinging'
      return 'struck out'
    case 'DP': return `grounded into a double play${suffix}`
    case 'TP': return `grounded into a triple play${suffix}`
    case 'GO': return `grounded out${suffix}`
    case 'FO': return `flied out${suffix}`
    case 'LO': return `lined out${suffix}`
    default: return pa.result || 'made a play'
  }
}

export function buildScoringPlayDescription(pa, scoringRuns, runEvents = [], charactersById = {}) {
  const batterName = charactersById[pa.character_id]?.name || 'Unknown batter'
  const isHomeRun = pa.result === 'HR' || pa.result === 'IPHR'
  const scorerNames = runEvents
    .filter((run) => !isHomeRun || String(run.scoring_character_id) !== String(pa.character_id))
    .map((run) => charactersById[run.scoring_character_id]?.name || null)
    .filter(Boolean)
  if (scorerNames.length) {
    return `${batterName} ${formatPlayResultText(pa)}; ${scorerNames.join(', ')} scored.`
  }
  const runText = scoringRuns === 1 ? '1 run scored' : `${scoringRuns} runs scored`
  return `${batterName} ${formatPlayResultText(pa)}; ${runText}.`
}
