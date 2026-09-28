import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { groupFinalStatEvents } from '../utils/finalStatDisplay'

const STATUS = {
  object_confirmed: 'Object observed',
  flag_named: 'Named game flag',
  inferred: 'Inferred cause',
  unknown: 'Cause unknown',
}

const PARK_COVERAGE = [
  ['Mario Stadium', 'Supported negative control', 'No park hazard expected'],
  ['Wario City', 'Supported', 'Arrow and manhole evidence'],
  ['Yoshi Park', 'Partial', 'Train inference labeled; night Wiggler untracked'],
  ['Daisy Cruiser', 'Day supported', 'Night creature and tilt effects untracked'],
  ['Peach Ice Garden', 'Partial', 'Freeze cause unknown without Freezie object; night blackout untracked'],
  ['Bowser Castle', 'Partial', 'Several fire and block effects untracked'],
  ['DK Jungle', 'Partial', 'Barrel cause untracked until moving object is located'],
  ['Bowser Jr. Playroom', 'Unnamed effects only', 'Named Thwomp, Chain Chomp and Bullet Bill causes untracked'],
  ["Luigi's Mansion", 'Unnamed effects only', 'Gravestone, ghost and grass causes untracked'],
]

function actorText(actor) {
  if (!actor) return 'Unattributed'
  // A runner is named by the base slot it came from; a fielder by its position.
  return actor.characterName || actor.position || actor.slot
    || (actor.characterId != null ? `Character ${actor.characterId}` : 'Unresolved actor')
}

