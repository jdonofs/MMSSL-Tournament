import { useState } from 'react'

const COLORS = {
  overlay: 'rgba(2, 6, 23, 0.72)',
  card: '#1E293B', border: '#334155',
  green: '#22C55E', red: '#EF4444', blue: '#3B82F6',
  text: '#FFFFFF', muted: '#94A3B8',
}

// Renders a Save / Discard / Cancel modal while `blocker.state === 'blocked'`
// (i.e. the user tried to navigate away with unsaved lineup/fielding changes).
// Pair with useUnsavedChangesGuard.
export default function UnsavedChangesPrompt({ blocker, onSave, onDiscard, message = 'You have unsaved lineup/fielding changes. Save them before leaving, or discard them?' }) {
  const [saving, setSaving] = useState(false)

  if (!blocker || blocker.state !== 'blocked') return null

  const handleSaveAndLeave = async () => {
    setSaving(true)
    try {
      await onSave()
      blocker.proceed()
    } catch {
      // The editor reports the save error. Keep the dialog and edits in place
      // for retry without rejecting the button's event handler.
    } finally {
      setSaving(false)
    }
  }

  const handleDiscardAndLeave = () => {
    onDiscard?.()
    blocker.proceed()
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: COLORS.overlay, padding: 16,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        style={{
          width: '100%', maxWidth: 420,
          background: COLORS.card, border: `1px solid ${COLORS.border}`,
          borderRadius: 14, padding: 20,
        }}
      >
        <h3 style={{ margin: '0 0 8px', color: COLORS.text, fontSize: 18 }}>Unsaved changes</h3>
        <p style={{ margin: '0 0 18px', color: COLORS.muted, fontSize: 14 }}>
          {message}
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button
            type="button"
            onClick={handleSaveAndLeave}
            disabled={saving}
            style={{
              padding: '10px 16px', borderRadius: 10, border: 'none',
              background: COLORS.green, color: '#052e16', fontWeight: 800, fontSize: 14,
              cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.8 : 1,
            }}
          >
            {saving ? 'Saving…' : 'Save & Leave'}
          </button>
          <button
            type="button"
            onClick={handleDiscardAndLeave}
            disabled={saving}
            style={{
              padding: '10px 16px', borderRadius: 10, border: `1px solid ${COLORS.red}`,
              background: 'transparent', color: COLORS.red, fontWeight: 700, fontSize: 14,
              cursor: saving ? 'default' : 'pointer',
            }}
          >
            Discard & Leave
          </button>
          <button
            type="button"
            onClick={() => blocker.reset()}
            disabled={saving}
            style={{
              padding: '10px 16px', borderRadius: 10, border: `1px solid ${COLORS.border}`,
              background: 'transparent', color: COLORS.muted, fontWeight: 700, fontSize: 14,
              cursor: saving ? 'default' : 'pointer',
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
