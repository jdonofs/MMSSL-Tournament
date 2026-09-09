import { useEffect, useMemo } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { percentileOfValue, summarizeBatting } from '../utils/statsCalculator'
import { getTalentTierMeta } from '../utils/characterAnalysis'
import { buildRawValueRows } from '../utils/measuredAttributes'
import { buildScopeOptions } from '../utils/characterScopes'
import useCharacterProfileData from '../hooks/useCharacterProfileData'
import useCharacterExtras from '../hooks/useCharacterExtras'
import useCharacterMetaFallback from '../hooks/useCharacterMeta'
import CharacterPortrait from '../components/CharacterPortrait'
import PercentileBar from '../components/PercentileBar'
import RollingStatChart from '../components/RollingStatChart'
import SprayChart from '../components/SprayChart'
import TeamLogo from '../components/TeamLogo'
import { getChemistry } from '../data/chemistry'
import { getTeamShortName, buildPlayerTeamIdentity, buildSeasonTeamIdentity } from '../utils/teamIdentity'
import '../styles/stats-pages.css'

const BACK_TO_STORAGE_PREFIX = 'sluggers-character-back:'
const ROLLING_WINDOW = 15

function getTierBadgeStyle(tier) {
  const map = {
    S: { bg: 'rgba(125,211,252,0.15)', border: 'rgba(125,211,252,0.4)', color: '#7DD3FC' },
    A: { bg: 'rgba(74,222,128,0.15)', border: 'rgba(74,222,128,0.4)', color: '#4ADE80' },
    B: { bg: 'rgba(234,179,8,0.15)', border: 'rgba(234,179,8,0.4)', color: '#EAB308' },
    C: { bg: 'rgba(249,115,22,0.15)', border: 'rgba(249,115,22,0.4)', color: '#F97316' },
    D: { bg: 'rgba(239,68,68,0.15)', border: 'rgba(239,68,68,0.4)', color: '#EF4444' },
    F: { bg: 'rgba(239,68,68,0.2)', border: 'rgba(239,68,68,0.5)', color: '#EF4444' },
  }
  return map[tier] || map.C
}

// ─── The percentile column ───────────────────────────────────────────────────
//
// Every bar ranks against the FULL cast, so a character with no tracker samples renders an
// empty bar rather than a zero. `invert` marks the metrics where lower is better.
const PERCENTILE_GROUPS = [
  {
    title: 'Value',
    metrics: [
      { key: 'xwoba', label: 'xwOBA', digits: 3 },
      { key: 'baserunningRunValue', label: 'Baserunning Run Value', digits: 1 },
      { key: 'fieldingRunValue', label: 'Fielding Run Value', digits: 1 },
    ],
  },
  {
    title: 'Batting',
    metrics: [
      { key: 'exitVelo', label: 'Avg Exit Velo', digits: 1, suffix: ' mph' },
      { key: 'barrelRate', label: 'Barrel %', digits: 1, suffix: '%' },
      { key: 'hardHitRate', label: 'Hard-Hit %', digits: 1, suffix: '%' },
      { key: 'whiffRate', label: 'Whiff %', digits: 1, suffix: '%', invert: true },
      { key: 'kRate', label: 'K %', digits: 1, suffix: '%', invert: true },
      { key: 'bbRate', label: 'BB %', digits: 1, suffix: '%' },
    ],
  },
  {
    title: 'Fielding',
    metrics: [
      { key: 'outsAboveAverage', label: 'Range (OAA)', digits: 1 },
      { key: 'armStrengthMph', label: 'Arm Strength', digits: 1, suffix: ' mph' },
      { key: 'routeEfficiency', label: 'Route Efficiency', digits: 3 },
    ],
  },
  {
    title: 'Running',
    metrics: [
      { key: 'sprintSpeedFps', label: 'Sprint Speed', digits: 1, suffix: ' ft/s' },
      { key: 'homeToFirstSeconds', label: 'Home to First', digits: 2, suffix: ' s', invert: true },
    ],
  },
]

const CARD_STYLE = {
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 12,
  padding: '1rem 1.1rem',
  minWidth: 0,
}

const GROUP_TITLE_STYLE = {
  color: '#94A3B8', fontSize: 10, fontWeight: 800, textTransform: 'uppercase',
  letterSpacing: '.12em', margin: '0 0 10px',
}

function formatSigned(value, digits) {
  if (!Number.isFinite(value)) return '-'
  const fixed = Math.abs(value).toFixed(digits)
  if (value > 0) return `+${fixed}`
  if (value < 0) return `-${fixed}`
  return fixed
}

