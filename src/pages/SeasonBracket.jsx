import { useMemo } from 'react'
import BracketContainer from '../components/BracketContainer'
import { useSeason } from '../context/SeasonContext'
import { buildDoubleElimBracket, generateSingleElimBracket } from '../utils/bracketTemplates'
import { sortSeasonPlayoffGames } from '../utils/seasonPlayoffs'
import { buildSeasonTeamIdentity, getTeamShortName } from '../utils/teamIdentity'

function buildPlayoffPicture(seeding, bracketFormat) {
  const templateGames = bracketFormat === 'single_elimination'
    ? generateSingleElimBracket(seeding)
    : buildDoubleElimBracket(seeding)

  return templateGames.map((game, index) => ({
    id: `playoff-picture-${index + 1}`,
    game_code: `P${index + 1}`,
    stage: game.stage,
    status: 'pending',
    // Season playoff schedule rows treat template teamA as the home slot.
    // Bracket cards display away on top and home on bottom, so flip here.
    team_a_player_id: game.teamB || null,
    team_b_player_id: game.teamA || null,
    winner_player_id: null,
    team_a_runs: 0,
    team_b_runs: 0,
  }))
}

export default function SeasonBracket() {
  const { currentSeason, seasonTeams, schedule, standings, seasonPlayersById } = useSeason()

  const teamsById = useMemo(() => Object.fromEntries(seasonTeams.map((team) => [team.id, team])), [seasonTeams])
  const playersById = useMemo(
    () => Object.fromEntries(seasonTeams.map((team) => {
      const player = seasonPlayersById[team.player_id]
      return [team.player_id, { id: team.player_id, name: player?.name || team.team_name || 'TBD', color: player?.color || '#E2E8F0' }]
    })),
    [seasonTeams, seasonPlayersById],
  )
  const identitiesByPlayerId = useMemo(
    () => Object.fromEntries(seasonTeams.map((team) => [team.player_id, buildSeasonTeamIdentity(team)])),
    [seasonTeams],
  )
  const seeding = useMemo(() => standings.map((entry) => entry.player_id), [standings])
  const actualPlayoffGames = useMemo(
    () => sortSeasonPlayoffGames(
      schedule.filter((game) => Boolean(game.stage)),
      currentSeason?.playoff_format,
      seasonTeams.length,
    ).map((game) => ({
      ...game,
      team_a_player_id: teamsById[game.away_team_id]?.player_id || null,
      team_b_player_id: teamsById[game.home_team_id]?.player_id || null,
      winner_player_id: teamsById[game.winner_team_id]?.player_id || null,
      team_a_runs: game.away_score || 0,
      team_b_runs: game.home_score || 0,
    })),
    [currentSeason?.playoff_format, schedule, seasonTeams.length, teamsById],
  )
  const showPlayoffPicture = currentSeason && actualPlayoffGames.length === 0 && currentSeason.status !== 'completed'
  const displayGames = useMemo(
    () => (showPlayoffPicture ? buildPlayoffPicture(seeding, currentSeason?.playoff_format || 'double_elimination') : actualPlayoffGames),
    [showPlayoffPicture, seeding, currentSeason?.playoff_format, actualPlayoffGames],
  )
  const championLabel = useMemo(() => {
    const championId = currentSeason?.champion_player_id
    if (!championId) return ''
    return getTeamShortName(identitiesByPlayerId[championId]) || playersById[championId]?.name || 'Champion'
  }, [currentSeason?.champion_player_id, identitiesByPlayerId, playersById])
  const headerNote = showPlayoffPicture
    ? 'Playoff Picture: if the season ended today, this would be the bracket based on current standings.'
    : championLabel
      ? `Champion: ${championLabel}. Play postseason games from Season Schedule > Playoffs.`
      : 'Play postseason games from Season Schedule > Playoffs.'

  if (!currentSeason) {
    return <div className="page-stack"><div className="page-head"><h1>No season selected.</h1></div></div>
  }

  return (
    <div className="page-stack">
      <div className="page-head">
        <div>
          <span className="brand-kicker">Season Playoffs</span>
          <h1>{currentSeason.name}</h1>
        </div>
      </div>
      <BracketContainer
        bracketFormat={currentSeason.playoff_format}
        games={displayGames}
        headerNote={headerNote}
        identitiesByPlayerId={identitiesByPlayerId}
        playersById={playersById}
        seeding={seeding}
      />
    </div>
  )
}