export default function FinalStatEventsPanel({ plays, identity, kind, playersById, charactersById }) {
  const [family, setFamily] = useState('all')
  const [sort, setSort] = useState('count')
  const [expanded, setExpanded] = useState(null)
  const data = useMemo(() => groupFinalStatEvents(plays, identity, kind), [plays, identity, kind])
  const rows = useMemo(() => data.rows
    .filter((row) => family === 'all' || row.family === family)
    .sort((a, b) => sort === 'count'
      ? b.count - a.count || a.label.localeCompare(b.label)
      : a.label.localeCompare(b.label) || b.count - a.count), [data, family, sort])
  const selected = rows.find((row) => row.key === expanded)
  const actorName = (id) => {
    if (id == null) return 'Unattributed'
    return identity === 'character' ? charactersById[id]?.name || `Character ${id}` : playersById[id]?.name || `Player ${id}`
  }
  const actorLink = (id) => id == null ? null
    : identity === 'character' ? `/character/${id}` : `/teams/${id}/career`

  return (
    <section className="table-card">
      <h2 style={{ marginTop: 0 }}>{kind === 'stadium' ? 'Stadium Interactions' : 'Player Mechanics'}</h2>
      {kind === 'stadium' ? <details style={{ marginBottom: 12 }}><summary>Park measurement coverage</summary><div className="stats-table-shell" style={{ overflowX: 'auto' }}><table className="data-table stats-data-table"><thead><tr><th>Park</th><th>Status</th><th>Limit</th></tr></thead><tbody>{PARK_COVERAGE.map(([park, status, limit]) => <tr key={park}><td>{park}</td><td>{status}</td><td>{limit}</td></tr>)}</tbody></table></div></details> : null}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <label>Show <select value={family} onChange={(event) => { setFamily(event.target.value); setExpanded(null) }}>
          <option value="all">All roles</option>
          {kind === 'stadium' ? <>
            <option value="actor_effect">Affected actors</option>
            <option value="ball_interaction">Ball interactions</option>
            <option value="object_change">Object breaks</option>
          </> : <option value="player_action">Player actions</option>}
        </select></label>
        <label>Sort <select value={sort} onChange={(event) => setSort(event.target.value)}>
          <option value="count">Most incidents</option><option value="name">Type A–Z</option>
        </select></label>
      </div>
      <div className="stats-table-shell" style={{ overflowX: 'auto' }}>
        <table className="data-table stats-data-table" style={{ minWidth: 640 }}>
          <thead><tr><th scope="col">{identity === 'character' ? 'Character' : 'Owner'}</th><th scope="col">Role</th><th scope="col">Type</th><th scope="col">Park</th><th scope="col">Events</th>{kind === 'mechanics' ? <><th scope="col">Contacts</th><th scope="col">Object clears</th><th scope="col">Victims</th></> : <th scope="col">Intentional breaks</th>}<th scope="col">Plays</th><th scope="col">Measured duration</th></tr></thead>
          <tbody>{rows.length ? rows.map((row) => <tr key={row.key}>
            <td>{actorLink(row.actorId) ? <Link to={actorLink(row.actorId)}>{actorName(row.actorId)}</Link> : actorName(row.actorId)}</td>
            <td>{row.role === 'victim' ? 'Affected' : row.role === 'contestant' ? 'Contested' : row.role === 'initiator' ? row.family === 'ball_interaction' ? 'Linked actor' : 'Initiated' : 'Acted'}</td>
            <td>{row.label}</td><td>{row.park}</td>
            <td><button type="button" aria-label={`Show ${row.count} ${row.label} records for ${actorName(row.actorId)}`} aria-expanded={expanded === row.key} onClick={() => setExpanded(expanded === row.key ? null : row.key)}>{row.count}</button></td>
            {kind === 'mechanics' ? <><td>{row.type === 'buddy_attack' ? row.contacts : '—'}</td><td>{row.type === 'buddy_attack' ? row.clears : '—'}</td><td>{row.type === 'star_effect_caused' ? row.victims : '—'}</td></> : null}
            {kind === 'stadium' ? <td>{row.family === 'object_change' ? row.intentional : '—'}</td> : null}
            <td>{row.distinctPlays}</td><td>{row.durationSeconds ? `${row.durationSeconds.toFixed(2)} s` : '—'}</td>
          </tr>) : <tr><td colSpan={kind === 'mechanics' ? 10 : 8} className="muted">{data.coveredPlays ? 'No recorded events for this selection.' : 'This scope has no covered tracking plays.'}</td></tr>}</tbody>
        </table>
      </div>
      {selected ? <div className="panel" style={{ marginTop: 12, padding: 12 }}>
        <h3 style={{ marginTop: 0 }}>{selected.label}: {selected.count} records on {selected.distinctPlays} plays</h3>
        <div style={{ maxHeight: 320, overflowY: 'auto' }}>
          {selected.events.map(({ event, play }, index) => <p key={`${event.id || index}:${play.id || index}`} style={{ margin: '0 0 8px' }}>
            {play.competition_type || 'Unknown competition'} game {play.game_id}, play {play.play_ordinal ?? 'unknown'} · {event.park || 'Unknown park'} · {event.time_of_day || 'unknown'} · {event.label || event.type} · {event.family === 'actor_effect' ? `affected ${actorText(event.victim)}` : kind === 'mechanics' ? `actor ${actorText(event.actor)}` : `initiator ${actorText(event.initiator)}`} · {STATUS[event.cause?.confidence] || (kind === 'mechanics' ? 'Recorded action' : 'Evidence status unknown')}
            {event.duration_seconds != null ? ` · ${Number(event.duration_seconds).toFixed(2)} s` : ''}
            {event.type === 'buddy_attack' ? ` · ${event.contact ? 'contact' : 'no contact'}${event.cleared_object ? ', object cleared' : ''}` : ''}
            {event.type === 'star_effect_caused' ? ` · ${event.victims ?? 0} affected` : ''}
            {event.type === 'close_play' || event.type === 'close_play_contested' ? ` · ${event.won_by === 'fielder' ? 'fielder held on' : event.won_by === 'runner' ? 'runner knocked it loose' : 'result not recorded'}${event.runner?.slot ? ` · runner ${actorText(event.runner)} from ${event.runner.slot}` : ''}` : ''}
            {event.family === 'object_change' ? ` · ${event.intentional ? 'intentional clear' : 'incidental break'}` : ''}
          </p>)}
        </div>
      </div> : null}
    </section>
  )
}
