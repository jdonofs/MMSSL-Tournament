import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeftRight, ChevronLeft, ChevronRight, Moon, RotateCcw, Sun, X } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { useToast } from '../context/ToastContext'
import { useTournament } from '../context/TournamentContext'
import { useAuth } from '../context/AuthContext'
import { calculateOutsForPa, getCreditedRbiForPa, inningsPitchedFromOuts, summarizeBatting } from '../utils/statsCalculator'
import CharacterPortrait from '../components/CharacterPortrait'
import PlayerTag from '../components/PlayerTag'
import useTournamentTeamIdentity from '../hooks/useTournamentTeamIdentity'
import { buildBettingEntityLabel, generateGameOdds, mergeOddsWithExistingRows, recalculateOdds } from '../utils/oddsEngine'
import { buildOddsGenerationContext as buildSharedOddsGenerationContext } from '../utils/oddsContext'
import { resolveFirstInningNoRun, resolveGameBets, resolveOnPA } from '../utils/betResolution'
import { advanceBracketOnGameComplete } from '../utils/bracketProgression'
import {
  getChaosStars,
  getOrderedStadiums,
  getStadiumSpriteStyle,
  getStadiumTimeLabel,
  normalizeIsNightForStadium,
  stadiumTimeToggleDisabled,
} from '../utils/stadiums'

// ─── Style constants ──────────────────────────────────────────────────────────
const C = {
  bg: '#0F172A', card: '#1E293B', border: '#334155',
  accent: '#EAB308', green: '#22C55E', red: '#EF4444',
  blue: '#3B82F6', text: '#FFFFFF', muted: '#94A3B8',
}

function StadiumLogo({ name, height = 56 }) {
  return (
    <div
      aria-hidden="true"
      style={{
        ...getStadiumSpriteStyle(name, {
          width: '100%',
          height,
          borderRadius: 12,
          backgroundColor: 'rgba(15,23,42,0.85)',
          border: `1px solid ${C.border}`,
        }),
      }}
    />
  )
}

function StadiumHeaderPill({ stadium, isNight }) {
  if (!stadium) return null
  const timeLabel = getStadiumTimeLabel(stadium, isNight)
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginTop: 6, padding: '6px 10px', borderRadius: 999, border: `1px solid ${C.border}`, background: `${C.card}CC`, maxWidth: '100%' }}>
      <div style={{ width: 74, flexShrink: 0 }}>
        <StadiumLogo name={stadium.name} height={28} />
      </div>
      <span style={{ fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' }}>{stadium.name}</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: C.muted, fontSize: 11, fontWeight: 700 }}>
        {timeLabel === 'Night' ? <Moon size={12} /> : <Sun size={12} />}
        {timeLabel}
      </span>
    </div>
  )
}

const HIT_RESULTS  = new Set(['1B', '2B', '3B', 'HR'])
const WALK_RESULTS = new Set(['BB', 'HBP'])
// Results that need runner-resolution panel (only when runners are on base)
const NEEDS_RESOLUTION = new Set(['1B', '2B', '3B'])

const OUTCOME_BUTTONS = [
  { result: '1B', zone: 'green' }, { result: '2B', zone: 'green' },
  { result: '3B', zone: 'green' }, { result: 'HR',  zone: 'green' },
  { result: 'K',  zone: 'red'   }, { result: 'GO',  zone: 'red'   },
  { result: 'FO', zone: 'red'   }, { result: 'LO',  zone: 'red'   },
  { result: 'BB', zone: 'blue'  }, { result: 'HBP', zone: 'blue'  },
  { result: 'DP', zone: 'red'   }, { result: 'SF',  zone: 'blue'  },
  { result: 'SH', zone: 'blue'  }, { result: 'FC',  zone: 'blue'  },
]
const ZONE_COLOR = { green: C.green, red: C.red, blue: C.blue }

// ─── Helpers ──────────────────────────────────────────────────────────────────
function normalizeStageLabel(stage = '') {
  if (stage.includes('CG-2')) return 'Championship Reset'
  if (stage.includes('CG-1')) return 'Championship'
  return stage
}

function deriveOffense(game, outsRecorded) {
  const halfInning = Math.floor(outsRecorded / 3)
  const isTop = halfInning % 2 === 0
  const inning = Math.floor(halfInning / 2) + 1
  return {
    battingPlayerId:  isTop ? game.team_a_player_id : game.team_b_player_id,
    pitchingPlayerId: isTop ? game.team_b_player_id : game.team_a_player_id,
    inning, isTop, halfLabel: `${isTop ? 'TOP' : 'BOT'} ${inning}`,
  }
}

function runsFromPAs(pas, playerId) {
  return pas.filter(pa => pa.player_id === playerId)
    .reduce((s, pa) => s + (pa.rbi || 0) + (pa.run_scored ? 1 : 0), 0)
}
function hitsFromPAs(pas, playerId) {
  return pas.filter(pa => pa.player_id === playerId && HIT_RESULTS.has(pa.result)).length
}
function inningRunsFromPAs(pas, playerId) {
  const map = {}
  pas.filter(pa => pa.player_id === playerId).forEach(pa => {
    map[pa.inning] = (map[pa.inning] || 0) + (pa.rbi || 0) + (pa.run_scored ? 1 : 0)
  })
  return map
}

// ─── Runner logic ─────────────────────────────────────────────────────────────
// Each runner: { characterId, playerId }
// pendingPA assignments: [{ id, runner, origin, destination, isBatter }]

function buildPendingAssignment(id, runner, origin, destination, isBatter = false) {
  return { id, runner, origin, destination, isBatter }
}

function computePendingState(result, runners, batter) {
  const { first, second, third } = runners
  const assignments = []
  const push = (id, runner, origin, destination, isBatter = false) => {
    if (!runner) return
    assignments.push(buildPendingAssignment(id, runner, origin, destination, isBatter))
  }

  switch (result) {
    case '1B':
      push('batter', batter, 'plate', 'first', true)
      push('first', first, 'first', 'second')
      push('second', second, 'second', 'third')
      push('third', third, 'third', 'home')
      return { result, assignments }
    case '2B':
      push('batter', batter, 'plate', 'second', true)
      push('first', first, 'first', 'third')
      push('second', second, 'second', 'home')
      push('third', third, 'third', 'home')
      return { result, assignments }
    case '3B':
      push('batter', batter, 'plate', 'third', true)
      push('first', first, 'first', 'home')
      push('second', second, 'second', 'home')
      push('third', third, 'third', 'home')
      return { result, assignments }
    case 'BB': case 'HBP':
      push('batter', batter, 'plate', 'first', true)
      if (first && second && third) {
        push('first', first, 'first', 'second')
        push('second', second, 'second', 'third')
        push('third', third, 'third', 'home')
      } else if (first && second) {
        push('first', first, 'first', 'second')
        push('second', second, 'second', 'third')
      } else if (first) {
        push('first', first, 'first', 'second')
        push('third', third, 'third', 'third')
      } else {
        push('second', second, 'second', 'second')
        push('third', third, 'third', 'third')
      }
      return { result, assignments }
    default:
      return { result, assignments: [] }
  }
}

function getRbiFromAssignments(assignments) {
  return assignments.filter((assignment) => assignment.destination === 'home' && !assignment.isBatter).length
}

function getPreviewRbiFromAssignments(result, assignments) {
  const runnerRbi = getRbiFromAssignments(assignments)
  const batterScoresOnHit = HIT_RESULTS.has(result) && assignments.some((assignment) => assignment.isBatter && assignment.destination === 'home')
  return runnerRbi + (batterScoresOnHit ? 1 : 0)
}

function didBatterScore(assignments) {
  return assignments.some((assignment) => assignment.isBatter && assignment.destination === 'home')
}

function extractNextRunners({ assignments }) {
  return assignments.reduce((next, assignment) => {
    if (assignment.destination === 'first') next.first = assignment.runner
    if (assignment.destination === 'second') next.second = assignment.runner
    if (assignment.destination === 'third') next.third = assignment.runner
    return next
  }, { first: null, second: null, third: null })
}

function getHomeAssignments({ assignments }) {
  return assignments.filter((assignment) => assignment.destination === 'home')
}

function getOutAssignments({ assignments }) {
  return assignments.filter((assignment) => assignment.destination === 'out')
}

function computeImmediateNextRunners(result, runners, batter) {
  const { first, second, third } = runners
  switch (result) {
    case 'HR':  return { first: null, second: null, third: null }
    case 'SF':  return { first, second, third: null }
    case 'SH':  return { first: null, second: first, third: second }
    case 'FC':  return { first: batter, second, third }   // lead runner (first) out
    case 'DP':  return { first: null, second, third }     // runner on first out, batter out
    default:    return { first, second, third }           // K, GO, FO, LO — runners hold
  }
}

function getRunsScoredOnPa(pa) {
  return Number(pa?.rbi || 0) + (pa?.run_scored ? 1 : 0)
}

function getRunnerStateStorageKey(gameId, halfIdx) {
  return `scorebook-runners:${gameId}:${halfIdx}`
}

