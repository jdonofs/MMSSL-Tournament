import { summarizeStadiumIncidents } from './stadiumIncidents.js'
import { summarizeMechanics } from './playerMechanics.js'

const list = (value) => Array.isArray(value) ? value : []

// The page has already selected completed games and active tracking versions.
// Keep the same quarantine rule as the canonical aggregators.
export function groupFinalStatEvents(plays = [], identity = 'player', kind = 'stadium') {
  const idField = identity === 'character' ? 'characterId' : 'playerId'
  const groups = new Map()
  let coveredPlays = 0
  let legacyPlays = 0
  let quarantinedPlays = 0
  for (const play of plays) {
    if (play?.quality?.quarantined_session === true) { quarantinedPlays += 1; continue }
    const base = kind === 'mechanics' ? play?.quality?.play_mechanics : play?.quality?.stadium_incidents
    if (!Array.isArray(base)) { legacyPlays += 1; continue }
    const source = kind === 'mechanics'
      ? [...base,
        // THE RUNNER'S HALF OF A CLOSE PLAY, as its own row. The contest is one
        // record naming two people; listing it only under the fielder is what
        // left the runner who knocked the ball loose with nothing on the page.
        ...base.filter((event) => event?.type === 'close_play' && event?.runner)
          .map((event) => ({ ...event, type: 'close_play_contested', label: 'close play (runner)', actor: event.runner })),
        ...list(play?.quality?.stadium_incidents)
          .filter((event) => event?.cause?.player_caused)
          .map((event) => ({ ...event, type: `star_effect_suffered_${event.type}`, label: event.label, actor: event.victim }))]
      : base
    coveredPlays += 1
    // Mechanics recorded before they carried a park fall back to the capture's
    // own stadium (the session's stadium_key) and to any incident on the play.
    const incidents = list(play?.quality?.stadium_incidents)
    const playPark = play?.park || incidents.find((event) => event?.park)?.park || null
    const playTime = incidents.find((event) => event?.time_of_day && event.time_of_day !== 'unknown')?.time_of_day || null
    for (const recorded of source) {
      const event = {
        ...recorded,
        park: recorded.park || playPark,
        time_of_day: recorded.time_of_day && recorded.time_of_day !== 'unknown' ? recorded.time_of_day : playTime || recorded.time_of_day,
      }
      if (kind === 'stadium' && event?.cause?.player_caused) continue
      const type = event.type || 'unknown'
      const role = kind === 'mechanics'
        ? type.startsWith('star_effect_suffered_') ? 'victim' : type === 'close_play_contested' ? 'contestant' : 'actor'
        : event.family === 'actor_effect' ? 'victim' : 'initiator'
      const actor = role === 'contestant' ? event.actor : event[role]
      const actorId = actor?.[idField] == null ? null : String(actor[idField])
      const family = kind === 'mechanics' ? 'player_action' : event.family
      const park = event.park || 'Unknown park'
      const key = [family, type, park, actorId ?? 'unattributed'].join('|')
      if (!groups.has(key)) groups.set(key, { key, family, type, label: event.label || type.replaceAll('_', ' '), park, actorId, role, events: [], plays: new Set(), durationSeconds: 0, contacts: 0, clears: 0, victims: 0, intentional: 0 })
      const group = groups.get(key)
      group.events.push({ event, play })
      if (event.contact) group.contacts += 1
      if (event.cleared_object) group.clears += 1
      if (event.intentional) group.intentional += 1
      if (event.type === 'star_effect_caused') group.victims += Number(event.victims) || 0
      group.plays.add(`${play.competition_type || 'unknown'}:${play.game_id}:${play.play_ordinal}`)
      if (event.duration_seconds != null && Number.isFinite(Number(event.duration_seconds))) group.durationSeconds += Number(event.duration_seconds)
    }
  }
  const summary = kind === 'mechanics'
    ? summarizeMechanics(plays, identity)
    : summarizeStadiumIncidents(plays, identity)
  return {
    rows: [...groups.values()].map(({ plays: playSet, ...group }) => ({ ...group, count: group.events.length, distinctPlays: playSet.size })),
    summary, coveredPlays, legacyPlays, quarantinedPlays,
  }
}
