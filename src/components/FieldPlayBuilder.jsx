import { useRef } from 'react'
import CharacterPortrait from './CharacterPortrait'

const FIELD_POSITIONS = [
  { position: 8, label: 'CF', left: '50%', top: '14%' },
  { position: 7, label: 'LF', left: '20%', top: '32%' },
  { position: 9, label: 'RF', left: '80%', top: '32%' },
  { position: 6, label: 'SS', left: '38%', top: '52%' },
  { position: 4, label: '2B', left: '62%', top: '52%' },
  { position: 5, label: '3B', left: '25%', top: '68%' },
  { position: 1, label: 'P',  left: '50%', top: '62%' },
  { position: 3, label: '1B', left: '75%', top: '68%' },
  { position: 2, label: 'C',  left: '50%', top: '85%' },
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
          aspectRatio: '25 / 18',
          borderRadius: 18,
          border: '1.5px solid rgba(148,163,184,0.35)',
          background: 'rgba(15,23,42,0.82)',
          cursor: 'crosshair',
          overflow: 'hidden',
        }}
      >
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
                border: `2px solid ${selected ? accent : disabled ? 'rgba(71,85,105,0.4)' : 'rgba(148,163,184,0.4)'}`,
                background: selected ? `${accent}33` : disabled ? 'rgba(15,23,42,0.45)' : 'rgba(15,23,42,0.92)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.4 : 1,
                padding: 0,
              }}
            >
              <div style={{ position: 'relative', width: 22, height: 22 }}>
                <CharacterPortrait name={fielder?.character} size={22} />
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
              <div style={{ fontSize: 7.5, fontWeight: 700, color: selected ? accent : disabled ? '#475569' : '#CBD5E1', marginTop: 1 }}>
                {slot.label}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
