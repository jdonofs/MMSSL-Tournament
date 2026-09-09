import TeamLogo from '../../../components/TeamLogo'
import { getTeamShortName } from '../../../utils/teamIdentity'
import { formatBaseballAverage } from '../domain/display'
import { getLineScoreCellValue } from '../domain/scoreboard'
import { StadiumHeaderPill } from './StadiumControls'
import { Avatar, CountDotRow, MiniRunnerDiamond } from './ScorebookPrimitives'
import { C } from './theme'

export default function ScorekeeperGameHeader({ game, teams, matchup, lineScore, actions }) {
  const {
    selectedGame,
    selectedStadium,
    isScorekeeper,
    gamePAs,
    effectiveGameStatus,
    currentInning,
    regulationInnings,
    innings,
    completedHalfCount,
    activeBattingSide,
  } = game
  const {
    battingColor,
    battingIdentity,
    battingPlayer,
    pitchingColor,
    pitchingIdentity,
    pitchingPlayer,
    identitiesByPlayerId,
    playersById,
  } = teams
  const {
    characterSeasonStats,
    charactersById,
    currentBatter,
    currentPitcherChar,
    currentPitcherGameLine,
    currentPitcherStint,
    displayBalls,
    displayOutsInHalf,
    displayPitchNumber,
    displayRunners,
    displayStrikes,
  } = matchup
  const { lineScoreRows, viewedInning, setViewedInning } = lineScore
  const { openStadiumEditModal, toggleHomeAwaySwap } = actions

  return (
    <>
      {/* ── Sticky header: score + inning strip ── */}
      <div style={{ background: C.bg, borderBottom: `1px solid ${C.border}` }}>
        <div style={{ padding: '8px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <StadiumHeaderPill stadium={selectedStadium} isNight={selectedGame?.is_night} onEdit={isScorekeeper ? openStadiumEditModal : undefined} />
            {isScorekeeper && (
              <button
                type="button"
                className="ghost-button"
                onClick={toggleHomeAwaySwap}
                disabled={gamePAs.length > 0}
                title={gamePAs.length > 0
                  ? 'Home/Away can only be swapped before the first plate appearance is recorded.'
                  : 'Swap which team bats first (top of the inning) — updates the batting order, line score, and game view for everyone.'}
                style={{ fontSize: 11, padding: '6px 10px', opacity: gamePAs.length > 0 ? 0.5 : 1 }}
              >
                ⇄ Swap Home/Away
              </button>
            )}
          </div>
        </div>

        <div style={{ padding: '0 12px 8px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)', gap: 16, alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
              <div style={{ width: 48, height: 48, borderRadius: '50%', overflow: 'hidden', border: `2px solid ${battingColor}`, flexShrink: 0 }}>
                <Avatar name={charactersById[currentBatter?.character_id]?.name} size={48} />
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: battingColor, fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.06em' }}>
                  <TeamLogo logoKey={battingIdentity?.teamLogoKey} logoUrl={battingIdentity?.teamLogoUrl || battingPlayer?.team_logo_url} teamName={battingPlayer?.name} height={14} />
                  Batter
                </div>
                <div style={{ fontSize: 16, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{charactersById[currentBatter?.character_id]?.name || 'No batter'}</div>
                <div style={{ color: C.muted, fontSize: 11, fontWeight: 700 }}>{currentBatter ? `${getTeamShortName(identitiesByPlayerId[currentBatter.player_id]) || playersById[currentBatter.player_id]?.name || ''} · #${currentBatter.batting_order}` : 'Waiting'}</div>
                {characterSeasonStats ? (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
                    <span style={{ color: '#CBD5E1', fontSize: 11, fontWeight: 700 }}>AVG {formatBaseballAverage({ atBats: 1, avg: characterSeasonStats.avg })}</span>
                    <span style={{ color: '#CBD5E1', fontSize: 11, fontWeight: 700 }}>HR {characterSeasonStats.homeRuns}</span>
                    <span style={{ color: '#CBD5E1', fontSize: 11, fontWeight: 700 }}>RBI {characterSeasonStats.rbi}</span>
                  </div>
                ) : null}
              </div>
            </div>
            {/* ── Mini runner diamond ── */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, flexShrink: 0 }}>
              <MiniRunnerDiamond runners={displayRunners} charactersById={charactersById} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10, minWidth: 0 }}>
              <div style={{ minWidth: 0, textAlign: 'right' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4, color: pitchingColor, fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.06em' }}>
                  Pitcher
                  <TeamLogo logoKey={pitchingIdentity?.teamLogoKey} logoUrl={pitchingIdentity?.teamLogoUrl || pitchingPlayer?.team_logo_url} teamName={pitchingPlayer?.name} height={14} />
                </div>
                <div style={{ fontSize: 16, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{currentPitcherChar?.name || 'No pitcher'}</div>
                <div style={{ color: C.muted, fontSize: 11, fontWeight: 700 }}>{getTeamShortName(identitiesByPlayerId[currentPitcherStint?.player_id]) || playersById[currentPitcherStint?.player_id]?.name || 'Waiting'}</div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
                  <span style={{ color: '#CBD5E1', fontSize: 11, fontWeight: 700 }}>IP {currentPitcherGameLine.ip ?? '0.0'}</span>
                  <span style={{ color: '#CBD5E1', fontSize: 11, fontWeight: 700 }}>H {currentPitcherGameLine.h ?? 0}</span>
                  <span style={{ color: '#CBD5E1', fontSize: 11, fontWeight: 700 }}>R {currentPitcherGameLine.r ?? 0}</span>
                  <span style={{ color: '#CBD5E1', fontSize: 11, fontWeight: 700 }}>ER {currentPitcherGameLine.er ?? 0}</span>
                  <span style={{ color: '#CBD5E1', fontSize: 11, fontWeight: 700 }}>BB {currentPitcherGameLine.bb ?? 0}</span>
                  <span style={{ color: '#CBD5E1', fontSize: 11, fontWeight: 700 }}>K {currentPitcherGameLine.k ?? 0}</span>
                  <span style={{ color: '#CBD5E1', fontSize: 11, fontWeight: 700 }}>P {displayPitchNumber}</span>
                </div>
              </div>
              <div style={{ width: 48, height: 48, borderRadius: '50%', overflow: 'hidden', border: `2px solid ${pitchingColor}`, flexShrink: 0 }}>
                <Avatar name={currentPitcherChar?.name} size={48} />
              </div>
            </div>
          </div>
        </div>
        {/* Inning score strip */}
        <div style={{ overflowX: 'auto', scrollbarWidth: 'none' }}>
          <div style={{ display: 'flex', minWidth: 'max-content', padding: '2px 8px 4px', gap: 1, alignItems: 'flex-start' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginRight: 6, paddingTop: 18 }}>
              {lineScoreRows.map((team) => (
                <div key={team.battingSide} style={{ height: 26, display: 'flex', alignItems: 'center', gap: 4, color: team.color, fontSize: 10, fontWeight: 700 }}>
                  <TeamLogo logoKey={team.logoKey} logoUrl={team.logoUrl} teamName={team.teamName} height={18} />
                  <span>{team.abbreviation}</span>
                </div>
              ))}
            </div>
            {innings.map(inn => {
              // No half-inning is "active" once the game is final, unless the user is
              // deliberately browsing a past inning via viewedInning.
              const isActive = inn === (viewedInning ?? (effectiveGameStatus === 'complete' ? null : currentInning))
              const isExtra  = inn > regulationInnings
              // When looking at the live current inning (not browsing a past one), only the
              // half-inning actually being played should be highlighted, not the whole column.
              const isLiveHalf = isActive && !viewedInning && inn === currentInning && activeBattingSide
              return (
                <div key={inn} onClick={() => setViewedInning(viewedInning === inn ? null : inn)} style={{ display: 'flex', flexDirection: 'column', gap: 2, cursor: 'pointer', width: 30 }}>
                  <div style={{ height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: inn === currentInning ? 700 : 400, color: inn === currentInning ? C.accent : isExtra ? '#F97316' : C.muted, borderBottom: isActive ? `2px solid ${C.accent}` : isExtra ? '2px solid #F97316' : '2px solid transparent' }}>{inn}</div>
                  {lineScoreRows.map((team) => (
                    <div key={team.battingSide} style={{ height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', background: (isLiveHalf ? team.battingSide === activeBattingSide : isActive) ? `${C.accent}20` : 'transparent', border: isExtra ? '1px solid #F9731644' : 'none', borderRadius: 3, fontSize: 13, fontWeight: 700, color: C.text }}>{getLineScoreCellValue({ inning: inn, side: team.battingSide, scoreMap: team.scoreMap, completedHalfCount })}</div>
                  ))}
                </div>
              )
            })}
            {/* R / H / E totals */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginLeft: 8 }}>
              <div style={{ height: 18, display: 'flex', gap: 4 }}>{['R', 'H', 'E'].map(l => <div key={l} style={{ width: 24, textAlign: 'center', fontSize: 10, color: C.muted, fontWeight: 700 }}>{l}</div>)}</div>
              {lineScoreRows.map((team) => (
                <div key={team.battingSide} style={{ height: 26, display: 'flex', gap: 4, alignItems: 'center' }}>
                  <div style={{ width: 24, textAlign: 'center', fontSize: 13, fontWeight: 800, color: team.color }}>{team.runs}</div>
                  <div style={{ width: 24, textAlign: 'center', fontSize: 13, fontWeight: 700 }}>{team.hits}</div>
                  <div style={{ width: 24, textAlign: 'center', fontSize: 13, fontWeight: 700 }}>{team.errors}</div>
                </div>
              ))}
            </div>
            <div style={{ marginLeft: 10, padding: '8px 10px', borderRadius: 12, border: `1px solid ${C.border}`, background: `${C.card}DD`, display: 'flex', flexDirection: 'column', gap: 6, alignSelf: 'center' }}>
              <CountDotRow label="B" count={Math.min(displayBalls, 3)} total={3} activeColor={C.green} inactiveColor={C.border} />
              <CountDotRow label="S" count={Math.min(displayStrikes, 2)} total={2} activeColor={C.accent} inactiveColor={C.border} />
              <CountDotRow label="O" count={Math.min(displayOutsInHalf, 2)} total={2} activeColor={C.red} inactiveColor={C.border} />
            </div>
          </div>
        </div>
        {viewedInning && viewedInning !== currentInning && (
          <button onClick={() => setViewedInning(null)} style={{ display: 'block', width: '100%', background: `${C.accent}22`, color: C.accent, border: 'none', padding: '5px 0', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
            Jump to Current (Inn. {currentInning}) →
          </button>
        )}
      </div>
    </>
  )
}