function getRunnerHistoryStorageKey(gameId, halfIdx) {
  return `scorebook-runners-history:${gameId}:${halfIdx}`
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function Avatar({ name, size = 36, style: sx = {} }) {
  return <CharacterPortrait name={name} size={size} borderRadius={0} objectFit="contain" style={sx} />
}

function ResultBadge({ result }) {
  const color = HIT_RESULTS.has(result) ? C.green : WALK_RESULTS.has(result) ? C.blue : C.red
  return (
    <span style={{ background: color + '22', color, border: `1px solid ${color}55`, borderRadius: 4, padding: '2px 6px', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>
      {result}
    </span>
  )
}

function OutcomeBtn({ result, zone, onClick, disabled = false }) {
  const base = ZONE_COLOR[zone]
  return (
    <button
      onClick={() => onClick(result)} disabled={disabled}
      style={{ background: `${base}22`, color: disabled ? C.border : base, border: `1.5px solid ${disabled ? C.border : base + '55'}`, borderRadius: 8, minHeight: 54, fontWeight: 800, fontSize: 15, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.4 : 1 }}
      onPointerDown={e => { if (!disabled) e.currentTarget.style.background = `${base}44` }}
      onPointerUp={e => { e.currentTarget.style.background = `${base}22` }}
      onPointerLeave={e => { e.currentTarget.style.background = `${base}22` }}
    >
      {result}
    </button>
  )
}

// ─── Diamond ─────────────────────────────────────────────────────────────────
function Diamond({
  runners,
  pitcherChar,
  outs,
  previewHomeRunners = [],
  previewOuts = 0,
  onMoundDrop,
  onMoundDragOver,
  onMoundDragLeave,
  isDragOver,
  isScorekeeper,
  charactersById,
  selectedPitcher,
  onMoundClick,
}) {
  // SVG viewBox coords → CSS % positions  (square container)
  // 2nd: 50,8   1st: 90,46   3rd: 10,46   home: 50,84   mound: 50,46
  const bases = [
    { key: 'second', label: '2B', left: '50%', top:  '8%' },
    { key: 'first',  label: '1B', left: '90%', top: '46%' },
    { key: 'third',  label: '3B', left: '10%', top: '46%' },
  ]
  const committedOuts = Math.min(outs, 3)
  const pendingOuts = Math.max(0, Math.min(previewOuts, 3 - committedOuts))
  const overflowOuts = Math.max(0, outs + previewOuts - 3)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <div style={{ position: 'relative', width: 'min(100%, 210px)', aspectRatio: '1', margin: '0 auto' }}>
        {/* Base lines */}
        <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} viewBox="0 0 100 92" preserveAspectRatio="xMidYMid meet">
          <polygon points="50,6 90,44 50,82 10,44" fill="none" stroke={C.border} strokeWidth="1.5" />
        </svg>

        {/* Runner bases */}
        {bases.map(b => {
          const runner = runners[b.key]
          return (
            <div key={b.key} style={{ position: 'absolute', left: b.left, top: b.top, transform: 'translate(-50%,-50%)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
              {runner ? (
                <div style={{ width: 34, height: 34, borderRadius: '50%', overflow: 'hidden', border: `2px solid ${C.accent}`, flexShrink: 0 }}>
                  <Avatar name={charactersById[runner.characterId]?.name} size={34} />
                </div>
              ) : (
                <div style={{ width: 14, height: 14, background: C.border, transform: 'rotate(45deg)', borderRadius: 2 }} />
              )}
            </div>
          )
        })}

        {/* Home plate */}
        <div style={{ position: 'absolute', left: '50%', top: '84%', transform: 'translate(-50%,-50%)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 14, height: 14, background: C.card, border: `2px solid ${previewHomeRunners.length ? C.accent : C.border}`, transform: 'rotate(45deg)', borderRadius: 2 }} />
            {previewHomeRunners.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {previewHomeRunners.slice(0, 3).map((assignment, index) => (
                  <div
                    key={assignment.id}
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: '50%',
                      overflow: 'hidden',
                      border: `2px solid ${C.accent}`,
                      marginLeft: index === 0 ? 0 : -7,
                      background: C.card,
                      boxShadow: '0 0 0 2px rgba(15, 23, 42, 0.9)',
                    }}
                  >
                    <Avatar name={charactersById[assignment.runner.characterId]?.name} size={24} />
                  </div>
                ))}
                {previewHomeRunners.length > 3 && (
                  <div style={{ marginLeft: 4, fontSize: 9, color: C.accent, fontWeight: 800 }}>
                    +{previewHomeRunners.length - 3}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Pitcher mound — drop target + tap-to-confirm */}
        <div
          onDragOver={isScorekeeper ? onMoundDragOver : undefined}
          onDragLeave={isScorekeeper ? onMoundDragLeave : undefined}
          onDrop={isScorekeeper ? onMoundDrop : undefined}
          onClick={isScorekeeper && selectedPitcher ? onMoundClick : undefined}
          style={{ position: 'absolute', left: '50%', top: '46%', transform: 'translate(-50%,-50%)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, cursor: selectedPitcher ? 'pointer' : 'default' }}
        >
          <div style={{ width: 46, height: 46, borderRadius: '50%', border: `2px ${isDragOver || selectedPitcher ? 'solid' : 'dashed'} ${isDragOver ? C.accent : selectedPitcher ? '#A78BFA' : C.border}`, background: isDragOver ? `${C.accent}20` : selectedPitcher ? '#A78BFA20' : `${C.bg}cc`, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', transition: 'all 0.15s' }}>
            {pitcherChar
              ? <Avatar name={pitcherChar.name} size={42} />
              : <span style={{ fontSize: 18 }}>⚾</span>}
          </div>
          {selectedPitcher && isScorekeeper && (
            <div style={{ fontSize: 8, color: '#A78BFA', fontWeight: 800, textAlign: 'center', maxWidth: 56 }}>tap to confirm</div>
          )}
          {!selectedPitcher && pitcherChar && (
            <div style={{ fontSize: 8, color: C.muted, fontWeight: 700, textAlign: 'center', maxWidth: 52, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {pitcherChar.name.split(' ')[0]}
            </div>
          )}
          {!selectedPitcher && !pitcherChar && isScorekeeper && (
            <div style={{ fontSize: 8, color: C.border, textAlign: 'center', maxWidth: 52 }}>drag / tap pitcher</div>
          )}
        </div>
      </div>

      {/* Outs row */}
      <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
        <span style={{ fontSize: 9, color: C.muted, fontWeight: 700, letterSpacing: '.04em' }}>OUTS</span>
        {[0, 1, 2].map(i => (
          <div
            key={i}
            style={{
              width: 12,
              height: 12,
              borderRadius: '50%',
              background: i < committedOuts ? '#F59E0B' : i < committedOuts + pendingOuts ? `${C.red}` : 'transparent',
              border: `2px solid ${i < committedOuts ? '#F59E0B' : i < committedOuts + pendingOuts ? C.red : C.border}`,
            }}
          />
        ))}
        {overflowOuts > 0 && (
          <span style={{ fontSize: 9, color: C.red, fontWeight: 800 }}>+{overflowOuts}</span>
        )}
      </div>
    </div>
  )
}

// ─── Lineup column ────────────────────────────────────────────────────────────
function LineupColumn({ lineup, currentIdx, teamColor, label, draggable: isDraggable, currentPitcherCharId, pendingPitcherCharId, onDragStart, onItemClick, charactersById }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
      <div style={{ fontSize: 8, color: teamColor, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 2, textAlign: 'center' }}>
        {label}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, overflowY: 'auto', maxHeight: 220, width: '100%', alignItems: 'center' }}>
        {lineup.map((entry, i) => {
          const char = charactersById[entry.character_id]
          const isCurrentPitcher = isDraggable && entry.character_id === currentPitcherCharId
          const isPending = isDraggable && entry.character_id === pendingPitcherCharId
          const isCurrent = isDraggable ? isCurrentPitcher : i === currentIdx
          const borderColor = isPending ? '#A78BFA' : isCurrent ? teamColor : C.border
          const shadow = isPending ? '0 0 8px #A78BFA' : isCurrent ? `0 0 6px ${teamColor}` : 'none'
          return (
            <div
              key={entry.id}
              draggable={isDraggable}
              onDragStart={isDraggable ? onDragStart(entry.character_id, entry.player_id) : undefined}
              onClick={isDraggable && onItemClick ? () => onItemClick(entry.character_id, entry.player_id) : undefined}
              title={char?.name}
              style={{ position: 'relative', cursor: isDraggable ? 'pointer' : 'default', opacity: (isCurrent || isPending) ? 1 : 0.45, flexShrink: 0 }}
            >
              <div style={{ width: 36, height: 36, borderRadius: '50%', overflow: 'hidden', border: `2px solid ${borderColor}`, boxShadow: shadow, transition: 'border-color 0.15s, box-shadow 0.15s' }}>
                <Avatar name={char?.name} size={36} />
              </div>
              <div style={{ position: 'absolute', bottom: -1, right: -1, width: 13, height: 13, borderRadius: '50%', background: isPending ? '#A78BFA' : isCurrent ? teamColor : C.card, border: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 7, fontWeight: 900, color: (isCurrent || isPending) ? '#000' : C.muted }}>
                {i + 1}
              </div>
            </div>
          )
        })}
        {lineup.length === 0 && (
          <div style={{ fontSize: 10, color: C.border, textAlign: 'center', padding: 6 }}>—</div>
        )}
      </div>
    </div>
  )
}

// ─── Runner chip (used inside resolution panel) ───────────────────────────────
function RunnerChip({ slot, label, isHome, onToggle, charactersById }) {
  if (!slot) return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
      <div style={{ width: 34, height: 34, borderRadius: '50%', border: `2px dashed ${C.border}` }} />
      <div style={{ fontSize: 8, color: C.border, fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 8, color: C.border }}>empty</div>
    </div>
  )

  const isOut    = slot.status === 'out'
  const isScored = slot.status === 'scored'
  const statusColor = isOut ? C.red : isScored ? C.accent : C.green
  const statusLabel = isOut ? 'OUT' : isScored ? 'SCORED' : 'SAFE'

  return (
    <button
      onClick={onToggle}
      type="button"
      style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, padding: 0 }}
    >
      <div style={{ width: 38, height: 38, borderRadius: '50%', overflow: 'hidden', border: `2.5px solid ${statusColor}`, opacity: isOut ? 0.5 : 1 }}>
        <Avatar name={charactersById[slot.runner.characterId]?.name} size={38} />
      </div>
      <div style={{ fontSize: 8, color: C.muted, fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 9, fontWeight: 800, color: statusColor, background: statusColor + '22', borderRadius: 4, padding: '1px 5px', border: `1px solid ${statusColor}44` }}>
        {statusLabel}
      </div>
    </button>
  )
}

// ─── Runner resolution panel ──────────────────────────────────────────────────
function RunnerResolutionPanel({ pendingPA, onToggleBase, onToggleScored, onConfirm, onCancel, charactersById }) {
  const { result, first, second, third, scored } = pendingPA
  const rbi = scored.filter(s => s.status === 'scored').length

  return (
    <div style={{ background: `${C.accent}10`, border: `1px solid ${C.accent}44`, borderRadius: 12, padding: '12px 10px 10px', marginBottom: 10 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ResultBadge result={result} />
          <span style={{ fontSize: 12, color: C.muted, fontWeight: 600 }}>Tap to toggle scored / out</span>
        </div>
        <button onClick={onCancel} type="button" style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer', padding: 2 }}>
          <X size={16} />
        </button>
      </div>

      {/* Diamond layout for resolution */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginBottom: 10 }}>
        {/* Row 1: 3B | 2B | 1B */}
        <RunnerChip slot={third}  label="3B" onToggle={() => onToggleBase('third')}  charactersById={charactersById} />
        <RunnerChip slot={second} label="2B" onToggle={() => onToggleBase('second')} charactersById={charactersById} />
        <RunnerChip slot={first}  label="1B" onToggle={() => onToggleBase('first')}  charactersById={charactersById} />
      </div>

      {/* Home plate runners */}
      {scored.length > 0 && (
        <div>
          <div style={{ fontSize: 9, color: C.muted, fontWeight: 700, textTransform: 'uppercase', marginBottom: 6, textAlign: 'center', letterSpacing: '.04em' }}>
            🏠 Home Plate
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
            {scored.map((s, i) => (
              <RunnerChip key={i} slot={s} label="HOME" isHome onToggle={() => onToggleScored(i)} charactersById={charactersById} />
            ))}
          </div>
        </div>
      )}

      {/* Footer */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1, fontSize: 13, fontWeight: 700 }}>
          {rbi > 0
            ? <span style={{ color: C.accent }}>{rbi} RBI</span>
            : <span style={{ color: C.muted }}>0 RBI</span>}
        </div>
        <button onClick={onCancel} type="button" style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 8, padding: '9px 14px', color: C.muted, fontWeight: 600, cursor: 'pointer', fontSize: 13 }}>
          Cancel
        </button>
        <button onClick={onConfirm} type="button" style={{ background: C.accent, color: '#000', border: 'none', borderRadius: 8, padding: '9px 20px', fontWeight: 800, fontSize: 14, cursor: 'pointer' }}>
          Save PA →
        </button>
      </div>
    </div>
  )
}

function RunnerAssignmentChip({ assignment, onSetDestination, charactersById }) {
  const destinationMeta = {
    first: { color: C.green, label: '1B' },
    second: { color: C.green, label: '2B' },
    third: { color: C.green, label: '3B' },
    home: { color: C.accent, label: 'HOME' },
    out: { color: C.red, label: 'OUT' },
  }
  const current = destinationMeta[assignment.destination] || destinationMeta.out
  const destinationButtons = [
    { key: 'first', label: '1B' },
    { key: 'second', label: '2B' },
    { key: 'third', label: '3B' },
    { key: 'home', label: 'HOME' },
    { key: 'out', label: 'OUT' },
  ]

  return (
    <div style={{ display: 'grid', gap: 6, padding: 8, borderRadius: 10, border: `1px solid ${C.border}`, background: `${current.color}12` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ width: 38, height: 38, borderRadius: '50%', overflow: 'hidden', border: `2.5px solid ${current.color}`, opacity: assignment.destination === 'out' ? 0.5 : 1 }}>
          <Avatar name={charactersById[assignment.runner.characterId]?.name} size={38} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 11, color: C.muted, fontWeight: 700, textTransform: 'uppercase' }}>
            {assignment.isBatter ? 'Batter' : `${assignment.origin.toUpperCase()} Runner`}
          </div>
          <div style={{ fontSize: 12, color: current.color, fontWeight: 800 }}>{current.label}</div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {destinationButtons.map((button) => (
          <button
            key={button.key}
            onClick={() => onSetDestination(assignment.id, button.key)}
            type="button"
            style={{
              background: assignment.destination === button.key ? current.color : 'transparent',
              color: assignment.destination === button.key ? '#000' : C.muted,
              border: `1px solid ${assignment.destination === button.key ? current.color : C.border}`,
              borderRadius: 999,
              padding: '4px 8px',
              fontSize: 10,
              fontWeight: 800,
              cursor: 'pointer',
            }}
          >
            {button.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function RunnerAssignmentsPanel({ pendingPA, onSetDestination, onConfirm, onCancel, charactersById }) {
  const { result, assignments } = pendingPA
  const rbi = getPreviewRbiFromAssignments(result, assignments)

  return (
    <div style={{ background: `${C.accent}10`, border: `1px solid ${C.accent}44`, borderRadius: 12, padding: '12px 10px 10px', marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ResultBadge result={result} />
          <span style={{ fontSize: 12, color: C.muted, fontWeight: 600 }}>Assign each runner to a base, home, or out</span>
        </div>
        <button onClick={onCancel} type="button" style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer', padding: 2 }}>
          <X size={16} />
        </button>
      </div>

      <div style={{ display: 'grid', gap: 8, marginBottom: 10 }}>
        {assignments.map((assignment) => (
          <RunnerAssignmentChip
            key={assignment.id}
            assignment={assignment}
            onSetDestination={onSetDestination}
            charactersById={charactersById}
          />
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1, fontSize: 13, fontWeight: 700 }}>
          {rbi > 0
            ? <span style={{ color: C.accent }}>{rbi} RBI</span>
            : <span style={{ color: C.muted }}>0 RBI</span>}
        </div>
        <button onClick={onCancel} type="button" style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 8, padding: '9px 14px', color: C.muted, fontWeight: 600, cursor: 'pointer', fontSize: 13 }}>
          Cancel
        </button>
        <button onClick={onConfirm} type="button" style={{ background: C.accent, color: '#000', border: 'none', borderRadius: 8, padding: '9px 20px', fontWeight: 800, fontSize: 14, cursor: 'pointer' }}>
          Save PA →
        </button>
      </div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function Scorebook() {
  const navigate = useNavigate()
  const { pushToast } = useToast()
  const { viewedTournament, currentTournament } = useTournament()
  const tournament = viewedTournament || currentTournament
  const { player } = useAuth()
  const { identitiesByPlayerId } = useTournamentTeamIdentity(tournament?.id)
  const [searchParams] = useSearchParams()

  // ── Data state ─────────────────────────────────────────────────────────────
  const [games, setGames] = useState([])
  const [players, setPlayers] = useState([])
  const [lineups, setLineups] = useState([])
  const [characters, setCharacters] = useState([])
  const [draftPicks, setDraftPicks] = useState([])
  const [plateAppearances, setPlateAppearances] = useState([])
  const [pitchingStints, setPitchingStints] = useState([])
  const [stadiums, setStadiums] = useState([])
  const [stadiumGameLog, setStadiumGameLog] = useState([])

  // ── UI state ───────────────────────────────────────────────────────────────
  const [selectedGameId, setSelectedGameId] = useState(searchParams.get('game') || '')
  const [viewedInning, setViewedInning] = useState(null)
  const [overrideBatterIdx, setOverrideBatterIdx] = useState(null)
  const [showOutsBanner, setShowOutsBanner] = useState(false)
  const [gameEndBanner, setGameEndBanner] = useState(null)
  const [editingPa, setEditingPa] = useState(null)
  const [showAddGame, setShowAddGame] = useState(false)
  const [addGameForm, setAddGameForm] = useState({ teamA: '', teamB: '', stage: '', stadiumId: '', isNight: false })
  const [showAccessModal, setShowAccessModal] = useState(false)

  // ── Runner state ───────────────────────────────────────────────────────────
  // Each slot: { characterId, playerId } | null
  const [runners, setRunners] = useState({ first: null, second: null, third: null })
  const [runnersHistory, setRunnersHistory] = useState([])
  const [pendingPA, setPendingPA] = useState(null)
  const [isDragOverMound, setIsDragOverMound] = useState(false)
  const [selectedPitcher, setSelectedPitcher] = useState(null) // { charId, playerId }
  const [showEndGameConfirm, setShowEndGameConfirm] = useState(false)
  const [runnerStateLoadedScope, setRunnerStateLoadedScope] = useState(null)

  const outsRef = useRef(0)

  // Tournament settings
  const regulationInnings = tournament?.innings ?? 3
  const mercyOn  = tournament?.mercy_rule !== false
  const mercyLimit = 10

  const pushRunners = useCallback((next) => {
    setRunnersHistory(prev => [...prev, { ...runners }])
    setRunners(next)
  }, [runners])

  const popRunners = useCallback(() => {
    setRunnersHistory(prev => {
      if (!prev.length) return prev
      setRunners(prev[prev.length - 1])
      return prev.slice(0, -1)
    })
  }, [])

  const resetRunners = useCallback((clearHistory = true) => {
    setRunners({ first: null, second: null, third: null })
    if (clearHistory) setRunnersHistory([])
  }, [])

  // ── Load data ──────────────────────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      const [
        { data: gamesData }, { data: playersData }, { data: lineupsData },
        { data: charsData }, { data: picksData }, { data: pasData }, { data: pitchData },
        { data: stadiumsData }, { data: stadiumLogData },
      ] = await Promise.all([
        supabase.from('games').select('*').order('id'),
        supabase.from('players').select('*'),
        supabase.from('lineups').select('*').order('batting_order'),
        supabase.from('characters').select('*'),
        supabase.from('draft_picks').select('*'),
        supabase.from('plate_appearances').select('*').order('created_at'),
        supabase.from('pitching_stints').select('*').order('created_at'),
        supabase.from('stadiums').select('*'),
        supabase.from('stadium_game_log').select('*').order('created_at'),
      ])
      setGames(gamesData || [])
      setPlayers(playersData || [])
      setLineups(lineupsData || [])
      setCharacters(charsData || [])
      setDraftPicks(picksData || [])
      setPlateAppearances(pasData || [])
      setPitchingStints(pitchData || [])
      setStadiums(getOrderedStadiums(stadiumsData || []))
      setStadiumGameLog(stadiumLogData || [])

      setSelectedGameId(prev => {
        if (prev) return prev
        const filtered = tournament
          ? (gamesData || []).filter(g => g.tournament_id === tournament.id)
          : (gamesData || [])
        const def = filtered.find(g => ['active', 'pending'].includes(g.status)) || filtered[0]
        return def ? String(def.id) : ''
      })
    }
    load()
  }, [tournament?.id])

  // ── Realtime ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!selectedGameId) return
    const channel = supabase
      .channel(`sb-${selectedGameId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'plate_appearances', filter: `game_id=eq.${selectedGameId}` }, async () => {
        const { data } = await supabase.from('plate_appearances').select('*').eq('game_id', selectedGameId).order('created_at')
        setPlateAppearances(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGameId)), ...(data || [])])
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pitching_stints', filter: `game_id=eq.${selectedGameId}` }, async () => {
        const { data } = await supabase.from('pitching_stints').select('*').eq('game_id', selectedGameId).order('created_at')
        setPitchingStints(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGameId)), ...(data || [])])
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'games', filter: `id=eq.${selectedGameId}` }, payload => {
        if (payload.new) setGames(cur => cur.map(g => g.id === payload.new.id ? payload.new : g))
      })
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [selectedGameId])

  useEffect(() => {
    const channel = supabase
      .channel(`scorebook-stadiums-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stadiums' }, async () => {
        const { data } = await supabase.from('stadiums').select('*')
        setStadiums(getOrderedStadiums(data || []))
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stadium_game_log' }, async () => {
        const { data } = await supabase.from('stadium_game_log').select('*').order('created_at')
        setStadiumGameLog(data || [])
      })
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [])

  // ── Derived state ──────────────────────────────────────────────────────────
  const filteredGames = useMemo(
    () => games.filter(g => !tournament || g.tournament_id === tournament.id),
    [games, tournament],
  )
  const selectedGame  = filteredGames.find(g => String(g.id) === String(selectedGameId))
  const playersById   = useMemo(() => Object.fromEntries(players.map(p => [p.id, p])), [players])
  const charactersById = useMemo(() => Object.fromEntries(characters.map(c => [c.id, c])), [characters])
  const stadiumsById = useMemo(() => Object.fromEntries(stadiums.map((stadium) => [stadium.id, stadium])), [stadiums])
  const selectedStadium = selectedGame?.stadium_id ? stadiumsById[selectedGame.stadium_id] : null
  const selectedAddGameStadium = addGameForm.stadiumId ? stadiumsById[addGameForm.stadiumId] : stadiums[0] || null

  useEffect(() => {
    if (!stadiums.length) return
    setAddGameForm((current) => {
      if (current.stadiumId && stadiumsById[current.stadiumId]) {
        return {
          ...current,
          isNight: normalizeIsNightForStadium(stadiumsById[current.stadiumId], current.isNight),
        }
      }
      return {
        ...current,
        stadiumId: stadiums[0].id,
        isNight: normalizeIsNightForStadium(stadiums[0], current.isNight),
      }
    })
  }, [stadiums, stadiumsById])

  const gamePAs = useMemo(
    () => plateAppearances.filter(p => String(p.game_id) === String(selectedGameId)).sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
    [plateAppearances, selectedGameId],
  )
  const gamePitching = useMemo(
    () => pitchingStints.filter(p => String(p.game_id) === String(selectedGameId)),
    [pitchingStints, selectedGameId],
  )
  const gameLineups = useMemo(
    () => lineups.filter(l => String(l.game_id) === String(selectedGameId)).sort((a, b) => a.batting_order - b.batting_order),
    [lineups, selectedGameId],
  )

  const outsRecorded = useMemo(() => gamePAs.reduce((s, pa) => s + calculateOutsForPa(pa.result), 0), [gamePAs])
  useEffect(() => { outsRef.current = outsRecorded }, [outsRecorded])

  const outsInHalf = outsRecorded % 3
  const offense = useMemo(() => selectedGame ? deriveOffense(selectedGame, outsRecorded) : null, [selectedGame, outsRecorded])
  const currentInning  = offense?.inning || 1
  const currentHalfIdx = Math.floor(outsRecorded / 3)

  // Current (batting) lineup — offensive team
  const currentLineup = useMemo(
    () => gameLineups.filter(l => l.player_id === offense?.battingPlayerId),
    [gameLineups, offense],
  )
  // Defensive lineup — pitching team (draggable to mound)
  const defensiveLineup = useMemo(
    () => gameLineups.filter(l => l.player_id === offense?.pitchingPlayerId),
    [gameLineups, offense],
  )

  const autoIdx = useMemo(() => {
    if (!currentLineup.length) return 0
    return gamePAs.filter(pa => pa.player_id === offense?.battingPlayerId).length % currentLineup.length
  }, [gamePAs, currentLineup, offense])

  const effectiveBatterIdx = overrideBatterIdx !== null
    ? overrideBatterIdx % Math.max(currentLineup.length, 1)
    : autoIdx
  const currentBatter  = currentLineup[effectiveBatterIdx]
  const onDeckBatter   = currentLineup[(effectiveBatterIdx + 1) % Math.max(currentLineup.length, 1)]

  // Current pitcher (last stint for defensive team this game)
  const currentPitcherStint = useMemo(() => {
    if (!offense) return null
    const stints = gamePitching.filter(s => s.player_id === offense.pitchingPlayerId)
    return stints[stints.length - 1] ?? null
  }, [gamePitching, offense])
  const currentPitcherChar = currentPitcherStint ? charactersById[currentPitcherStint.character_id] : null

  const teamRosters = useMemo(() => {
    if (!selectedGame) return { teamA: [], teamB: [] }
    const picks = draftPicks.filter(p => p.tournament_id === selectedGame.tournament_id)
    return {
      teamA: picks.filter(p => p.player_id === selectedGame.team_a_player_id),
      teamB: picks.filter(p => p.player_id === selectedGame.team_b_player_id),
    }
  }, [draftPicks, selectedGame])

  const scores = useMemo(() => {
    if (!selectedGame) return { a: 0, b: 0, aByInning: {}, bByInning: {}, aHits: 0, bHits: 0 }
    if (selectedGame.status === 'complete') {
      return {
        a: Number(selectedGame.team_a_runs || 0),
        b: Number(selectedGame.team_b_runs || 0),
        aByInning: { 1: Number(selectedGame.team_a_runs || 0) },
        bByInning: { 1: Number(selectedGame.team_b_runs || 0) },
        aHits: hitsFromPAs(gamePAs, selectedGame.team_a_player_id),
        bHits: hitsFromPAs(gamePAs, selectedGame.team_b_player_id),
      }
    }
    return {
      a: runsFromPAs(gamePAs, selectedGame.team_a_player_id),
      b: runsFromPAs(gamePAs, selectedGame.team_b_player_id),
      aByInning: inningRunsFromPAs(gamePAs, selectedGame.team_a_player_id),
      bByInning: inningRunsFromPAs(gamePAs, selectedGame.team_b_player_id),
      aHits: hitsFromPAs(gamePAs, selectedGame.team_a_player_id),
      bHits: hitsFromPAs(gamePAs, selectedGame.team_b_player_id),
    }
  }, [gamePAs, selectedGame])

  const tournamentGameIds = useMemo(
    () => new Set(filteredGames.map(g => String(g.id))),
    [filteredGames],
  )

  const characterSeasonStats = useMemo(() => {
    if (!currentBatter) return null
    const tournPAs = plateAppearances.filter(pa =>
      pa.character_id === currentBatter.character_id &&
      tournamentGameIds.has(String(pa.game_id)),
    )
    return summarizeBatting(tournPAs)
  }, [plateAppearances, currentBatter, tournamentGameIds])

  const characterCareerStats = useMemo(() => {
    if (!currentBatter) return null
    return summarizeBatting(plateAppearances.filter(pa => pa.character_id === currentBatter.character_id))
  }, [plateAppearances, currentBatter])

  const currentBatterGamePAs = useMemo(() => {
    if (!currentBatter) return []
    return gamePAs.filter(pa => pa.character_id === currentBatter.character_id && pa.player_id === currentBatter.player_id)
  }, [gamePAs, currentBatter])

  const previewRunners = useMemo(
    () => (pendingPA?.assignments?.length ? extractNextRunners(pendingPA) : runners),
    [pendingPA, runners],
  )

  const previewHomeRunners = useMemo(
    () => (pendingPA?.assignments?.length ? getHomeAssignments(pendingPA) : []),
    [pendingPA],
  )

  const previewOuts = useMemo(
    () => (pendingPA?.assignments?.length ? getOutAssignments(pendingPA).length : 0),
    [pendingPA],
  )

  useEffect(() => {
    if (!selectedGameId) return
    const runnerKey = getRunnerStateStorageKey(selectedGameId, currentHalfIdx)
    const historyKey = getRunnerHistoryStorageKey(selectedGameId, currentHalfIdx)
    try {
      const stored = sessionStorage.getItem(runnerKey)
      const storedHistory = sessionStorage.getItem(historyKey)
      const parsed = stored ? JSON.parse(stored) : null
      const parsedHistory = storedHistory ? JSON.parse(storedHistory) : []
      setRunners({
        first: parsed?.first || null,
        second: parsed?.second || null,
        third: parsed?.third || null,
      })
      setRunnersHistory(Array.isArray(parsedHistory) ? parsedHistory : [])
    } catch {
      setRunners({ first: null, second: null, third: null })
      setRunnersHistory([])
    }
    setRunnerStateLoadedScope(`${selectedGameId}:${currentHalfIdx}`)
  }, [selectedGameId, currentHalfIdx])

  useEffect(() => {
    if (!selectedGameId || runnerStateLoadedScope !== `${selectedGameId}:${currentHalfIdx}`) return
    const runnerKey = getRunnerStateStorageKey(selectedGameId, currentHalfIdx)
    const historyKey = getRunnerHistoryStorageKey(selectedGameId, currentHalfIdx)
    try {
      sessionStorage.setItem(runnerKey, JSON.stringify(runners))
      sessionStorage.setItem(historyKey, JSON.stringify(runnersHistory))
    } catch {}
  }, [selectedGameId, currentHalfIdx, runnerStateLoadedScope, runners, runnersHistory])

  const isCommissioner = player?.is_commissioner === true
  const isScorekeeper  = Boolean(player && (player.is_commissioner || player.scorebook_access))
  const canRecordOutcome = Boolean(currentPitcherStint)

  const displayedPAs = useMemo(() => {
    const base = [...gamePAs].reverse()
    return viewedInning ? base.filter(pa => pa.inning === viewedInning) : base
  }, [gamePAs, viewedInning])

  const maxInning = Math.max(regulationInnings, currentInning)
  const innings   = Array.from({ length: maxInning }, (_, i) => i + 1)

  // Batting/pitching team display info
  const battingPlayer  = selectedGame ? playersById[offense?.battingPlayerId]  : null
  const pitchingPlayer = selectedGame ? playersById[offense?.pitchingPlayerId] : null
  const teamAPlayer    = selectedGame ? playersById[selectedGame.team_a_player_id] : null
  const teamBPlayer    = selectedGame ? playersById[selectedGame.team_b_player_id] : null
  const teamAName      = teamAPlayer?.name || 'Team A'
  const teamBName      = teamBPlayer?.name || 'Team B'
  const teamAColor     = teamAPlayer?.color || C.blue
  const teamBColor     = teamBPlayer?.color || C.red
  const battingColor   = battingPlayer?.color  || C.accent
  const pitchingColor  = pitchingPlayer?.color || C.muted

  // ── Game-end check ─────────────────────────────────────────────────────────
  const checkGameEnd = useCallback((completedInnings, currentScores) => {
    if (!selectedGame || selectedGame.status === 'complete') return null
    const diff = Math.abs(currentScores.a - currentScores.b)
    if (mercyOn && completedInnings >= 1 && diff >= mercyLimit && currentScores.a !== currentScores.b) {
      const winnerId = currentScores.a > currentScores.b ? selectedGame.team_a_player_id : selectedGame.team_b_player_id
      return { type: 'mercy', winnerId, inning: completedInnings }
    }
    if (completedInnings >= regulationInnings && currentScores.a !== currentScores.b) {
      const winnerId = currentScores.a > currentScores.b ? selectedGame.team_a_player_id : selectedGame.team_b_player_id
      return { type: 'regulation', winnerId, inning: completedInnings }
    }
    return null
  }, [selectedGame, mercyOn, mercyLimit, regulationInnings])

  // ── Sync scores ────────────────────────────────────────────────────────────
  async function syncScores(freshPAs, game) {
    await supabase.from('games').update({
      team_a_runs: runsFromPAs(freshPAs, game.team_a_player_id),
      team_b_runs: runsFromPAs(freshPAs, game.team_b_player_id),
    }).eq('id', game.id)
  }

  // ── Save plate appearance ──────────────────────────────────────────────────
  const buildOddsGenerationContext = useCallback((overridePitching = gamePitching, overridePAs = gamePAs) => {
    return buildSharedOddsGenerationContext({
      game: selectedGame,
      draftPicks,
      charactersById,
      gamePAs: overridePAs,
      gamePitching: overridePitching,
      allGames: games,
      allPAs: plateAppearances,
      allPitching: pitchingStints,
      stadiumsById,
      stadiumGameLog,
      playersById,
      currentInning,
      scores,
    })
  }, [
    charactersById,
    currentInning,
    gamePAs,
    gamePitching,
    draftPicks,
    games,
    pitchingStints,
    plateAppearances,
    playersById,
    scores,
    selectedGame,
    stadiumGameLog,
    stadiumsById,
  ])

  const upsertChangedOdds = useCallback(async (changedRows) => {
    if (!selectedGame || !changedRows.length) return
    const { data: existingOdds } = await supabase.from('game_odds').select('*').eq('game_id', selectedGame.id)
    const payload = mergeOddsWithExistingRows(changedRows, existingOdds || []).map((row) => {
      const sanitized = Object.fromEntries(
        Object.entries(row).filter(([, value]) => value !== null && value !== undefined),
      )
      return sanitized
    })
    const { error } = await supabase.from('game_odds').upsert(payload)
    if (error) throw error
  }, [selectedGame])

  const ensureLiveOdds = useCallback(async (overridePitching = gamePitching, overridePAs = gamePAs) => {
    if (!selectedGame) return []
    const { data: currentOdds } = await supabase.from('game_odds').select('*').eq('game_id', selectedGame.id)
    if ((currentOdds || []).length) return currentOdds || []

    const generationContext = buildOddsGenerationContext(overridePitching, overridePAs)
    if (!generationContext) return []

    const generatedRows = generateGameOdds(
      generationContext.game,
      generationContext.homeRoster,
      generationContext.awayRoster,
      generationContext.homeHistorical,
      generationContext.awayHistorical,
      generationContext.playerProps,
      { char_stats_weight: 0.333, historical_weight: 0.333, live_weight: 0.334 },
    )

    await upsertChangedOdds(generatedRows)
    return generatedRows
  }, [selectedGame, gamePitching, gamePAs, buildOddsGenerationContext, upsertChangedOdds])

  useEffect(() => {
    if (!selectedGame || selectedGame.status === 'complete') return
    ensureLiveOdds().catch((error) => {
      pushToast({ title: 'Odds sync failed', message: error.message, type: 'error' })
    })
  }, [selectedGame?.id, selectedGame?.status, ensureLiveOdds, pushToast])

  const recomputePitchingStatsForGame = useCallback(async (overridePAs, overridePitching = gamePitching) => {
    if (!selectedGame || !overridePitching.length) return

    const stints = [...overridePitching].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    const pas = [...overridePAs].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    const nextStatsByStintId = Object.fromEntries(
      stints.map((stint) => [stint.id, {
        innings_pitched: 0,
        hits_allowed: 0,
        runs_allowed: 0,
        earned_runs: 0,
        walks: 0,
        strikeouts: 0,
        hr_allowed: 0,
        _outsRecorded: 0,
      }]),
    )

    let outsBeforePa = 0
    pas.forEach((pa) => {
      const defense = deriveOffense(selectedGame, outsBeforePa)
      const eligibleStints = stints.filter(
        (stint) =>
          String(stint.player_id) === String(defense.pitchingPlayerId) &&
          new Date(stint.created_at).getTime() <= new Date(pa.created_at).getTime(),
      )
      const activeStint = eligibleStints[eligibleStints.length - 1]
      if (activeStint) {
        const next = nextStatsByStintId[activeStint.id]
        const outs = calculateOutsForPa(pa.result)
        const runsScored = getRunsScoredOnPa(pa)

        next._outsRecorded += outs
        next.runs_allowed += runsScored
        next.earned_runs += runsScored
        if (HIT_RESULTS.has(pa.result)) next.hits_allowed += 1
        if (pa.result === 'HR') next.hr_allowed += 1
        if (pa.result === 'BB') next.walks += 1
        if (pa.result === 'K') next.strikeouts += 1
      }
      outsBeforePa += calculateOutsForPa(pa.result)
    })

    Object.values(nextStatsByStintId).forEach((entry) => {
      entry.innings_pitched = inningsPitchedFromOuts(entry._outsRecorded)
      delete entry._outsRecorded
    })

    await Promise.all(
      stints.map((stint) =>
        supabase
          .from('pitching_stints')
          .update(nextStatsByStintId[stint.id])
          .eq('id', stint.id),
      ),
    )

    setPitchingStints((current) => current.map((stint) => (
      nextStatsByStintId[stint.id]
        ? { ...stint, ...nextStatsByStintId[stint.id] }
        : stint
    )))
  }, [selectedGame, gamePitching])

  const savePA = useCallback(async (result, rbi, runScored) => {
    if (!selectedGame || !offense || !currentBatter) return

    const paPayload = {
      game_id: selectedGame.id,
      player_id: currentBatter.player_id,
      character_id: currentBatter.character_id,
      inning: offense.inning,
      pa_number: editingPa?.pa_number ?? (gamePAs.length + 1),
      result, rbi: rbi || 0, run_scored: runScored || false,
    }

    const query = editingPa
      ? supabase.from('plate_appearances').update(paPayload).eq('id', editingPa.id)
      : supabase.from('plate_appearances').insert(paPayload)
    const { error } = await query
    if (error) { pushToast({ title: 'Save failed', message: error.message, type: 'error' }); return }

    const { data: freshPAs } = await supabase.from('plate_appearances').select('*')
      .eq('game_id', selectedGame.id).order('created_at')
    const allPAs = freshPAs || []
    setPlateAppearances(cur => [
      ...cur.filter(p => String(p.game_id) !== String(selectedGame.id)),
      ...allPAs,
    ])
    await syncScores(allPAs, selectedGame)
    await recomputePitchingStatsForGame(allPAs)

    if (!editingPa) {
      try {
        await resolveOnPA(selectedGame.id, paPayload)
        const currentOdds = await ensureLiveOdds(gamePitching, allPAs)
        const changedRows = recalculateOdds(currentOdds || [], {
          battingSide: offense.isTop ? 'away' : 'home',
          isTop: offense.isTop,
          paCount: allPAs.length,
          runsThisHalf: allPAs
            .filter(pa => pa.inning === offense.inning && pa.player_id === currentBatter.player_id)
            .reduce((sum, pa) => sum + Number(pa.rbi || 0) + (pa.run_scored ? 1 : 0), 0),
          lockedEntities: [buildBettingEntityLabel(charactersById[currentBatter.character_id], playersById[currentBatter.player_id])],
        }, paPayload)
        await upsertChangedOdds(changedRows)
      } catch (bettingError) {
        pushToast({ title: 'Betting update failed', message: bettingError.message, type: 'error' })
      }
    }

    const newOuts = allPAs.reduce((s, pa) => s + calculateOutsForPa(pa.result), 0)
    const prevHalf = Math.floor(outsRef.current / 3)
    const newHalf  = Math.floor(newOuts / 3)
    if (newHalf > prevHalf) setShowOutsBanner(true)

    if (result === 'HR') {
      pushToast({ title: 'Home run!', message: 'HR prop bets can be resolved on the betting board.', type: 'success' })
    } else {
      pushToast({ title: `${charactersById[currentBatter.character_id]?.name || 'Batter'} — ${result}`, type: 'success' })
    }
    if (navigator.vibrate) navigator.vibrate(50)
    setEditingPa(null)
    setOverrideBatterIdx(null)
  }, [selectedGame, offense, currentBatter, editingPa, gamePAs, charactersById, playersById, pushToast, upsertChangedOdds, ensureLiveOdds, gamePitching, recomputePitchingStatsForGame])

  // ── Handle outcome button ──────────────────────────────────────────────────
  const handleOutcome = useCallback((result) => {
    if (!currentBatter || !offense) return
    if (!currentPitcherStint) {
      pushToast({ title: 'Select a pitcher', message: 'Choose the active pitcher on the mound before recording an outcome.', type: 'error' })
      return
    }

    // Edit mode: save directly, preserve RBI if result type unchanged
    if (editingPa) {
      const rbi = editingPa.result === result ? editingPa.rbi : 0
      savePA(result, rbi, result === 'HR')
      return
    }

    const batter     = { characterId: currentBatter.character_id, playerId: currentBatter.player_id }
    const hasRunners = runners.first || runners.second || runners.third

    // HR: all runners score automatically
    if (result === 'HR') {
      const rbi = (runners.first ? 1 : 0) + (runners.second ? 1 : 0) + (runners.third ? 1 : 0)
      savePA('HR', rbi, true)
      pushRunners({ first: null, second: null, third: null })
      return
    }

    // Hits / walks with runners: show resolution panel
    if (NEEDS_RESOLUTION.has(result) && hasRunners) {
      setPendingPA({ result, ...computePendingState(result, runners, batter) })
      return
    }

    // Hits / walks without runners: auto-advance batter, 0 RBI
    if (NEEDS_RESOLUTION.has(result)) {
      const pending = computePendingState(result, runners, batter)
      savePA(result, 0, false)
      pushRunners(extractNextRunners(pending))
      return
    }

    // Walks / HBP: always use forced/default advancement
    if (result === 'BB' || result === 'HBP') {
      const pending = computePendingState(result, runners, batter)
      savePA(result, 0, false)
      pushRunners(extractNextRunners(pending))
      return
    }

    // SF: runner on third scores
    if (result === 'SF') {
      savePA('SF', runners.third ? 1 : 0, false)
      pushRunners(computeImmediateNextRunners('SF', runners, null))
      return
    }

    // All other outs (K, GO, FO, LO, DP, SH, FC)
    savePA(result, 0, false)
    pushRunners(computeImmediateNextRunners(result, runners, batter))
  }, [currentBatter, offense, editingPa, runners, savePA, pushRunners, currentPitcherStint, pushToast])

  // ── Runner resolution toggles ──────────────────────────────────────────────
  const handleSetRunnerDestination = useCallback((assignmentId, destination) => {
    setPendingPA(prev => {
      if (!prev) return prev
      const duplicateBaseOwner = ['first', 'second', 'third'].includes(destination)
        ? prev.assignments.find((assignment) => assignment.id !== assignmentId && assignment.destination === destination)
        : null

      return {
        ...prev,
        assignments: prev.assignments.map((assignment) => {
          if (assignment.id === assignmentId) return { ...assignment, destination }
          if (duplicateBaseOwner && assignment.id === duplicateBaseOwner.id) return { ...assignment, destination: 'out' }
          return assignment
        }),
      }
    })
  }, [])

  const confirmPendingPA = useCallback(async () => {
    if (!pendingPA || !currentBatter) return
    const occupiedBases = pendingPA.assignments
      .filter((assignment) => ['first', 'second', 'third'].includes(assignment.destination))
      .map((assignment) => assignment.destination)
    if (new Set(occupiedBases).size !== occupiedBases.length) {
      pushToast({ title: 'Runner conflict', message: 'Only one runner can occupy each base.', type: 'error' })
      return
    }
    const { result, assignments } = pendingPA
    await savePA(result, getRbiFromAssignments(assignments), didBatterScore(assignments))
    pushRunners(extractNextRunners(pendingPA))
    setPendingPA(null)
  }, [pendingPA, currentBatter, savePA, pushRunners, pushToast])

  // ── Next half-inning ───────────────────────────────────────────────────────
  const handleNextHalfInning = useCallback(async () => {
    const newHalfIdx = Math.floor(outsRecorded / 3)
    if (selectedGame && newHalfIdx >= 2 && scores.a + scores.b === 0) {
      try {
        await resolveFirstInningNoRun(selectedGame.id)
      } catch (error) {
        pushToast({ title: 'First inning resolution failed', message: error.message, type: 'error' })
      }
    }
    // After top half of regulation/extra inning: if home team (team_b) is winning, offer to end
    if (newHalfIdx % 2 === 1) {
      const justFinishedInning = Math.ceil(newHalfIdx / 2)
      if (justFinishedInning >= regulationInnings && scores.b > scores.a) {
        setGameEndBanner({ type: 'regulation', winnerId: selectedGame.team_b_player_id, inning: justFinishedInning })
        setShowOutsBanner(false)
        setOverrideBatterIdx(null)
        resetRunners(false)
        return
      }
    }
    // After bottom half: standard end-of-inning check (regulation + mercy + extra innings)
    if (newHalfIdx % 2 === 0 && newHalfIdx > 0) {
      const completedInnings = newHalfIdx / 2
      const end = checkGameEnd(completedInnings, scores)
      if (end) {
        setGameEndBanner(end)
        setShowOutsBanner(false)
        setOverrideBatterIdx(null)
        resetRunners(false)
        return
      }
    }
    setShowOutsBanner(false)
    setOverrideBatterIdx(null)
    setPendingPA(null)
    setSelectedPitcher(null)
    resetRunners(false)
  }, [outsRecorded, selectedGame, scores, checkGameEnd, regulationInnings, pushToast, resetRunners])

  // ── Undo last PA ───────────────────────────────────────────────────────────
  const toggleScorebookAccess = useCallback(async (targetPlayer) => {
    const newValue = !targetPlayer.scorebook_access
    const { error } = await supabase.from('players').update({ scorebook_access: newValue }).eq('id', targetPlayer.id)
    if (error) { pushToast({ title: 'Error', message: error.message, type: 'error' }); return }
    setPlayers(prev => prev.map(p => p.id === targetPlayer.id ? { ...p, scorebook_access: newValue } : p))
    pushToast({ title: newValue ? 'Access granted' : 'Access revoked', message: `${targetPlayer.name} ${newValue ? 'can now edit' : 'can no longer edit'} the scorebook.`, type: 'success' })
  }, [pushToast])

  const undoLastPA = useCallback(async () => {
    if (!gamePAs.length || !selectedGame) return
    const last = [...gamePAs].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]
    const { error } = await supabase.from('plate_appearances').delete().eq('id', last.id)
    if (error) { pushToast({ title: 'Undo failed', message: error.message, type: 'error' }); return }
    const { data: freshPAs } = await supabase.from('plate_appearances').select('*').eq('game_id', selectedGame.id).order('created_at')
    const allPAs = freshPAs || []
    setPlateAppearances(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...allPAs])
    await syncScores(allPAs, selectedGame)
    await recomputePitchingStatsForGame(allPAs)
    setShowOutsBanner(false)
    setGameEndBanner(null)
    setPendingPA(null)
    popRunners()
    if (navigator.vibrate) navigator.vibrate(30)
  }, [gamePAs, selectedGame, pushToast, popRunners, recomputePitchingStatsForGame])

  // ── Auto-seed lineups ──────────────────────────────────────────────────────
  const generateDefaultLineups = useCallback(async () => {
    if (!selectedGame || gameLineups.length) return
    const buildRows = (roster, playerId) => {
      let picks = roster.filter(p => p.character_id)
      try {
        const saved = JSON.parse(localStorage.getItem(`roster-lineup-${selectedGame.tournament_id}-${playerId}`) || 'null')
        if (saved && Array.isArray(saved)) {
          const byCharId = Object.fromEntries(picks.map(p => [p.character_id, p]))
          const ordered  = saved.map(id => byCharId[id]).filter(Boolean)
          const rest     = picks.filter(p => !saved.includes(p.character_id))
          picks = [...ordered, ...rest]
        }
      } catch {}
      return picks.slice(0, 9).map((pick, i) => ({
        game_id: selectedGame.id, player_id: playerId, character_id: pick.character_id, batting_order: i + 1,
      }))
    }
    const payload = [
      ...buildRows(teamRosters.teamA, selectedGame.team_a_player_id),
      ...buildRows(teamRosters.teamB, selectedGame.team_b_player_id),
    ]
    if (!payload.length) return
    const { error } = await supabase.from('lineups').insert(payload)
    if (error) { pushToast({ title: 'Lineup seed failed', message: error.message, type: 'error' }); return }
    setLineups(cur => [...cur, ...payload])
  }, [selectedGame, gameLineups, teamRosters, pushToast])

  useEffect(() => {
    if (!selectedGame || gameLineups.length > 0) return
    const total = teamRosters.teamA.length + teamRosters.teamB.length
    if (total === 0) return
    generateDefaultLineups()
  }, [selectedGame?.id, gameLineups.length, teamRosters.teamA.length + teamRosters.teamB.length])

  // ── Mark game complete ─────────────────────────────────────────────────────
  const markGameComplete = useCallback(async (winnerId, finalInning, isExtra) => {
    if (!selectedGame) return
    const resolved = winnerId ?? (scores.a === scores.b ? null : scores.a > scores.b ? selectedGame.team_a_player_id : selectedGame.team_b_player_id)
    const { error } = await supabase.from('games').update({
      status: 'complete', winner_player_id: resolved,
      team_a_runs: scores.a, team_b_runs: scores.b,
      final_inning: finalInning || currentInning, is_extra_innings: isExtra || false,
    }).eq('id', selectedGame.id)
    if (error) { pushToast({ title: 'Error', message: error.message, type: 'error' }); return }
    const completedGame = {
      ...selectedGame,
      status: 'complete',
      winner_player_id: resolved,
      team_a_runs: scores.a,
      team_b_runs: scores.b,
      final_inning: finalInning || currentInning,
      is_extra_innings: isExtra || false,
    }
    setGames(cur => cur.map(g => g.id === selectedGame.id ? completedGame : g))
    setGameEndBanner(null)
    if (selectedGame.stadium_id) {
      const { error: stadiumLogError } = await supabase.from('stadium_game_log').insert({
        game_id: selectedGame.id,
        stadium_id: selectedGame.stadium_id,
        is_night: Boolean(selectedGame.is_night),
        total_runs: scores.a + scores.b,
        confidence: 1.0,
      })
      if (stadiumLogError) {
        pushToast({ title: 'Stadium log failed', message: stadiumLogError.message, type: 'error' })
      }
    }
    try {
      const pitcherKTotals = {}
      gamePitching.forEach((stint) => {
        const key = buildBettingEntityLabel(charactersById[stint.character_id], playersById[stint.player_id])
        pitcherKTotals[key] = Number(pitcherKTotals[key] || 0) + Number(stint.strikeouts || 0)
      })
      await resolveGameBets(
        selectedGame.id,
        resolved === selectedGame.team_b_player_id ? 'home' : 'away',
        scores.a + scores.b,
        pitcherKTotals,
        Math.abs(scores.a - scores.b),
      )
    } catch (bettingError) {
      pushToast({ title: 'Bet resolution failed', message: bettingError.message, type: 'error' })
    }
    try {
      const createdGames = await advanceBracketOnGameComplete({
        supabase,
        tournament,
        games: games.map((game) => (game.id === selectedGame.id ? completedGame : game)),
        completedGame,
      })
      if (createdGames.length) {
        setGames((current) => {
          const existingById = new Map(current.map((game) => [game.id, game]))
          createdGames.forEach((game) => existingById.set(game.id, game))
          return Array.from(existingById.values())
        })
      }
    } catch (bracketError) {
      pushToast({ title: 'Bracket update failed', message: bracketError.message, type: 'error' })
    }
    pushToast({ title: 'Game complete', type: 'success' })
  }, [selectedGame, scores, currentInning, pushToast, gamePitching, charactersById, playersById, tournament, games])

  // ── Swap home / away teams ────────────────────────────────────────────────
  const swapTeams = useCallback(async () => {
    if (!selectedGame) return
    const { error } = await supabase.from('games').update({
      team_a_player_id: selectedGame.team_b_player_id,
      team_b_player_id: selectedGame.team_a_player_id,
      team_a_runs: selectedGame.team_b_runs,
      team_b_runs: selectedGame.team_a_runs,
    }).eq('id', selectedGame.id)
    if (error) { pushToast({ title: 'Swap failed', message: error.message, type: 'error' }); return }
    setGames(cur => cur.map(g => g.id === selectedGame.id ? {
      ...g,
      team_a_player_id: g.team_b_player_id,
      team_b_player_id: g.team_a_player_id,
      team_a_runs: g.team_b_runs,
      team_b_runs: g.team_a_runs,
    } : g))
    pushToast({ title: 'Teams swapped — Away/Home flipped', type: 'success' })
  }, [selectedGame, pushToast])

  // ── Pitcher change (drag to mound or double-tap) ──────────────────────────
  const changePitcher = useCallback(async (playerId, characterId) => {
    if (!selectedGame) return
    const newStint = {
      game_id: selectedGame.id, player_id: playerId, character_id: characterId,
      innings_pitched: 0, hits_allowed: 0, runs_allowed: 0, earned_runs: 0, walks: 0, strikeouts: 0, hr_allowed: 0,
    }
    const { data, error } = await supabase.from('pitching_stints').insert(newStint).select().single()
    if (error) { pushToast({ title: 'Pitcher change failed', message: error.message, type: 'error' }); return }
    // Optimistic update — don't wait for realtime to refresh the mound
    if (data) setPitchingStints(cur => [...cur, data])
    try {
      const nextPitching = data ? [...gamePitching, data] : gamePitching
      const generationContext = buildOddsGenerationContext(nextPitching, gamePAs)
      const currentOdds = await ensureLiveOdds(nextPitching, gamePAs)
      const changedRows = recalculateOdds(currentOdds || [], {
        pitcherSwap: true,
        generationContext: generationContext ? { ...generationContext, weights: { char_stats_weight: 0.333, historical_weight: 0.333, live_weight: 0.334 } } : null,
      })
      await upsertChangedOdds(changedRows)
    } catch (bettingError) {
      pushToast({ title: 'Odds refresh failed', message: bettingError.message, type: 'error' })
    }
    pushToast({ title: `Pitcher → ${charactersById[characterId]?.name}`, type: 'success' })
  }, [selectedGame, charactersById, pushToast, gamePitching, buildOddsGenerationContext, gamePAs, upsertChangedOdds, ensureLiveOdds])

  const handleMoundDragOver = useCallback((e) => { e.preventDefault(); setIsDragOverMound(true) }, [])
  const handleMoundDragLeave = useCallback(() => setIsDragOverMound(false), [])
  const handleMoundDrop = useCallback(async (e) => {
    e.preventDefault()
    setIsDragOverMound(false)
    const charId   = parseInt(e.dataTransfer.getData('pitcherCharId'), 10)
    const playerId = e.dataTransfer.getData('pitcherPlayerId')
    if (!charId || !playerId) return
    if (playerId !== offense?.pitchingPlayerId) {
      pushToast({ title: 'Wrong team', message: 'Only the pitching team\'s players can be dragged to the mound.', type: 'error' })
      return
    }
    if (charId === currentPitcherStint?.character_id) return
    await changePitcher(playerId, charId)
  }, [offense, currentPitcherStint, changePitcher, pushToast])

  const handlePitcherDragStart = useCallback((charId, playerId) => (e) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('pitcherCharId', String(charId))
    e.dataTransfer.setData('pitcherPlayerId', String(playerId))
  }, [])

  // Tap-to-select pitcher: first tap selects (purple), second tap confirms change
  const handlePitcherItemClick = useCallback(async (charId, playerId) => {
    if (charId === currentPitcherStint?.character_id) return // already pitching
    if (selectedPitcher?.charId === charId) {
      // Second tap — confirm
      await changePitcher(playerId, charId)
      setSelectedPitcher(null)
    } else {
      // First tap — select
      setSelectedPitcher({ charId, playerId })
    }
  }, [currentPitcherStint, selectedPitcher, changePitcher])

  // Mound click still works as an alternative confirm
  const handleMoundClick = useCallback(async () => {
    if (!selectedPitcher) return
    if (selectedPitcher.playerId !== offense?.pitchingPlayerId) {
      pushToast({ title: 'Wrong team', message: 'Only the pitching team can be assigned to the mound.', type: 'error' })
      setSelectedPitcher(null)
      return
    }
    await changePitcher(selectedPitcher.playerId, selectedPitcher.charId)
    setSelectedPitcher(null)
  }, [selectedPitcher, offense, changePitcher, pushToast])

  // ── Add game ───────────────────────────────────────────────────────────────
  const addGame = useCallback(async () => {
    if (!tournament || !selectedAddGameStadium) return
    const highestCode = Math.max(...filteredGames.map(g => parseInt(String(g.game_code || '').replace(/\D/g, '') || '0')), 0)
    const { data, error } = await supabase.from('games').insert({
      tournament_id: tournament.id,
      game_code: `G${highestCode + 1}`,
      stage: addGameForm.stage || 'Game',
      team_a_player_id: addGameForm.teamA || null,
      team_b_player_id: addGameForm.teamB || null,
      stadium_id: selectedAddGameStadium.id,
      is_night: normalizeIsNightForStadium(selectedAddGameStadium, addGameForm.isNight),
      team_a_runs: 0, team_b_runs: 0, status: 'pending',
    }).select().single()
    if (error) { pushToast({ title: 'Error', message: error.message, type: 'error' }); return }
    setGames(cur => [...cur, data])
    setSelectedGameId(String(data.id))
    setShowAddGame(false)
    setAddGameForm({
      teamA: '',
      teamB: '',
      stage: '',
      stadiumId: selectedAddGameStadium.id,
      isNight: normalizeIsNightForStadium(selectedAddGameStadium, false),
    })
    pushToast({ title: `${data.game_code} added`, type: 'success' })
  }, [tournament, filteredGames, addGameForm, pushToast, selectedAddGameStadium])

  // ─── Empty state ────────────────────────────────────────────────────────────
  if (!selectedGame && filteredGames.length === 0) {
    return (
      <div>
        <div className="page-head"><span className="brand-kicker">Live Scorebook</span><h1>Scorebook</h1></div>
        <section className="panel" style={{ textAlign: 'center', padding: 40 }}>
          <p className="muted" style={{ marginBottom: 16 }}>No games created yet for this tournament.</p>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
            <button className="ghost-button" onClick={() => navigate('/bracket')} type="button">Go to Bracket →</button>
            {isCommissioner && (
              <button className="solid-button" onClick={() => setShowAddGame(true)} type="button">+ Add Game</button>
            )}
          </div>
        </section>
        {showAddGame && <AddGameModal players={players} stadiums={stadiums} addGameForm={addGameForm} setAddGameForm={setAddGameForm} onAdd={addGame} onClose={() => setShowAddGame(false)} />}
      </div>
    )
  }

  // ── Shared game-switcher row ────────────────────────────────────────────────
  const gameSwitcher = (
    <div style={{ overflowX: 'auto', scrollbarWidth: 'none', padding: '10px 0 6px' }}>
      <div style={{ display: 'flex', gap: 8, minWidth: 'max-content', padding: '0 12px' }}>
        {filteredGames.map(g => {
          const active = String(g.id) === String(selectedGameId)
          const dot    = g.status === 'active' ? '🟡' : g.status === 'complete' ? '✅' : '⚪'
          const stage  = normalizeStageLabel(g.stage || '').split(' ').slice(0, 2).join(' ')
          return (
            <button key={g.id} onClick={() => { setSelectedGameId(String(g.id)); setViewedInning(null); setGameEndBanner(null); setPendingPA(null); resetRunners(); setSelectedPitcher(null) }}
              style={{ background: active ? C.accent : C.card, color: active ? '#000' : C.text, border: `1.5px solid ${active ? C.accent : C.border}`, borderRadius: 20, padding: '6px 14px', cursor: 'pointer', fontWeight: active ? 800 : 600, fontSize: 13, whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>{dot}</span><span>{g.game_code}</span>
              {stage && <span style={{ opacity: 0.7, fontSize: 11 }}>{stage}</span>}
            </button>
          )
        })}
        {isCommissioner && (
          <button onClick={() => setShowAddGame(true)}
            style={{ background: 'none', border: `1.5px dashed ${C.border}`, borderRadius: 20, padding: '6px 14px', cursor: 'pointer', color: C.muted, fontSize: 13 }}>
            + Add Game
          </button>
        )}
        {isCommissioner && (
          <button onClick={() => setShowAccessModal(true)}
            style={{ background: 'none', border: `1.5px dashed ${C.border}`, borderRadius: 20, padding: '6px 14px', cursor: 'pointer', color: C.muted, fontSize: 13 }}>
            🔑 Scorebook Access
          </button>
        )}
      </div>
    </div>
  )

  // ── Spectator mode ──────────────────────────────────────────────────────────
  if (selectedGame && !isScorekeeper) {
    return (
      <div style={{ color: C.text, paddingBottom: 40, margin: '-1.25rem -1.25rem 0' }}>
        {gameSwitcher}
        <div style={{ position: 'sticky', top: 60, zIndex: 19, background: C.bg, borderBottom: `1px solid ${C.border}`, padding: '10px 12px 8px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: C.muted, fontSize: 12 }}>{selectedGame.game_code} · {normalizeStageLabel(selectedGame.stage)}</span>
            <div style={{ display: 'flex', gap: 5 }}>
              {[0, 1, 2].map(i => <span key={i} style={{ width: 12, height: 12, borderRadius: '50%', display: 'inline-block', background: i < outsInHalf ? '#F59E0B' : C.card, border: `2px solid ${i < outsInHalf ? '#F59E0B' : C.border}` }} />)}
            </div>
          </div>
          <StadiumHeaderPill stadium={selectedStadium} isNight={selectedGame?.is_night} />
          <div style={{ textAlign: 'center', fontSize: 28, fontWeight: 900, letterSpacing: 3, marginTop: 4 }}>{offense?.halfLabel || 'PREGAME'}</div>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 28, marginTop: 6, fontSize: 18 }}>
            <span style={{ color: teamAColor, fontWeight: 800 }}>{teamAName} {scores.a}</span>
            <span style={{ color: C.muted }}>·</span>
            <span style={{ color: teamBColor, fontWeight: 800 }}>{teamBName} {scores.b}</span>
          </div>
        </div>
        {/* ── Lineups + Diamond ── */}
        <div style={{ padding: '8px 10px 0' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '58px 1fr 58px', gap: 6, marginBottom: 10, alignItems: 'start' }}>
            <LineupColumn
              lineup={currentLineup}
              currentIdx={effectiveBatterIdx}
              teamColor={battingColor}
              label="BAT"
              draggable={false}
              charactersById={charactersById}
            />
            <Diamond
              runners={previewRunners}
              pitcherChar={currentPitcherChar}
              outs={outsInHalf}
              previewHomeRunners={previewHomeRunners}
              previewOuts={previewOuts}
              isScorekeeper={false}
              charactersById={charactersById}
              selectedPitcher={null}
            />
            <LineupColumn
              lineup={defensiveLineup}
              currentIdx={-1}
              currentPitcherCharId={currentPitcherChar?.id}
              teamColor={pitchingColor}
              label="PIT"
              draggable={false}
              charactersById={charactersById}
            />
          </div>

          {/* Current batter strip */}
          {currentBatter && (
            <div style={{ background: C.card, borderRadius: 10, padding: '10px 14px', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
              <Avatar name={charactersById[currentBatter.character_id]?.name} size={48} />
              <div style={{ flex: 1 }}>
                <div style={{ color: playersById[currentBatter.player_id]?.color, fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }}>{playersById[currentBatter.player_id]?.name}</div>
                <div style={{ fontSize: 18, fontWeight: 800 }}>{charactersById[currentBatter.character_id]?.name}</div>
                <div style={{ color: C.muted, fontSize: 12 }}>Now Batting</div>
              </div>
              {onDeckBatter && (
                <div style={{ textAlign: 'center', opacity: 0.6 }}>
                  <Avatar name={charactersById[onDeckBatter.character_id]?.name} size={32} />
                  <div style={{ fontSize: 9, color: C.muted, marginTop: 2 }}>on deck</div>
                </div>
              )}
            </div>
          )}

          {/* Recent PAs */}
          <div style={{ color: C.muted, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', marginBottom: 8 }}>Recent PAs</div>
          {[...gamePAs].reverse().slice(0, 10).map(pa => (
            <div key={pa.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 0', borderBottom: `1px solid ${C.border}22` }}>
              <Avatar name={charactersById[pa.character_id]?.name} size={32} />
              <div style={{ flex: 1 }}><span style={{ fontWeight: 600, fontSize: 14 }}>{charactersById[pa.character_id]?.name}</span><span style={{ color: C.muted, fontSize: 12 }}> · Inn. {pa.inning}</span></div>
              <ResultBadge result={pa.result} />
              {getCreditedRbiForPa(pa) > 0 && <span style={{ color: C.accent, fontSize: 12, fontWeight: 700 }}>+{getCreditedRbiForPa(pa)} RBI</span>}
            </div>
          ))}
          {!gamePAs.length && <p style={{ color: C.muted }}>No plate appearances yet.</p>}
        </div>
      </div>
    )
  }

  // ── Scorekeeper mode ────────────────────────────────────────────────────────
  return (
    <div style={{ color: C.text, paddingBottom: 90, margin: '-1.25rem -1.25rem 0' }}>
      {gameSwitcher}

      {/* ── Sticky header: score + inning strip ── */}
      <div style={{ position: 'sticky', top: 60, zIndex: 19, background: C.bg, borderBottom: `1px solid ${C.border}` }}>
        <div style={{ padding: '8px 12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: C.muted, fontSize: 12, fontWeight: 600 }}>{selectedGame?.game_code} · {normalizeStageLabel(selectedGame?.stage || '')}</span>
            <div style={{ textAlign: 'center', fontSize: 24, fontWeight: 900, letterSpacing: 3, lineHeight: 1 }}>{offense?.halfLabel || 'PREGAME'}</div>
            <div style={{ display: 'flex', gap: 5 }}>
              {[0, 1, 2].map(i => <span key={i} style={{ width: 14, height: 14, borderRadius: '50%', display: 'inline-block', background: i < outsInHalf ? '#F59E0B' : C.card, border: `2px solid ${i < outsInHalf ? '#F59E0B' : C.border}` }} />)}
            </div>
          </div>
          <StadiumHeaderPill stadium={selectedStadium} isNight={selectedGame?.is_night} />
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 10, marginTop: 4, fontSize: 14 }}>
            <span style={{ color: teamAColor, fontWeight: 700 }}>{teamAName} {scores.a}</span>
            <span style={{ color: C.muted }}>·</span>
            <span style={{ color: teamBColor, fontWeight: 700 }}>{teamBName} {scores.b}</span>
            {selectedGame?.status !== 'complete' && (
              <button onClick={swapTeams} title="Swap home/away"
                style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer', padding: 2, lineHeight: 0, marginLeft: 4 }}>
                <ArrowLeftRight size={14} />
              </button>
            )}
          </div>
        </div>

        {/* Inning score strip */}
        <div style={{ overflowX: 'auto', scrollbarWidth: 'none' }}>
          <div style={{ display: 'flex', minWidth: 'max-content', padding: '2px 8px 4px', gap: 1, alignItems: 'flex-start' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginRight: 6, paddingTop: 18 }}>
              <div style={{ height: 26, display: 'flex', alignItems: 'center', color: teamAColor, fontSize: 10, fontWeight: 700 }}>{teamAName.slice(0, 4).toUpperCase()}</div>
              <div style={{ height: 26, display: 'flex', alignItems: 'center', color: teamBColor, fontSize: 10, fontWeight: 700 }}>{teamBName.slice(0, 4).toUpperCase()}</div>
            </div>
            {innings.map(inn => {
              const isActive = inn === (viewedInning ?? currentInning)
              const isExtra  = inn > regulationInnings
              return (
                <div key={inn} onClick={() => setViewedInning(viewedInning === inn ? null : inn)} style={{ display: 'flex', flexDirection: 'column', gap: 2, cursor: 'pointer', width: 30 }}>
                  <div style={{ height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: inn === currentInning ? 700 : 400, color: inn === currentInning ? C.accent : isExtra ? '#F97316' : C.muted, borderBottom: isActive ? `2px solid ${C.accent}` : isExtra ? '2px solid #F97316' : '2px solid transparent' }}>{inn}</div>
                  <div style={{ height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', background: isActive ? `${C.accent}20` : 'transparent', border: isExtra ? '1px solid #F9731644' : 'none', borderRadius: 3, fontSize: 13, fontWeight: 700, color: (scores.aByInning[inn] || 0) > 0 ? C.text : `${C.border}88` }}>{scores.aByInning[inn] ?? '·'}</div>
                  <div style={{ height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', background: isActive ? `${C.accent}20` : 'transparent', border: isExtra ? '1px solid #F9731644' : 'none', borderRadius: 3, fontSize: 13, fontWeight: 700, color: (scores.bByInning[inn] || 0) > 0 ? C.text : `${C.border}88` }}>{scores.bByInning[inn] ?? '·'}</div>
                </div>
              )
            })}
            {/* R / H totals */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginLeft: 8 }}>
              <div style={{ height: 18, display: 'flex', gap: 4 }}>{['R', 'H'].map(l => <div key={l} style={{ width: 24, textAlign: 'center', fontSize: 10, color: C.muted, fontWeight: 700 }}>{l}</div>)}</div>
              <div style={{ height: 26, display: 'flex', gap: 4, alignItems: 'center' }}>
                <div style={{ width: 24, textAlign: 'center', fontSize: 13, fontWeight: 800, color: teamAColor }}>{scores.a}</div>
                <div style={{ width: 24, textAlign: 'center', fontSize: 13, fontWeight: 700 }}>{scores.aHits}</div>
              </div>
              <div style={{ height: 26, display: 'flex', gap: 4, alignItems: 'center' }}>
                <div style={{ width: 24, textAlign: 'center', fontSize: 13, fontWeight: 800, color: teamBColor }}>{scores.b}</div>
                <div style={{ width: 24, textAlign: 'center', fontSize: 13, fontWeight: 700 }}>{scores.bHits}</div>
              </div>
            </div>
          </div>
        </div>
        {viewedInning && viewedInning !== currentInning && (
          <button onClick={() => setViewedInning(null)} style={{ display: 'block', width: '100%', background: `${C.accent}22`, color: C.accent, border: 'none', padding: '5px 0', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
            Jump to Current (Inn. {currentInning}) →
          </button>
        )}
        {currentInning > regulationInnings && (
          <div style={{ background: '#F9731618', borderTop: '1px solid #F9731644', padding: '4px 12px', fontSize: 11, color: '#F97316', fontWeight: 700 }}>
            EXTRA INNINGS — Inn. {currentInning}
          </div>
        )}
      </div>

      {/* ── Main content ── */}
      <div style={{ padding: '8px 10px 0' }}>

        {/* Loading lineups indicator */}
        {!gameLineups.length && (
          <div style={{ background: `${C.accent}18`, border: `1px solid ${C.accent}44`, borderRadius: 10, padding: '8px 14px', marginBottom: 8 }}>
            <div style={{ color: C.accent, fontWeight: 700, fontSize: 13 }}>Loading lineup…</div>
          </div>
        )}

        {/* ── Three-column: batting lineup | diamond | pitching lineup ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '58px 1fr 58px', gap: 6, marginBottom: 10, alignItems: 'start' }}>

          {/* Left: batting team lineup */}
          <LineupColumn
            lineup={currentLineup}
            currentIdx={effectiveBatterIdx}
            teamColor={battingColor}
            label="BAT"
            draggable={false}
            charactersById={charactersById}
          />

          {/* Center: diamond */}
          <Diamond
            runners={previewRunners}
            pitcherChar={currentPitcherChar}
            outs={outsInHalf}
            previewHomeRunners={previewHomeRunners}
            previewOuts={previewOuts}
            onMoundDrop={handleMoundDrop}
            onMoundDragOver={handleMoundDragOver}
            onMoundDragLeave={handleMoundDragLeave}
            isDragOver={isDragOverMound}
            isScorekeeper={isScorekeeper}
            charactersById={charactersById}
            selectedPitcher={selectedPitcher}
            onMoundClick={handleMoundClick}
          />

          {/* Right: pitching team lineup (drag to mound or tap to select) */}
          <LineupColumn
            lineup={defensiveLineup}
            currentIdx={-1}
            currentPitcherCharId={currentPitcherChar?.id}
            pendingPitcherCharId={selectedPitcher?.charId}
            teamColor={pitchingColor}
            label="PIT"
            draggable={isScorekeeper}
            onDragStart={handlePitcherDragStart}
            onItemClick={isScorekeeper ? handlePitcherItemClick : undefined}
            charactersById={charactersById}
          />
        </div>

        {/* ── Batter strip ── */}
        {currentBatter ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: C.card, borderRadius: 10, padding: '8px 10px', marginBottom: 10, border: `1px solid ${C.border}` }}>
            <button onClick={() => setOverrideBatterIdx(((overrideBatterIdx ?? autoIdx) - 1 + Math.max(currentLineup.length, 1)) % Math.max(currentLineup.length, 1))}
              disabled={currentLineup.length <= 1} style={{ background: 'none', border: 'none', color: C.muted, cursor: currentLineup.length <= 1 ? 'not-allowed' : 'pointer', padding: '10px 8px', flexShrink: 0, minWidth: 44, minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <ChevronLeft size={22} />
            </button>
            <div
              style={{ width: 50, height: 50, borderRadius: '50%', overflow: 'hidden', border: `2px solid ${battingColor}`, flexShrink: 0, padding: 0, background: 'none' }}
            >
              <Avatar name={charactersById[currentBatter.character_id]?.name} size={50} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 800, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {charactersById[currentBatter.character_id]?.name || '—'}
              </div>
              <div style={{ color: battingColor, fontSize: 10, fontWeight: 700, textTransform: 'uppercase' }}>
                {playersById[currentBatter.player_id]?.name} · #{currentBatter.batting_order}
              </div>
              {characterSeasonStats && characterSeasonStats.plateAppearances > 0 && (
                <div style={{ display: 'flex', gap: 10, marginTop: 2 }}>
                  {[
                    { label: 'AVG', val: characterSeasonStats.avg ? characterSeasonStats.avg.toFixed(3).replace('0.', '.') : '.000' },
                    { label: 'HR', val: characterSeasonStats.homeRuns },
                    { label: 'RBI', val: characterSeasonStats.rbi },
                  ].map(({ label, val }) => (
                    <div key={label} style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: 13, fontWeight: 800 }}>{val}</div>
                      <div style={{ color: C.muted, fontSize: 9, textTransform: 'uppercase' }}>T-{label}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {/* This game's PAs */}
            <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', justifyContent: 'flex-end', maxWidth: 80 }}>
              {currentBatterGamePAs.map(pa => <ResultBadge key={pa.id} result={pa.result} />)}
            </div>
            {onDeckBatter && onDeckBatter.id !== currentBatter.id && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                <div style={{ width: 30, height: 30, borderRadius: '50%', overflow: 'hidden', opacity: 0.5 }}>
                  <Avatar name={charactersById[onDeckBatter.character_id]?.name} size={30} />
                </div>
                <div style={{ fontSize: 8, color: C.muted }}>on deck</div>
              </div>
            )}
            <button onClick={() => setOverrideBatterIdx(((overrideBatterIdx ?? autoIdx) + 1) % Math.max(currentLineup.length, 1))}
              disabled={currentLineup.length <= 1} style={{ background: 'none', border: 'none', color: C.muted, cursor: currentLineup.length <= 1 ? 'not-allowed' : 'pointer', padding: '10px 8px', flexShrink: 0, minWidth: 44, minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <ChevronRight size={22} />
            </button>
          </div>
        ) : (
          selectedGame && <div style={{ background: C.card, borderRadius: 10, padding: 16, textAlign: 'center', marginBottom: 10, color: C.muted }}>No lineup set.</div>
        )}

        {/* ── Runner resolution panel ── */}
        {pendingPA && !showOutsBanner && !gameEndBanner && (
          <RunnerAssignmentsPanel
            pendingPA={pendingPA}
            onSetDestination={handleSetRunnerDestination}
            onConfirm={confirmPendingPA}
            onCancel={() => setPendingPA(null)}
            charactersById={charactersById}
          />
        )}

        {/* ── 3-outs banner ── */}
        {showOutsBanner && !gameEndBanner && (
          <div style={{ background: `${C.accent}18`, border: `2px solid ${C.accent}`, borderRadius: 14, padding: 16, marginBottom: 10, textAlign: 'center' }}>
            <div style={{ fontSize: 18, fontWeight: 800, color: C.accent, marginBottom: 12 }}>3 OUTS — Switch sides?</div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button onClick={handleNextHalfInning} style={{ background: C.accent, color: '#000', border: 'none', borderRadius: 8, padding: '12px 20px', fontWeight: 800, fontSize: 15, cursor: 'pointer' }}>
                Next Half-Inning →
              </button>
              <button onClick={() => { undoLastPA(); setShowOutsBanner(false) }} style={{ background: C.card, color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, padding: '12px 14px', fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
                <RotateCcw size={15} /> Undo
              </button>
            </div>
          </div>
        )}

        {/* ── Game-end banner ── */}
        {gameEndBanner && !showOutsBanner && (
          <div style={{ background: `${C.green}18`, border: `2px solid ${C.green}`, borderRadius: 14, padding: 20, marginBottom: 10, textAlign: 'center' }}>
            <div style={{ fontSize: 20, fontWeight: 900, color: C.green, marginBottom: 4 }}>
              {gameEndBanner.type === 'mercy' ? '⚡ Mercy Rule!' : '🏁 Game Over!'}
            </div>
            <div style={{ color: C.text, fontSize: 16, fontWeight: 700, marginBottom: 4 }}>
              {playersById[gameEndBanner.winnerId]?.name} wins {scores.a}–{scores.b}
            </div>
            <div style={{ color: C.muted, fontSize: 13, marginBottom: 16 }}>
              {gameEndBanner.type === 'mercy'
                ? `Mercy rule after ${gameEndBanner.inning} inning${gameEndBanner.inning !== 1 ? 's' : ''}`
                : gameEndBanner.inning > regulationInnings ? `Walk-off in extra inning ${gameEndBanner.inning}` : `Final after ${gameEndBanner.inning} innings`}
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button onClick={() => markGameComplete(gameEndBanner.winnerId, gameEndBanner.inning, gameEndBanner.inning > regulationInnings)}
                style={{ background: C.green, color: '#000', border: 'none', borderRadius: 8, padding: '12px 24px', fontWeight: 800, fontSize: 15, cursor: 'pointer' }}>
                Mark Complete ✓
              </button>
              <button onClick={() => setGameEndBanner(null)}
                style={{ background: C.card, color: C.muted, border: `1px solid ${C.border}`, borderRadius: 8, padding: '12px 14px', fontWeight: 600, cursor: 'pointer', fontSize: 13 }}>
                Continue Playing
              </button>
            </div>
          </div>
        )}

        {/* ── Outcome buttons ── */}
        {!pendingPA && !showOutsBanner && !gameEndBanner && currentBatter && (
          <div style={{ marginBottom: 10 }}>
            {editingPa && (
              <div style={{ background: `${C.blue}18`, border: `1px solid ${C.blue}44`, borderRadius: 8, padding: '7px 12px', marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: C.blue, fontSize: 13 }}>Editing PA #{editingPa.pa_number} — {charactersById[editingPa.character_id]?.name}</span>
                <button onClick={() => setEditingPa(null)} style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer' }}><X size={15} /></button>
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 5, marginBottom: 5 }}>
              {OUTCOME_BUTTONS.filter(b => b.zone === 'green').map(b => (
                <OutcomeBtn key={b.result} result={b.result} zone={b.zone} onClick={handleOutcome} disabled={!canRecordOutcome} />
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 5, marginBottom: 5 }}>
              {OUTCOME_BUTTONS.filter(b => b.zone === 'red').map(b => (
                <OutcomeBtn key={b.result} result={b.result} zone={b.zone} onClick={handleOutcome} disabled={!canRecordOutcome} />
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 5 }}>
              {OUTCOME_BUTTONS.filter(b => b.zone === 'blue').map(b => (
                <OutcomeBtn key={b.result} result={b.result} zone={b.zone} onClick={handleOutcome} disabled={!canRecordOutcome} />
              ))}
            </div>
          </div>
        )}

        {/* ── Undo + End game ── */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <button onClick={undoLastPA} disabled={!gamePAs.length}
            style={{ flex: 1, background: C.card, border: `1px solid ${C.border}`, color: gamePAs.length ? C.text : C.muted, borderRadius: 8, padding: '10px 0', fontWeight: 600, cursor: gamePAs.length ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 13 }}>
            <RotateCcw size={14} /> Undo
          </button>
          <button onClick={() => setShowEndGameConfirm(true)} disabled={selectedGame?.status === 'complete'}
            style={{ flex: 1, background: C.card, border: `1px solid ${C.border}`, color: selectedGame?.status === 'complete' ? C.muted : C.text, borderRadius: 8, padding: '10px 0', fontWeight: 600, cursor: selectedGame?.status === 'complete' ? 'not-allowed' : 'pointer', fontSize: 13 }}>
            End Game
          </button>
        </div>

        {/* ── PA Log ── */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div style={{ color: C.muted, fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }}>PA Log {viewedInning ? `· Inn. ${viewedInning}` : ''}</div>
            {viewedInning && <button onClick={() => setViewedInning(null)} style={{ background: 'none', border: 'none', color: C.accent, fontSize: 12, cursor: 'pointer' }}>Show All</button>}
          </div>
          {displayedPAs.length === 0 && <div style={{ color: C.muted, fontSize: 14, textAlign: 'center', padding: '16px 0' }}>No plate appearances yet.</div>}
          {displayedPAs.map(pa => (
            <div key={pa.id} onClick={() => {
              const batter = gameLineups.find(l => l.character_id === pa.character_id && l.player_id === pa.player_id)
              setEditingPa(pa)
              if (batter) { const idx = currentLineup.findIndex(l => l.id === batter.id); if (idx >= 0) setOverrideBatterIdx(idx) }
            }}
              style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 0', borderBottom: `1px solid ${C.border}22`, cursor: 'pointer' }}>
              <Avatar name={charactersById[pa.character_id]?.name} size={30} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>{charactersById[pa.character_id]?.name}</span>
                <span style={{ color: C.muted, fontSize: 11 }}> · Inn. {pa.inning}</span>
              </div>
              <ResultBadge result={pa.result} />
              {getCreditedRbiForPa(pa) > 0 && <span style={{ color: C.accent, fontSize: 12, fontWeight: 700, minWidth: 36 }}>+{getCreditedRbiForPa(pa)}</span>}
              {pa.run_scored && <span style={{ color: C.green, fontSize: 11, fontWeight: 700 }}>R</span>}
            </div>
          ))}
        </div>
      </div>

      {/* ── Add Game Modal ── */}
      {showAddGame && <AddGameModal players={players} stadiums={stadiums} addGameForm={addGameForm} setAddGameForm={setAddGameForm} onAdd={addGame} onClose={() => setShowAddGame(false)} />}

      {/* ── Scorebook Access Modal ── */}
      {showAccessModal && (
        <div style={{ position: 'fixed', inset: 0, background: '#00000088', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: C.card, borderRadius: 16, padding: 24, width: 340, maxWidth: '90vw', boxShadow: '0 8px 32px #0008' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>Scorebook Access</h3>
              <button onClick={() => setShowAccessModal(false)} style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer', fontSize: 20, lineHeight: 1 }}>×</button>
            </div>
            <p style={{ color: C.muted, fontSize: 12, marginBottom: 16 }}>Grant players the ability to edit the scorebook. Commissioners always have access.</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {players.filter(p => !p.is_commissioner).map(p => (
                <div key={p.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: C.bg, borderRadius: 8, border: `1px solid ${C.border}` }}>
                  <span style={{ fontWeight: 600, color: p.color || C.text }}>{p.name}</span>
                  <button
                    onClick={() => toggleScorebookAccess(p)}
                    style={{ background: p.scorebook_access ? '#22C55E22' : C.card, color: p.scorebook_access ? '#22C55E' : C.muted, border: `1px solid ${p.scorebook_access ? '#22C55E' : C.border}`, borderRadius: 20, padding: '4px 14px', cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>
                    {p.scorebook_access ? 'Editor ✓' : 'Viewer'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── End Game Confirmation Modal ── */}
      {showEndGameConfirm && (
        <EndGameConfirmModal
          scores={scores}
          teamAName={teamAName}
          teamBName={teamBName}
          teamAColor={teamAColor}
          teamBColor={teamBColor}
          onConfirm={() => { setShowEndGameConfirm(false); markGameComplete() }}
          onClose={() => setShowEndGameConfirm(false)}
        />
      )}

      {/* ── Batter Stats Modal ── */}
    </div>
  )
}

// ─── Add Game Modal (shared) ──────────────────────────────────────────────────
function AddGameModal({ players, stadiums, addGameForm, setAddGameForm, onAdd, onClose }) {
  const orderedStadiums = useMemo(() => getOrderedStadiums(stadiums), [stadiums])
  const selectedStadium = orderedStadiums.find((stadium) => String(stadium.id) === String(addGameForm.stadiumId)) || orderedStadiums[0] || null

  const setStadium = (stadium) => {
    setAddGameForm((current) => ({
      ...current,
      stadiumId: stadium.id,
      isNight: normalizeIsNightForStadium(stadium, current.isNight),
    }))
  }

  const toggleTime = () => {
    if (!selectedStadium || stadiumTimeToggleDisabled(selectedStadium)) return
    setAddGameForm((current) => ({
      ...current,
      isNight: !normalizeIsNightForStadium(selectedStadium, current.isNight),
    }))
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: C.card, borderRadius: 16, padding: 24, width: '100%', maxWidth: 960, maxHeight: '92vh', overflowY: 'auto', border: `1px solid ${C.border}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div style={{ fontWeight: 800, fontSize: 18 }}>Add Game</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer' }}><X size={20} /></button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14, marginBottom: 20 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ color: C.muted, fontSize: 12, fontWeight: 700, textTransform: 'uppercase' }}>Stage / Round</span>
            <input type="text" placeholder="e.g. Winners Final" value={addGameForm.stage}
              onChange={e => setAddGameForm(cur => ({ ...cur, stage: e.target.value }))}
              style={{ background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 12px', fontSize: 14 }} />
          </label>
          {[{ label: 'Team A', key: 'teamA' }, { label: 'Team B', key: 'teamB' }].map(f => (
            <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ color: C.muted, fontSize: 12, fontWeight: 700, textTransform: 'uppercase' }}>{f.label}</span>
              <select value={addGameForm[f.key]} onChange={e => setAddGameForm(cur => ({ ...cur, [f.key]: e.target.value }))}
                style={{ background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 12px', fontSize: 14 }}>
                <option value="">Select player</option>
                {players.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          ))}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ color: C.muted, fontSize: 12, fontWeight: 700, textTransform: 'uppercase' }}>Stadium</div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>{selectedStadium?.name || 'Select a stadium'}</div>
          </div>
          <button
            onClick={toggleTime}
            disabled={!selectedStadium || stadiumTimeToggleDisabled(selectedStadium)}
            type="button"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              borderRadius: 999,
              border: `1px solid ${C.border}`,
              background: selectedStadium && normalizeIsNightForStadium(selectedStadium, addGameForm.isNight) ? 'rgba(59,130,246,0.18)' : 'rgba(234,179,8,0.16)',
              color: C.text,
              padding: '10px 14px',
              cursor: !selectedStadium || stadiumTimeToggleDisabled(selectedStadium) ? 'not-allowed' : 'pointer',
              opacity: !selectedStadium || stadiumTimeToggleDisabled(selectedStadium) ? 0.65 : 1,
              fontWeight: 700,
            }}
          >
            {selectedStadium && normalizeIsNightForStadium(selectedStadium, addGameForm.isNight) ? <Moon size={16} /> : <Sun size={16} />}
            {selectedStadium ? getStadiumTimeLabel(selectedStadium, addGameForm.isNight) : 'Day'}
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
          {orderedStadiums.map((stadium) => {
            const active = String(addGameForm.stadiumId) === String(stadium.id)
            const isNight = normalizeIsNightForStadium(stadium, active ? addGameForm.isNight : false)
            return (
              <button
                key={stadium.id}
                onClick={() => setStadium(stadium)}
                type="button"
                style={{
                  textAlign: 'left',
                  padding: 14,
                  borderRadius: 14,
                  border: `1.5px solid ${active ? C.accent : C.border}`,
                  background: active ? 'rgba(234,179,8,0.12)' : C.bg,
                  color: C.text,
                  cursor: 'pointer',
                }}
              >
                <StadiumLogo name={stadium.name} height={52} />
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 10, alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontWeight: 800, fontSize: 15 }}>{stadium.name}</div>
                    <div style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>LF {stadium.lf_distance} / CF {stadium.cf_distance} / RF {stadium.rf_distance}</div>
                  </div>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: C.muted, fontSize: 11, fontWeight: 700 }}>
                    {isNight ? <Moon size={12} /> : <Sun size={12} />}
                    {getStadiumTimeLabel(stadium, isNight)}
                  </div>
                </div>
                <div style={{ color: C.muted, fontSize: 12, marginTop: 8, minHeight: 34 }}>{stadium.description}</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10, gap: 10 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#FBBF24' }}>{getChaosStars(stadium.chaos_level)}</span>
                  <span style={{ color: C.muted, fontSize: 11, fontWeight: 700 }}>
                    {stadium.night_only ? 'Night only' : stadium.day_only ? 'Day only' : 'Day or night'}
                  </span>
                </div>
              </button>
            )
          })}
        </div>

        <button onClick={onAdd} disabled={!selectedStadium} style={{ width: '100%', background: C.accent, color: '#000', border: 'none', borderRadius: 10, padding: '14px 0', fontWeight: 800, fontSize: 16, cursor: selectedStadium ? 'pointer' : 'not-allowed', marginTop: 20, opacity: selectedStadium ? 1 : 0.6 }}>
          Add Game
        </button>
      </div>
    </div>
  )
}

// ─── End Game Confirmation Modal ─────────────────────────────────────────────
function EndGameConfirmModal({ scores, teamAName, teamBName, teamAColor, teamBColor, onConfirm, onClose }) {
  const tied = scores.a === scores.b
  const winner = scores.a > scores.b ? teamAName : scores.b > scores.a ? teamBName : null
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: C.card, borderRadius: 16, padding: 24, width: '100%', maxWidth: 340, border: `1px solid ${C.border}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ fontWeight: 800, fontSize: 18 }}>End Game?</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer' }}><X size={20} /></button>
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 24, marginBottom: 16, fontSize: 22, fontWeight: 900 }}>
          <span style={{ color: teamAColor }}>{teamAName} {scores.a}</span>
          <span style={{ color: C.muted, fontWeight: 400 }}>–</span>
          <span style={{ color: teamBColor }}>{teamBName} {scores.b}</span>
        </div>
        {tied ? (
          <div style={{ color: '#F97316', fontWeight: 700, textAlign: 'center', marginBottom: 16, fontSize: 14 }}>
            ⚠ Game is tied — ending will record no winner.
          </div>
        ) : (
          <div style={{ color: C.muted, textAlign: 'center', marginBottom: 16, fontSize: 14 }}>
            <span style={{ color: winner === teamAName ? teamAColor : teamBColor, fontWeight: 700 }}>{winner}</span> wins.
          </div>
        )}
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onConfirm} style={{ flex: 1, background: C.green, color: '#000', border: 'none', borderRadius: 10, padding: '13px 0', fontWeight: 800, fontSize: 15, cursor: 'pointer' }}>
            Confirm End
          </button>
          <button onClick={onClose} style={{ flex: 1, background: 'none', color: C.muted, border: `1px solid ${C.border}`, borderRadius: 10, padding: '13px 0', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Batter Stats Modal ───────────────────────────────────────────────────────
function BatterStatsModal({ characterId, plateAppearances, games, tournamentGameIds, charactersById, playersById, identitiesByPlayerId, selectedGame, onClose }) {
  const char = charactersById[characterId]
  if (!char) return null

  const allCharPAs  = plateAppearances.filter(pa => pa.character_id === characterId)
  const tournPAs    = allCharPAs.filter(pa => tournamentGameIds.has(String(pa.game_id)))
  const gamePAs     = allCharPAs.filter(pa => String(pa.game_id) === String(selectedGame?.id))

  const toStats = (pas) => summarizeBatting(pas)
  const fmtAvg  = (s) => s.atBats ? s.avg.toFixed(3).replace('0.', '.') : '—'
  const fmtOps  = (s) => s.atBats ? (s.obp + s.slg).toFixed(3) : '—'

  const StatRow = ({ label, s }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: `1px solid ${C.border}22` }}>
      <div style={{ color: C.muted, fontSize: 12, fontWeight: 700, textTransform: 'uppercase', minWidth: 80 }}>{label}</div>
      <div style={{ display: 'flex', gap: 14 }}>
        {[
          { l: 'PA',  v: s.plateAppearances },
          { l: 'AVG', v: fmtAvg(s) },
          { l: 'OPS', v: fmtOps(s) },
          { l: 'HR',  v: s.homeRuns },
          { l: 'RBI', v: s.rbi },
        ].map(({ l, v }) => (
          <div key={l} style={{ textAlign: 'center', minWidth: 28 }}>
            <div style={{ fontSize: 14, fontWeight: 800 }}>{v}</div>
            <div style={{ color: C.muted, fontSize: 9, textTransform: 'uppercase' }}>{l}</div>
          </div>
        ))}
      </div>
    </div>
  )

  const HIT_RESULTS_SET = new Set(['1B', '2B', '3B', 'HR'])

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
      onClick={onClose}>
      <div style={{ background: C.card, borderRadius: '20px 20px 0 0', width: '100%', maxWidth: 480, maxHeight: '85vh', overflowY: 'auto', border: `1px solid ${C.border}`, paddingBottom: 32 }}
        onClick={e => e.stopPropagation()}>

        {/* Handle bar */}
        <div style={{ width: 36, height: 4, background: C.border, borderRadius: 2, margin: '12px auto 0' }} />

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 20px 12px' }}>
          <div style={{ width: 64, height: 64, borderRadius: '50%', overflow: 'hidden', border: `2px solid ${C.accent}`, flexShrink: 0 }}>
            <Avatar name={char.name} size={64} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 20 }}>{char.name}</div>
            <div style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>
              {selectedGame ? (
                <PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} playerId={selectedGame.team_a_player_id} playersById={playersById} />
              ) : null}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer', padding: 8 }}>
            <X size={20} />
          </button>
        </div>

        <div style={{ padding: '0 20px' }}>
          {/* Stats rows */}
          <StatRow label="This Game"  s={toStats(gamePAs)} />
          <StatRow label="Tournament" s={toStats(tournPAs)} />
          <StatRow label="Career"     s={toStats(allCharPAs)} />

          {/* This game PA list */}
          {gamePAs.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div style={{ color: C.muted, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', marginBottom: 8, letterSpacing: '.04em' }}>This Game</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {gamePAs.map((pa, i) => {
                  const color = HIT_RESULTS_SET.has(pa.result) ? C.green : pa.result === 'BB' || pa.result === 'HBP' ? C.blue : C.red
                  return (
                    <div key={pa.id} style={{ background: `${color}22`, color, border: `1px solid ${color}55`, borderRadius: 6, padding: '4px 10px', fontSize: 13, fontWeight: 700 }}>
                      {pa.result}{getCreditedRbiForPa(pa) > 0 ? ` +${getCreditedRbiForPa(pa)}` : ''}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
