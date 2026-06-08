import { useCallback, useEffect, useState } from 'react'

function buildPitchOutcome(result, ballsBefore, strikesBefore, ballsAfter, strikesAfter, isStarPitch) {
  return {
    result,
    count_balls_before: ballsBefore,
    count_strikes_before: strikesBefore,
    count_balls_after: ballsAfter,
    count_strikes_after: strikesAfter,
    is_star_pitch: Boolean(isStarPitch),
  }
}

export default function usePitchCount({ pitcherKey, initialPitchNumber = 0 }) {
  const [balls, setBalls] = useState(0)
  const [strikes, setStrikes] = useState(0)
  const [pitchNumber, setPitchNumber] = useState(initialPitchNumber)

  useEffect(() => {
    setBalls(0)
    setStrikes(0)
    setPitchNumber(initialPitchNumber)
  }, [pitcherKey, initialPitchNumber])

  const resetPa = useCallback(() => {
    setBalls(0)
    setStrikes(0)
  }, [])

  const restoreState = useCallback(({ balls: nextBalls = 0, strikes: nextStrikes = 0, pitchNumber: nextPitchNumber = initialPitchNumber } = {}) => {
    setBalls(nextBalls)
    setStrikes(nextStrikes)
    setPitchNumber(nextPitchNumber)
  }, [initialPitchNumber])

  const registerPitch = useCallback((result, nextBalls, nextStrikes, isStarPitch) => {
    const nextPitchNumber = pitchNumber + 1
    const payload = {
      pitchNumberGame: nextPitchNumber,
      pitchNumberPa: balls + strikes + 1,
      pitch: buildPitchOutcome(result, balls, strikes, nextBalls, nextStrikes, isStarPitch),
    }
    setBalls(nextBalls)
    setStrikes(nextStrikes)
    setPitchNumber(nextPitchNumber)
    return payload
  }, [balls, strikes, pitchNumber])

  const recordBall = useCallback((isStarPitch = false) => {
    const nextBalls = Math.min(4, balls + 1)
    const payload = registerPitch('ball', nextBalls, strikes, isStarPitch)
    return {
      ...payload,
      completedPa: nextBalls >= 4 ? { result: 'BB' } : null,
    }
  }, [balls, strikes, registerPitch])

  const recordStrike = useCallback((type, isStarPitch = false) => {
    const result = type === 'looking' ? 'looking' : 'swinging_miss'
    const nextStrikes = Math.min(3, strikes + 1)
    const payload = registerPitch(result, balls, nextStrikes, isStarPitch)
    return {
      ...payload,
      completedPa: nextStrikes >= 3 ? { result: 'K', strikeoutType: type === 'looking' ? 'KL' : 'KS' } : null,
    }
  }, [balls, strikes, registerPitch])

  const recordFoul = useCallback((isStarPitch = false) => {
    const nextStrikes = strikes >= 2 ? 2 : strikes + 1
    return {
      ...registerPitch('foul', balls, nextStrikes, isStarPitch),
      completedPa: null,
    }
  }, [balls, strikes, registerPitch])

  const recordHbp = useCallback((isStarPitch = false) => ({
    ...registerPitch('hbp', balls, strikes, isStarPitch),
    completedPa: { result: 'HBP' },
  }), [balls, strikes, registerPitch])

  const recordInPlay = useCallback((isStarPitch = false) => ({
    ...registerPitch('in_play', balls, strikes, isStarPitch),
    completedPa: null,
  }), [balls, strikes, registerPitch])

  const undoPitch = useCallback((pitchEvent) => {
    if (!pitchEvent?.pitch) return
    setBalls(Number(pitchEvent.pitch.count_balls_before ?? 0))
    setStrikes(Number(pitchEvent.pitch.count_strikes_before ?? 0))
    setPitchNumber(Math.max(initialPitchNumber, Number(pitchEvent.pitchNumberGame || initialPitchNumber) - 1))
  }, [initialPitchNumber])

  return {
    balls,
    strikes,
    pitchNumber,
    resetPa,
    restoreState,
    setCount: ({ balls: nextBalls = 0, strikes: nextStrikes = 0 }) => {
      setBalls(nextBalls)
      setStrikes(nextStrikes)
    },
    recordBall,
    recordStrike,
    recordFoul,
    recordHbp,
    recordInPlay,
    undoPitch,
  }
}