function ScopePicker({ characterId, scope, scopeOptions }) {
  const isActive = (type, id) => (
    type === 'career' ? scope.type === 'career' : scope.type === type && String(scope.id) === String(id)
  )
  const chip = (active) => ({
    display: 'inline-block', padding: '0.3rem 0.7rem', borderRadius: 999, fontSize: 12,
    fontWeight: 700, textDecoration: 'none', whiteSpace: 'nowrap',
    background: active ? 'rgba(59,130,246,0.18)' : 'rgba(255,255,255,0.04)',
    border: `1px solid ${active ? 'rgba(59,130,246,0.5)' : 'rgba(255,255,255,0.09)'}`,
    color: active ? '#93C5FD' : '#CBD5E1',
  })

  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      <Link to={`/character/${characterId}/scouting`} style={chip(isActive('career'))}>Career</Link>
      {scopeOptions.map((opt) => (
        <Link
          key={`${opt.type}:${opt.id}`}
          to={`/character/${characterId}/${opt.type}/${opt.id}/scouting`}
          style={chip(isActive(opt.type, opt.id))}
        >
          {opt.label}
        </Link>
      ))}
    </div>
  )
}

function RawValueTable({ rows }) {
  const groups = ['Batting', 'Pitching', 'Fielding', 'Running']
  const th = { padding: '7px 8px', textAlign: 'left', color: '#64748B', fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.08em', whiteSpace: 'nowrap' }
  const td = { padding: '6px 8px', fontSize: 12, whiteSpace: 'nowrap' }
  const dash = <span style={{ color: '#475569' }}>—</span>

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', minWidth: 640, borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th scope="col" style={{ ...th, width: '30%' }}>Metric</th>
            <th scope="col" style={{ ...th, textAlign: 'right' }}>Data-mined</th>
            <th scope="col" style={{ ...th, textAlign: 'right' }}>Measured</th>
            <th scope="col" style={{ ...th, textAlign: 'right' }}>n</th>
            <th scope="col" style={{ ...th, textAlign: 'right' }}>Δ pct</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => {
            const groupRows = rows.filter((row) => row.group === group)
            if (!groupRows.length) return null
            return [
              <tr key={`${group}-head`}>
                <td colSpan={5} style={{ padding: '12px 8px 4px', color: '#94A3B8', fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.12em' }}>
                  {group}
                </td>
              </tr>,
              ...groupRows.map((row) => {
                const deltaColor = row.delta == null ? '#475569'
                  : row.delta > 0 ? '#4ADE80'
                    : row.delta < 0 ? '#F87171' : '#94A3B8'
                return (
                  <tr key={row.key} style={{ borderTop: '1px solid rgba(148,163,184,0.12)' }}>
                    <td style={{ ...td, color: '#E2E8F0', fontWeight: 600 }}>
                      {row.label}
                      {row.measuredLabel ? (
                        <span style={{ color: '#64748B', fontWeight: 500 }}> · {row.measuredLabel}</span>
                      ) : null}
                    </td>
                    <td style={{ ...td, textAlign: 'right', color: '#F8FAFC' }}>
                      {row.minedValue == null ? dash : (
                        <>
                          {row.minedValue.toFixed(row.minedDigits)}
                          {row.minedPercentile != null && (
                            <span style={{ color: '#64748B', fontSize: 10 }}> ({row.minedPercentile})</span>
                          )}
                        </>
                      )}
                    </td>
                    <td style={{ ...td, textAlign: 'right', color: '#F8FAFC' }}>
                      {row.measuredValue == null ? dash : (
                        <>
                          {row.measuredValue.toFixed(row.measuredDigits)}
                          {row.measuredUnit ? <span style={{ color: '#94A3B8' }}> {row.measuredUnit}</span> : null}
                          {row.measuredPercentile != null && (
                            <span style={{ color: '#64748B', fontSize: 10 }}> ({row.measuredPercentile})</span>
                          )}
                        </>
                      )}
                    </td>
                    <td style={{ ...td, textAlign: 'right', color: '#64748B' }}>
                      {row.samples == null ? dash : row.samples}
                    </td>
                    <td style={{ ...td, textAlign: 'right', color: deltaColor, fontWeight: 700 }}>
                      {row.delta == null ? dash : formatSigned(row.delta, 0)}
                    </td>
                  </tr>
                )
              }),
            ]
          })}
        </tbody>
      </table>
    </div>
  )
}

