import { useMemo, useState } from 'react'
import { X } from 'lucide-react'

import {
  getOrderedStadiums,
  normalizeIsNightForStadium,
  stadiumTimeToggleDisabled,
} from '../../../utils/stadiums'
import { StadiumSelectionFields } from './StadiumControls'
import { C } from './theme'

export function AddGameModal({ players, stadiums, addGameForm, setAddGameForm, onAdd, onClose }) {
  const orderedStadiums = useMemo(() => getOrderedStadiums(stadiums), [stadiums])
  const selectedStadium = orderedStadiums.find((stadium) => String(stadium.id) === String(addGameForm.stadiumId)) || orderedStadiums[0] || null

  const setStadium = (stadium) => {
    setAddGameForm((current) => ({
      ...current,
      stadiumId: stadium.id,
      isNight: normalizeIsNightForStadium(stadium, current.isNight),
    }))
  }

  const toggleTime = () => {
    if (!selectedStadium || stadiumTimeToggleDisabled(selectedStadium)) return
    setAddGameForm((current) => ({
      ...current,
      isNight: !normalizeIsNightForStadium(selectedStadium, current.isNight),
    }))
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: C.card, borderRadius: 16, padding: 24, width: '100%', maxWidth: 960, maxHeight: '92vh', overflowY: 'auto', border: `1px solid ${C.border}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div style={{ fontWeight: 800, fontSize: 18 }}>Add Game</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer' }}><X size={20} /></button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14, marginBottom: 20 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ color: C.muted, fontSize: 12, fontWeight: 700, textTransform: 'uppercase' }}>Stage / Round</span>
            <input type="text" placeholder="e.g. Winners Final" value={addGameForm.stage}
              onChange={e => setAddGameForm(cur => ({ ...cur, stage: e.target.value }))}
              style={{ background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 12px', fontSize: 14 }} />
          </label>
          {[{ label: 'Team A', key: 'teamA' }, { label: 'Team B', key: 'teamB' }].map(f => (
            <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ color: C.muted, fontSize: 12, fontWeight: 700, textTransform: 'uppercase' }}>{f.label}</span>
              <select value={addGameForm[f.key]} onChange={e => setAddGameForm(cur => ({ ...cur, [f.key]: e.target.value }))}
                style={{ background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 12px', fontSize: 14 }}>
                <option value="">Select player</option>
                {players.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          ))}
        </div>

        <StadiumSelectionFields
          stadiums={stadiums}
          selectedStadiumId={addGameForm.stadiumId}
          isNight={addGameForm.isNight}
          onSelectStadium={setStadium}
          onToggleTime={toggleTime}
        />

        <button onClick={onAdd} disabled={!selectedStadium} style={{ width: '100%', background: C.accent, color: '#000', border: 'none', borderRadius: 10, padding: '14px 0', fontWeight: 800, fontSize: 16, cursor: selectedStadium ? 'pointer' : 'not-allowed', marginTop: 20, opacity: selectedStadium ? 1 : 0.6 }}>
          Add Game
        </button>
      </div>
    </div>
  )
}

export function EndGameConfirmModal({ scores, teamAName, teamBName, teamAColor, teamBColor, onConfirm, onClose }) {
  const tied = scores.a === scores.b
  const winner = scores.a > scores.b ? teamAName : scores.b > scores.a ? teamBName : null
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: C.card, borderRadius: 16, padding: 24, width: '100%', maxWidth: 340, border: `1px solid ${C.border}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ fontWeight: 800, fontSize: 18 }}>End Game?</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer' }}><X size={20} /></button>
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 24, marginBottom: 16, fontSize: 22, fontWeight: 900 }}>
          <span style={{ color: teamAColor }}>{teamAName} {scores.a}</span>
          <span style={{ color: C.muted, fontWeight: 400 }}>–</span>
          <span style={{ color: teamBColor }}>{teamBName} {scores.b}</span>
        </div>
        {tied ? (
          <div style={{ color: '#F97316', fontWeight: 700, textAlign: 'center', marginBottom: 16, fontSize: 14 }}>
            ⚠ Game is tied — ending will record no winner.
          </div>
        ) : (
          <div style={{ color: C.muted, textAlign: 'center', marginBottom: 16, fontSize: 14 }}>
            <span style={{ color: winner === teamAName ? teamAColor : teamBColor, fontWeight: 700 }}>{winner}</span> wins.
          </div>
        )}
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onConfirm} style={{ flex: 1, background: C.green, color: '#000', border: 'none', borderRadius: 10, padding: '13px 0', fontWeight: 800, fontSize: 15, cursor: 'pointer' }}>
            Confirm End
          </button>
          <button onClick={onClose} style={{ flex: 1, background: 'none', color: C.muted, border: `1px solid ${C.border}`, borderRadius: 10, padding: '13px 0', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

export function ResetGameConfirmModal({ teamAName, teamBName, busy, onConfirm, onClose }) {
  const [typed, setTyped] = useState('')
  const armed = typed.trim().toUpperCase() === 'RESET'
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: C.card, borderRadius: 16, padding: 24, width: '100%', maxWidth: 420, border: '1px solid #B91C1C' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ fontWeight: 800, fontSize: 18, color: '#FCA5A5' }}>Reset Game?</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer' }}><X size={20} /></button>
        </div>
        <div style={{ textAlign: 'center', fontSize: 16, fontWeight: 800, marginBottom: 14 }}>
          {teamAName} vs {teamBName}
        </div>
        <div style={{ color: C.muted, marginBottom: 14, fontSize: 13, lineHeight: 1.6 }}>
          This permanently deletes every plate appearance, pitch, run, pitching stint,
          lineup, fielding assignment, inning score and odds row for this game, and sets
          it back to unplayed, including its stadium and video selection. If the game has
          any bets, nothing will be deleted; void or settle those bets first. A running
          local tracker will stop and save its pending work before reset.
          <div style={{ marginTop: 10, color: '#FCA5A5', fontWeight: 700 }}>
            There is no undo. To fix a mistake in a finished game, use Reopen Game instead.
          </div>
        </div>
        <input
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          placeholder="Type RESET to confirm"
          style={{ width: '100%', marginBottom: 14, padding: '11px 12px', borderRadius: 10, border: `1px solid ${C.border}`, background: C.bg, color: '#E2E8F0', fontSize: 14 }}
        />
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={onConfirm}
            disabled={!armed || busy}
            style={{ flex: 1, background: armed && !busy ? '#B91C1C' : 'rgba(185,28,28,0.35)', color: '#fff', border: 'none', borderRadius: 10, padding: '13px 0', fontWeight: 800, fontSize: 15, cursor: armed && !busy ? 'pointer' : 'not-allowed' }}
          >
            {busy ? 'Resetting…' : 'Delete Everything'}
          </button>
          <button onClick={onClose} disabled={busy} style={{ flex: 1, background: 'none', color: C.muted, border: `1px solid ${C.border}`, borderRadius: 10, padding: '13px 0', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

export function ReopenGameConfirmModal({ scores, teamAName, teamBName, teamAColor, teamBColor, onConfirm, onClose }) {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: C.card, borderRadius: 16, padding: 24, width: '100%', maxWidth: 360, border: `1px solid ${C.border}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ fontWeight: 800, fontSize: 18 }}>Reopen Game?</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer' }}><X size={20} /></button>
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 24, marginBottom: 16, fontSize: 22, fontWeight: 900 }}>
          <span style={{ color: teamAColor }}>{teamAName} {scores.a}</span>
          <span style={{ color: C.muted, fontWeight: 400 }}>-</span>
          <span style={{ color: teamBColor }}>{teamBName} {scores.b}</span>
        </div>
        <div style={{ color: C.muted, textAlign: 'center', marginBottom: 16, fontSize: 14, lineHeight: 1.5 }}>
          Reopening will unlock the scorebook, clear the final result, and roll back postgame standings, bracket advancement, and bet settlement so you can fix mistakes.
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onConfirm} style={{ flex: 1, background: C.accent, color: '#000', border: 'none', borderRadius: 10, padding: '13px 0', fontWeight: 800, fontSize: 15, cursor: 'pointer' }}>
            Confirm Reopen
          </button>
          <button onClick={onClose} style={{ flex: 1, background: 'none', color: C.muted, border: `1px solid ${C.border}`, borderRadius: 10, padding: '13px 0', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
