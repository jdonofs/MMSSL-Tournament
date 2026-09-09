import SaveLineupBar from '../../../components/SaveLineupBar'
import { DraggableRosterItem, FieldingView } from '../../../components/RosterLineupWidgets'
import { buildChemistryHighlightSet } from '../../../utils/chemistryHighlights'
import { SectionCard } from './ScorebookPrimitives'
import { C } from './theme'

function LineupTeamCard({ team, isNarrowViewport, state, actions }) {
  const {
    teamAName,
    teamBName,
    lineupDrafts,
    rosterCharMaps,
    selectedFieldingPlayer,
    selectedLineupMoveId,
    lineupDirty,
    lineupSaveStatus,
  } = state
  const {
    handleDropOnLineupSlot,
    handleLineupDragStart,
    openCharacterPage,
    handleLineupNumberClick,
    setFieldingPositionsForTeam,
    setSelectedFieldingPlayerForTeam,
    handleSaveLineupTeam,
  } = actions
  const teamName = team === 'A' ? teamAName : teamBName
  const draft = lineupDrafts[team]
  const rosterCharMap = rosterCharMaps[team]
  const rosterCharsArray = Object.values(rosterCharMap)
  const rosterNames = rosterCharsArray.map((character) => character.chemistryName || character.name)
  const selectedFieldingCharId = selectedFieldingPlayer[team]
  const chemistryHighlightIds = buildChemistryHighlightSet(selectedFieldingCharId || null, rosterCharsArray)
  const positionByCharId = Object.fromEntries(Object.entries(draft.fielding).map(([fieldId, charId]) => [charId, fieldId]))

  return (
    <SectionCard title={teamName} subtitle="Batting order & fielding positions">
      <div
        className="roster-grid"
        style={{
          gridTemplateColumns: isNarrowViewport ? '1fr' : 'minmax(0, 0.88fr) minmax(340px, 1.12fr)',
          alignItems: 'start',
          gap: 16,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {draft.order.length === 0 ? (
            <div style={{ padding: 12, textAlign: 'center', color: C.muted, fontSize: 12 }}>No lineup set yet.</div>
          ) : (
            draft.order.map((charId, index) => {
              const character = rosterCharMap[charId]
              if (!character) return null
              return (
                <div key={charId} onDragOver={(event) => event.preventDefault()} onDrop={handleDropOnLineupSlot(team, index)} style={{ borderRadius: 8 }}>
                  <DraggableRosterItem
                    character={character}
                    onDragStart={handleLineupDragStart(charId)}
                    rosterNames={rosterNames}
                    onOpenCard={() => openCharacterPage(charId)}
                    compact
                    portraitScale={0.88}
                    lineupNumber={index + 1}
                    positionLabel={positionByCharId[charId] || null}
                    onLineupNumberClick={() => handleLineupNumberClick(team, charId, index)}
                    lineupNumberSelected={selectedLineupMoveId[team] === charId}
                    lineupNumberAriaLabel={`Lineup spot ${index + 1}`}
                    lineupNumberTitle={selectedLineupMoveId[team] === charId ? 'Selected lineup slot' : 'Tap to swap this player with another lineup slot'}
                    showChemistryNote={chemistryHighlightIds.has(charId)}
                    highlighted={selectedLineupMoveId[team] === charId}
                  />
                </div>
              )
            })
          )}
        </div>

        <FieldingView
          charactersById={rosterCharMap}
          fieldingPositions={draft.fielding}
          setFieldingPositions={setFieldingPositionsForTeam(team)}
          selectedPlayer={selectedFieldingCharId}
          setSelectedPlayer={setSelectedFieldingPlayerForTeam(team)}
          fieldingAssignMode={false}
          selectedForFielding={null}
          onAssignPosition={() => {}}
          editable
          chemistryHighlightIds={chemistryHighlightIds}
          fieldScale={1.16}
          portraitScale={0.85}
        />
      </div>
      <SaveLineupBar isDirty={lineupDirty[team]} status={lineupSaveStatus[team]} onSave={() => handleSaveLineupTeam(team)} label={`Save Team ${team} Lineup`} />
    </SectionCard>
  )
}

export default function ScorebookLineupsView({
  toolbar,
  tabs,
  selectedGame,
  currentInning,
  isNarrowViewport,
  state,
  actions,
}) {
  return (
    <div style={{ color: C.text, paddingBottom: 40, margin: '-1.25rem -1.25rem 0' }}>
      {toolbar}
      {tabs}
      <div style={{ padding: '8px 10px 32px', display: 'grid', gap: 12 }}>
        {!selectedGame ? (
          <div style={{ color: C.muted, textAlign: 'center', padding: 24 }}>Select a game to manage lineups.</div>
        ) : (
          <>
            <div style={{ color: C.muted, fontSize: 12, textAlign: 'center' }}>
              Changes apply starting in inning {currentInning} and update the scorebook, spectator view, and odds immediately.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
              <LineupTeamCard team="A" isNarrowViewport={isNarrowViewport} state={state} actions={actions} />
              <LineupTeamCard team="B" isNarrowViewport={isNarrowViewport} state={state} actions={actions} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
