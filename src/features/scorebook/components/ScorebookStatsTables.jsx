import { useCallback, useEffect, useId, useState } from 'react'

import MiddleClickLink from '../../../components/MiddleClickLink'
import TeamLogo from '../../../components/TeamLogo'
import { summarizeBatting } from '../../../utils/statsCalculator'
import { formatBaseballAverage, formatRate } from '../domain/display'
import { getLineScoreCellValue } from '../domain/scoreboard'
import { Avatar, SectionCard } from './ScorebookPrimitives'
import { C } from './theme'

export function BoxScoreTable({
  innings,
  scores,
  completedHalfCount,
  currentInning,
  teamAAbbreviation,
  teamBAbbreviation,
  teamAColor,
  teamBColor,
  teamALogoKey,
  teamALogoUrl,
  teamBLogoKey,
  teamBLogoUrl,
  teamAName,
  teamBName,
  compact = false,
  swapped = false,
  activeBattingSide = null,
}) {
  const cellPad = compact ? '7px 0' : '10px 0'
  const cellFontSize = compact ? 11 : 13
  const headerFontSize = compact ? 10 : 11
  const teamColMinWidth = compact ? 76 : 112
  const teamARow = {
    key: 'teamA',
    abbreviation: teamAAbbreviation,
    color: teamAColor,
    logoKey: teamALogoKey,
    logoUrl: teamALogoUrl,
    teamName: teamAName,
    scoreMap: scores.aByInning,
    runs: scores.a,
    hits: scores.aHits,
    errors: scores.aErrors,
    battingSide: swapped ? 'home' : 'away',
  }
  const teamBRow = {
    key: 'teamB',
    abbreviation: teamBAbbreviation,
    color: teamBColor,
    logoKey: teamBLogoKey,
    logoUrl: teamBLogoUrl,
    teamName: teamBName,
    scoreMap: scores.bByInning,
    runs: scores.b,
    hits: scores.bHits,
    errors: scores.bErrors,
    battingSide: swapped ? 'away' : 'home',
  }
  const displayRows = teamARow.battingSide === 'away' ? [teamARow, teamBRow] : [teamBRow, teamARow]
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', minWidth: compact ? 320 : 520, borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', padding: `0 0 ${compact ? 6 : 10}px`, color: C.muted, fontSize: headerFontSize, fontWeight: 800 }}>Team</th>
            {innings.map((inning) => (
              <th key={inning} style={{ padding: `0 ${compact ? 4 : 0}px ${compact ? 6 : 10}px`, color: inning === currentInning && activeBattingSide ? C.accent : C.muted, fontSize: headerFontSize, fontWeight: 800 }}>{inning}</th>
            ))}
            {['R', 'H', 'E'].map((label) => (
              <th key={label} style={{ padding: `0 ${compact ? 4 : 0}px ${compact ? 6 : 10}px`, color: C.muted, fontSize: headerFontSize, fontWeight: 800 }}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {displayRows.map((team) => (
            <tr key={team.key}>
              <td style={{ padding: cellPad, borderTop: `1px solid ${C.border}44` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: compact ? 6 : 8, minWidth: teamColMinWidth }}>
                  <TeamLogo logoKey={team.logoKey} logoUrl={team.logoUrl} teamName={team.teamName} height={compact ? 16 : 20} />
                  <span style={{ color: team.color, fontSize: compact ? 11 : 12, fontWeight: 800 }}>{team.abbreviation}</span>
                </div>
              </td>
              {innings.map((inning) => {
                const isActiveHalf = inning === currentInning && team.battingSide === activeBattingSide
                return (
                  <td key={`${team.key}-${inning}`} style={{ padding: cellPad, borderTop: `1px solid ${C.border}44`, textAlign: 'center', background: isActiveHalf ? `${C.accent}20` : 'transparent', color: isActiveHalf ? '#F8FAFC' : '#CBD5E1', fontSize: cellFontSize, fontWeight: 700 }}>
                    {getLineScoreCellValue({ inning, side: team.battingSide, scoreMap: team.scoreMap, completedHalfCount })}
                  </td>
                )
              })}
              <td style={{ padding: cellPad, borderTop: `1px solid ${C.border}44`, textAlign: 'center', color: team.color, fontSize: cellFontSize, fontWeight: 900 }}>{team.runs}</td>
              <td style={{ padding: cellPad, borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: cellFontSize, fontWeight: 700 }}>{team.hits}</td>
              <td style={{ padding: cellPad, borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: cellFontSize, fontWeight: 700 }}>{team.errors}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function LineupStatsTable({
  title,
  lineup,
  statsByEntryKey,
  currentEntryKey = null,
  teamColor,
  charactersById,
  getCharacterLink,
}) {
  return (
    <SectionCard title={title}>
      {!lineup.length ? (
        <div style={{ color: C.muted, fontSize: 13 }}>No lineup set.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', minWidth: 320, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '0 0 10px', color: C.muted, fontSize: 11, fontWeight: 800 }}>Batter</th>
                {['AB', 'R', 'H', 'RBI', 'HR', 'BB', 'K', 'AVG', 'OBP', 'SLG'].map((label) => (
                  <th key={label} style={{ padding: '0 0 10px', textAlign: 'center', color: C.muted, fontSize: 11, fontWeight: 800 }}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lineup.map((entry, index) => {
                const key = `${entry.player_id}:${entry.character_id}`
                const stats = statsByEntryKey[key] || { game: summarizeBatting([]), source: summarizeBatting([]) }
                const isCurrent = key === currentEntryKey
                const link = getCharacterLink ? getCharacterLink(entry.character_id, entry.player_id) : null
                return (
                  <tr key={key}>
                    <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44` }}>
                      <MiddleClickLink
                        to={link?.to}
                        state={link?.state}
                        style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: link ? 'pointer' : 'default', color: 'inherit', textDecoration: 'none' }}
                      >
                        <span style={{ width: 18, color: isCurrent ? teamColor : C.muted, fontSize: 11, fontWeight: 800 }}>{index + 1}</span>
                        <div style={{ width: 30, height: 30, borderRadius: '50%', overflow: 'hidden', border: `1.5px solid ${isCurrent ? teamColor : C.border}` }}>
                          <Avatar name={charactersById[entry.character_id]?.name} size={30} />
                        </div>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ color: isCurrent ? teamColor : '#F8FAFC', fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{charactersById[entry.character_id]?.name || 'Unknown'}</div>
                          {isCurrent ? <div style={{ color: C.muted, fontSize: 11 }}>Current batter</div> : null}
                        </div>
                      </MiddleClickLink>
                    </td>
                    <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stats.game.atBats}</td>
                    <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stats.game.runs}</td>
                    <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stats.game.hits}</td>
                    <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stats.game.rbi}</td>
                    <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stats.game.homeRuns}</td>
                    <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stats.game.walks}</td>
                    <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stats.game.strikeouts}</td>
                    <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13, fontWeight: 700 }}>{formatBaseballAverage(stats.source)}</td>
                    <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13, fontWeight: 700 }}>{formatRate(stats.source.obp)}</td>
                    <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13, fontWeight: 700 }}>{formatRate(stats.source.slg)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  )
}

export function PitchingStatsTable({ title, stints, decisionLabels, charactersById, getCharacterLink, sourceStatsByCharacterKey = {} }) {
  return (
    <SectionCard title={title}>
      {!stints.length ? (
        <div style={{ color: C.muted, fontSize: 13 }}>No pitching lines yet.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', minWidth: 320, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '0 0 10px', color: C.muted, fontSize: 11, fontWeight: 800 }}>Pitcher</th>
                {['IP', 'H', 'R', 'ER', 'BB', 'K', 'HR', 'PC-ST', 'ERA'].map((label) => (
                  <th key={label} style={{ padding: '0 0 10px', textAlign: 'center', color: C.muted, fontSize: 11, fontWeight: 800 }}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stints.map((stint) => {
                const link = getCharacterLink ? getCharacterLink(stint.character_id, stint.player_id) : null
                const sourceStats = sourceStatsByCharacterKey[`${stint.player_id}:${stint.character_id}`]
                return (
                <tr key={stint.id}>
                  <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44` }}>
                    <MiddleClickLink
                      to={link?.to}
                      state={link?.state}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: link ? 'pointer' : 'default', color: 'inherit', textDecoration: 'none' }}
                    >
                      <div style={{ width: 30, height: 30, borderRadius: '50%', overflow: 'hidden', border: `1.5px solid ${C.border}` }}>
                        <Avatar name={charactersById[stint.character_id]?.name} size={30} />
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ color: '#F8FAFC', fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{charactersById[stint.character_id]?.name || 'Unknown'}</div>
                        {decisionLabels[stint.id] ? <div style={{ color: C.accent, fontSize: 11, fontWeight: 800 }}>{decisionLabels[stint.id]}</div> : null}
                      </div>
                    </MiddleClickLink>
                  </td>
                  <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stint.innings_pitched ?? 0}</td>
                  <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stint.hits_allowed ?? 0}</td>
                  <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stint.runs_allowed ?? 0}</td>
                  <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stint.earned_runs ?? 0}</td>
                  <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stint.walks ?? 0}</td>
                  <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stint.strikeouts ?? 0}</td>
                  <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stint.hr_allowed ?? 0}</td>
                  <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stint.pitches_thrown ?? 0}-{stint.strikes_thrown ?? 0}</td>
                  <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13, fontWeight: 700 }}>{Number(sourceStats?.era || 0).toFixed(2)}</td>
                </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  )
}

