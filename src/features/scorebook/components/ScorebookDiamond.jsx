import { Avatar } from './ScorebookPrimitives'
import { C } from './theme'

export default function ScorebookDiamond({
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
  hideOutsRow = false,
  onRemoveRunner,
}) {
  const bases = [
    { key: 'second', label: '2B', left: '50%', top: '10%' },
    { key: 'first',  label: '1B', left: '86%', top: '42%' },
    { key: 'third',  label: '3B', left: '14%', top: '42%' },
  ]
  const committedOuts = Math.min(outs, 3)
  const pendingOuts = Math.max(0, Math.min(previewOuts, 3 - committedOuts))
  const overflowOuts = Math.max(0, outs + previewOuts - 3)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <div style={{ position: 'relative', width: '100%', maxWidth: '340px', aspectRatio: '1.12 / 1', margin: '0 auto' }}>
        <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">
          <polygon points="50,10 86,42 50,82 14,42" fill="rgba(148,163,184,0.05)" stroke={C.border} strokeWidth="1.8" />
          <line x1="50" y1="10" x2="50" y2="82" stroke="rgba(148,163,184,0.22)" strokeWidth="1.2" />
          <line x1="14" y1="42" x2="86" y2="42" stroke="rgba(148,163,184,0.16)" strokeWidth="1.2" />
        </svg>

        {bases.map(b => {
          const runner = runners[b.key]
          const showRemove = Boolean(isScorekeeper && runner)
          return (
            <div key={b.key} style={{ position: 'absolute', left: b.left, top: b.top, transform: 'translate(-50%,-50%)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
              {runner ? (
                <div style={{ position: 'relative', width: 44, height: 44 }}>
                  <div style={{ width: 44, height: 44, borderRadius: '50%', overflow: 'hidden', border: `2px solid ${C.accent}`, flexShrink: 0 }}>
                    <Avatar name={charactersById[runner.characterId]?.name} size={44} />
                  </div>
                  {showRemove && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        onRemoveRunner?.(b.key)
                      }}
                      style={{
                        position: 'absolute',
                        top: -6,
                        right: -6,
                        width: 18,
                        height: 18,
                        borderRadius: '50%',
                        border: `1px solid ${C.red}`,
                        background: `${C.red}EE`,
                        color: '#fff',
                        fontSize: 11,
                        fontWeight: 900,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
                      }}
                      aria-label={`Remove runner from ${b.label}`}
                      title={`Remove runner from ${b.label}`}
                    >
                      ×
                    </button>
                  )}
                </div>
              ) : (
                <div style={{ width: 18, height: 18, background: C.border, transform: 'rotate(45deg)', borderRadius: 2 }} />
              )}
            </div>
          )
        })}

        <div style={{ position: 'absolute', left: '50%', top: '82%', transform: 'translate(-50%,-50%)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 18, height: 18, background: C.card, border: `2px solid ${previewHomeRunners.length ? C.accent : C.border}`, transform: 'rotate(45deg)', borderRadius: 2 }} />
            {previewHomeRunners.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {previewHomeRunners.slice(0, 3).map((assignment, index) => (
                  <div
                    key={assignment.id}
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: '50%',
                      overflow: 'hidden',
                      border: `2px solid ${C.accent}`,
                      marginLeft: index === 0 ? 0 : -7,
                      background: C.card,
                      boxShadow: '0 0 0 2px rgba(15, 23, 42, 0.9)',
                    }}
                  >
                    <Avatar name={charactersById[assignment.runner.characterId]?.name} size={28} />
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

        <div
          onDragOver={isScorekeeper ? onMoundDragOver : undefined}
          onDragLeave={isScorekeeper ? onMoundDragLeave : undefined}
          onDrop={isScorekeeper ? onMoundDrop : undefined}
          onClick={isScorekeeper && selectedPitcher ? onMoundClick : undefined}
          style={{ position: 'absolute', left: '50%', top: '46%', transform: 'translate(-50%,-50%)', cursor: selectedPitcher ? 'pointer' : 'default' }}
        >
          <div style={{ width: 60, height: 60, borderRadius: '50%', border: `2px ${isDragOver || selectedPitcher ? 'solid' : 'dashed'} ${isDragOver ? C.accent : selectedPitcher ? '#A78BFA' : C.border}`, background: isDragOver ? `${C.accent}20` : selectedPitcher ? '#A78BFA20' : `${C.bg}cc`, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', transition: 'all 0.15s' }}>
            {pitcherChar
              ? <Avatar name={pitcherChar.name} size={56} />
              : <span style={{ fontSize: 22 }}>⚾</span>}
          </div>
        </div>
        {selectedPitcher && isScorekeeper && (
          <div style={{ position: 'absolute', left: '50%', top: '62%', transform: 'translateX(-50%)', fontSize: 9, color: '#A78BFA', fontWeight: 800, textAlign: 'center', maxWidth: 72 }}>tap to confirm</div>
        )}
        {!selectedPitcher && pitcherChar && (
          <div style={{ position: 'absolute', left: '50%', top: '62%', transform: 'translateX(-50%)', fontSize: 9, color: C.muted, fontWeight: 700, textAlign: 'center', maxWidth: 72, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {pitcherChar.name.split(' ')[0]}
          </div>
        )}
        {!selectedPitcher && !pitcherChar && isScorekeeper && (
          <div style={{ position: 'absolute', left: '50%', top: '62%', transform: 'translateX(-50%)', fontSize: 9, color: C.border, textAlign: 'center', maxWidth: 72 }}>drag / tap pitcher</div>
        )}
      </div>

      {!hideOutsRow && (
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
      )}
    </div>
  )
}
