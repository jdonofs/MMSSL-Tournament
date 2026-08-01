import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { GENERIC_FIELD_CONFIG, STADIUM_CONFIGS, STADIUM_KEY_LABELS, projectDistanceAngleToSpot } from './FieldPlayBuilder'
import { isBarrel } from '../utils/hitDistanceStats'
import { buildAtBatPath } from '../utils/scorebookRouting'

// Devices with a fine pointer and real hover (mouse/trackpad) can preview a
// dot on hover, so a click can afford to jump straight to the at-bat page.
// Touch devices have no hover preview, so a tap opens the tooltip first —
// the user then taps its "View at-bat" link when they actually want to go.
function usePointerIsPrecise() {
  return useMemo(() => (
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(hover: hover) and (pointer: fine)').matches
      : false
  ), [])
}

// Colors follow the Baseball Savant spray-chart convention: orange/purple/
// gold/magenta for 1B/2B/3B/HR.
const DOT_COLORS = {
  HR: '#D6266E',
  IPHR: '#D6266E',
  '3B': '#F4C430',
  '2B': '#8B5CF6',
  '1B': '#F2761E',
}
const OUT_DOT_COLOR = '#94A3B8'
const ERROR_DOT_COLOR = '#06B6D4'
const ALL_PARKS_KEY = '__all__'

const LEGEND_ITEMS = [
  { label: 'Single', color: DOT_COLORS['1B'] },
  { label: 'Double', color: DOT_COLORS['2B'] },
  { label: 'Triple', color: DOT_COLORS['3B'] },
  { label: 'Home Run', color: DOT_COLORS.HR },
  { label: 'Error', color: ERROR_DOT_COLOR },
  { label: 'Out', color: OUT_DOT_COLOR },
]

function dotColorFor(pa) {
  if (pa.is_error) return ERROR_DOT_COLOR
  if (DOT_COLORS[pa.result]) return DOT_COLORS[pa.result]
  return OUT_DOT_COLOR
}

function dotSizeFor(pa) {
  return pa.result === 'HR' || pa.result === 'IPHR' ? 11 : 8
}

function aspectRatioValue(aspectRatio) {
  const [w, h] = String(aspectRatio || '1/1').split('/').map(Number)
  return w > 0 && h > 0 ? w / h : 1
}

const RESULT_LABELS = {
  HR: 'Home Run',
  IPHR: 'Inside-the-Park HR',
  '3B': 'Triple',
  '2B': 'Double',
  '1B': 'Single',
}

function resultLabelFor(pa) {
  if (pa.is_error) return 'Error'
  return RESULT_LABELS[pa.result] || pa.result || 'Out'
}

function HitTooltip({ pa, onClose, stadiumLabel, characterName }) {
  const hasExitVelo = pa.exit_velocity_mph != null
  const hasLaunchAngle = pa.launch_angle_deg != null
  const hasDistance = pa.hit_distance_ft != null
  const left = pa.hit_x
  const top = pa.hit_y
  const flipUp = top > 55

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        left: `${left}%`,
        top: `${top}%`,
        transform: `translate(-50%, ${flipUp ? 'calc(-100% - 12px)' : '12px'})`,
        background: 'rgba(15,23,42,0.96)',
        border: '1px solid rgba(255,255,255,0.18)',
        borderRadius: 8,
        padding: '8px 10px',
        fontSize: 11,
        color: '#E2E8F0',
        whiteSpace: 'nowrap',
        zIndex: 10,
        pointerEvents: 'auto',
        boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
      }}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        style={{
          position: 'absolute',
          top: 2,
          right: 4,
          background: 'none',
          border: 'none',
          color: '#94A3B8',
          fontSize: 12,
          cursor: 'pointer',
          padding: 2,
          lineHeight: 1,
        }}
      >
        ×
      </button>
      <div style={{ fontWeight: 700, marginBottom: 4, paddingRight: 10 }}>{resultLabelFor(pa)}</div>
      {characterName ? <div>Character: {characterName}</div> : null}
      {stadiumLabel ? <div>Stadium: {stadiumLabel}</div> : null}
      {hasDistance ? <div>Distance: {pa.hit_distance_ft} ft</div> : null}
      {hasExitVelo ? <div>Exit Velo: {pa.exit_velocity_mph} mph</div> : null}
      {hasLaunchAngle ? <div>Launch Angle: {pa.launch_angle_deg}°</div> : null}
      {hasExitVelo && hasLaunchAngle && isBarrel(pa.exit_velocity_mph, pa.launch_angle_deg)
        ? <div style={{ color: '#FDE68A', fontWeight: 700 }}>⬤ Barrel</div>
        : null}
      {!hasDistance && !hasExitVelo && !hasLaunchAngle ? <div style={{ color: '#94A3B8' }}>No hit data tracked</div> : null}
      {pa.id != null ? (
        <div style={{ marginTop: 4 }}>
          <Link
            to={buildAtBatPath({ id: pa.id, source: pa.season_id != null ? 'season' : 'tournament' })}
            style={{ color: '#EAB308', fontWeight: 700 }}
          >
            View at-bat →
          </Link>
        </div>
      ) : null}
    </div>
  )
}

