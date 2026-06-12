import { useCallback } from 'react'
import { ArrowRightLeft } from 'lucide-react'
import CharacterPortrait from './CharacterPortrait'
import StatIcon from './StatIcon'
import { CHEMISTRY_NOTE_SRC } from '../utils/chemistryHighlights'

// ─── Character portrait with chemistry/highlight overlays ─────────────────────
export function Portrait({ name, size = 36, style = {}, showChemistryNote = false, highlighted = false }) {
  const shadowLayers = []
  if (highlighted) {
    shadowLayers.push('0 0 0 3px #FACC15', '0 0 0 6px rgba(250,204,21,0.25)')
  }
  if (style.boxShadow) shadowLayers.push(style.boxShadow)
  const portraitStyle = shadowLayers.length ? { ...style, boxShadow: shadowLayers.join(', ') } : style

  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <CharacterPortrait name={name} size={size} draggable={false} style={portraitStyle} />
      {showChemistryNote ? (
        <img
          src={CHEMISTRY_NOTE_SRC}
          alt=""
          aria-hidden="true"
          style={{ position: 'absolute', right: -5, bottom: -5, width: size * 0.34, height: size * 0.34, objectFit: 'contain', pointerEvents: 'none' }}
        />
      ) : null}
    </div>
  )
}

// ─── Draggable roster item — used for lineup ordering ──────────────────────────
export function DraggableRosterItem({
  character,
  onDragStart,
  rosterNames,
  onOpenCard,
  onTrade,
  showChemistryNote = false,
  highlighted = false,
  showTrade = false,
  disabled = false,
  selected = false,
  compact = false,
  lineupNumber = null,
  onLineupNumberClick,
  lineupNumberSelected = false,
  lineupNumberTitle,
  lineupNumberAriaLabel,
  lineupNumberDisabled = false,
  positionLabel = null,
}) {
  const positionGroup = positionLabel ? (FIELD_POSITIONS_BY_ID[positionLabel]?.group || 'bench') : null
  const badgeLabel = positionLabel ? FIELD_POSITIONS_BY_ID[positionLabel]?.label || 'Bench' : 'Bench'
  const badgeColor = POSITION_GROUP_COLORS[positionGroup || 'bench']
  return (
    <div
      draggable={!disabled}
      onDragStart={disabled ? undefined : onDragStart}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: compact ? 10 : 12,
        padding: compact ? '10px 14px' : '14px 16px',
        minHeight: compact ? 64 : 80,
        background: selected ? '#FACC1533' : '#1E293B',
        borderRadius: 12,
        border: `1px solid ${selected ? '#FACC15' : '#334155'}`,
        transition: 'background 0.15s ease, border-color 0.15s ease',
      }}
    >
      {lineupNumber !== null ? (
        <button
          type="button"
          onClick={(event) => { event.stopPropagation(); onLineupNumberClick?.(event) }}
          disabled={lineupNumberDisabled}
          aria-label={lineupNumberAriaLabel}
          title={lineupNumberTitle}
          style={{
            width: compact ? 26 : 32,
            height: compact ? 26 : 32,
            borderRadius: '50%',
            border: `2px solid ${lineupNumberSelected ? '#FACC15' : '#DBEAFE'}`,
            background: lineupNumberSelected ? '#FACC15' : '#DBEAFE',
            color: '#0F172A',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: compact ? 10 : 11,
            fontWeight: 900,
            cursor: lineupNumberDisabled ? 'default' : 'pointer',
            flexShrink: 0,
            padding: 0,
          }}
        >
          {lineupNumber}
        </button>
      ) : null}
      <button type="button" onClick={(event) => { event.stopPropagation(); onOpenCard?.() }} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
        <Portrait name={character.name} size={compact ? 36 : 48} showChemistryNote={showChemistryNote} highlighted={highlighted} />
      </button>
      <button type="button" onClick={(event) => { event.stopPropagation(); onOpenCard?.() }} style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', color: '#E2E8F0', padding: 0, cursor: 'pointer' }}>
        <div style={{ fontWeight: 700, fontSize: compact ? 13 : 15, lineHeight: 1.2, whiteSpace: 'normal', overflowWrap: 'break-word' }}>{character.displayName || character.name}</div>
      </button>
      {lineupNumber !== null ? (
        <div className="roster-item-stats" style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          {[
            { stat: 'batting', value: character.batting },
            { stat: 'pitching', value: character.pitching },
            { stat: 'fielding', value: character.fielding },
            { stat: 'speed', value: character.speed },
          ].map(({ stat, value }) => (
            <div key={stat} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <StatIcon stat={stat} size={12} />
              <span style={{ fontSize: 11, fontWeight: 700, color: '#CBD5E1' }}>{value}</span>
            </div>
          ))}
        </div>
      ) : null}
      {lineupNumber !== null ? (
        <span
          className="roster-item-badge"
          style={{
            flexShrink: 0,
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: '.04em',
            textTransform: 'uppercase',
            color: positionGroup ? '#0F172A' : '#CBD5E1',
            background: badgeColor + (positionGroup ? '' : '33'),
            border: positionGroup ? 'none' : `1px solid ${badgeColor}66`,
            borderRadius: 999,
            padding: '4px 10px',
          }}
        >
          {badgeLabel}
        </span>
      ) : null}
      {showTrade ? (
        <button className="ghost-button" onClick={(event) => { event.stopPropagation(); onTrade?.() }} type="button" disabled={disabled} aria-label="Trade player" title="Trade player" style={{ minWidth: 42, minHeight: 42, padding: 0, justifyContent: 'center' }}>
          <ArrowRightLeft size={15} />
        </button>
      ) : null}
    </div>
  )
}

