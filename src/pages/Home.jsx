import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { format } from 'date-fns'
import { ArrowRight, BookOpenText, Download, ScrollText, Trophy } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { useToast } from '../context/ToastContext'
import { useTournament } from '../context/TournamentContext'
import BracketView from '../components/BracketView'
import PlayerTag from '../components/PlayerTag'
import useTournamentTeamIdentity from '../hooks/useTournamentTeamIdentity'
import { buildStandings } from '../utils/statsCalculator'
import { importTournamentOneWorkbook } from '../utils/dataImport.jsx'

export default function Home() {
  const navigate = useNavigate()
  const { pushToast } = useToast()
  const { currentTournament, refreshTournaments } = useTournament()
  const { identitiesByPlayerId } = useTournamentTeamIdentity(currentTournament?.id)
  const [players, setPlayers] = useState([])
  const [allGames, setAllGames] = useState([])
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)

  useEffect(() => {
    const loadHome = async () => {
      setLoading(true)
      const [{ data: playersData, error: playersError }, { data: gamesData, error: gamesError }] =
        await Promise.all([
          supabase.from('players').select('*').order('name'),
          supabase.from('games').select('*').order('id')
        ])

      const firstError = playersError || gamesError
      if (firstError) {
        pushToast({
          title: 'Unable to load home page',
          message: firstError.message,
          type: 'error'
        })
      } else {
        setPlayers(playersData || [])
        setAllGames(gamesData || [])
      }
      setLoading(false)
    }

    loadHome()
  }, [pushToast])

  useEffect(() => {
    if (!currentTournament?.id) return undefined

    const channel = supabase
      .channel(`home-tournament-${currentTournament.id}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'games', filter: `tournament_id=eq.${currentTournament.id}` }, (payload) => {
        setAllGames((current) => {
          const next = [...current]
          const index = next.findIndex((game) => game.id === payload.new?.id || game.id === payload.old?.id)
          if (payload.eventType === 'INSERT' && payload.new) return [...next, payload.new]
          if (payload.eventType === 'UPDATE' && payload.new && index >= 0) {
            next[index] = payload.new
            return next
          }
          if (payload.eventType === 'DELETE' && payload.old && index >= 0) {
            next.splice(index, 1)
            return next
          }
          return next
        })
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'players' }, async () => {
        const { data } = await supabase.from('players').select('*').order('name')
        setPlayers(data || [])
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [currentTournament?.id])

  const playersById = useMemo(
    () => Object.fromEntries(players.map((player) => [player.id, player])),
    [players]
  )

  const games = allGames.filter((game) => !currentTournament || game.tournament_id === currentTournament.id)

  const currentGame = games.find((game) => game.status === 'active')
  const recentResults = games.filter((game) => game.status === 'complete').slice(-5).reverse()
  const standings = buildStandings(games, players)

  const handleImportTournamentOne = async () => {
    setImporting(true)
    try {
      const tournament = await importTournamentOneWorkbook()
      await refreshTournaments(tournament.id)
      const { data: refreshedGames } = await supabase.from('games').select('*').order('id')
      setAllGames(refreshedGames || [])
      pushToast({
        title: 'Tournament 1 imported',
        message: 'Historical draft, bracket, lineups, batting, and pitching data are now available.',
        type: 'success'
      })
    } catch (importError) {
      pushToast({
        title: 'Import failed',
        message: importError.message,
        type: 'error'
      })
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="page-stack">
      <div className="page-head">
        <div>
          <span className="brand-kicker">Tournament Overview</span>
          <h1>{loading ? 'Loading tournament...' : currentTournament ? `Tournament ${currentTournament.tournament_number}` : 'No tournaments imported yet'}</h1>
        </div>
        <div className="inline-actions">
          <button className="ghost-button" disabled={importing} onClick={handleImportTournamentOne} type="button">
            <Download size={16} />
            {importing ? 'Importing...' : 'Import Tournament 1'}
          </button>
          <div className="player-pill">
            <span>Status</span>
            <strong>{currentTournament?.status || 'pending'}</strong>
          </div>
        </div>
      </div>

      <div className="summary-grid">
        <article className="summary-card">
          <span className="muted">Date</span>
          <h2>{currentTournament?.date ? format(new Date(currentTournament.date), 'MMM d, yyyy') : 'TBD'}</h2>
        </article>
        <article className="summary-card">
          <span className="muted">Players</span>
          <h2>{currentTournament?.player_count || players.length || 0}</h2>
        </article>
        <article className="summary-card">
          <span className="muted">Games Logged</span>
          <h2>{games.length}</h2>
        </article>
        <article className="summary-card">
          <span className="muted">Completed</span>
          <h2>{games.filter((game) => game.status === 'complete').length}</h2>
        </article>
      </div>

      {!currentTournament ? (
        <section className="panel">
          <h2>No tournament history yet</h2>
          <p className="muted">Use the import button above to load Tournament 1 from the workbook data and unlock historical browsing across the app.</p>
        </section>
      ) : null}

      <div className="home-grid">
        <section className="panel">
          <div className="section-head">
            <h2>Bracket Preview</h2>
            <button className="ghost-button" onClick={() => navigate('/bracket')} type="button">
              <span>Open Full Bracket</span>
              <ArrowRight size={16} />
            </button>
          </div>
          <BracketView compact games={games} identitiesByPlayerId={identitiesByPlayerId} onSelectGame={(game) => navigate(`/scorebook?game=${game.id}`)} playersById={playersById} />
        </section>

        <div className="page-stack">
          <section className="panel">
            <div className="section-head">
              <h2>Current Game</h2>
              <span className={`status-pill status-${currentGame?.status || 'pending'}`}>{currentGame?.status || 'No live game'}</span>
            </div>
            {currentGame ? (
              <div className="feed-list">
                <div className="feed-row">
                  <strong
                    style={{
                      color:
                        currentGame.status === 'complete'
                          ? currentGame.winner_player_id === currentGame.team_a_player_id
                            ? '#4ade80'
                            : '#fb7185'
                          : undefined
                    }}
                  >
                    <PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} playerId={currentGame.team_a_player_id} playersById={playersById} />
                  </strong>
                  <strong>{currentGame.team_a_runs}</strong>
                </div>
                <div className="feed-row">
                  <strong
                    style={{
                      color:
                        currentGame.status === 'complete'
                          ? currentGame.winner_player_id === currentGame.team_b_player_id
                            ? '#4ade80'
                            : '#fb7185'
                          : undefined
                    }}
                  >
                    <PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} playerId={currentGame.team_b_player_id} playersById={playersById} />
                  </strong>
                  <strong>{currentGame.team_b_runs}</strong>
                </div>
                <button className="solid-button" onClick={() => navigate(`/scorebook?game=${currentGame.id}`)} type="button">
                  <BookOpenText size={16} />
                  <span>Open Scorebook</span>
                </button>
              </div>
            ) : (
              <p className="muted">No game is currently marked active.</p>
            )}
          </section>

          <section className="panel">
            <div className="section-head">
              <h2>Quick Links</h2>
            </div>
            <div className="inline-actions">
              <button className="ghost-button" onClick={() => navigate('/draft')} type="button"><ScrollText size={16} />Draft</button>
              <button className="ghost-button" onClick={() => navigate('/scorebook')} type="button"><BookOpenText size={16} />Scorebook</button>
              <button className="ghost-button" onClick={() => navigate('/betting')} type="button"><Trophy size={16} />Betting</button>
            </div>
          </section>

          <section className="panel">
            <div className="section-head">
              <h2>Recent Results</h2>
            </div>
            <div className="feed-list">
              {recentResults.map((game) => (
                <div className="feed-row" key={game.id}>
                  <span>{game.game_code}</span>
                  <strong style={{ color: '#4ade80' }}><PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} playerId={game.winner_player_id} playersById={playersById} /></strong>
                  <span className="muted">
                    over{' '}
                    <span style={{ color: '#fb7185' }}>
                      <PlayerTag
                        height={24}
                        identitiesByPlayerId={identitiesByPlayerId}
                        playerId={game.winner_player_id === game.team_a_player_id ? game.team_b_player_id : game.team_a_player_id}
                        playersById={playersById}
                      />
                    </span>{' '}
                    {game.team_a_runs}-{game.team_b_runs}
                  </span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>

      <section className="table-card">
        <div className="section-head">
          <h2>Standings</h2>
          <span className="muted">W/L, runs scored, runs allowed, and run differential</span>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Player</th>
              <th>W</th>
              <th>L</th>
              <th>RS</th>
              <th>RA</th>
              <th>RD</th>
            </tr>
          </thead>
          <tbody>
            {standings.map((row) => (
              <tr key={row.playerId}>
                <td><PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} playerId={row.playerId} playersById={playersById} /></td>
                <td>{row.wins}</td>
                <td>{row.losses}</td>
                <td>{row.runsFor}</td>
                <td>{row.runsAgainst}</td>
                <td>{row.runDiff}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  )
}
