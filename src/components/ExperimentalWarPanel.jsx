import { useMemo, useState } from 'react'
import StatLabel from './StatLabel'

const columns = [['war', 'Exp. WAR'], ['positionWar', 'Position WAR'], ['pitchingWar', 'Pitching WAR'], ['pa', 'PA'], ['ip', 'IP'], ['battingRuns', 'Bat Runs'], ['baserunningRuns', 'BsR'], ['fieldingRuns', 'Fld Runs'], ['positionRuns', 'Pos Adj'], ['leagueRuns', 'Lg Adj'], ['replacementRuns', 'Repl Runs']]
const format = (value, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : '—'
const innings = (ip) => `${Math.floor(Math.round(ip * 3) / 3)}.${Math.round(ip * 3) % 3}`
const buttonStyle = { background: 'none', border: 0, color: 'inherit', padding: 0, fontWeight: 'inherit' }

export default function ExperimentalWarPanel({ model, identity, players = [], characters = [] }) {
  const [sort, setSort] = useState({ key: 'war', descending: true })
  const [selectedId, setSelectedId] = useState(null)
  const names = useMemo(() => new Map((identity === 'players' ? players : characters).map((row) => [String(row.id), row.name])), [identity, players, characters])
  const rows = useMemo(() => [...model[identity]].sort((a, b) => {
    if (a[sort.key] == null) return b[sort.key] == null ? a.id.localeCompare(b.id) : 1
    if (b[sort.key] == null) return -1
    return (a[sort.key] - b[sort.key]) * (sort.descending ? -1 : 1) || a.id.localeCompare(b.id)
  }), [model, identity, sort])
  const selected = rows.find((row) => `${identity}:${row.id}` === selectedId)
  return (
    <section className="table-card" aria-label="Experimental WAR">
      <div style={{ padding: '16px 20px' }}>
        <h2 style={{ margin: '0 0 8px' }}>Experimental WAR</h2>
        <p className="muted">FanGraphs framework · {model.includedGames} completed games · {model.excludedGames} games excluded · v1</p>
        <p>Exp. WAR = Position WAR + Pitching WAR. Select a name to inspect missing inputs. Unmeasured components contribute neutrally to this provisional total.</p>
        <details>
          <summary>Method and assumptions</summary>
          <p>Uses the published FanGraphs equations, 2025 MLB batting weights, actual innings played, and the league’s nine-inning run environment. Three-inning appearances are not projected into full MLB games.</p>
          <p>Replacement credit follows MLB’s 57% position-player / 43% pitcher split and 1,000 WAR per 2,430 completed games. Each season or tournament is calculated separately before career totals are added.</p>
          <p>Park factors and relief leverage are neutral (1.0). Infield flies and position exposure are reconstructed where the scorebook supports them; pitcher roles use the first recorded opposing at-bat. Tracked extra-base, double-play, and fielding values use experimental Sluggers models as proxies for MLB’s tracking inputs. No stolen-base value is added under the current game rules.</p>
          <p>Player and character views aggregate the same credited performances. They must not be added together. These estimates are not official MLB fWAR and do not isolate human skill from character strength.</p>
          <p><a href="https://library.fangraphs.com/war/war-position-players/" target="_blank" rel="noreferrer">Position-player method</a>{' · '}<a href="https://library.fangraphs.com/war/calculating-war-pitchers/" target="_blank" rel="noreferrer">Pitching method</a>{' · '}<a href="https://www.fangraphs.com/tools/guts" target="_blank" rel="noreferrer">MLB weights</a></p>
          {model.cohorts.map((cohort) => <p className="muted" key={cohort.id}>{cohort.id}: {cohort.games} games, {cohort.leaguePa} PA, {format(cohort.runsPerWin)} runs/win, {format(cohort.expectedWar)} target total WAR.</p>)}
        </details>
        {selected ? <div role="status" style={{ marginTop: 12 }}>
          <strong>{names.get(selected.id) || selected.id}: {format(selected.war)} experimental WAR</strong>
          <p>{selected.runnerOpportunities} modeled runner opportunities · {selected.fieldingOpportunities} modeled fielding opportunities · {selected.positionOuts} outs with position attribution.</p>
          {selected.issues.length ? <ul>{selected.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul> : <p>Tracked components are available. The global model assumptions still apply.</p>}
          <p className="muted">Pitching league correction included: {format(selected.pitchingCorrection, 3)} wins.</p>
        </div> : null}
      </div>
      <div className="stats-table-shell">
        <table className="data-table stats-data-table" style={{ width: '100%', whiteSpace: 'nowrap' }}>
          <thead><tr><th scope="col">{identity === 'players' ? 'Player' : 'Character'}</th>
            {columns.map(([key, label]) => <th scope="col" key={key} aria-sort={sort.key === key ? sort.descending ? 'descending' : 'ascending' : 'none'}>
              <button type="button" style={buttonStyle} onClick={() => setSort({ key, descending: sort.key === key ? !sort.descending : true })}><StatLabel label={label} />{sort.key === key ? sort.descending ? ' ↓' : ' ↑' : ''}</button>
            </th>)}<th scope="col">Coverage</th></tr></thead>
          <tbody>{rows.length ? rows.map((row) => <tr key={row.id}>
            <th scope="row"><button type="button" style={{ ...buttonStyle, color: 'var(--gold)' }} onClick={() => setSelectedId(`${identity}:${row.id}`)}>{names.get(row.id) || row.id}</button></th>
            {columns.map(([key]) => <td key={key}>{key === 'ip' ? innings(row.ip) : key === 'pa' ? row.pa : format(row[key])}</td>)}<td>{row.coverage}</td>
          </tr>) : <tr><td colSpan={columns.length + 2}>No completed games with both batting and pitching data in this scope.</td></tr>}</tbody>
          {rows.length ? <tfoot><tr><th scope="row">League total</th><td>{format(rows.reduce((sum, row) => sum + row.war, 0))}</td><td colSpan={columns.length}>Both identity views reconcile to this total.</td></tr></tfoot> : null}
        </table>
      </div>
    </section>
  )
}