export function WinProbabilityCard({ points, currentHomeProbability, homeLabel, awayLabel, homeColor, awayColor }) {
  const safePoints = points.length ? points : [{ label: 'Start', probability: currentHomeProbability, description: 'Game start' }]
  const chartUid = useId()
  const chartWidth = 300
  const chartHeight = 150
  const chartPadding = { top: 8, right: 12, bottom: 8, left: 34 }
  const innerWidth = chartWidth - chartPadding.left - chartPadding.right
  const innerHeight = chartHeight - chartPadding.top - chartPadding.bottom
  const midY = chartPadding.top + (innerHeight / 2)
  const [selectedIndex, setSelectedIndex] = useState(safePoints.length - 1)

  useEffect(() => {
    setSelectedIndex(safePoints.length - 1)
  }, [safePoints.length])

  const clampedIndex = Math.min(Math.max(selectedIndex, 0), safePoints.length - 1)
  const selectedPoint = safePoints[clampedIndex] || safePoints[safePoints.length - 1]

  const getIndexFromClientX = useCallback((clientX, rect) => {
    if (!rect.width || safePoints.length <= 1) return 0
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left - ((chartPadding.left / chartWidth) * rect.width)) / ((innerWidth / chartWidth) * rect.width)))
    return Math.round(ratio * (safePoints.length - 1))
  }, [safePoints.length, chartPadding.left, chartWidth, innerWidth])

  const handleChartPointer = useCallback((clientX, rect) => {
    setSelectedIndex(getIndexFromClientX(clientX, rect))
  }, [getIndexFromClientX])

  const path = safePoints.map((point, index) => {
    const x = safePoints.length === 1
      ? chartPadding.left + (innerWidth / 2)
      : chartPadding.left + ((index / (safePoints.length - 1)) * innerWidth)
    const y = chartPadding.top + ((1 - point.probability) * innerHeight)
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
  }).join(' ')
  const fillPath = `${path} L ${chartPadding.left + innerWidth} ${chartPadding.top + innerHeight} L ${chartPadding.left} ${chartPadding.top + innerHeight} Z`
  const homePct = (currentHomeProbability * 100).toFixed(1)
  const awayPct = (100 - currentHomeProbability * 100).toFixed(1)

  return (
    <SectionCard
      title="Win Probability"
      subtitle={`${homeLabel} vs ${awayLabel}`}
    >
      <div style={{ display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 700 }}>
          <span style={{ color: awayColor }}>{awayLabel} {awayPct}%</span>
          <span style={{ color: homeColor }}>{homeLabel} {homePct}%</span>
        </div>
        <div style={{ borderRadius: 12, border: `1px solid ${C.border}`, background: `${C.card}AA`, padding: '10px 12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
            <div style={{ color: '#F8FAFC', fontSize: 13, fontWeight: 800 }}>{selectedPoint.label}</div>
            <div style={{ color: selectedPoint.probability >= 0.5 ? homeColor : awayColor, fontSize: 14, fontWeight: 900 }}>
              {selectedPoint.probability >= 0.5 ? (selectedPoint.probability * 100).toFixed(1) : ((1 - selectedPoint.probability) * 100).toFixed(1)}% {selectedPoint.probability >= 0.5 ? homeLabel : awayLabel}
            </div>
          </div>
          <div style={{ color: C.muted, fontSize: 12, marginTop: 4, lineHeight: 1.45 }}>
            {selectedPoint.description || 'Game state update'}
          </div>
          {selectedPoint.score ? (
            <div style={{ color: '#CBD5E1', fontSize: 11, fontWeight: 700, marginTop: 6 }}>{selectedPoint.score}</div>
          ) : null}
        </div>
        <div style={{ borderRadius: 14, border: `1px solid ${C.border}`, background: 'rgba(15,23,42,0.72)', padding: 10 }}>
          <svg
            viewBox={`0 0 ${chartWidth} ${chartHeight}`}
            preserveAspectRatio="none"
            style={{ width: '100%', aspectRatio: '2 / 1', display: 'block', touchAction: 'none', cursor: 'pointer' }}
            onMouseMove={(event) => handleChartPointer(event.clientX, event.currentTarget.getBoundingClientRect())}
            onClick={(event) => handleChartPointer(event.clientX, event.currentTarget.getBoundingClientRect())}
            onTouchStart={(event) => handleChartPointer(event.touches[0].clientX, event.currentTarget.getBoundingClientRect())}
            onTouchMove={(event) => handleChartPointer(event.touches[0].clientX, event.currentTarget.getBoundingClientRect())}
          >
            <defs>
              <clipPath id={`wp-top-${chartUid}`}>
                <rect x={0} y={0} width={chartWidth} height={midY} />
              </clipPath>
              <clipPath id={`wp-bottom-${chartUid}`}>
                <rect x={0} y={midY} width={chartWidth} height={chartHeight - midY} />
              </clipPath>
            </defs>
            {[0, 0.25, 0.5, 0.75, 1].map((mark) => {
              const y = chartPadding.top + ((1 - mark) * innerHeight)
              const isCenter = mark === 0.5
              return <line key={mark} x1={chartPadding.left} x2={chartPadding.left + innerWidth} y1={y} y2={y} stroke={isCenter ? 'rgba(148,163,184,0.4)' : 'rgba(148,163,184,0.18)'} strokeWidth="1" strokeDasharray={isCenter ? undefined : '4 4'} />
            })}
            {[
              { mark: 1, label: '100', color: homeColor },
              { mark: 0.75, label: '75', color: homeColor },
              { mark: 0.5, label: '50', color: C.muted },
              { mark: 0.25, label: '75', color: awayColor },
              { mark: 0, label: '100', color: awayColor },
            ].map(({ mark, label, color }) => {
              const y = chartPadding.top + ((1 - mark) * innerHeight)
              return (
                <text key={`label-${mark}-${label}`} x={chartPadding.left - 6} y={y + 4} textAnchor="end" fill={color} fontSize="9" fontWeight="700">
                  {label}
                </text>
              )
            })}
            <g clipPath={`url(#wp-top-${chartUid})`}>
              <path d={fillPath} fill={`${homeColor}26`} />
              <path d={path} fill="none" stroke={homeColor} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            </g>
            <g clipPath={`url(#wp-bottom-${chartUid})`}>
              <path d={fillPath} fill={`${awayColor}26`} />
              <path d={path} fill="none" stroke={awayColor} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            </g>
            {safePoints.map((point, index) => {
              const x = safePoints.length === 1
                ? chartPadding.left + (innerWidth / 2)
                : chartPadding.left + ((index / (safePoints.length - 1)) * innerWidth)
              const y = chartPadding.top + ((1 - point.probability) * innerHeight)
              const active = index === clampedIndex
              const pointColor = point.probability >= 0.5 ? homeColor : awayColor
              return (
                <circle
                  key={`${point.label}-${index}`}
                  cx={x}
                  cy={y}
                  r={active ? 5 : 3}
                  fill={active ? '#F8FAFC' : pointColor}
                  stroke={pointColor}
                  strokeWidth={active ? 2 : 0}
                />
              )
            })}
          </svg>
        </div>
      </div>
    </SectionCard>
  )
}
