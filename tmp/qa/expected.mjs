// Independent hand-tally: simulates the scripted game plan under official
// baseball rules (no app code reused) and emits expected stat lines.
import { plan } from './game1_plan.mjs'

const HIT_TB = { '1B': 1, '2B': 2, '3B': 3, HR: 4, IPHR: 4 }
const OUTS_BY_RESULT = { K: 1, GO: 1, FO: 1, LO: 1, SF: 1, SH: 1, FC: 1, DP: 2, TP: 3 }
const NOT_AB = new Set(['BB', 'HBP', 'SF', 'SH'])
const BASE_ORDER = ['1B', '2B', '3B']

export function simulate() {
  const batting = {}
  const pitching = {}
  const runsLog = [] // { scorer, half, paId, chargedTo, earned }
  const bat = (name) => (batting[name] ||= { pa: 0, ab: 0, h: 0, s1: 0, s2: 0, s3: 0, hr: 0, r: 0, rbi: 0, bb: 0, hbp: 0, so: 0, sf: 0, sh: 0, tb: 0, rispAb: 0, rispH: 0, rispPa: 0, lob: 0 })
  const pit = (name) => (pitching[name] ||= { outs: 0, h: 0, r: 0, er: 0, bb: 0, hbp: 0, k: 0, hr: 0, pitches: 0, strikes: 0 })

  // Bases: { '1B': {name, reachedVia, chargedPitcher} }
  let bases = {}
  let currentHalf = 'T1'
  let outs = 0
  const pitcherFor = { A: () => 'Dark Bones', B: null } // B changes mid-T2
  let bPitcher = 'Luigi'
  const currentPitcher = (half) => (half.startsWith('T') ? bPitcher : 'Dark Bones')

  const inningRuns = {} // half -> runs
  const teamTotals = { A: { r: 0, h: 0 }, B: { r: 0, h: 0 } }

  for (const pa of plan) {
    if (pa.half !== currentHalf) {
      currentHalf = pa.half
      bases = {}
      outs = 0
    }
    const half = pa.half
    const team = half.startsWith('T') ? 'A' : 'B'
    const pitcher = currentPitcher(half)
    const b = bat(pa.batter)
    const p = pit(pitcher)
    const result = pa.final

    // pitch accounting
    for (const kind of pa.pitches || []) {
      p.pitches += 1
      if (kind === 'BALL') { /* ball */ } else if (kind === 'HBP') { /* not a strike */ } else p.strikes += 1
    }
    if (pa.inplay) { p.pitches += 1; p.strikes += 1 }

    // RISP before PA
    const risp = Boolean(bases['2B'] || bases['3B'])
    b.pa += 1
    b.rispPa += risp ? 1 : 0
    if (!NOT_AB.has(result)) {
      b.ab += 1
      if (risp) b.rispAb += 1
    }

    const scorers = [] // runner objects scoring this PA
    const destMap = Object.fromEntries((pa.inplay?.dests || []).map(([n, d]) => [n, d]))

    const advanceForced = () => {
      // BB/HBP force advances
      const moved = {}
      const chain = ['1B', '2B', '3B']
      let pushBase = '1B'
      let forced = true
      let carry = { name: pa.batter, reachedVia: result, chargedPitcher: pitcher }
      for (const base of chain) {
        if (!forced) break
        const occupant = bases[base]
        moved[base] = carry
        if (occupant) { carry = occupant; forced = true } else { forced = false; carry = null }
      }
      if (carry) scorers.push(carry) // forced in from 3rd (bases loaded)
      Object.assign(bases, moved)
    }

    if (result === 'BB' || result === 'HBP') {
      if (result === 'BB') { b.bb += 1; p.bb += 1 } else { b.hbp += 1; p.hbp += 1 }
      advanceForced()
    } else if (result === 'K') {
      b.so += 1; p.k += 1
    } else if (result === 'HR' || result === 'IPHR') {
      b.h += 1; b.hr += 1; b.tb += 4; p.h += 1; p.hr += 1
      if (risp) b.rispH += 1
      teamTotals[team].h += 1
      for (const base of BASE_ORDER) if (bases[base]) scorers.push(bases[base])
      scorers.push({ name: pa.batter, reachedVia: result, chargedPitcher: pitcher, isBatter: true })
      bases = {}
    } else if (HIT_TB[result]) {
      b.h += 1; b.tb += HIT_TB[result]; p.h += 1
      b.s1 += result === '1B' ? 1 : 0; b.s2 += result === '2B' ? 1 : 0; b.s3 += result === '3B' ? 1 : 0
      if (risp) b.rispH += 1
      teamTotals[team].h += 1
      applyDests()
      bases[result === '1B' ? '1B' : result === '2B' ? '2B' : '3B'] = { name: pa.batter, reachedVia: result, chargedPitcher: pitcher }
    } else if (result === 'ROE') {
      applyDests()
      bases['1B'] = { name: pa.batter, reachedVia: 'ROE', chargedPitcher: pitcher }
    } else if (result === 'FC') {
      applyDests()
      bases[pa.inplay.batterDest || '1B'] = { name: pa.batter, reachedVia: 'FC', chargedPitcher: pitcher }
    } else if (result === 'SF') {
      b.sf += 1
      applyDests()
    } else if (result === 'SH') {
      b.sh += 1
      applyDests()
    } else { // GO, FO, LO, DP, TP, K handled above
      applyDests()
    }

    function applyDests() {
      const next = {}
      for (const base of BASE_ORDER) {
        const runner = bases[base]
        if (!runner) continue
        const dest = destMap[runner.name] ?? base // default hold
        if (dest === 'Home') scorers.push(runner)
        else if (dest === 'Out') { /* runner out */ }
        else next[dest] = runner
      }
      bases = next
    }

    // outs
    const outsOnPlay = OUTS_BY_RESULT[result] || 0
    outs += outsOnPlay

    // runs & RBI
    for (const s of scorers) {
      bat(s.name).r += 1
      const charged = pit(s.chargedPitcher)
      charged.r += 1
      const earned = s.reachedVia !== 'ROE'
      if (earned) charged.er += 1
      runsLog.push({ scorer: s.name, half, paId: pa.id, chargedTo: s.chargedPitcher, earned })
      teamTotals[team].r += 1
      inningRuns[half] = (inningRuns[half] || 0) + 1
    }
    const rbiZero = ['ROE', 'DP', 'TP', 'FC'].includes(result)
    b.rbi += rbiZero ? 0 : scorers.length

    // pitcher outs credited to CURRENT pitcher
    p.outs += outsOnPlay

    if (pa.afterPa?.changePitcher) bPitcher = pa.afterPa.changePitcher
  }

  return { batting, pitching, runsLog, inningRuns, teamTotals }
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  const { batting, pitching, runsLog, inningRuns, teamTotals } = simulate()
  console.log('BATTING:')
  for (const [name, s] of Object.entries(batting)) console.log(name.padEnd(18), JSON.stringify(s))
  console.log('PITCHING:')
  for (const [name, s] of Object.entries(pitching)) console.log(name.padEnd(12), JSON.stringify(s))
  console.log('RUNS:', runsLog.length)
  runsLog.forEach((r) => console.log(' ', JSON.stringify(r)))
  console.log('INNING RUNS:', JSON.stringify(inningRuns))
  console.log('TEAM TOTALS:', JSON.stringify(teamTotals))
}
