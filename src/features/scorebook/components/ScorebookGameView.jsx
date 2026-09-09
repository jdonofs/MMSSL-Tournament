import MiddleClickLink from '../../../components/MiddleClickLink'
import TeamLogo from '../../../components/TeamLogo'
import { getTeamShortName } from '../../../utils/teamIdentity'
import { formatBaseballAverage, formatHitsAtBats } from '../domain/display'
import { formatGameStatusLabel, normalizeStageLabel } from '../domain/scoreboard'
import { EditStadiumModal, StadiumHeaderPill } from './StadiumControls'
import { Avatar, BaseStateDiamond, CountDotRow, SectionCard } from './ScorebookPrimitives'
import { BoxScoreTable, LineupStatsTable, PitchingStatsTable, WinProbabilityCard } from './ScorebookStatsTables'
import { C } from './theme'

export default function ScorebookGameView({
  toolbar,
  tabs,
  game,
  teams,
  matchup,
  tables,
  actions,
  stadiumModal,
}) {
  const {
    selectedGame,
    effectiveGameStatus,
    regulationInnings,
    selectedStadium,
    isScorekeeper,
  } = game
  const {
    homeAwaySwapped,
    scores,
    identitiesByPlayerId,
    teamAAbbreviation,
    teamAName,
    teamAColor,
    teamALogoKey,
    teamALogoUrl,
    teamBAbbreviation,
    teamBName,
    teamBColor,
    teamBLogoKey,
    teamBLogoUrl,
    battingIdentity,
    battingPlayer,
    battingColor,
    pitchingIdentity,
    pitchingPlayer,
    pitchingColor,
  } = teams
  const {
    offense,
    pitcherDecisionSummary,
    charactersById,
    currentBatterLink,
    currentBatter,
    lineupStatsByEntryKey,
    currentEntryKey,
    currentBatterGameSummary,
    displayRunners,
    displayBalls,
    displayStrikes,
    displayOutsInHalf,
    currentPitcherLink,
    currentPitcherChar,
    currentPitcherGameLine,
    displayPitchNumber,
  } = matchup
  const {
    innings,
    completedHalfCount,
    currentInning,
    isNarrowViewport,
    activeBattingSide,
    winProbabilityPoints,
    currentWinProbability,
    viewedLineupSide,
    teamALineup,
    teamBLineup,
    teamAPitching,
    teamBPitching,
    pitcherDecisionLabels,
    pitchingSourceStatsByCharacterKey,
  } = tables
  const { openStadiumEditModal, setViewedLineupSide, getCharacterLinkTarget } = actions

  return (
    <div style={{ color: C.text, paddingBottom: 40, margin: '-1.25rem -1.25rem 0' }}>
      {toolbar}
      {tabs}
      <div style={{ padding: '8px 10px 32px', display: 'grid', gap: 12 }}>
        <SectionCard
          title={selectedGame.stage ? normalizeStageLabel(selectedGame.stage) : ''}
          right={(
            <div style={{ textAlign: 'right' }}>
              <div style={{ color: effectiveGameStatus === 'complete' ? C.green : effectiveGameStatus === 'active' ? C.accent : '#93C5FD', fontSize: 12, fontWeight: 800, textTransform: 'uppercase' }}>
                {formatGameStatusLabel(selectedGame, effectiveGameStatus, offense?.halfLabel, regulationInnings)}
              </div>
            </div>
          )}
        >
          <div style={{ display: 'grid', gap: 14 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <StadiumHeaderPill stadium={selectedStadium} isNight={selectedGame?.is_night} onEdit={isScorekeeper ? openStadiumEditModal : undefined} />
            </div>
            <div style={{ display: 'grid', gap: 10 }}>
              {(() => {
                const teamARow = { key: homeAwaySwapped ? 'home' : 'away', abbreviation: teamAAbbreviation, name: teamAName, color: teamAColor, logoKey: teamALogoKey, logoUrl: teamALogoUrl, score: scores.a, playerId: selectedGame.team_a_player_id }
                const teamBRow = { key: homeAwaySwapped ? 'away' : 'home', abbreviation: teamBAbbreviation, name: teamBName, color: teamBColor, logoKey: teamBLogoKey, logoUrl: teamBLogoUrl, score: scores.b, playerId: selectedGame.team_b_player_id }
                return teamARow.key === 'away' ? [teamARow, teamBRow] : [teamBRow, teamARow]
              })().map((team) => (
                <div key={team.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', padding: '12px 14px', borderRadius: 14, border: `1px solid ${C.border}`, background: 'rgba(15,23,42,0.58)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                    <TeamLogo logoKey={team.logoKey} logoUrl={team.logoUrl} teamName={team.name} height={30} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ color: team.color, fontSize: 11, fontWeight: 800, textTransform: 'uppercase' }}>{team.abbreviation} · {team.key === 'away' ? 'Away' : 'Home'}</div>
                      <div style={{ color: '#F8FAFC', fontSize: 16, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{getTeamShortName(identitiesByPlayerId[team.playerId]) || team.name}</div>
                    </div>
                  </div>
                  <div style={{ color: team.color, fontSize: 34, fontWeight: 900, lineHeight: 1 }}>{team.score}</div>
                </div>
              ))}
            </div>
            {effectiveGameStatus === 'complete' ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
                {[
                  { label: 'Winning Pitcher', tone: C.green, stint: pitcherDecisionSummary.winning },
                  { label: 'Losing Pitcher', tone: C.red, stint: pitcherDecisionSummary.losing },
                ].map((entry) => {
                  const link = entry.stint ? getCharacterLinkTarget(entry.stint.character_id) : null
                  return (
                    <MiddleClickLink key={entry.label} to={link?.to} state={link?.state} style={{ borderRadius: 14, border: `1px solid ${entry.tone}44`, background: `${entry.tone}14`, padding: 12, display: 'flex', alignItems: 'center', gap: 10, cursor: link ? 'pointer' : 'default', color: 'inherit', textDecoration: 'none' }}>
                      <div style={{ width: 42, height: 42, borderRadius: '50%', overflow: 'hidden', border: `2px solid ${entry.tone}` }}>
                        <Avatar name={charactersById[entry.stint?.character_id]?.name} size={42} />
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ color: entry.tone, fontSize: 11, fontWeight: 800, textTransform: 'uppercase' }}>{entry.label}</div>
                        <div style={{ color: '#F8FAFC', fontSize: 14, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{charactersById[entry.stint?.character_id]?.name || 'Not recorded'}</div>
                        <div style={{ color: C.muted, fontSize: 12 }}>{entry.stint ? `IP ${entry.stint.innings_pitched ?? 0} / H ${entry.stint.hits_allowed ?? 0} / R ${entry.stint.runs_allowed ?? 0}` : 'Decision unavailable'}</div>
                      </div>
                    </MiddleClickLink>
                  )
                })}
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
                <div style={{ borderRadius: 14, border: `1px solid ${C.border}`, background: 'rgba(15,23,42,0.58)', padding: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: C.muted, fontSize: 11, fontWeight: 800, textTransform: 'uppercase', marginBottom: 8 }}>
                    <TeamLogo logoKey={battingIdentity?.teamLogoKey} logoUrl={battingIdentity?.teamLogoUrl || battingPlayer?.team_logo_url} teamName={battingPlayer?.name} height={14} />
                    Current Batter
                  </div>
                  <MiddleClickLink to={currentBatterLink?.to} state={currentBatterLink?.state} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: currentBatter ? 'pointer' : 'default', color: 'inherit', textDecoration: 'none' }}>
                    <div style={{ width: 42, height: 42, borderRadius: '50%', overflow: 'hidden', border: `2px solid ${battingColor}` }}>
                      <Avatar name={charactersById[currentBatter?.character_id]?.name} size={42} />
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ color: '#F8FAFC', fontSize: 14, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{charactersById[currentBatter?.character_id]?.name || 'Waiting on lineup'}</div>
                      <div style={{ color: C.muted, fontSize: 12 }}>{currentBatter ? `AVG ${formatBaseballAverage(lineupStatsByEntryKey[currentEntryKey]?.source || {})} / ${formatHitsAtBats(currentBatterGameSummary)}` : 'No batter yet'}</div>
                    </div>
                  </MiddleClickLink>
                </div>
                <div style={{ borderRadius: 14, border: `1px solid ${C.border}`, background: 'rgba(15,23,42,0.58)', padding: 12, display: 'grid', justifyItems: 'center', gap: 8 }}>
                  <div style={{ color: C.muted, fontSize: 11, fontWeight: 800, textTransform: 'uppercase' }}>{offense?.halfLabel || 'Top 1'}</div>
                  <BaseStateDiamond runners={displayRunners} charactersById={charactersById} />
                  <div style={{ display: 'grid', gap: 6, justifyItems: 'center' }}>
                    <CountDotRow label="B" count={Math.min(displayBalls, 3)} total={3} activeColor={C.green} inactiveColor={C.border} />
                    <CountDotRow label="S" count={Math.min(displayStrikes, 2)} total={2} activeColor={C.accent} inactiveColor={C.border} />
                    <CountDotRow label="O" count={Math.min(displayOutsInHalf, 2)} total={2} activeColor={C.red} inactiveColor={C.border} />
                  </div>
                </div>
                <div style={{ borderRadius: 14, border: `1px solid ${C.border}`, background: 'rgba(15,23,42,0.58)', padding: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: C.muted, fontSize: 11, fontWeight: 800, textTransform: 'uppercase', marginBottom: 8 }}>
                    <TeamLogo logoKey={pitchingIdentity?.teamLogoKey} logoUrl={pitchingIdentity?.teamLogoUrl || pitchingPlayer?.team_logo_url} teamName={pitchingPlayer?.name} height={14} />
                    Current Pitcher
                  </div>
                  <MiddleClickLink to={currentPitcherLink?.to} state={currentPitcherLink?.state} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: currentPitcherChar ? 'pointer' : 'default', color: 'inherit', textDecoration: 'none' }}>
                    <div style={{ width: 42, height: 42, borderRadius: '50%', overflow: 'hidden', border: `2px solid ${pitchingColor}` }}>
                      <Avatar name={currentPitcherChar?.name} size={42} />
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ color: '#F8FAFC', fontSize: 14, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{currentPitcherChar?.name || 'Waiting on pitcher'}</div>
                      <div style={{ color: C.muted, fontSize: 12 }}>IP {currentPitcherGameLine.ip ?? 0} / H {currentPitcherGameLine.h ?? 0} / R {currentPitcherGameLine.r ?? 0} / K {currentPitcherGameLine.k ?? 0}</div>
                      <div style={{ color: C.muted, fontSize: 12 }}>Pitch Count {displayPitchNumber}</div>
                    </div>
                  </MiddleClickLink>
                </div>
              </div>
            )}
          </div>
        </SectionCard>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
          <SectionCard title="Box Score" subtitle="Line score by inning">
            <BoxScoreTable innings={innings} scores={scores} completedHalfCount={completedHalfCount} currentInning={currentInning} teamAAbbreviation={teamAAbbreviation} teamBAbbreviation={teamBAbbreviation} teamAColor={teamAColor} teamBColor={teamBColor} teamALogoKey={teamALogoKey} teamALogoUrl={teamALogoUrl} teamBLogoKey={teamBLogoKey} teamBLogoUrl={teamBLogoUrl} teamAName={teamAName} teamBName={teamBName} compact={isNarrowViewport} swapped={homeAwaySwapped} activeBattingSide={activeBattingSide} />
          </SectionCard>
          <WinProbabilityCard points={winProbabilityPoints} currentHomeProbability={homeAwaySwapped ? 1 - currentWinProbability : currentWinProbability} homeLabel={homeAwaySwapped ? teamAAbbreviation : teamBAbbreviation} awayLabel={homeAwaySwapped ? teamBAbbreviation : teamAAbbreviation} homeColor={homeAwaySwapped ? teamAColor : teamBColor} awayColor={homeAwaySwapped ? teamBColor : teamAColor} />
        </div>

        {isNarrowViewport ? (
          <div style={{ display: 'grid', gap: 12 }}>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              {[
                { side: 'A', abbreviation: teamAAbbreviation, name: teamAName, color: teamAColor, logoKey: teamALogoKey, logoUrl: teamALogoUrl },
                { side: 'B', abbreviation: teamBAbbreviation, name: teamBName, color: teamBColor, logoKey: teamBLogoKey, logoUrl: teamBLogoUrl },
              ].map(({ side, abbreviation, name, color, logoKey, logoUrl }) => (
                <button key={side} type="button" onClick={() => setViewedLineupSide(side)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderRadius: 12, border: `2px solid ${viewedLineupSide === side ? color : C.border}`, background: viewedLineupSide === side ? `${color}22` : 'transparent', color: viewedLineupSide === side ? color : C.muted, fontWeight: 800, fontSize: 13, cursor: 'pointer' }}>
                  <TeamLogo logoKey={logoKey} logoUrl={logoUrl} teamName={name} height={24} />
                  {abbreviation}
                </button>
              ))}
            </div>
            {viewedLineupSide === 'A' ? (
              <LineupStatsTable title={`${teamAAbbreviation} Lineup`} lineup={teamALineup} statsByEntryKey={lineupStatsByEntryKey} currentEntryKey={currentEntryKey} teamColor={teamAColor} charactersById={charactersById} getCharacterLink={getCharacterLinkTarget} />
            ) : (
              <LineupStatsTable title={`${teamBAbbreviation} Lineup`} lineup={teamBLineup} statsByEntryKey={lineupStatsByEntryKey} currentEntryKey={currentEntryKey} teamColor={teamBColor} charactersById={charactersById} getCharacterLink={getCharacterLinkTarget} />
            )}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
            <LineupStatsTable title={`${teamAAbbreviation} Lineup`} lineup={teamALineup} statsByEntryKey={lineupStatsByEntryKey} currentEntryKey={currentEntryKey} teamColor={teamAColor} charactersById={charactersById} getCharacterLink={getCharacterLinkTarget} />
            <LineupStatsTable title={`${teamBAbbreviation} Lineup`} lineup={teamBLineup} statsByEntryKey={lineupStatsByEntryKey} currentEntryKey={currentEntryKey} teamColor={teamBColor} charactersById={charactersById} getCharacterLink={getCharacterLinkTarget} />
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
          <PitchingStatsTable title={`${teamAAbbreviation} Pitchers`} stints={teamAPitching} decisionLabels={pitcherDecisionLabels} charactersById={charactersById} getCharacterLink={getCharacterLinkTarget} sourceStatsByCharacterKey={pitchingSourceStatsByCharacterKey} />
          <PitchingStatsTable title={`${teamBAbbreviation} Pitchers`} stints={teamBPitching} decisionLabels={pitcherDecisionLabels} charactersById={charactersById} getCharacterLink={getCharacterLinkTarget} sourceStatsByCharacterKey={pitchingSourceStatsByCharacterKey} />
        </div>
      </div>
      {stadiumModal.open && (
        <EditStadiumModal stadiums={stadiumModal.stadiums} stadiumEditForm={stadiumModal.form} setStadiumEditForm={stadiumModal.setForm} onSave={stadiumModal.onSave} onClose={stadiumModal.onClose} saving={stadiumModal.saving} />
      )}
    </div>
  )
}