export default function CharacterScoutingReport() {
  const { id, seasonId, tournamentId } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const presetState = location.state || null
  const hasPreset = Boolean(presetState?.character)

  useEffect(() => {
    if (presetState?.backTo && id) {
      sessionStorage.setItem(`${BACK_TO_STORAGE_PREFIX}${id}`, presetState.backTo)
    }
  }, [id, presetState?.backTo])

  const fallbackMeta = useCharacterMetaFallback(id, hasPreset)
  const meta = hasPreset ? presetState : fallbackMeta
  const character = meta?.character || null
  const playersById = meta?.playersById || {}
  const identitiesByPlayerId = meta?.identitiesByPlayerId || {}

  const scope = useMemo(() => {
    if (seasonId) return { type: 'season', id: seasonId }
    if (tournamentId) return { type: 'tournament', id: tournamentId }
    return { type: 'career' }
  }, [seasonId, tournamentId])
  const isCareer = scope.type === 'career'

  const profileData = useCharacterProfileData(character, isCareer ? null : scope, presetState?.profileData || {})
  const extras = useCharacterExtras(character, isCareer ? null : scope)

  const {
    allTimeBatting, currentTournamentBatting, battingHistory = [], pitchingHistory = [],
    seasonTeamsById = {},
  } = profileData
  const {
    fieldingHistory = [], measuredByCharacterId = {}, minedByCharacterId = {},
    analysesByCharacterId = {},
  } = extras

  const scopeOptions = useMemo(
    () => buildScopeOptions(battingHistory, pitchingHistory, fieldingHistory),
    [battingHistory, pitchingHistory, fieldingHistory],
  )

  const talentAnalysis = character ? analysesByCharacterId[character.id] || null : null
  const measured = character ? measuredByCharacterId[String(character.id)] || null : null
  const measuredValues = useMemo(() => Object.values(measuredByCharacterId), [measuredByCharacterId])

  const rawValueRows = useMemo(
    () => (character ? buildRawValueRows(character.id, minedByCharacterId, measuredByCharacterId) : []),
    [character, minedByCharacterId, measuredByCharacterId],
  )

  const showBatting = isCareer ? allTimeBatting : currentTournamentBatting
  const rawPasBatting = showBatting?.rawPas || []

  const rollingChartPoints = useMemo(() => {
    if (rawPasBatting.length < ROLLING_WINDOW) return []
    const points = []
    for (let i = ROLLING_WINDOW - 1; i < rawPasBatting.length; i++) {
      const windowPas = rawPasBatting.slice(i - ROLLING_WINDOW + 1, i + 1)
      const s = summarizeBatting(windowPas)
      points.push({ value: s.obp + s.slg, xLabel: `PA ${i + 1}` })
    }
    return points
  }, [rawPasBatting])

  // Every team this character has suited up for, so the identity card can show the same chips
  // the character page header does.
  const teamHistory = useMemo(() => {
    const rows = new Map()
    battingHistory.forEach((entry) => {
      if (!entry.playerId || !entry.eventType || entry.eventId == null) return
      const key = `${entry.eventType}:${entry.eventId}`
      if (rows.has(key)) return
      const identity = entry.eventType === 'season'
        ? buildSeasonTeamIdentity(seasonTeamsById[entry.seasonTeamId] || null)
        : buildPlayerTeamIdentity(playersById[entry.playerId] || null)
      rows.set(key, {
        eventType: entry.eventType,
        eventId: entry.eventId,
        eventLabel: entry.sourceLabel || String(entry.eventNumber ?? ''),
        playerId: entry.playerId,
        playerName: playersById[entry.playerId]?.name || null,
        identity: identity || identitiesByPlayerId[entry.playerId] || null,
      })
    })
    return [...rows.values()]
  }, [battingHistory, playersById, seasonTeamsById, identitiesByPlayerId])

  const handleBack = () => {
    const storedBackTo = id ? sessionStorage.getItem(`${BACK_TO_STORAGE_PREFIX}${id}`) : null
    if (storedBackTo) navigate(storedBackTo)
    else navigate(`/character/${id}/career`)
  }

  // Same split as CharacterPage: meta === null is still loading, meta with no character means the
  // id doesn't exist. The unavailable case needs a way out — a bare sentence left the reader on a
  // dead page with only the browser Back button.
  if (!character) {
    return (
      <div style={{ display: 'grid', gap: 16 }}>
        {meta === null ? (
          <section className="panel entity-status-panel">
            <h1 className="entity-status-title">Loading character…</h1>
            <div className="entity-status-progress" />
          </section>
        ) : (
          <section className="panel entity-status-panel entity-status-error">
            <h1 className="entity-status-title">Character not found</h1>
            <p className="entity-status-body">
              No character matches id <strong>{id}</strong>, so there is no scouting report to build.
            </p>
            <div className="entity-status-actions">
              <button className="entity-status-button entity-status-button-primary" onClick={handleBack} type="button">Go back</button>
              <Link className="entity-status-button" to="/stats">Browse all characters</Link>
            </div>
          </section>
        )}
      </div>
    )
  }

  const tier = talentAnalysis?.tier
  const tierStyle = getTierBadgeStyle(tier)
  const tierMeta = getTalentTierMeta(tier)
  const chemistry = getChemistry(character.name) || { good: [], bad: [] }
  const abilities = talentAnalysis ? [
    { label: 'Fielding', value: talentAnalysis.fieldingAbility },
    { label: 'Baserunning', value: talentAnalysis.baserunningAbility },
    { label: 'Star Pitch', value: talentAnalysis.starPitchAbility },
    { label: 'Star Swing', value: talentAnalysis.starSwingAbility },
  ].filter((row) => row.value && row.value !== 'None') : []

  const scopeLabel = isCareer
    ? 'Career'
    : (scopeOptions.find((opt) => opt.type === scope.type && String(opt.id) === String(scope.id))?.label || 'Scoped')

  return (
    <div style={{ display: 'grid', gap: 16, paddingBottom: 40 }}>
      <button
        type="button"
        onClick={handleBack}
        style={{
          justifySelf: 'start', display: 'flex', alignItems: 'center', gap: 6,
          background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)', borderRadius: 8,
          color: '#CBD5E1', padding: '0.4rem 0.75rem', fontSize: 13, fontWeight: 600, cursor: 'pointer',
        }}
      >
        <ArrowLeft size={16} /> Back
      </button>

      <section className="panel" style={{ padding: '1rem 1.2rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, lineHeight: 1.1 }}>
            {character.name} <span style={{ color: '#64748B', fontWeight: 600, fontSize: 15 }}>Scouting Report</span>
          </h1>
          <Link to={`/character/${id}/${isCareer ? 'career' : `${scope.type}/${scope.id}`}`} style={{ color: '#93C5FD', fontSize: 12, fontWeight: 600, textDecoration: 'none' }}>
            ← Full stat page
          </Link>
        </div>
        <ScopePicker characterId={id} scope={scope} scopeOptions={scopeOptions} />
      </section>

      {/* Savant's three columns: identity, percentile rankings, charts. Collapses to a single
          stack on narrow screens rather than squeezing three columns into a phone. */}
      <div className="scouting-columns">
        {/* ── Identity ── */}
        <div style={CARD_STYLE}>
          <div style={{ display: 'grid', justifyItems: 'center', gap: 8 }}>
            <div style={{ width: 96, height: 96, borderRadius: '50%', overflow: 'hidden', border: `2px solid ${tierStyle.border}` }}>
              <CharacterPortrait name={character.name} size={96} />
            </div>
            <div style={{ fontSize: 18, fontWeight: 800, textAlign: 'center', lineHeight: 1.15 }}>{character.name}</div>
            {talentAnalysis && (
              <span style={{
                fontSize: 11, fontWeight: 800, padding: '0.15rem 0.55rem', borderRadius: 999,
                background: tierStyle.bg, border: `1px solid ${tierStyle.border}`, color: tierStyle.color,
                letterSpacing: '.03em', textTransform: 'uppercase',
              }}>
                {tierMeta.label}
              </span>
            )}
            <span style={{ color: '#64748B', fontSize: 11, fontWeight: 700 }}>{scopeLabel}</span>
          </div>

          {teamHistory.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <p style={GROUP_TITLE_STYLE}>Teams</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {teamHistory.map((row) => {
                  const name = getTeamShortName(row.identity) || row.playerName || 'Unknown'
                  return (
                    <Link
                      key={`${row.eventType}:${row.eventId}`}
                      to={`/teams/${row.playerId}/${row.eventType}/${row.eventId}`}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600,
                        color: '#93C5FD', textDecoration: 'none', padding: '0.12rem 0.5rem 0.12rem 0.25rem',
                        borderRadius: 999, background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.3)',
                      }}
                    >
                      <TeamLogo height={16} logoKey={row.identity?.teamLogoKey} logoUrl={row.identity?.teamLogoUrl} teamName={name} placeholder={false} />
                      {name}
                    </Link>
                  )
                })}
              </div>
            </div>
          )}

          {abilities.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <p style={GROUP_TITLE_STYLE}>Abilities</p>
              <div style={{ display: 'grid', gap: 4 }}>
                {abilities.map(({ label, value }) => (
                  <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11 }}>
                    <span style={{ color: '#64748B' }}>{label}</span>
                    <span style={{ color: '#E2E8F0', fontWeight: 600, textAlign: 'right' }}>{value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ marginTop: 14 }}>
            <p style={GROUP_TITLE_STYLE}>Chemistry</p>
            <div style={{ display: 'grid', gap: 6 }}>
              {[
                { kind: 'Good', names: chemistry.good, color: '#22C55E' },
                { kind: 'Bad', names: chemistry.bad, color: '#EF4444' },
              ].map(({ kind, names, color }) => (
                <div key={kind}>
                  <div style={{ fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.08em', color, marginBottom: 4 }}>{kind}</div>
                  {names.length ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {names.map((name) => (
                        <span key={name} style={{ fontSize: 10, padding: '0.1rem 0.4rem', borderRadius: 999, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.09)', color: '#CBD5E1' }}>
                          {name}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span style={{ color: '#475569', fontSize: 11, fontStyle: 'italic' }}>None</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── Percentile rankings ── */}
        <div style={CARD_STYLE}>
          <p style={{ ...GROUP_TITLE_STYLE, fontSize: 11, color: '#CBD5E1' }}>
            Percentile Rankings <span style={{ color: '#64748B', fontWeight: 600, letterSpacing: 0, textTransform: 'none' }}>· vs the full cast</span>
          </p>
          <div style={{ display: 'grid', gap: 16 }}>
            {PERCENTILE_GROUPS.map((group) => (
              <div key={group.title}>
                <p style={GROUP_TITLE_STYLE}>{group.title}</p>
                <div style={{ display: 'grid', gap: 9 }}>
                  {group.metrics.map((metric) => {
                    const scale = metric.scale || 1
                    const raw = measured?.[metric.key]
                    const value = Number.isFinite(raw) ? raw * scale : null
                    const allValues = measuredValues
                      .map((row) => (Number.isFinite(row?.[metric.key]) ? row[metric.key] * scale : null))
                      .filter((v) => v != null)
                    return (
                      <PercentileBar
                        key={metric.key}
                        label={metric.label}
                        value={value}
                        percentile={percentileOfValue(value, allValues, { invert: Boolean(metric.invert) })}
                        formatValue={(v) => (Number.isFinite(v) ? `${v.toFixed(metric.digits)}${metric.suffix || ''}` : '—')}
                      />
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Charts ── */}
        <div style={{ display: 'grid', gap: 16, minWidth: 0, alignContent: 'start' }}>
          <div style={CARD_STYLE}>
            <p style={GROUP_TITLE_STYLE}>Hits Spray Chart</p>
            {rawPasBatting.length ? (
              <SprayChart plateAppearances={rawPasBatting} height={300} />
            ) : (
              <p style={{ color: '#475569', fontSize: 12, fontStyle: 'italic', margin: 0 }}>No batted balls in this scope.</p>
            )}
          </div>
          <div style={CARD_STYLE}>
            <p style={GROUP_TITLE_STYLE}>Rolling OPS · trailing {ROLLING_WINDOW} PA</p>
            <RollingStatChart points={rollingChartPoints} color="#EAB308" />
          </div>
        </div>
      </div>

      {/* ── Raw values ── */}
      <section className="panel" style={{ padding: '1rem 1.2rem', minWidth: 0 }}>
        <p style={{ ...GROUP_TITLE_STYLE, fontSize: 11, color: '#CBD5E1', marginBottom: 4 }}>Raw Values</p>
        <p style={{ color: '#64748B', fontSize: 11, margin: '0 0 10px', lineHeight: 1.5 }}>
          What the game&apos;s own data says, beside what the tracker measured. The two sides are in
          different units, so <strong style={{ color: '#94A3B8' }}>Δ pct</strong> is the difference in
          percentile rank against the cast — positive means the tracker measured this character above
          what their rating implies. Parenthesised numbers are percentiles; <em>n</em> is the measured
          sample count. A dash is unmeasured, not zero.
        </p>
        <RawValueTable rows={rawValueRows} />
      </section>
    </div>
  )
}
