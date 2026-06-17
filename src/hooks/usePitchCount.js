import { useCallback, useEffect, useRef, useState } from 'react'

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
  // Refs are the synchronous source of truth — always reflect the current count
  // even between React renders. State is kept in sync for rendering only.
  const ballsRef = useRef(0)
  const strikesRef = useRef(0)
  const pitchNumberRef = useRef(initialPitchNumber)

  const [balls, setBalls] = useState(0)
  const [strikes, setStrikes] = useState(0)
  const [pitchNumber, setPitchNumber] = useState(initialPitchNumber)

  useEffect(() => {
    ballsRef.current = 0
    strikesRef.current = 0
    pitchNumberRef.current = initialPitchNumber
    setBalls(0)
    setStrikes(0)
    setPitchNumber(initialPitchNumber)
  }, [pitcherKey, initialPitchNumber])

  const resetPa = useCallback(() => {
    ballsRef.current = 0
    strikesRef.current = 0
    setBalls(0)
    setStrikes(0)
  }, [])

  const restoreState = useCallback(({ balls: nextBalls = 0, strikes: nextStrikes = 0, pitchNumber: nextPitchNumber = initialPitchNumber } = {}) => {
    ballsRef.current = nextBalls
    strikesRef.current = nextStrikes
    pitchNumberRef.current = nextPitchNumber
    setBalls(nextBalls)
    setStrikes(nextStrikes)
    setPitchNumber(nextPitchNumber)
  }, [initialPitchNumber])

  // Reads from refs (not closure) so it's always current, even on rapid presses.
  const registerPitch = useCallback((result, nextBalls, nextStrikes, isStarPitch) => {
    const curBalls = ballsRef.current
    const curStrikes = strikesRef.current
    const nextPitchNumber = pitchNumberRef.current + 1
    const payload = {
      pitchNumberGame: nextPitchNumber,
      pitchNumberPa: curBalls + curStrikes + 1,
      pitch: buildPitchOutcome(result, curBalls, curStrikes, nextBalls, nextStrikes, isStarPitch),
    }
    ballsRef.current = nextBalls
    strikesRef.current = nextStrikes
    pitchNumberRef.current = nextPitchNumber
    setBalls(nextBalls)
    setStrikes(nextStrikes)
    setPitchNumber(nextPitchNumber)
    return payload
  }, []) // no closure deps — reads from refs

  const recordBall = useCallback((isStarPitch = false) => {
    const nextBalls = Math.min(4, ballsRef.current + 1)
    const payload = registerPitch('ball', nextBalls, strikesRef.current, isStarPitch)
    return {
      ...payload,
      completedPa: nextBalls >= 4 ? { result: 'BB' } : null,
    }
  }, [registerPitch])

  const recordStrike = useCallback((type, isStarPitch = false) => {
    const result = type === 'looking' ? 'looking' : 'swinging_miss'
    const nextStrikes = Math.min(3, strikesRef.current + 1)
    const payload = registerPitch(result, ballsRef.current, nextStrikes, isStarPitch)
    return {
      ...payload,
      completedPa: nextStrikes >= 3 ? { result: 'K', strikeoutType: type === 'looking' ? 'KL' : 'KS' } : null,
    }
  }, [registerPitch])

  const recordFoul = useCallback((isStarPitch = false) => {
    const nextStrikes = strikesRef.current >= 2 ? 2 : strikesRef.current + 1
    return {
      ...registerPitch('foul', ballsRef.current, nextStrikes, isStarPitch),
      completedPa: null,
    }
  }, [registerPitch])

  const recordHbp = useCallback((isStarPitch = false) => ({
    ...registerPitch('hbp', ballsRef.current, strikesRef.current, isStarPitch),
    completedPa: { result: 'HBP' },
  }), [registerPitch])

  const recordInPlay = useCallback((isStarPitch = false) => ({
    ...registerPitch('in_play', ballsRef.current, strikesRef.current, isStarPitch),
    completedPa: null,
  }), [registerPitch])

  const undoPitch = useCallback((pitchEvent) => {
    if (!pitchEvent?.pitch) return
    const nextBalls = Number(pitchEvent.pitch.count_balls_before ?? 0)
    const nextStrikes = Number(pitchEvent.pitch.count_strikes_before ?? 0)
    const nextPitchNumber = Math.max(initialPitchNumber, Number(pitchEvent.pitchNumberGame || initialPitchNumber) - 1)
    ballsRef.current = nextBalls
    strikesRef.current = nextStrikes
    pitchNumberRef.current = nextPitchNumber
    setBalls(nextBalls)
    setStrikes(nextStrikes)
    setPitchNumber(nextPitchNumber)
  }, [initialPitchNumber])

  return {
    balls,
    strikes,
    pitchNumber,
    resetPa,
    restoreState,
    setCount: ({ balls: nextBalls = 0, strikes: nextStrikes = 0 }) => {
      ballsRef.current = nextBalls
      strikesRef.current = nextStrikes
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