// ─── Baseball field positions ──────────────────────────────────────────────────
export const POSITION_GROUP_COLORS = {
  battery: '#FACC15',
  infield: '#60A5FA',
  outfield: '#4ADE80',
  bench: '#64748B',
}

export const FIELD_POSITIONS = [
  { id: 'pitcher', label: 'P', x: 50, y: 68, group: 'battery' },
  { id: 'catcher', label: 'C', x: 50, y: 85, group: 'battery' },
  { id: 'firstBase', label: '1B', x: 66, y: 64, group: 'infield' },
  { id: 'secondBase', label: '2B', x: 62, y: 48, group: 'infield' },
  { id: 'thirdBase', label: '3B', x: 34, y: 64, group: 'infield' },
  { id: 'shortStop', label: 'SS', x: 38, y: 48, group: 'infield' },
  { id: 'leftField', label: 'LF', x: 22, y: 38, group: 'outfield' },
  { id: 'centerField', label: 'CF', x: 50, y: 27, group: 'outfield' },
  { id: 'rightField', label: 'RF', x: 78, y: 38, group: 'outfield' },
]

export const FIELD_POSITIONS_BY_ID = Object.fromEntries(FIELD_POSITIONS.map((p) => [p.id, p]))

// Maps the numeric scorebook fielding positions (1-9) to FIELD_POSITIONS ids.
export const SCOREBOOK_POSITION_TO_FIELD_ID = {
  1: 'pitcher',
  2: 'catcher',
  3: 'firstBase',
  4: 'secondBase',
  5: 'thirdBase',
  6: 'shortStop',
  7: 'leftField',
  8: 'centerField',
  9: 'rightField',
}

export const FIELD_ID_TO_SCOREBOOK_POSITION = Object.fromEntries(
  Object.entries(SCOREBOOK_POSITION_TO_FIELD_ID).map(([num, id]) => [id, Number(num)]),
)

export function FieldingView({
  charactersById,
  fieldingPositions,
  setFieldingPositions,
  selectedPlayer,
  setSelectedPlayer,
  fieldingAssignMode,
  selectedForFielding,
  onAssignPosition,
  editable = true,
  chemistryHighlightIds,
}) {
  const assignCharToPos = useCallback((posId, characterId) => {
    if (!editable) return
    setFieldingPositions((current) => {
      const next = { ...current }
      const targetCharId = next[posId]
      if (targetCharId && targetCharId !== characterId) {
        const sourcePos = Object.entries(next).find(([, value]) => value === characterId)?.[0]
        if (sourcePos) next[sourcePos] = targetCharId
        next[posId] = characterId
      } else {
        next[posId] = characterId
        Object.keys(next).forEach((key) => {
          if (key !== posId && next[key] === characterId) delete next[key]
        })
      }
      return next
    })
  }, [editable, setFieldingPositions])

  const handlePositionClick = (posId) => {
    if (fieldingAssignMode && selectedForFielding) {
      assignCharToPos(posId, selectedForFielding)
      onAssignPosition()
      return
    }
    const charId = fieldingPositions[posId]
    if (selectedPlayer) {
      if (selectedPlayer === charId) {
        setSelectedPlayer(null)
        return
      }
      assignCharToPos(posId, selectedPlayer)
      setSelectedPlayer(null)
      return
    }
    if (charId) {
      setSelectedPlayer((current) => (current === charId ? null : charId))
    }
  }

  return (
    <div style={{ background: '#0F172A', border: '1px solid #1E293B', borderRadius: 14, padding: 16, display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4, flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ fontSize: 14, fontWeight: 800, color: '#EFF6FF', letterSpacing: '.04em', textTransform: 'uppercase', margin: 0 }}>Fielding Positions</h3>
        <div style={{ fontSize: 11, fontWeight: 700, color: fieldingAssignMode ? '#A78BFA' : '#DBEAFE', background: '#0F172A55', padding: '4px 8px', borderRadius: 999 }}>
          {editable ? (fieldingAssignMode ? (selectedForFielding ? 'Tap position to place' : 'Tap roster player first') : (selectedPlayer ? 'Tap position to move selected player' : 'Tap player, then tap position to swap')) : 'View only'}
        </div>
      </div>
      <div style={{ position: 'relative', width: '100%', maxWidth: 460, aspectRatio: '1/1.02', borderRadius: 26, margin: '0 auto', overflow: 'hidden', boxShadow: '0 8px 24px #00000040', border: '1px solid #1E293B' }}>
        <img src="/baseball-field.jpg" alt="Baseball field" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
        {FIELD_POSITIONS.map((pos) => {
          const charId = fieldingPositions[pos.id]
          const character = charId ? charactersById[charId] : null
          const groupColor = POSITION_GROUP_COLORS[pos.group]
          return (
            <div
              key={pos.id}
              onClick={() => handlePositionClick(pos.id)}
              style={{ position: 'absolute', left: `${pos.x}%`, top: `${pos.y}%`, transform: 'translate(-50%, -50%)', width: 90, height: 90, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: character ? 'pointer' : 'default' }}
            >
              {character ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                  <Portrait
                    name={character.name}
                    size={52}
                    showChemistryNote={chemistryHighlightIds.has(charId)}
                    highlighted={selectedPlayer === charId}
                    style={{ boxShadow: `0 6px 14px #00000040, 0 0 0 2px ${groupColor}`, background: 'transparent', borderRadius: '50%' }}
                  />
                  <div style={{ fontSize: 10, fontWeight: 800, color: '#0F172A', background: groupColor, padding: '2px 6px', borderRadius: 999 }}>{pos.label}</div>
                </div>
              ) : (
                <div style={{ width: 48, height: 48, borderRadius: '50%', background: '#0F172A66', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, color: '#E2E8F0', border: `2px dashed ${groupColor}99` }}>{pos.label}</div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
