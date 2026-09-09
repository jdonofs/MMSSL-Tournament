import { buildExtraBaseOpportunitiesFromPa } from './advancedDefense.js'

// Idempotent per-PA refresh shared by manual entry, edits and tracker writes.
// Unchanged opportunities retain fitted values and tracking enrichment.
export async function syncRunnerOpportunities(db, { pa, competitionType, outsBefore, responsibleFielder = null }) {
  if (!pa?.id || !['season', 'tournament'].includes(competitionType)) throw new Error('A saved PA and competition type are required')
  if (!Number.isInteger(outsBefore) || outsBefore < 0 || outsBefore > 2) throw new Error('The outs before this PA are required to refresh baserunning opportunities')
  const scope = () => db.from('runner_opportunities').select('*')
    .eq('competition_type', competitionType).eq('game_id', pa.game_id).eq('pa_id', pa.id)
  const { data: existing = [], error } = await scope()
  if (error) throw error
  const rows = buildExtraBaseOpportunitiesFromPa(pa, { competitionType, outsBefore, responsibleFielder })
  const key = (row) => `${row.runner_id}:${row.target_base}`
  const previous = new Map(existing.map((row) => [key(row), row]))
  const changed = rows.filter((row) => {
    const old = previous.get(key(row))
    return !old || Object.keys(row).some((field) => (
      field === 'model_version' ? false
        : field === 'quality' ? Object.keys(row.quality).some((key) => old.quality?.[key] !== row.quality[key])
          : JSON.stringify(old[field] ?? null) !== JSON.stringify(row[field] ?? null)
    ))
  }).map((row) => ({ ...row, quality: { ...previous.get(key(row))?.quality, ...row.quality }, expected_attempt_probability: null, expected_success_probability: null, runner_run_value: null, arm_run_value: null }))
  if (changed.length) {
    const { error: saveError } = await db.from('runner_opportunities')
      .upsert(changed, { onConflict: 'competition_type,game_id,pa_id,runner_id,target_base' })
    if (saveError) throw saveError
  }
  const wanted = new Set(rows.map(key))
  const staleIds = existing.filter((row) => !wanted.has(key(row))).map((row) => row.id)
  if (staleIds.length) {
    const { error: deleteError } = await db.from('runner_opportunities').delete()
      .eq('competition_type', competitionType).eq('game_id', pa.game_id).eq('pa_id', pa.id).in('id', staleIds)
    if (deleteError) throw deleteError
  }
  return { opportunities: rows.length, updated: changed.length, removed: staleIds.length }
}
