import { RotateCcw, RotateCw } from 'lucide-react'
import { C } from './theme'

export default function ScorekeeperActionBar({ inPlayState, canUndoAction, canRedoUiAction, isGameComplete, actions }) {
  if (inPlayState) return null

  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
      <button onClick={actions.handleUndoAction} disabled={!canUndoAction}
        style={{ flex: 1, background: C.card, border: `1px solid ${C.border}`, color: canUndoAction ? C.text : C.muted, borderRadius: 8, padding: '10px 0', fontWeight: 600, cursor: canUndoAction ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 13 }}>
        <RotateCcw size={14} /> Undo
      </button>
      <button onClick={actions.handleRedoAction} disabled={!canRedoUiAction}
        style={{ flex: 1, background: C.card, border: `1px solid ${C.border}`, color: canRedoUiAction ? C.text : C.muted, borderRadius: 8, padding: '10px 0', fontWeight: 600, cursor: canRedoUiAction ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 13 }}>
        <RotateCw size={14} /> Redo
      </button>
      <button onClick={actions.openEndGameConfirm} disabled={isGameComplete}
        style={{ flex: 1, background: C.card, border: `1px solid ${C.border}`, color: isGameComplete ? C.muted : C.text, borderRadius: 8, padding: '10px 0', fontWeight: 600, cursor: isGameComplete ? 'not-allowed' : 'pointer', fontSize: 13 }}>
        End Game
      </button>
    </div>
  )
}
