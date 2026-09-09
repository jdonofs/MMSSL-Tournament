import { X } from 'lucide-react'
import { C } from './theme'

export default function ScorekeeperPitchControls({ visibility, pitch, actions }) {
  const {
    canEditScorebook,
    currentBatter,
    gameEndBanner,
    inPlayState,
    pendingPA,
    pitchActionSheet,
    showOutsBanner,
  } = visibility
  const {
    canRecordOutcome,
    charactersById,
    editingPa,
    isPitchActionPending,
    isSaving,
    starHitUsed,
    starPitchActive,
  } = pitch

  if (!canEditScorebook || pendingPA || pitchActionSheet || inPlayState || showOutsBanner || gameEndBanner || !currentBatter) return null

  const controlsDisabled = isSaving || isPitchActionPending

  return (
    <div style={{ position: 'sticky', bottom: 0, zIndex: 22, marginBottom: 10 }}>
      {editingPa && (
        <div style={{ background: `${C.blue}18`, border: `1px solid ${C.blue}44`, borderRadius: 8, padding: '7px 12px', marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: C.blue, fontSize: 13 }}>Editing PA #{editingPa.pa_number} - {charactersById[editingPa.character_id]?.name}</span>
          <button onClick={() => actions.setEditingPa(null)} style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer' }}><X size={15} /></button>
        </div>
      )}
      <div style={{ background: 'rgba(15,23,42,0.98)', border: `1px solid ${C.border}`, borderRadius: 18, padding: 14, boxShadow: '0 -8px 30px rgba(0,0,0,0.28)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10, marginBottom: 12 }}>
          <button type="button" disabled={controlsDisabled} onClick={() => actions.setStarPitchActive((current) => !current)} style={{ width: '100%', minHeight: 68, borderRadius: 16, border: `1px solid ${starPitchActive ? C.accent : C.border}`, background: starPitchActive ? `${C.accent}22` : C.card, color: starPitchActive ? C.accent : C.text, fontWeight: 800, fontSize: 15, opacity: controlsDisabled ? 0.55 : 1, cursor: controlsDisabled ? 'not-allowed' : 'pointer' }}>
            {starPitchActive ? 'STAR PITCH ON' : 'STAR PITCH'}
          </button>
          <button type="button" disabled={controlsDisabled} onClick={() => actions.setStarHitUsed((current) => {
            if (current) actions.setStarHitConnected(false)
            return !current
          })} style={{ width: '100%', minHeight: 68, borderRadius: 16, border: `1px solid ${starHitUsed ? C.accent : C.border}`, background: starHitUsed ? `${C.accent}22` : C.card, color: starHitUsed ? C.accent : C.text, fontWeight: 800, fontSize: 15, opacity: controlsDisabled ? 0.55 : 1, cursor: controlsDisabled ? 'not-allowed' : 'pointer' }}>
            {starHitUsed ? 'STAR HIT ON' : 'STAR HIT'}
          </button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10, marginBottom: 10 }}>
          <button type="button" onClick={actions.handlePitchBall} disabled={!canRecordOutcome || starHitUsed} style={{ minHeight: 68, borderRadius: 16, border: `1px solid ${starHitUsed ? `${C.border}99` : C.border}`, background: starHitUsed ? 'rgba(148,163,184,0.12)' : `${C.blue}22`, color: starHitUsed ? C.muted : C.blue, fontWeight: 800, fontSize: 15, opacity: !canRecordOutcome || starHitUsed ? 0.55 : 1, cursor: !canRecordOutcome || starHitUsed ? 'not-allowed' : 'pointer' }}>BALL</button>
          <button type="button" onClick={() => actions.handleStrikeChoice('swinging')} disabled={!canRecordOutcome} style={{ minHeight: 68, borderRadius: 16, border: `1px solid ${C.border}`, background: `${C.red}22`, color: C.red, fontWeight: 800, fontSize: 15, opacity: !canRecordOutcome ? 0.55 : 1, cursor: !canRecordOutcome ? 'not-allowed' : 'pointer' }}>SWING</button>
          <button type="button" onClick={() => actions.handleStrikeChoice('looking')} disabled={!canRecordOutcome || starHitUsed} title={starHitUsed ? 'A star hit requires swinging.' : undefined} style={{ minHeight: 68, borderRadius: 16, border: `1px solid ${starHitUsed ? `${C.border}99` : C.border}`, background: starHitUsed ? 'rgba(148,163,184,0.12)' : `${C.red}22`, color: starHitUsed ? C.muted : C.red, fontWeight: 800, fontSize: 15, opacity: !canRecordOutcome || starHitUsed ? 0.55 : 1, cursor: !canRecordOutcome || starHitUsed ? 'not-allowed' : 'pointer' }}>LOOK</button>
          <button type="button" onClick={actions.handlePitchFoul} disabled={!canRecordOutcome} style={{ minHeight: 68, borderRadius: 16, border: `1px solid ${C.border}`, background: `${C.red}22`, color: C.red, fontWeight: 800, fontSize: 15, opacity: !canRecordOutcome ? 0.55 : 1, cursor: !canRecordOutcome ? 'not-allowed' : 'pointer' }}>FOUL</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
          <button type="button" onClick={actions.handlePitchHbp} disabled={!canRecordOutcome || starHitUsed} style={{ minHeight: 68, borderRadius: 16, border: `1px solid ${starHitUsed ? `${C.border}99` : C.border}`, background: starHitUsed ? 'rgba(148,163,184,0.12)' : `${C.blue}22`, color: starHitUsed ? C.muted : C.blue, fontWeight: 800, fontSize: 15, opacity: !canRecordOutcome || starHitUsed ? 0.55 : 1, cursor: !canRecordOutcome || starHitUsed ? 'not-allowed' : 'pointer' }}>HBP</button>
          <button type="button" onClick={actions.handlePitchInPlay} disabled={!canRecordOutcome} style={{ minHeight: 68, borderRadius: 16, border: `1px solid ${C.border}`, background: `${C.green}22`, color: C.green, fontWeight: 800, fontSize: 15, opacity: !canRecordOutcome ? 0.55 : 1, cursor: !canRecordOutcome ? 'not-allowed' : 'pointer' }}>IN PLAY</button>
        </div>
      </div>
    </div>
  )
}
