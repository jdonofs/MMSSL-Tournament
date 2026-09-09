import LineupColumn from './ScorebookLineupColumn'
import { C } from './theme'

export default function ScorekeeperLineupStatus({ game, lineups, actions }) {
  const {
    gameLineups,
    inPlayState,
    isGameComplete,
    isScorekeeper,
    selectedGame,
  } = game
  const {
    battingColor,
    canEditScorebook,
    charactersById,
    currentLineup,
    currentPitcherChar,
    defensiveLineup,
    effectiveBatterIdx,
    isNarrowViewport,
    pitchingColor,
    selectedPitcher,
  } = lineups
  const {
    handlePitcherDragStart,
    handlePitcherItemClick,
    setShowReopenGameConfirm,
  } = actions

  return (
    <>
      {!gameLineups.length && (
        <div style={{ background: `${C.accent}18`, border: `1px solid ${C.accent}44`, borderRadius: 10, padding: '8px 14px', marginBottom: 8 }}>
          <div style={{ color: C.accent, fontWeight: 700, fontSize: 13 }}>Loading lineup…</div>
        </div>
      )}

      {/* The play builder needs the full width and the lineups are not actionable mid-play. */}
      {!inPlayState && (
        <div style={{ display: 'grid', gap: 8, marginBottom: 10, width: '100%' }}>
          <LineupColumn
            lineup={currentLineup}
            currentIdx={effectiveBatterIdx}
            teamColor={battingColor}
            stat="batting"
            draggable={false}
            charactersById={charactersById}
            orientation="horizontal"
            wrap={isNarrowViewport}
          />
          <LineupColumn
            lineup={defensiveLineup}
            currentIdx={-1}
            currentPitcherCharId={currentPitcherChar?.id}
            pendingPitcherCharId={selectedPitcher?.charId}
            teamColor={pitchingColor}
            stat="pitching"
            draggable={canEditScorebook}
            onDragStart={handlePitcherDragStart}
            onItemClick={canEditScorebook ? handlePitcherItemClick : undefined}
            charactersById={charactersById}
            orientation="horizontal"
            wrap={isNarrowViewport}
          />
        </div>
      )}

      {selectedGame && !gameLineups.length && !inPlayState && (
        <div style={{ background: C.card, borderRadius: 10, padding: 16, textAlign: 'center', marginBottom: 10, color: C.muted }}>No lineup set.</div>
      )}

      {isGameComplete && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, background: `${C.green}18`, border: `1px solid ${C.green}44`, borderRadius: 10, padding: '10px 14px', marginBottom: 10, color: C.green, fontWeight: 700, fontSize: 13 }}>
          <span>Game complete. The scorebook is locked for viewing only.</span>
          {isScorekeeper && (
            <button
              type="button"
              onClick={() => setShowReopenGameConfirm(true)}
              style={{ background: C.card, color: C.green, border: `1px solid ${C.green}55`, borderRadius: 8, padding: '8px 12px', fontWeight: 800, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' }}
            >
              Reopen Game
            </button>
          )}
        </div>
      )}
    </>
  )
}
