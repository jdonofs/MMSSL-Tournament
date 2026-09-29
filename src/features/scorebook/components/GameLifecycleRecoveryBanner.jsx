import { C } from './theme'

// What completing or reopening this game still owes, worked out from the
// database rather than from what this page remembers, with the one control
// that finishes it. It stays until the audit finds nothing left, so a reload,
// a realtime status change or another device finishing the game does not hide
// it while work is outstanding.
export default function GameLifecycleRecoveryBanner({ recovery }) {
  const audit = recovery?.audit
  if (!audit) return null
  const owed = audit.owed || []
  if (!owed.length && !audit.error) return null

  const isReopen = audit.kind === 'reopen'
  const actionLabel = isReopen ? 'Finish reopening' : 'Finish completion steps'
  const running = Boolean(recovery.running)

  return (
    <div
      role="alert"
      data-testid="game-lifecycle-recovery"
      data-lifecycle-kind={audit.kind || 'unknown'}
      style={{ margin: '10px 10px 0', padding: '12px 14px', borderRadius: 10, border: `1px solid ${C.accent}66`, background: `${C.accent}14`, color: C.text, display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
    >
      <div style={{ fontSize: 13, lineHeight: 1.5, minWidth: 0, flex: '1 1 280px' }}>
        {audit.error ? (
          <>
            <div style={{ fontWeight: 800 }}>Could not check this game&apos;s follow-up steps</div>
            <div style={{ color: C.muted }}>{audit.error.message}</div>
          </>
        ) : (
          <>
            <div style={{ fontWeight: 800 }}>
              {isReopen
                ? 'This game was reopened, but its rollback is not finished.'
                : 'This game is final, but its follow-up steps are not finished.'}
            </div>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18, color: C.muted }}>
              {owed.map((step) => (
                <li key={step.key} data-testid="game-lifecycle-owed-step">
                  <span style={{ color: C.text }}>{step.label}</span>
                  {step.owed ? ' — not done yet' : `: ${step.message}`}
                </li>
              ))}
            </ul>
            <div style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>
              Safe to repeat: steps that already finished are left alone.
            </div>
          </>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {!audit.error && (
          <button type="button" className="solid-button" disabled={running} onClick={() => recovery.finish()}>
            {running ? 'Working…' : actionLabel}
          </button>
        )}
        <button type="button" className="ghost-button" disabled={running} onClick={() => recovery.recheck()}>
          Check again
        </button>
      </div>
    </div>
  )
}
