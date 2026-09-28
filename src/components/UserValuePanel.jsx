import { useMemo, useState } from 'react'
import StatLabel from './StatLabel'

const DOMAINS = [
  { id: 'batting', label: 'Batting', value: 'BatUVA', sample: 'pitches' },
  { id: 'pitching', label: 'Pitching', value: 'PitchUVA', sample: 'pitches' },
  { id: 'baserunning', label: 'Baserunning', value: 'BsRUVA', sample: 'sprintSamples' },
  { id: 'fielding', label: 'Fielding', value: 'FldUVA', sample: 'actionAttempts' },
]

const pct = (value) => Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '—'
const num = (value, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : '—'
const integer = (value) => Number.isFinite(value) ? value : '—'
const buttonStyle = { background: 'none', border: 0, color: 'inherit', padding: 0, fontWeight: 'inherit' }

const COLUMNS = {
  batting: [
    ['userRuns', 'BatUVA', (value) => num(value)],
    ['decisionRuns', 'SwDec', (value, row) => row.modeledDecisions ? num(value) : '—'],
    ['executionRuns', 'ConEx', (value, row) => row.modeledExecutions ? num(value) : '—'],
    ['pitches', 'Pitches', integer],
    ['swingRate', 'Swing%', pct],
    ['contactRate', 'Contact%', pct],
    ['chaseRate', 'Chase%', pct],
    ['chaseContactRate', 'Chase Contact%', pct],
    ['outsideZonePitches', 'Out-Zone Pitches', integer],
    ['zoneSwingRate', 'Zone Swing%', pct],
    ['zoneCoverage', 'Zone Tracked%', pct],
    ['shadowPitches', 'Shadow Pitches', integer],
    ['slapSwings', 'Slap Swings', integer],
    ['chargeSwings', 'Charge Swings', integer],
    ['starSwings', 'Star Choices', integer],
    ['bunts', 'Bunts', integer],
    ['chargeCoverage', 'Mode Tracked%', pct],
  ],
  pitching: [
    ['userRuns', 'PitchUVA', (value) => num(value)],
    ['decisionRuns', 'PitchSel', (value, row) => row.modeledDecisions ? num(value) : '—'],
    ['executionRuns', 'Cmd/Exec', (value, row) => row.modeledExecutions ? num(value) : '—'],
    ['pitches', 'Pitches', integer],
    ['changeups', 'Changeups', integer],
    ['starPitches', 'Star Pitches', integer],
    ['inputCoverage', 'Input Tracked%', pct],
    ['aimCoverage', 'Aim Tracked%', pct],
    ['chargeCoverage', 'Charge Tracked%', pct],
  ],
  baserunning: [
    ['userRuns', 'BsRUVA', (value) => num(value)],
    ['executionRuns', 'RunEx', (value, row) => row.modeledExecutions ? num(value) : '—'],
    ['sprintSamples', 'Sprint Samples', integer],
    ['sprintSpeedFps', 'Sprint ft/s', (value) => num(value, 1)],
    ['inputCoverage', 'Shake Tracked%', pct],
    ['automaticRuns', 'Auto BR Runs', (value, row) => row.automaticModeled ? num(value) : '—'],
    ['automaticModeled', 'Auto BR Opp', integer],
  ],
  fielding: [
    ['userRuns', 'FldUVA', (value) => num(value)],
    ['decisionRuns', 'Action Dec', (value, row) => row.modeledDecisions ? num(value) : '—'],
    ['executionRuns', 'Action Ex', (value, row) => row.modeledExecutions ? num(value) : '—'],
    ['actionAttempts', 'Actions', integer],
    ['buddyAttacks', 'Buddy Attacks', integer],
    ['buddyContactRate', 'Buddy Contact%', pct],
    ['buddyJumpAttempts', 'Buddy Jumps', integer],
    ['buddyObjectClears', 'Object Clears', integer],
    ['rangeRuns', 'Range Runs', (value, row) => row.rangeModeled ? num(value) : '—'],
  ],
}

function evidenceText(domain, row) {
  if (Number.isFinite(row.userRuns)) return `${row.modeledDecisions + row.modeledExecutions} modeled value events`
  if (domain === 'batting') {
    if (!row.pitches) return 'No pitch evidence'
    if (row.chargeCoverage) return 'Swing mode observed; value model pending'
    if (row.zoneCoverage) return 'Zone/chase observed; slap/charge calibration pending'
    return 'Decisions observed; slap/charge not tracked'
  }
  if (domain === 'pitching') {
    if (!row.pitches) return 'No pitch evidence'
    if (!row.aimCoverage && !row.chargeCoverage) return 'Pitch results observed; aim and charge not tracked'
    return 'Input evidence partial; value model pending'
  }
  if (domain === 'baserunning') {
    if (!row.sprintSamples) return row.automaticModeled ? 'Automatic runner decisions only' : 'No sprint evidence'
    return row.inputCoverage ? 'Shake observed; value model pending' : 'Speed measured; shake input not tracked'
  }
  if (!row.actionAttempts && !row.rangeModeled) return 'No fielding evidence'
  return row.actionAttempts ? 'Actions observed; counterfactual value pending' : 'Automatic range only; no user action value'
}

export default function UserValuePanel({ model, identity, players = [], characters = [] }) {
  const [domain, setDomain] = useState('batting')
  const [sort, setSort] = useState({ key: 'pitches', descending: true })
  const names = useMemo(() => new Map((identity === 'players' ? players : characters).map((row) => [String(row.id), row.name])), [identity, players, characters])
  const columns = COLUMNS[domain]
  const definition = DOMAINS.find((entry) => entry.id === domain)
  const rows = useMemo(() => (model?.[identity] || [])
    .map((row) => ({ id: row.id, ...row[domain] }))
    .filter((row) => row[definition.sample] || row.modeledDecisions || row.modeledExecutions || row.automaticModeled || row.rangeModeled)
    .sort((left, right) => {
      const a = Number.isFinite(left[sort.key]) ? left[sort.key] : null
      const b = Number.isFinite(right[sort.key]) ? right[sort.key] : null
      if (a == null) return b == null ? (names.get(left.id) || left.id).localeCompare(names.get(right.id) || right.id) : 1
      if (b == null) return -1
      return (a - b) * (sort.descending ? -1 : 1) || (names.get(left.id) || left.id).localeCompare(names.get(right.id) || right.id)
    }), [definition.sample, domain, identity, model, names, sort])
  const modeled = rows.filter((row) => Number.isFinite(row.userRuns)).length

  const changeDomain = (next) => {
    const nextDefinition = DOMAINS.find((entry) => entry.id === next)
    setDomain(next)
    setSort({ key: nextDefinition.sample, descending: true })
  }

  return (
    <section className="table-card" aria-label="User Value Added">
      <div style={{ padding: '16px 20px' }}>
        <h2 style={{ margin: '0 0 8px' }}>User Value Added <span className="muted" style={{ fontSize: 14 }}>Beta</span></h2>
        <p style={{ marginTop: 0 }}>UVA credits only inputs available to the human. Character ability, automatic movement/selection, stadium effects, and result variance remain outside the user total.</p>
        <div className="stats-set-tabs" style={{ marginBottom: 12 }}>
          {DOMAINS.map((entry) => <button
            aria-pressed={domain === entry.id}
            className={`stats-set-tab ${domain === entry.id ? 'stats-set-tab-active' : ''}`}
            key={entry.id}
            onClick={() => changeDomain(entry.id)}
            type="button"
          >{entry.label}</button>)}
        </div>
        <div role="status" className="muted">
          {modeled
            ? `${modeled} ${identity === 'players' ? 'players' : 'characters'} have modeled ${definition.value} in this scope.`
            : `${definition.value} is not yet publishable in this scope; the evidence columns show exactly what is tracked and what is missing.`}
        </div>
        <details style={{ marginTop: 10 }}>
          <summary>Attribution and coverage rules</summary>
          <p>Batting requires explicit slap/charge and timing evidence. Pitching requires input type, charge, and aim endpoints. Baserunning advance/hold value is automatic under no-Nunchuk controls and appears only as Auto BR Runs; shake execution is BsRUVA. Fielding credits explicit sprint/dive/jump/Buddy actions, not automatic fielder selection or routes.</p>
          <p>Blank UVA values mean unmodeled, not zero. Range Runs remain team/character performance context and use 0.90 runs per out for outfield OAA and 0.75 for infield OAA.</p>
        </details>
      </div>
      <div className="stats-table-shell">
        <table className="data-table stats-data-table" style={{ width: '100%', whiteSpace: 'nowrap' }}>
          <thead><tr><th scope="col">{identity === 'players' ? 'Player' : 'Character'}</th>
            {columns.map(([key, label]) => <th scope="col" key={key} aria-sort={sort.key === key ? sort.descending ? 'descending' : 'ascending' : 'none'}>
              <button type="button" style={buttonStyle} onClick={() => setSort({ key, descending: sort.key === key ? !sort.descending : true })}>
                <StatLabel label={label} />{sort.key === key ? sort.descending ? ' ↓' : ' ↑' : ''}
              </button>
            </th>)}
            <th scope="col">Evidence status</th>
          </tr></thead>
          <tbody>{rows.length ? rows.map((row) => <tr key={row.id}>
            <th scope="row">{names.get(row.id) || row.id}</th>
            {columns.map(([key, , format]) => <td key={key}>{format(row[key], row)}</td>)}
            <td>{evidenceText(domain, row)}</td>
          </tr>) : <tr><td colSpan={columns.length + 2}>No {domain} input evidence in this scope.</td></tr>}</tbody>
        </table>
      </div>
    </section>
  )
}
