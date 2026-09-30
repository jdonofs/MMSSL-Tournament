const COLORS = {
  card: '#1E293B', border: '#334155',
  green: '#22C55E', red: '#EF4444',
  text: '#FFFFFF', muted: '#94A3B8',
}

// Prominent, sticky save control for lineup/fielding editors. Shown whenever
// the section is editable; the button itself is only enabled while dirty.
// Until the saved lineup has been read (`loadStatus`), nothing on screen is
// saved, so the bar says so and offers a retry instead of "All changes saved".
export default function SaveLineupBar({ isDirty, status = 'idle', onSave, label = 'Save Lineup', loadStatus = 'ready', onRetryLoad }) {
  const isSaving = status === 'saving'
  const isError = status === 'error'
  const isLoading = loadStatus === 'loading'
  const isLoadError = loadStatus === 'error'

  if (isLoading || isLoadError) {
    return (
      <div
        role={isLoadError ? 'alert' : 'status'}
        style={{
          position: 'sticky',
          bottom: 0,
          zIndex: 20,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginTop: 12,
          padding: '10px 14px',
          borderRadius: 12,
          border: `2px solid ${isLoadError ? COLORS.red : COLORS.border}`,
          background: COLORS.card,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 700, color: isLoadError ? COLORS.red : COLORS.muted }}>
          {isLoadError ? 'Saved lineup failed to load — nothing can be saved until it does' : 'Loading saved lineup…'}
        </span>
        {isLoadError ? (
          <button
            type="button"
            onClick={onRetryLoad}
            style={{
              minWidth: 140,
              padding: '10px 20px',
              borderRadius: 10,
              border: 'none',
              fontSize: 14,
              fontWeight: 800,
              color: '#FFFFFF',
              background: COLORS.red,
              cursor: 'pointer',
            }}
          >
            Retry Load
          </button>
        ) : null}
      </div>
    )
  }

  let buttonLabel = label
  if (isSaving) buttonLabel = 'Saving…'
  else if (!isDirty) buttonLabel = 'Saved'
  else if (isError) buttonLabel = 'Retry Save'

  return (
    <div
      style={{
        position: 'sticky',
        bottom: 0,
        zIndex: 20,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        marginTop: 12,
        padding: '10px 14px',
        borderRadius: 12,
        border: `2px solid ${isDirty ? COLORS.green : COLORS.border}`,
        background: COLORS.card,
        boxShadow: isDirty ? '0 4px 16px rgba(34, 197, 94, 0.35)' : 'none',
      }}
    >
      <span style={{ fontSize: 13, fontWeight: 700, color: isError ? COLORS.red : isDirty ? COLORS.text : COLORS.muted }}>
        {isError ? 'Save failed — try again' : isDirty ? 'You have unsaved changes' : 'All changes saved'}
      </span>
      <button
        type="button"
        onClick={onSave}
        disabled={!isDirty || isSaving}
        style={{
          minWidth: 140,
          padding: '10px 20px',
          borderRadius: 10,
          border: 'none',
          fontSize: 14,
          fontWeight: 800,
          letterSpacing: 0.2,
          color: isDirty && !isSaving ? '#052e16' : COLORS.muted,
          background: isDirty && !isSaving ? COLORS.green : COLORS.border,
          cursor: isDirty && !isSaving ? 'pointer' : 'default',
          opacity: isSaving ? 0.8 : 1,
        }}
      >
        {buttonLabel}
      </button>
    </div>
  )
}
