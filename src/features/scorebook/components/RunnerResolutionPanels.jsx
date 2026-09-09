import { X } from 'lucide-react'

import {
  derivePendingResult,
  getPreviewRbiFromAssignments,
  isTrivialPendingResolution,
} from '../../../utils/runnerAssignment'
import { Avatar, ResultBadge } from './ScorebookPrimitives'
import { C } from './theme'

function RunnerChip({ slot, label, onToggle, charactersById }) {
  if (!slot) return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
      <div style={{ width: 34, height: 34, borderRadius: '50%', border: `2px dashed ${C.border}` }} />
      <div style={{ fontSize: 8, color: C.border, fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 8, color: C.border }}>empty</div>
    </div>
  )

  const isOut = slot.status === 'out'
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

export function RunnerResolutionPanel({ pendingPA, onToggleBase, onToggleScored, onConfirm, onCancel, charactersById }) {
  const { result, first, second, third, scored } = pendingPA
  const rbi = scored.filter(s => s.status === 'scored').length

  return (
    <div style={{ background: `${C.accent}10`, border: `1px solid ${C.accent}44`, borderRadius: 12, padding: '12px 10px 10px', marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ResultBadge result={result} />
          <span style={{ fontSize: 12, color: C.muted, fontWeight: 600 }}>Tap to toggle scored / out</span>
        </div>
        <button onClick={onCancel} type="button" style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer', padding: 2 }}>
          <X size={16} />
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginBottom: 10 }}>
        <RunnerChip slot={third} label="3B" onToggle={() => onToggleBase('third')} charactersById={charactersById} />
        <RunnerChip slot={second} label="2B" onToggle={() => onToggleBase('second')} charactersById={charactersById} />
        <RunnerChip slot={first} label="1B" onToggle={() => onToggleBase('first')} charactersById={charactersById} />
      </div>

      {scored.length > 0 && (
        <div>
          <div style={{ fontSize: 9, color: C.muted, fontWeight: 700, textTransform: 'uppercase', marginBottom: 6, textAlign: 'center', letterSpacing: '.04em' }}>
            🏠 Home Plate
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
            {scored.map((scoredRunner, index) => (
              <RunnerChip key={index} slot={scoredRunner} label="HOME" onToggle={() => onToggleScored(index)} charactersById={charactersById} />
            ))}
          </div>
        </div>
      )}

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

function RunnerAssignmentChip({ assignment, onSetDestination, charactersById, readOnly = false }) {
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
      {readOnly ? null : (
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
      )}
    </div>
  )
}

export function RunnerAssignmentsPanel({ pendingPA, onSetDestination, onConfirm, onCancel, charactersById }) {
  const { assignments } = pendingPA
  const displayResult = derivePendingResult(pendingPA)
  const rbi = getPreviewRbiFromAssignments(displayResult, assignments)
  const isTrivial = isTrivialPendingResolution(pendingPA)

  return (
    <div style={{ background: `${C.accent}10`, border: `1px solid ${C.accent}44`, borderRadius: 12, padding: '12px 10px 10px', marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ResultBadge result={displayResult} />
          <span style={{ fontSize: 12, color: C.muted, fontWeight: 600 }}>
            {isTrivial ? 'Set where the runner ended up' : 'Assign each runner to a base, home, or out'}
          </span>
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
