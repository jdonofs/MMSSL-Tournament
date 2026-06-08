import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import BracketContainer from '../components/BracketContainer'
import { useSeason } from '../context/SeasonContext'
import { useToast } from '../context/ToastContext'
import { supabase } from '../supabaseClient'
import { buildDoubleElimBracket, generateSingleElimBracket } from '../utils/bracketTemplates'
import { buildScorebookPath } from '../utils/scorebookRouting'
import { buildSeasonTeamIdentity } from '../utils/teamIdentity'

function buildPlayoffPicture(seeding, bracketFormat) {
  const templateGames = bracketFormat === 'single_elimination'
    ? generateSingleElimBracket(seeding)
    : buildDoubleElimBracket(seeding)

  return templateGames.map((game, index) => ({
    id: `playoff-picture-${index + 1}`,
    game_code: `P${index + 1}`,
    stage: game.stage,
    status: 'pending',
    team_a_player_id: game.teamA || null,
    team_b_player_id: game.teamB || null,
    winner_player_id: null,
    team_a_runs: 0,
    team_b_runs: 0,
  }))
}

export default function SeasonBracket() {
  const navigate = useNavigate()
  const { pushToast } = useToast()
  const { currentSeason, seasonTeams, schedule, standings, refreshSeasons, seasonPlayersById } = useSeason()

  const teamsById = useMemo(() => Object.fromEntries(seasonTeams.map((team) => [team.id, team])), [seasonTeams])
  const playersById = useMemo(
    () => Object.fromEntries(seasonTeams.map((team) => {
      const p = seasonPlayersById[team.player_id]
      return [team.player_id, { id: team.player_id, name: p?.name || team.team_name || 'TBD', color: p?.color || '#E2E8F0' }]
    })),
    [seasonTeams, seasonPlayersById],
  )
  const identitiesByPlayerId = useMemo(
    () => Object.fromEntries(seasonTeams.map((team) => [team.player_id, buildSeasonTeamIdentity(team)])),
    [seasonTeams],
  )
  const seeding = useMemo(() => standings.map((entry) => entry.player_id), [standings])
  const actualPlayoffGames = useMemo(
    () => schedule
      .filter((game) => Boolean(game.stage))
      .map((game) => ({
        ...game,
        team_a_player_id: teamsById[game.away_team_id]?.player_id || null,
        team_b_player_id: teamsById[game.home_team_id]?.player_id || null,
        winner_player_id: teamsById[game.winner_team_id]?.player_id || null,
        team_a_runs: game.away_score || 0,
        team_b_runs: game.home_score || 0,
      })),
    [schedule, teamsById],
  )
  const showPlayoffPicture = currentSeason && actualPlayoffGames.length === 0 && currentSeason.status !== 'completed'
  const displayGames = useMemo(
    () => (showPlayoffPicture ? buildPlayoffPicture(seeding, currentSeason?.playoff_format || 'double_elimination') : actualPlayoffGames),
    [showPlayoffPicture, seeding, currentSeason?.playoff_format, actualPlayoffGames],
  )

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
        headerNote={showPlayoffPicture ? 'Playoff Picture: if the season ended today, this would be the bracket based on current standings.' : ''}
        identitiesByPlayerId={identitiesByPlayerId}
        onChampionDeclared={async (winnerId) => {
          await supabase.from('seasons').update({ champion_player_id: winnerId, status: 'completed' }).eq('id', currentSeason.id)
          await refreshSeasons(currentSeason.id)
        }}
        onSelectGame={(game) => {
          if (String(game.id).startsWith('playoff-picture-')) return
          if (!game.stadium) {
            pushToast({
              title: 'Stadium required',
              message: 'Set the stadium from the season schedule before opening the scorebook.',
              type: 'error',
            })
            return
          }
          navigate(buildScorebookPath({ gameId: game.id, source: 'season' }))
        }}
        playersById={playersById}
        seeding={seeding}
      />
    </div>
  )
}
