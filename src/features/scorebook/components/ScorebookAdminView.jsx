import { getTeamShortName } from '../../../utils/teamIdentity'
import { SectionCard } from './ScorebookPrimitives'
import { C } from './theme'

export default function ScorebookAdminView({ toolbar, tabs, state, actions }) {
  const {
    selectedGame,
    videoUrlDraft,
    videoUrlSaving,
    trackerModeSaving,
    trackerStats,
    canEditScorebook,
    battingColor,
    battingIdentity,
    battingPlayer,
    runners,
    charactersById,
    adminRunnerBase,
    adminRunnerCharacterId,
    adminRunnerOptions,
    canUndoAction,
    isGameComplete,
    isCommissioner,
    resetGameBusy,
  } = state
  const {
    setVideoUrlDraft,
    saveVideoUrl,
    setStatsSource,
    applyTrackerFinalResult,
    removeRunnerFromBase,
    setAdminRunnerBase,
    setAdminRunnerCharacterId,
    addAdminRunner,
    handleUndoAction,
    openReopenConfirm,
    openResetConfirm,
  } = actions

  return (
    <div style={{ color: C.text, paddingBottom: 40, margin: '-1.25rem -1.25rem 0' }}>
      {toolbar}
      {tabs}
      <div style={{ padding: '8px 10px 32px', display: 'grid', gap: 12 }}>
        {!selectedGame ? (
          <div style={{ color: C.muted, textAlign: 'center', padding: 24 }}>Select a game to manage scorebook corrections.</div>
        ) : (
          <>
            <SectionCard title="Game Video">
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  type="text"
                  placeholder="https://www.youtube.com/watch?v=..."
                  value={videoUrlDraft}
                  onChange={(event) => setVideoUrlDraft(event.target.value)}
                  style={{ flex: 1, minWidth: 260, padding: '8px 10px' }}
                />
                <button type="button" className="solid-button" onClick={saveVideoUrl} disabled={videoUrlSaving}>
                  {videoUrlSaving ? 'Saving…' : 'Save video URL'}
                </button>
              </div>
            </SectionCard>

            <SectionCard title="Live Stat Tracker" subtitle="Feed this game from the community auto-tracker instead of the manual scorebook.">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 13, color: '#CBD5E1' }}>
                  Currently: <strong style={{ color: selectedGame.stats_source === 'tracker' ? '#22C55E' : '#E2E8F0' }}>
                    {selectedGame.stats_source === 'tracker' ? 'Live Tracker' : 'Manual Scorebook'}
                  </strong>
                  {selectedGame.stats_source === 'tracker' && (
                    <div style={{ color: '#94A3B8', fontSize: 12, marginTop: 4 }}>
                      The tracker now drives the live score, count, runners, lineups, pitching changes, fielding changes, in-game odds, and bet settlement. Use the At-Bat Editor only for details the console feed cannot identify confidently.
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className={selectedGame.stats_source === 'tracker' ? 'ghost-button' : 'solid-button'}
                    disabled={trackerModeSaving}
                    onClick={() => setStatsSource(selectedGame.stats_source === 'tracker' ? 'manual' : 'tracker')}
                  >
                    {trackerModeSaving ? 'Saving…' : selectedGame.stats_source === 'tracker' ? 'Switch to Manual Scorebook' : 'Switch to Live Tracker'}
                  </button>
                </div>
              </div>
              {selectedGame.stats_source === 'tracker' && (() => {
                const events = trackerStats?.live_feed?.events || []
                const dumpText = events.map((event) => `${event.time} [${event.level}] ${event.message}`).join('\n')
                return (
                  <div style={{ marginTop: 12, padding: 12, borderRadius: 12, border: `1px solid ${C.border}`, background: 'rgba(15,23,42,0.58)', display: 'grid', gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                      <div style={{ color: '#94A3B8', fontSize: 11, fontWeight: 800, textTransform: 'uppercase' }}>Console Dump</div>
                      <button type="button" className="ghost-button" disabled={!events.length} onClick={() => navigator.clipboard?.writeText(dumpText)} style={{ fontSize: 11, padding: '4px 10px' }}>
                        Copy
                      </button>
                    </div>
                    <div style={{ color: '#94A3B8', fontSize: 11 }}>
                      Every log line the bridge has seen for this game so far ({events.length}) — copy/paste these when reporting a tracker parsing issue.
                    </div>
                    <pre style={{ margin: 0, maxHeight: 420, overflowY: 'auto', overscrollBehavior: 'contain', fontFamily: 'monospace', fontSize: 11, color: '#CBD5E1', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {events.length ? dumpText : 'No log lines captured yet.'}
                    </pre>
                  </div>
                )
              })()}
              {selectedGame.stats_source === 'tracker' && trackerStats?.live_feed?.gameEnded && selectedGame.status !== 'complete' && (
                <div style={{ marginTop: 12, padding: 12, borderRadius: 12, border: `1px solid ${C.border}`, background: 'rgba(15,23,42,0.58)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ fontSize: 13, color: '#CBD5E1' }}>
                    The tracker reported a final score{trackerStats.live_feed.winner ? ` (${trackerStats.live_feed.winner} win)` : ''}, but automatic finalization has not completed and this game is still marked {selectedGame.status}.
                    <div style={{ color: '#94A3B8', fontSize: 12, marginTop: 4 }}>
                      Use this as an emergency fallback. It only sets the score and status; review the bridge log before applying it.
                    </div>
                  </div>
                  <button type="button" className="solid-button" disabled={trackerModeSaving} onClick={applyTrackerFinalResult}>
                    {trackerModeSaving ? 'Saving…' : 'Apply Final Score'}
                  </button>
                </div>
              )}
            </SectionCard>

            <SectionCard title="Scorebook Admin" subtitle={canEditScorebook ? 'Manual corrections for the active batting side and recorded plate appearances.' : 'Reopen the game to apply corrections.'}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
                <div style={{ display: 'grid', gap: 12 }}>
                  <div style={{ borderRadius: 14, border: `1px solid ${C.border}`, background: 'rgba(15,23,42,0.58)', padding: 14, display: 'grid', gap: 10 }}>
                    <div>
                      <div style={{ color: C.muted, fontSize: 11, fontWeight: 800, textTransform: 'uppercase' }}>Current offense</div>
                      <div style={{ color: battingColor, fontSize: 16, fontWeight: 800 }}>
                        {getTeamShortName(battingIdentity) || battingPlayer?.name || 'Batting team'}
                      </div>
                    </div>
                    {[
                      { key: 'first', label: '1B' },
                      { key: 'second', label: '2B' },
                      { key: 'third', label: '3B' },
                    ].map((base) => {
                      const runner = runners[base.key]
                      return (
                        <div key={base.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 10px', borderRadius: 10, border: `1px solid ${C.border}`, background: `${C.bg}AA` }}>
                          <div>
                            <div style={{ color: C.muted, fontSize: 11, fontWeight: 800 }}>{base.label}</div>
                            <div style={{ color: '#E2E8F0', fontSize: 13, fontWeight: 700 }}>
                              {runner ? charactersById[runner.characterId]?.name || 'Runner' : 'Empty'}
                            </div>
                          </div>
                          <button type="button" className="ghost-button" disabled={!canEditScorebook || !runner} onClick={() => removeRunnerFromBase(base.key)}>
                            Clear
                          </button>
                        </div>
                      )
                    })}
                    <div style={{ display: 'grid', gap: 8 }}>
                      <div style={{ color: C.muted, fontSize: 11, fontWeight: 800, textTransform: 'uppercase' }}>Add runner</div>
                      <div style={{ display: 'grid', gridTemplateColumns: '120px minmax(0, 1fr)', gap: 8 }}>
                        <select value={adminRunnerBase} onChange={(event) => setAdminRunnerBase(event.target.value)} disabled={!canEditScorebook}>
                          <option value="first">1st Base</option>
                          <option value="second">2nd Base</option>
                          <option value="third">3rd Base</option>
                        </select>
                        <select value={adminRunnerCharacterId} onChange={(event) => setAdminRunnerCharacterId(event.target.value)} disabled={!canEditScorebook}>
                          <option value="">Select batter</option>
                          {adminRunnerOptions.map((entry) => (
                            <option key={entry.id || `${entry.player_id}:${entry.character_id}`} value={entry.character_id}>
                              {charactersById[entry.character_id]?.name || `Character ${entry.character_id}`}
                            </option>
                          ))}
                        </select>
                      </div>
                      <button type="button" className="solid-button" disabled={!canEditScorebook || !adminRunnerCharacterId} onClick={addAdminRunner}>
                        Add Runner
                      </button>
                    </div>
                  </div>
                  <div style={{ display: 'grid', gap: 8 }}>
                    <button type="button" className="ghost-button" disabled={!canUndoAction} onClick={handleUndoAction}>
                      Undo Latest Action
                    </button>
                    {isGameComplete ? (
                      <button type="button" className="solid-button" onClick={openReopenConfirm}>Reopen Game</button>
                    ) : null}
                    {isCommissioner ? (
                      <div style={{ marginTop: 8, paddingTop: 12, borderTop: `1px solid ${C.border}`, display: 'grid', gap: 6 }}>
                        <div style={{ color: C.muted, fontSize: 11, fontWeight: 800, textTransform: 'uppercase' }}>Danger zone</div>
                        <div style={{ color: C.muted, fontSize: 12, lineHeight: 1.5 }}>
                          Deletes every plate appearance, pitch, lineup and odds row for this game and puts it back to unplayed. Games with bets must be cleared separately first.
                        </div>
                        <button type="button" className="ghost-button" style={{ borderColor: '#B91C1C', color: '#FCA5A5' }} disabled={resetGameBusy} onClick={openResetConfirm}>
                          {resetGameBusy ? 'Resetting…' : 'Reset Game'}
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </SectionCard>
          </>
        )}
      </div>
    </div>
  )
}