// Renders one dot per plate appearance. Individual stadium tabs plot the
// tapped hit_x/hit_y position on top of that park's own image, same as live
// scoring capture. A stadium-agnostic "All Parks" tab additionally projects
// every hit's stored distance/angle onto a normalized field diagram, for
// comparing power/direction across every park's different dimensions.
export default function SprayChart({ plateAppearances = [], initialStadiumKey = null, height = 320, showCharacterName = false }) {
  const paByStadium = useMemo(() => {
    const map = new Map()
    plateAppearances.forEach((pa) => {
      if (!pa.hit_stadium_key || pa.hit_x == null || pa.hit_y == null) return
      if (!map.has(pa.hit_stadium_key)) map.set(pa.hit_stadium_key, [])
      map.get(pa.hit_stadium_key).push(pa)
    })
    return map
  }, [plateAppearances])

  const allParksPas = useMemo(
    () => plateAppearances.filter((pa) => pa.hit_distance_ft != null && pa.hit_angle_deg != null),
    [plateAppearances],
  )

  const stadiumKeys = useMemo(
    () => [...paByStadium.keys()].sort((a, b) => paByStadium.get(b).length - paByStadium.get(a).length),
    [paByStadium],
  )

  const showAllParksOption = allParksPas.length > 0
  const defaultKey = initialStadiumKey || (showAllParksOption ? ALL_PARKS_KEY : stadiumKeys[0])
  const [selectedKey, setSelectedKey] = useState(defaultKey)
  const [activeDotKey, setActiveDotKey] = useState(null)
  const navigate = useNavigate()
  const isPointerPrecise = usePointerIsPrecise()
  const validKeys = showAllParksOption ? [ALL_PARKS_KEY, ...stadiumKeys] : stadiumKeys
  const activeKey = validKeys.includes(selectedKey) ? selectedKey : validKeys[0]
  const isAllParks = activeKey === ALL_PARKS_KEY
  const stadiumConfig = isAllParks ? GENERIC_FIELD_CONFIG : (activeKey ? STADIUM_CONFIGS[activeKey] : null)

  const dots = useMemo(() => {
    if (isAllParks) {
      return allParksPas
        .map((pa) => {
          const spot = projectDistanceAngleToSpot(Number(pa.hit_distance_ft), Number(pa.hit_angle_deg), GENERIC_FIELD_CONFIG)
          return spot ? { ...pa, hit_x: spot.x, hit_y: spot.y } : null
        })
        .filter(Boolean)
    }
    return activeKey ? paByStadium.get(activeKey) || [] : []
  }, [isAllParks, allParksPas, activeKey, paByStadium])

  if (!validKeys.length || !stadiumConfig) {
    return <div className="muted" style={{ fontSize: 13, padding: '1rem 0' }}>No tapped hit locations tracked yet.</div>
  }

  return (
    <div>
      {validKeys.length > 1 ? (
        <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
          {showAllParksOption ? (
            <button
              type="button"
              onClick={() => { setSelectedKey(ALL_PARKS_KEY); setActiveDotKey(null) }}
              style={{
                padding: '2px 10px',
                borderRadius: 999,
                border: '1px solid rgba(255,255,255,0.18)',
                background: isAllParks ? 'rgba(234,179,8,0.18)' : 'rgba(255,255,255,0.04)',
                color: isAllParks ? '#FDE68A' : '#94A3B8',
                cursor: 'pointer',
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              All Parks ({allParksPas.length})
            </button>
          ) : null}
          {stadiumKeys.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => { setSelectedKey(key); setActiveDotKey(null) }}
              style={{
                padding: '2px 10px',
                borderRadius: 999,
                border: '1px solid rgba(255,255,255,0.18)',
                background: key === activeKey ? 'rgba(234,179,8,0.18)' : 'rgba(255,255,255,0.04)',
                color: key === activeKey ? '#FDE68A' : '#94A3B8',
                cursor: 'pointer',
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              {STADIUM_KEY_LABELS[key] || key.replace(/_/g, ' ')} ({paByStadium.get(key).length})
            </button>
          ))}
        </div>
      ) : null}
      <div
        style={{ position: 'relative', width: '100%', maxWidth: Math.round(height * aspectRatioValue(stadiumConfig.aspectRatio)), margin: '0 auto', overflow: 'visible', background: isAllParks ? '#FFFFFF' : 'transparent', borderRadius: 18, boxShadow: isAllParks ? '0 2px 10px rgba(0,0,0,0.3)' : 'none' }}
        onClick={() => setActiveDotKey(null)}
      >
        <img src={stadiumConfig.image} alt="" style={{ display: 'block', width: '100%', height: 'auto', borderRadius: 18 }} />
        {dots.map((pa, index) => {
          const dotKey = pa.id ?? index
          return (
            <div
              key={dotKey}
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation()
                if (isPointerPrecise && pa.id != null) {
                  navigate(buildAtBatPath({ id: pa.id, source: pa.season_id != null ? 'season' : 'tournament' }))
                  return
                }
                setActiveDotKey((prev) => (prev === dotKey ? null : dotKey))
              }}
              onMouseEnter={() => setActiveDotKey(dotKey)}
              onMouseLeave={() => setActiveDotKey((prev) => (prev === dotKey ? null : prev))}
              style={{
                position: 'absolute',
                left: `${pa.hit_x}%`,
                top: `${pa.hit_y}%`,
                width: dotSizeFor(pa),
                height: dotSizeFor(pa),
                borderRadius: '50%',
                background: dotColorFor(pa),
                border: '1.5px solid rgba(15,23,42,0.75)',
                boxShadow: '0 1px 3px rgba(0,0,0,0.35)',
                transform: 'translate(-50%, -50%)',
                pointerEvents: 'auto',
                cursor: 'pointer',
              }}
            />
          )
        })}
        {activeDotKey != null
          ? (() => {
              const activePa = dots.find((pa, index) => (pa.id ?? index) === activeDotKey)
              if (!activePa) return null
              const stadiumLabel = isAllParks
                ? (STADIUM_KEY_LABELS[activePa.hit_stadium_key] || activePa.hit_stadium_key?.replace(/_/g, ' '))
                : null
              const characterName = showCharacterName ? activePa.character_name : null
              return <HitTooltip pa={activePa} onClose={() => setActiveDotKey(null)} stadiumLabel={stadiumLabel} characterName={characterName} />
            })()
          : null}
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 10 }}>
        {LEGEND_ITEMS.map((item) => (
          <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: item.color, border: '1px solid rgba(15,23,42,0.6)', display: 'inline-block' }} />
            <span style={{ fontSize: 11, color: '#94A3B8' }}>{item.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
