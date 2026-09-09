import CharacterPortrait from '../../../components/CharacterPortrait'
import { formatPlateAppearanceResult } from '../../../utils/plateAppearance'
import { HIT_RESULTS } from '../../../utils/runnerAssignment'
import { C } from './theme'

const WALK_RESULTS = new Set(['BB', 'HBP'])
const ZONE_COLOR = { green: C.green, red: C.red, blue: C.blue }

export function Avatar({ name, size = 36, style: sx = {} }) {
  return <CharacterPortrait name={name} size={size} borderRadius={0} objectFit="contain" style={sx} />
}

export function ResultBadge({ result, strikeoutType = null }) {
  const color = HIT_RESULTS.has(result) ? C.green : WALK_RESULTS.has(result) ? C.blue : C.red
  return (
    <span style={{ background: color + '22', color, border: `1px solid ${color}55`, borderRadius: 4, padding: '2px 6px', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>
      {formatPlateAppearanceResult(result, strikeoutType)}
    </span>
  )
}

export function CountDotRow({ count = 0, total = 3, activeColor = '#22C55E', inactiveColor = '#334155', label }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {label ? <span style={{ color: '#94A3B8', fontSize: 10, fontWeight: 800, minWidth: 10 }}>{label}</span> : null}
      <div style={{ display: 'flex', gap: 5, flexWrap: 'nowrap' }}>
        {Array.from({ length: total }, (_, index) => (
          <span
            key={`${label || 'dot'}-${index}`}
            style={{
              width: 10,
              minWidth: 10,
              height: 10,
              minHeight: 10,
              borderRadius: '50%',
              background: index < count ? activeColor : 'transparent',
              border: `2px solid ${index < count ? activeColor : inactiveColor}`,
              display: 'inline-block',
              flexShrink: 0,
            }}
          />
        ))}
      </div>
    </div>
  )
}

export function FieldStatusCard({ title, children, accent = '#94A3B8' }) {
  return (
    <div
      style={{
        width: '100%',
        minHeight: 96,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 8,
        padding: '12px 14px',
        borderRadius: 14,
        border: `1px solid ${C.border}`,
        background: `${C.card}DD`,
        overflow: 'hidden',
      }}
    >
      {title ? (
        <div style={{ color: accent, fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.06em' }}>
          {title}
        </div>
      ) : null}
      {children}
    </div>
  )
}

export function CompactMatchupCard({ align = 'left', kicker, name, subtext, stats = [], accent = '#EAB308' }) {
  const justify = align === 'right' ? 'flex-end' : 'flex-start'
  const textAlign = align === 'right' ? 'right' : 'left'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: align === 'right' ? 'flex-end' : 'flex-start', justifyContent: 'center', minWidth: 0 }}>
      <div style={{ color: accent, fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 2 }}>{kicker}</div>
      <div style={{ fontSize: 18, fontWeight: 800, textAlign, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>{name}</div>
      <div style={{ color: C.muted, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', textAlign }}>{subtext}</div>
      {stats.length > 0 && (
        <div style={{ display: 'flex', gap: 8, justifyContent: justify, flexWrap: 'wrap', marginTop: 4 }}>
          {stats.map((stat) => (
            <span key={stat.label} style={{ color: '#CBD5E1', fontSize: 11, fontWeight: 700 }}>
              {stat.label} {stat.value}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

export function OutcomeBtn({ result, zone, onClick, disabled = false }) {
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

export function SectionCard({ title, subtitle = '', right = null, children, hideHeader = false }) {
  return (
    <section style={{ background: 'linear-gradient(180deg, rgba(30,41,59,0.98), rgba(15,23,42,0.98))', border: `1px solid ${C.border}`, borderRadius: 18, padding: 16, boxShadow: '0 14px 28px rgba(2,6,23,0.22)' }}>
      {!hideHeader && (title || subtitle || right) ? (
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', marginBottom: 12 }}>
          <div>
            {title ? <div style={{ color: '#F8FAFC', fontSize: 15, fontWeight: 800 }}>{title}</div> : null}
            {subtitle ? <div style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>{subtitle}</div> : null}
          </div>
          {right}
        </div>
      ) : null}
      {children}
    </section>
  )
}

export function BaseStateDiamond({ runners, charactersById, size = 88 }) {
  const baseSize = Math.max(10, Math.round(size * 0.14))
  const runnerSize = Math.max(20, Math.round(size * 0.28))
  const baseNode = (runner) => (
    runner
      ? (
          <div style={{ width: runnerSize, height: runnerSize, borderRadius: '50%', overflow: 'hidden', border: `1.5px solid ${C.accent}`, boxShadow: '0 0 0 2px rgba(15,23,42,0.88)' }}>
            <Avatar name={charactersById[runner.characterId]?.name} size={runnerSize} />
          </div>
        )
      : <div style={{ width: baseSize, height: baseSize, background: C.border, transform: 'rotate(45deg)', borderRadius: 2 }} />
  )

  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} viewBox="0 0 100 100">
        <polygon points="50,8 88,46 50,84 12,46" fill="rgba(148,163,184,0.04)" stroke={C.border} strokeWidth="2" />
      </svg>
      <div style={{ position: 'absolute', left: '50%', top: 0, transform: 'translate(-50%, 0)' }}>{baseNode(runners.second)}</div>
      <div style={{ position: 'absolute', right: 0, top: '50%', transform: 'translate(0, -50%)' }}>{baseNode(runners.first)}</div>
      <div style={{ position: 'absolute', left: 0, top: '50%', transform: 'translate(0, -50%)' }}>{baseNode(runners.third)}</div>
      <div style={{ position: 'absolute', left: '50%', bottom: 0, transform: 'translate(-50%, 0)' }}>
        <div style={{ width: baseSize, height: baseSize, background: C.card, border: `1.5px solid ${C.border}`, transform: 'rotate(45deg)', borderRadius: 2 }} />
      </div>
    </div>
  )
}

export function MiniRunnerDiamond({ runners, charactersById, size = 72 }) {
  const runnerSize = Math.round(size * 0.3)
  const baseSize = Math.round(size * 0.14)
  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} viewBox="0 0 72 72">
        <polygon points="36,6 62,32 36,62 10,32" fill="rgba(148,163,184,0.04)" stroke={C.border} strokeWidth="1.5" />
      </svg>
      <div style={{ position: 'absolute', left: '50%', top: 0, transform: 'translate(-50%,0)' }}>
        {runners.second
          ? <div style={{ width: runnerSize, height: runnerSize, borderRadius: '50%', overflow: 'hidden', border: `1.5px solid ${C.accent}` }}><Avatar name={charactersById[runners.second.characterId]?.name} size={runnerSize} /></div>
          : <div style={{ width: baseSize, height: baseSize, background: C.border, transform: 'rotate(45deg)', borderRadius: 1 }} />}
      </div>
      <div style={{ position: 'absolute', right: 0, top: '50%', transform: 'translate(0,-50%)' }}>
        {runners.first
          ? <div style={{ width: runnerSize, height: runnerSize, borderRadius: '50%', overflow: 'hidden', border: `1.5px solid ${C.accent}` }}><Avatar name={charactersById[runners.first.characterId]?.name} size={runnerSize} /></div>
          : <div style={{ width: baseSize, height: baseSize, background: C.border, transform: 'rotate(45deg)', borderRadius: 1 }} />}
      </div>
      <div style={{ position: 'absolute', left: 0, top: '50%', transform: 'translate(0,-50%)' }}>
        {runners.third
          ? <div style={{ width: runnerSize, height: runnerSize, borderRadius: '50%', overflow: 'hidden', border: `1.5px solid ${C.accent}` }}><Avatar name={charactersById[runners.third.characterId]?.name} size={runnerSize} /></div>
          : <div style={{ width: baseSize, height: baseSize, background: C.border, transform: 'rotate(45deg)', borderRadius: 1 }} />}
      </div>
      <div style={{ position: 'absolute', left: '50%', bottom: 0, transform: 'translate(-50%,0)' }}>
        <div style={{ width: baseSize * 0.9, height: baseSize * 0.9, background: C.card, border: `1.5px solid ${C.border}`, transform: 'rotate(45deg)', borderRadius: 1 }} />
      </div>
    </div>
  )
}
