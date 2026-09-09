import { useMemo } from 'react'
import { Moon, Pencil, Sun, X } from 'lucide-react'

import {
  getOrderedStadiums,
  getStadiumSpriteStyle,
  getStadiumTimeLabel,
  normalizeIsNightForStadium,
  stadiumTimeToggleDisabled,
} from '../../../utils/stadiums'
import { C } from './theme'

export function StadiumLogo({ name, height = 56 }) {
  return (
    <div
      aria-hidden="true"
      style={{
        ...getStadiumSpriteStyle(name, {
          width: '100%',
          height,
        }),
      }}
    />
  )
}

export function StadiumHeaderPill({ stadium, isNight, onEdit }) {
  if (!stadium) return null
  const timeLabel = getStadiumTimeLabel(stadium, isNight)
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginTop: 6, padding: '6px 10px', borderRadius: 999, border: `1px solid ${C.border}`, background: `${C.card}CC`, maxWidth: '100%' }}>
      <div style={{ width: 74, flexShrink: 0 }}>
        <StadiumLogo name={stadium.name} height={28} />
      </div>
      <span style={{ fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' }}>{stadium.name}</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: C.muted, fontSize: 11, fontWeight: 700 }}>
        {timeLabel === 'Night' ? <Moon size={12} /> : <Sun size={12} />}
        {timeLabel}
      </span>
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          title="Edit stadium for this game"
          style={{ display: 'inline-flex', alignItems: 'center', background: 'none', border: 'none', color: C.muted, cursor: 'pointer', padding: 2 }}
        >
          <Pencil size={12} />
        </button>
      )}
    </div>
  )
}

export function StadiumSelectionFields({ stadiums, selectedStadiumId, isNight, onSelectStadium, onToggleTime }) {
  const orderedStadiums = useMemo(() => getOrderedStadiums(stadiums), [stadiums])
  const selectedStadium = orderedStadiums.find((stadium) => String(stadium.id) === String(selectedStadiumId)) || orderedStadiums[0] || null

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ color: C.muted, fontSize: 12, fontWeight: 700, textTransform: 'uppercase' }}>Stadium</div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{selectedStadium?.name || 'Select a stadium'}</div>
        </div>
        <button
          onClick={onToggleTime}
          disabled={!selectedStadium || stadiumTimeToggleDisabled(selectedStadium)}
          type="button"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            borderRadius: 999,
            border: `1px solid ${C.border}`,
            background: selectedStadium && normalizeIsNightForStadium(selectedStadium, isNight) ? 'rgba(59,130,246,0.18)' : 'rgba(234,179,8,0.16)',
            color: C.text,
            padding: '10px 14px',
            cursor: !selectedStadium || stadiumTimeToggleDisabled(selectedStadium) ? 'not-allowed' : 'pointer',
            opacity: !selectedStadium || stadiumTimeToggleDisabled(selectedStadium) ? 0.65 : 1,
            fontWeight: 700,
          }}
        >
          {selectedStadium && normalizeIsNightForStadium(selectedStadium, isNight) ? <Moon size={16} /> : <Sun size={16} />}
          {selectedStadium ? getStadiumTimeLabel(selectedStadium, isNight) : 'Day'}
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
        {orderedStadiums.map((stadium) => {
          const active = String(selectedStadiumId) === String(stadium.id)
          const stadiumIsNight = normalizeIsNightForStadium(stadium, active ? isNight : false)
          return (
            <button
              key={stadium.id}
              onClick={() => onSelectStadium(stadium)}
              type="button"
              style={{
                textAlign: 'left',
                padding: 14,
                borderRadius: 14,
                border: `1.5px solid ${active ? C.accent : C.border}`,
                background: active ? 'rgba(234,179,8,0.12)' : C.bg,
                color: C.text,
                cursor: 'pointer',
              }}
            >
              <StadiumLogo name={stadium.name} height={52} />
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 10, alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 15 }}>{stadium.name}</div>
                  <div style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>LF {stadium.lf_distance} / CF {stadium.cf_distance} / RF {stadium.rf_distance}</div>
                </div>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: C.muted, fontSize: 11, fontWeight: 700 }}>
                  {stadiumIsNight ? <Moon size={12} /> : <Sun size={12} />}
                  {getStadiumTimeLabel(stadium, stadiumIsNight)}
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', marginTop: 10, gap: 10 }}>
                <span style={{ color: C.muted, fontSize: 11, fontWeight: 700 }}>
                  {stadium.night_only ? 'Night only' : stadium.day_only ? 'Day only' : 'Day or night'}
                </span>
              </div>
            </button>
          )
        })}
      </div>
    </>
  )
}

export function EditStadiumModal({ stadiums, stadiumEditForm, setStadiumEditForm, onSave, onClose, saving }) {
  const orderedStadiums = useMemo(() => getOrderedStadiums(stadiums), [stadiums])
  const selectedStadium = orderedStadiums.find((stadium) => String(stadium.id) === String(stadiumEditForm.stadiumId)) || orderedStadiums[0] || null

  const setStadium = (stadium) => {
    setStadiumEditForm((current) => ({
      ...current,
      stadiumId: stadium.id,
      isNight: normalizeIsNightForStadium(stadium, current.isNight),
    }))
  }

  const toggleTime = () => {
    if (!selectedStadium || stadiumTimeToggleDisabled(selectedStadium)) return
    setStadiumEditForm((current) => ({
      ...current,
      isNight: !normalizeIsNightForStadium(selectedStadium, current.isNight),
    }))
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: C.card, borderRadius: 16, padding: 24, width: '100%', maxWidth: 960, maxHeight: '92vh', overflowY: 'auto', border: `1px solid ${C.border}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 18 }}>Edit Stadium</div>
            <div style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>Corrects the stadium on the live game record. A fresh historical row is written when the game is completed.</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer' }}><X size={20} /></button>
        </div>

        <StadiumSelectionFields
          stadiums={stadiums}
          selectedStadiumId={stadiumEditForm.stadiumId}
          isNight={stadiumEditForm.isNight}
          onSelectStadium={setStadium}
          onToggleTime={toggleTime}
        />

        <button onClick={onSave} disabled={!selectedStadium || saving} style={{ width: '100%', background: C.accent, color: '#000', border: 'none', borderRadius: 10, padding: '14px 0', fontWeight: 800, fontSize: 16, cursor: selectedStadium && !saving ? 'pointer' : 'not-allowed', marginTop: 20, opacity: selectedStadium && !saving ? 1 : 0.6 }}>
          {saving ? 'Saving…' : 'Save Stadium'}
        </button>
      </div>
    </div>
  )
}
