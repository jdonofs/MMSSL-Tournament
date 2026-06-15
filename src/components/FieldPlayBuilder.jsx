import { useRef } from 'react'
import CharacterPortrait from './CharacterPortrait'
import { POSITION_GROUP_COLORS } from './RosterLineupWidgets'

const FIELD_POSITIONS = [
  { position: 8, label: 'CF', left: '50%', top: '27%', group: 'outfield' },
  { position: 7, label: 'LF', left: '22%', top: '38%', group: 'outfield' },
  { position: 9, label: 'RF', left: '78%', top: '38%', group: 'outfield' },
  { position: 6, label: 'SS', left: '38%', top: '48%', group: 'infield' },
  { position: 4, label: '2B', left: '62%', top: '48%', group: 'infield' },
  { position: 5, label: '3B', left: '34%', top: '64%', group: 'infield' },
  { position: 1, label: 'P',  left: '50%', top: '68%', group: 'battery' },
  { position: 3, label: '1B', left: '66%', top: '64%', group: 'infield' },
  { position: 2, label: 'C',  left: '50%', top: '85%', group: 'battery' },
]

// Tap the field once to drop a landing-spot marker, then tap fielders in the
// order they touched the ball. Tapping a selected fielder again removes them —
// this lets a single diagram capture "where it landed" + "who's credited" + the
// play sequence (e.g. 6-3) without separate screens.
export default function FieldPlayBuilder({
  fieldersByPosition = {},
  fielderChain = [],
  landingSpot = null,
  onFieldTap,
  onToggleFielder,
  notation = '',
  accent = '#EAB308',
  label = 'Build The Play',
  allowedPositions = null,
  allowFielderSelection = true,
}) {
  const containerRef = useRef(null)
  const allowedSet = allowedPositions ? new Set(allowedPositions.map((position) => String(position))) : null

  const handleFieldClick = (event) => {
    if (!containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const x = Math.min(100, Math.max(0, ((event.clientX - rect.left) / rect.width) * 100))
    const y = Math.min(100, Math.max(0, ((event.clientY - rect.top) / rect.height) * 100))
    onFieldTap?.({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 })
  }

  return (
    <div>
      {(label || notation) ? (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 8 }}>
          {label ? <div style={{ fontSize: 12, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase' }}>{label}</div> : <span />}
          {notation ? (
            <div style={{ fontSize: 16, fontWeight: 800, color: accent, letterSpacing: '.04em' }}>{notation}</div>
          ) : null}
        </div>
      ) : null}
      <div
        ref={containerRef}
        onClick={handleFieldClick}
        role="button"
        tabIndex={0}
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: 320,
          margin: '0 auto',
          aspectRatio: '1/1.02',
          borderRadius: 18,
          border: '1.5px solid rgba(148,163,184,0.35)',
          cursor: 'crosshair',
          overflow: 'hidden',
        }}
      >
        <img src="/baseball-field.jpg" alt="Baseball field" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }} />
        {landingSpot ? (
          <div
            style={{
              position: 'absolute',
              left: `${landingSpot.x}%`,
              top: `${landingSpot.y}%`,
              width: 14,
              height: 14,
              borderRadius: '50%',
              background: `${accent}33`,
              border: `2px solid ${accent}`,
              transform: 'translate(-50%, -50%)',
              pointerEvents: 'none',
              boxShadow: `0 0 0 3px ${accent}1A`,
            }}
          />
        ) : null}
        {FIELD_POSITIONS.map((slot) => {
          const fielder = fieldersByPosition[String(slot.position)] || null
          const chainIndex = fielderChain.indexOf(String(slot.position))
          const selected = chainIndex !== -1
          const disabled = !allowFielderSelection || (allowedSet ? !allowedSet.has(String(slot.position)) : false)
          return (
            <button
              key={slot.position}
              type="button"
              disabled={disabled}
              onClick={(event) => {
                event.stopPropagation()
                if (disabled) return
                onToggleFielder?.(String(slot.position))
              }}
              style={{
                position: 'absolute',
                left: slot.left,
                top: slot.top,
                transform: 'translate(-50%, -50%)',
                width: 42,
                height: 42,
                borderRadius: '50%',
                border: selected ? `2px solid ${accent}` : '2px solid transparent',
                background: selected ? `${accent}33` : 'transparent',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.4 : 1,
                padding: 0,
              }}
            >
              <div
                style={{
                  position: 'relative',
                  width: 26,
                  height: 26,
                  borderRadius: '50%',
                  boxShadow: `0 4px 10px #00000040, 0 0 0 2px ${selected ? accent : POSITION_GROUP_COLORS[slot.group]}`,
                  background: '#0F172A',
                }}
              >
                <CharacterPortrait name={fielder?.character} size={26} />
                {selected ? (
                  <span
                    style={{
                      position: 'absolute',
                      top: -5,
                      right: -5,
                      minWidth: 14,
                      height: 14,
                      padding: '0 2px',
                      borderRadius: 999,
                      background: accent,
                      color: '#0F172A',
                      border: '1px solid rgba(15,23,42,0.4)',
                      fontSize: 9,
                      fontWeight: 800,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {chainIndex + 1}
                  </span>
                ) : null}
              </div>
              <div style={{ fontSize: 7.5, fontWeight: 800, color: selected ? accent : disabled ? '#475569' : '#F8FAFC', marginTop: 1, textShadow: '0 1px 2px rgba(0,0,0,0.7)' }}>
                {slot.label}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
