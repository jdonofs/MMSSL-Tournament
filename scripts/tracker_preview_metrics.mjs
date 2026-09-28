import { ADVANCED_METRIC_VERSION, MIN_QUALIFYING_RUN_UNITS, METRES_TO_FEET, MPS_TO_MPH, isEligibleDoublePlayPa } from '../src/utils/advancedDefense.js'

const number = (value) => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value)
const scaled = (value, scale) => number(value) == null ? null : number(value) * scale

// A small, selected-play payload. Never fit probabilities to the play being
// reviewed: a held-out baseline is required before those can test accuracy.
export function buildPreviewAdvancedMetrics({ play, atBat, join } = {}) {
  const result = {
    schema_version: 1,
    model_version: ADVANCED_METRIC_VERSION,
    contact_timer: play?.contact_timer ?? null,
    status: !play ? 'pending' : join?.status !== 'joined' ? 'unjoined' : 'ready',
    rows: [],
    models: [
      { label: 'Catch probability / Sluggers OAA', status: 'Baseline required', note: 'Distance and time are available below; no independent fitted baseline is loaded in preview.' },
      { label: 'Arm value / baserunning runs / DP value', status: 'Baseline required', note: 'Requires validated opportunity outcomes and a frozen run-expectancy baseline.' },
    ],
  }
  if (result.status !== 'ready') return result
  const add = (group, actor, label, value, unit, source, note = '', excluded = false) => {
    result.rows.push({ id: source, group, actor, label, value: number(value), unit, source,
      status: excluded ? 'excluded' : number(value) == null ? 'missing' : 'derived', note })
  }
  const primary = play.primary_fielder
  const fielder = play.fielders?.[primary]
  if (fielder) {
    const actor = `${fielder.character || primary} (${primary})`
    const field = (label, key, unit, note = '') => add('Fielding', actor, label, fielder[key], unit, `play.fielders.${primary}.${key}`, note)
    field('Distance to landing / catch', 'distance_to_landing_units', 'u')
    add('Fielding', actor, 'Opportunity time', play.hang_time_s, 's', 'play.hang_time_s')
    field('Reaction time', 'reaction_s', 's')
    field('Route efficiency', 'route_efficiency', 'ratio')
    field('Movement speed', 'sprint_speed_ups', 'u/s', 'Per-play movement, not a player speed rating.')
    field('Jump distance', 'jump_distance_feet', 'ft', 'Prototype: sampled from pitch release; short windows may use the last available frame.')
    field('Reaction distance', 'reaction_distance_feet', 'ft', 'Prototype first 1.5 seconds from pitch release.')
    field('Burst distance', 'burst_distance_feet', 'ft', 'Prototype 1.5–3 seconds from pitch release.')
    field('Jump route efficiency', 'jump_route_efficiency', 'ratio')
    field('Assisted movement', 'assist_units', 'u', 'Game-assisted movement is excluded from measured sprint speed.')
  }
  for (const [index, entry] of (play.throws || []).entries()) {
    if (entry.is_throw === false) continue
    const actor = `${entry.thrower_character || entry.thrower_position || 'Unknown'} · throw ${entry.sequence ?? index + 1}`
    const excluded = Boolean(entry.buddy_throw || play.truncated)
    const converted = number(entry.peak_speed_mph) == null
    add('Throws', actor, 'Peak throw speed', number(entry.peak_speed_mph) ?? scaled(entry.peak_speed_mps, MPS_TO_MPH), 'mph',
      `play.throws.${index}.${converted ? 'peak_speed_mps' : 'peak_speed_mph'}`,
      `${converted ? 'Converted from m/s. ' : ''}${excluded ? 'Excluded from ordinary arm strength: Buddy Throw or truncated play.' : 'Single throw measurement; arm strength uses a qualifying sample of hardest throws.'}`, excluded)
  }
  for (const [slot, entry] of Object.entries(play.runners || {})) {
    const actor = `${entry.character || slot} (${slot})`
    const path = number(entry.path_units)
    const excluded = Boolean(play.truncated || number(entry.teleports) > 0 || (path != null && path < MIN_QUALIFYING_RUN_UNITS))
    const converted = number(entry.sprint_speed_fps) == null
    add('Running', actor, 'Sprint speed', number(entry.sprint_speed_fps) ?? scaled(entry.sprint_speed_ups, METRES_TO_FEET), 'ft/s',
      `play.runners.${slot}.${converted ? 'sprint_speed_ups' : 'sprint_speed_fps'}`,
      `${converted ? 'Converted from u/s using the tracker scale. ' : ''}${excluded ? `Excluded from speed rating: short run (<${MIN_QUALIFYING_RUN_UNITS} u), teleport, or truncated play.` : 'Per-run fastest one-second window; player rating requires multiple qualifying runs.'}`, excluded)
    add('Running', actor, 'Run distance', path, 'u', `play.runners.${slot}.path_units`)
    if (slot === 'BAT') {
      add('Running', actor, 'Home to first', play.home_to_first_s, 's', 'play.home_to_first_s')
      add('Running', actor, '90-foot split', play.ninety_foot_split_s, 's', 'play.ninety_foot_split_s')
    } else {
      add('Running', actor, 'Lead at contact', entry.lead_at_contact_units, 'u', `play.runners.${slot}.lead_at_contact_units`)
    }
  }
  result.double_play = atBat?.outs_before_pa == null ? null : isEligibleDoublePlayPa(atBat, atBat.outs_before_pa)
  result.exclusions = [
    play.truncated && 'Truncated play: incomplete measurement windows.',
    play.after_deflection && 'Rebound after a deflection: excluded from ordinary OAA.',
    play.forced_misplays?.length > 0 && 'Forced misplay: excluded from ordinary OAA.',
    play.buddy_handoffs?.length > 0 && 'Buddy handoff: excluded from ordinary OAA.',
  ].filter(Boolean)
  return result
}
