import { useState } from 'react'

export default function InlineField({ label, value, onChange, placeholder, maxLength, transform, textStyle, inputStyle }) {
  const [editing, setEditing] = useState(false)

  if (editing) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#94A3B8', minWidth: 76 }}>{label}</span>
        <input
          type="text"
          autoFocus
          value={value}
          onChange={(e) => onChange(transform ? transform(e.target.value) : e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => { if (e.key === 'Enter') setEditing(false) }}
          maxLength={maxLength}
          placeholder={placeholder}
          style={inputStyle}
        />
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 12, fontWeight: 700, color: '#94A3B8', minWidth: 76 }}>{label}</span>
      <button
        type="button"
        onClick={() => setEditing(true)}
        title={`Edit ${label.replace(':', '')}`}
        style={{ background: 'transparent', border: '1px solid #334155', borderRadius: 6, color: '#94A3B8', width: 24, height: 24, cursor: 'pointer', fontSize: 12, lineHeight: 1, flexShrink: 0 }}
      >
        ✎
      </button>
      <span style={{ fontSize: 14, fontWeight: 600, color: value ? '#E2E8F0' : '#64748B', flex: 1, ...textStyle }}>
        {value || placeholder}
      </span>
    </div>
  )
}
