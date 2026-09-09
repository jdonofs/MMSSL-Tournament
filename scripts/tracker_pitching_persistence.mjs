import { isCreditedHit } from '../src/utils/creditedHit.js'
import { updateRowsVerified } from './tracker_persistence.mjs'

function outsForPa(result, outsOnPlay) {
  if (outsOnPlay != null) return Math.max(0, Number(outsOnPlay) || 0)
  if (result === 'DP') return 2
  if (result === 'TP') return 3
  return ['K', 'GO', 'FO', 'LO', 'FC', 'SF', 'SH'].includes(result) ? 1 : 0
}

function inningsFromOuts(outs) {
  return Math.floor(outs / 3) + (outs % 3) / 10
}

export async function recomputeTrackerPitchingStats(supabase, { tables, gameId }) {
  const [{ data: stints, error: stintsError }, { data: pas, error: pasError },
    { data: runs, error: runsError }, { data: pitches, error: pitchesError }] = await Promise.all([
    supabase.from(tables.pitchingStints).select('*').eq('game_id', gameId),
    supabase.from(tables.plateAppearances).select('*').eq('game_id', gameId),
    supabase.from(tables.runsScored).select('*').eq('game_id', gameId),
    supabase.from(tables.pitches).select('*').eq('game_id', gameId),
  ])
  const firstError = stintsError || pasError || runsError || pitchesError
  if (firstError) throw firstError
  if (!stints?.length) return []

  const sortedStints = [...stints].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
  const sortedPas = [...(pas || [])].sort((a, b) => {
    const byNumber = (Number(a.pa_number) || 0) - (Number(b.pa_number) || 0)
    return byNumber || new Date(a.created_at) - new Date(b.created_at)
  })
  const stats = Object.fromEntries(sortedStints.map((stint) => [stint.id, {
    innings_pitched: 0, hits_allowed: 0, runs_allowed: 0, earned_runs: 0,
    walks: 0, strikeouts: 0, hr_allowed: 0, pitches_thrown: 0, strikes_thrown: 0, _outs: 0,
  }]))
  const stintFor = (characterId, at) => sortedStints.filter((stint) => (
    String(stint.character_id) === String(characterId)
    && new Date(stint.created_at).getTime() <= new Date(at).getTime()
  )).at(-1) || null

  for (const pa of sortedPas) {
    const active = stintFor(pa.pitcher_id, pa.created_at)
    if (!active) continue
    const line = stats[active.id]
    line._outs += outsForPa(pa.result, pa.outs_on_play)
    if (isCreditedHit(pa)) line.hits_allowed += 1
    if (isCreditedHit(pa) && ['HR', 'IPHR'].includes(pa.result)) line.hr_allowed += 1
    if (pa.result === 'BB') line.walks += 1
    if (pa.result === 'K') line.strikeouts += 1
    const paPitches = (pitches || []).filter((pitch) => String(pitch.pa_id) === String(pa.id))
    line.pitches_thrown += paPitches.length
    line.strikes_thrown += paPitches.filter((pitch) => pitch.result !== 'ball' && pitch.result !== 'hbp').length
    for (const run of (runs || []).filter((row) => String(row.pa_id) === String(pa.id))) {
      const charged = String(run.charged_to_pitcher_id) === String(active.character_id)
        ? active : stintFor(run.charged_to_pitcher_id, pa.created_at)
      const target = charged ? stats[charged.id] : line
      target.runs_allowed += 1
      if (run.is_earned_run !== false) target.earned_runs += 1
    }
  }

  const updates = []
  for (const stint of sortedStints) {
    const { _outs, ...payload } = stats[stint.id]
    payload.innings_pitched = inningsFromOuts(_outs)
    await updateRowsVerified(supabase, tables.pitchingStints, { id: stint.id }, payload)
    updates.push({ id: stint.id, ...payload })
  }
  return updates
}
