import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Crown, Pencil, Trash2 } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { useToast } from '../context/ToastContext'
import { useTournament } from '../context/TournamentContext'
import { useAuth } from '../context/AuthContext'
import BracketView from '../components/BracketView'
import PlayerTag from '../components/PlayerTag'
import useTournamentTeamIdentity from '../hooks/useTournamentTeamIdentity'
import { buildDoubleElimBracket, generateSingleElimBracket, getRoundRobinSchedule } from '../utils/bracketTemplates'
import { syncBracketStructure } from '../utils/bracketProgression'

function normalizeStageLabel(stage = '') {
  if (stage.includes('CG-2')) return 'Championship Reset'
  if (stage.includes('CG-1')) return 'Championship'
  return stage
}


export default function Bracket() {
  const navigate = useNavigate()
  const { pushToast } = useToast()
  const { viewedTournament, currentTournament, refreshTournaments } = useTournament()
  const { player } = useAuth()
  const isCommissioner = player?.is_commissioner === true

  const tournament = viewedTournament || currentTournament
  const { identitiesByPlayerId } = useTournamentTeamIdentity(tournament?.id)

  const [games, setGames] = useState([])
  const [players, setPlayers] = useState([])
  const [editingGame, setEditingGame] = useState(null)
  const [form, setForm] = useState({ teamA: '', teamB: '' })
  const [showAddGame, setShowAddGame] = useState(false)
  const [addGameForm, setAddGameForm] = useState({ teamA: '', teamB: '', stage: '' })

  useEffect(() => {
    const loadBracket = async () => {
      const [{ data: gamesData }, { data: playersData }] = await Promise.all([
        supabase.from('games').select('*').order('id'),
        supabase.from('players').select('*'),
      ])
      let nextGames = gamesData || []
      if (tournament?.bracket_format === 'double') {
        const tournamentGames = nextGames.filter((game) => game.tournament_id === tournament.id)
        const synced = await syncBracketStructure({ supabase, tournament, games: tournamentGames })
        if (synced.length) {
          const gamesById = new Map(nextGames.map((game) => [game.id, game]))
          synced.forEach((game) => gamesById.set(game.id, game))
          nextGames = Array.from(gamesById.values()).sort((a, b) => a.id - b.id)
        }
      }
      setGames(nextGames)
      setPlayers(playersData || [])
    }
    loadBracket()
    const channel = supabase
      .channel(`bracket-live-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'games' }, loadBracket)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'players' }, loadBracket)
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [tournament?.id, tournament?.bracket_format])

  const playersById = useMemo(() => Object.fromEntries(players.map(p => [p.id, p])), [players])
  const filteredGames = games.filter(g => !tournament || g.tournament_id === tournament.id)
  const champion = players.find(p => p.id === tournament?.champion_player_id)
  const bracketFormat = tournament?.bracket_format || 'double'
  const seeding = tournament?.seeding || []
  const selectedPlayers = tournament?.player_ids || []

  const roundRobinStandings = useMemo(() => {
    if (bracketFormat !== 'round_robin') return null
    const stats = {}
    selectedPlayers.forEach(pid => { stats[pid] = { w: 0, l: 0, rs: 0, ra: 0 } })
    filteredGames.forEach(game => {
      if (game.status !== 'complete' || !game.winner_player_id) return
      const aId = game.team_a_player_id
      const bId = game.team_b_player_id
      if (!aId || !bId || !stats[aId] || !stats[bId]) return
      if (game.winner_player_id === aId) { stats[aId].w++; stats[bId].l++ }
      else { stats[bId].w++; stats[aId].l++ }
      stats[aId].rs += game.team_a_runs || 0; stats[aId].ra += game.team_b_runs || 0
      stats[bId].rs += game.team_b_runs || 0; stats[bId].ra += game.team_a_runs || 0
    })
    return selectedPlayers.map(pid => ({
      player: playersById[pid], ...stats[pid],
      rd: (stats[pid].rs || 0) - (stats[pid].ra || 0),
      pct: (stats[pid].w || 0) + (stats[pid].l || 0) > 0
        ? (stats[pid].w || 0) / ((stats[pid].w || 0) + (stats[pid].l || 0))
        : 0,
    })).sort((a, b) => b.pct - a.pct || b.rd - a.rd)
  }, [bracketFormat, selectedPlayers, filteredGames, playersById])

  const championshipGames = filteredGames.filter(g => g.stage?.includes('Championship') || g.stage?.includes('CG'))
  const championshipResetGame = championshipGames.find(g => g.stage?.includes('Reset') || g.stage?.includes('CG-2'))
  const baseChampionshipGame =
    championshipGames.find(g => g.stage === 'Championship' || g.stage?.includes('CG-1')) ||
    filteredGames.find(g => g.stage?.includes('Winners Final')) ||
    filteredGames[filteredGames.length - 1]
  const completedChampionshipResetGame = championshipResetGame?.status === 'complete' ? championshipResetGame : null
  const completedBaseChampionshipGame = baseChampionshipGame?.status === 'complete' ? baseChampionshipGame : null
  const tournamentDeciderGame = completedChampionshipResetGame || completedBaseChampionshipGame
  const canEndTournament =
    isCommissioner &&
    tournament &&
    tournamentDeciderGame?.winner_player_id &&
    tournament.champion_player_id !== tournamentDeciderGame.winner_player_id

  const saveMatchup = async () => {
    const { error } = await supabase.from('games').update({ team_a_player_id: form.teamA, team_b_player_id: form.teamB }).eq('id', editingGame.id)
    if (error) { pushToast({ title: 'Error', message: error.message, type: 'error' }); return }
    setGames(cur => cur.map(g => g.id === editingGame.id ? { ...g, team_a_player_id: form.teamA, team_b_player_id: form.teamB } : g))
    setEditingGame(null)
  }

  const deleteGame = async (game) => {
    const { error } = await supabase.from('games').delete().eq('id', game.id)
    if (error) { pushToast({ title: 'Error', message: error.message, type: 'error' }); return }
    setGames(cur => cur.filter(g => g.id !== game.id))
    if (editingGame?.id === game.id) setEditingGame(null)
    pushToast({ title: 'Game removed', message: `${game.game_code} removed.`, type: 'success' })
  }

  const toggleChampionshipReset = async () => {
    if (championshipResetGame) { await deleteGame(championshipResetGame); return }
    if (!tournament || !baseChampionshipGame) { pushToast({ title: 'Error', message: 'Set up primary matchup first.', type: 'error' }); return }
    const highestCode = Math.max(...filteredGames.map(g => Number(String(g.game_code || '').replace(/\D/g, '')) || 0), 0)
    const { data, error } = await supabase.from('games').insert({
      tournament_id: tournament.id, game_code: `G${highestCode + 1}`, stage: 'Championship Reset',
      team_a_player_id: baseChampionshipGame.team_a_player_id, team_b_player_id: baseChampionshipGame.team_b_player_id,
      team_a_runs: 0, team_b_runs: 0, status: 'pending',
    }).select().single()
    if (error) { pushToast({ title: 'Error', message: error.message, type: 'error' }); return }
    setGames(cur => [...cur, data])
    pushToast({ title: 'Reset game added', message: `${data.game_code} available.`, type: 'success' })
  }

  const generateBracket = async () => {
    if (!tournament || selectedPlayers.length < 2) { pushToast({ title: 'Error', message: 'Need at least 2 players.', type: 'error' }); return }
    if (filteredGames.some(g => g.status === 'pending')) { pushToast({ title: 'Bracket exists', message: 'Delete existing pending games first.', type: 'error' }); return }
    const highestCode = Math.max(...filteredGames.map(g => Number(String(g.game_code || '').replace(/\D/g, '')) || 0), 0)
    let gameNum = highestCode + 1
    let newGames = []

    if (bracketFormat === 'round_robin') {
      newGames = getRoundRobinSchedule(selectedPlayers).map((m, i) => ({
        tournament_id: tournament.id, game_code: `G${gameNum + i}`, stage: m.stage,
        team_a_player_id: m.teamA, team_b_player_id: m.teamB, team_a_runs: 0, team_b_runs: 0, status: 'pending',
      }))
    } else if (bracketFormat === 'single') {
      newGames = generateSingleElimBracket(seeding).map((g, i) => ({
        tournament_id: tournament.id, game_code: `G${gameNum + i}`, stage: g.stage,
        team_a_player_id: g.teamA, team_b_player_id: g.teamB, team_a_runs: 0, team_b_runs: 0, status: 'pending',
      }))
    } else {
      newGames = buildDoubleElimBracket(seeding).map((g, i) => ({
        tournament_id: tournament.id, game_code: `G${gameNum + i}`, stage: g.stage,
        team_a_player_id: g.teamA, team_b_player_id: g.teamB, team_a_runs: 0, team_b_runs: 0, status: 'pending',
      }))
    }

    const { data, error } = await supabase.from('games').insert(newGames).select()
    if (error) { pushToast({ title: 'Error', message: error.message, type: 'error' }); return }
    setGames(cur => [...cur, ...(data || [])])
    pushToast({ title: 'Bracket generated', message: `${newGames.length} games created.`, type: 'success' })
  }

  const addManualGame = async () => {
    if (!tournament) return
    const highestCode = Math.max(...filteredGames.map(g => Number(String(g.game_code || '').replace(/\D/g, '')) || 0), 0)
    const { data, error } = await supabase.from('games').insert({
      tournament_id: tournament.id, game_code: `G${highestCode + 1}`,
      stage: addGameForm.stage || 'Exhibition',
      team_a_player_id: addGameForm.teamA || null, team_b_player_id: addGameForm.teamB || null,
      team_a_runs: 0, team_b_runs: 0, status: 'pending',
    }).select().single()
    if (error) { pushToast({ title: 'Error', message: error.message, type: 'error' }); return }
    setGames(cur => [...cur, data])
    setShowAddGame(false)
    setAddGameForm({ teamA: '', teamB: '', stage: '' })
    pushToast({ title: 'Game added', message: `${data.game_code} created.`, type: 'success' })
  }

  const endTournament = async () => {
    if (!tournament || !tournamentDeciderGame?.winner_player_id) {
      pushToast({ title: 'Cannot end tournament', message: 'Complete the deciding game first.', type: 'error' })
      return
    }

    const { error } = await supabase
      .from('tournaments')
      .update({
        champion_player_id: tournamentDeciderGame.winner_player_id,
        status: 'complete',
      })
      .eq('id', tournament.id)

    if (error) {
      pushToast({ title: 'Unable to end tournament', message: error.message, type: 'error' })
      return
    }

    await refreshTournaments(tournament.id)
    pushToast({
      title: 'Tournament ended',
      message: `${playersById[tournamentDeciderGame.winner_player_id]?.name || 'Winner'} is now the champion.`,
      type: 'success',
    })
  }

  const formatLabel = bracketFormat === 'round_robin' ? 'Round Robin' : bracketFormat === 'single' ? 'Single Elimination' : 'Double Elimination'

  return (
    <div className="page-stack">
      <div className="page-head">
        <div>
          <span className="brand-kicker">{formatLabel}</span>
          <h1>Bracket</h1>
        </div>
        {champion && (
          <div className="player-pill" style={{ borderColor: champion.color }}>
            <Crown size={16} color="#eab308" />
            <strong><PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} player={champion} /> is champion</strong>
          </div>
        )}
      </div>


      {bracketFormat === 'round_robin' ? (
        <>
          <section className="panel">
            <div className="section-head">
              <h2>Standings</h2>
              <span className="muted">Win % first, run differential as tiebreaker</span>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #334155' }}>
                  {['Player','W','L','RS','RA','RD','PCT'].map(h => (
                    <th key={h} style={{ textAlign: h === 'Player' ? 'left' : 'center', padding: 8, color: '#94A3B8' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {roundRobinStandings?.map((s, i) => (
                  <tr key={s.player?.id || i} style={{ borderBottom: '1px solid #1E293B' }}>
                    <td style={{ padding: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 12, height: 12, borderRadius: '50%', background: s.player?.color || '#666', flexShrink: 0 }} />
                      <PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} player={s.player} />
                    </td>
                    <td style={{ textAlign: 'center', padding: 8 }}>{s.w}</td>
                    <td style={{ textAlign: 'center', padding: 8 }}>{s.l}</td>
                    <td style={{ textAlign: 'center', padding: 8 }}>{s.rs}</td>
                    <td style={{ textAlign: 'center', padding: 8 }}>{s.ra}</td>
                    <td style={{ textAlign: 'center', padding: 8 }}>{s.rd}</td>
                    <td style={{ textAlign: 'center', padding: 8, color: '#EAB308' }}>{(s.pct * 100).toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="panel">
            <div className="section-head">
              <h2>Schedule</h2>
              <span className="muted">All matchups for this tournament</span>
            </div>
            {isCommissioner && (
              <div style={{ marginBottom: 12 }}>
                <button className="ghost-button" onClick={() => setShowAddGame(true)} type="button">+ Add Game</button>
              </div>
            )}
            <div className="feed-list">
              {filteredGames.map(game => (
                <div className="lineup-row" key={game.id}>
                  <button className="ghost-button" onClick={() => navigate(`/scorebook?game=${game.id}`)} type="button">
                    <span style={{ padding: '2px 6px', borderRadius: 4, fontSize: 11, background: game.status === 'complete' ? '#22C55E' : game.status === 'active' ? '#EAB308' : '#334155', color: '#000' }}>
                      {game.status === 'complete' ? '✓' : game.status === 'active' ? '●' : '○'}
                    </span>
                    <span>{game.game_code}</span>
                  </button>
                  <div className="page-stack" style={{ gap: '0.2rem', minWidth: 0 }}>
                    <strong>{game.stage}</strong>
                    <span className="muted"><PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} playerId={game.team_a_player_id} playersById={playersById} /> vs <PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} playerId={game.team_b_player_id} playersById={playersById} /></span>
                  </div>
                  {game.status === 'complete' && <span style={{ color: '#EAB308', fontWeight: 600 }}>{game.team_a_runs}-{game.team_b_runs}</span>}
                  {isCommissioner && <button className="icon-button" onClick={() => deleteGame(game)} type="button"><Trash2 size={14} /></button>}
                </div>
              ))}
            </div>
          </section>
        </>
      ) : bracketFormat === 'single' ? (
        <>
          <section className="panel">
            <div className="section-head">
              <h2>Schedule</h2>
              <span className="muted">Single elimination — one loss and you're out</span>
            </div>
            {isCommissioner && (
              <div style={{ marginBottom: 12 }}>
                <button className="ghost-button" onClick={() => setShowAddGame(true)} type="button">+ Add Game</button>
              </div>
            )}
            <div className="feed-list">
              {filteredGames.map(game => (
                <div className="lineup-row" key={game.id}>
                  <button className="ghost-button" onClick={() => { setEditingGame(game); setForm({ teamA: game.team_a_player_id || '', teamB: game.team_b_player_id || '' }) }} type="button">
                    <Pencil size={14} /><span>{game.game_code}</span>
                  </button>
                  <div className="page-stack" style={{ gap: '0.2rem', minWidth: 0 }}>
                    <strong>{game.stage}</strong>
                    <span className="muted">
                      <span style={{ color: game.status === 'complete' && game.winner_player_id === game.team_a_player_id ? '#4ade80' : game.status === 'complete' ? '#fb7185' : undefined }}>
                        <PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} playerId={game.team_a_player_id} playersById={playersById} />
                      </span>
                      {' vs '}
                      <span style={{ color: game.status === 'complete' && game.winner_player_id === game.team_b_player_id ? '#4ade80' : game.status === 'complete' ? '#fb7185' : undefined }}>
                        <PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} playerId={game.team_b_player_id} playersById={playersById} />
                      </span>
                    </span>
                  </div>
                  {game.status === 'complete' && <span style={{ color: '#EAB308', fontWeight: 600 }}>{game.team_a_runs}-{game.team_b_runs}</span>}
                  {isCommissioner && <button className="icon-button" onClick={() => deleteGame(game)} type="button"><Trash2 size={14} /></button>}
                </div>
              ))}
            </div>
          </section>
        </>
      ) : (
        <>
          <section className="panel">
            <div className="section-head">
              <h2>Bracket Board</h2>
              <span className="muted">Winner's side left, loser's side right</span>
            </div>
            <BracketView games={filteredGames} identitiesByPlayerId={identitiesByPlayerId} onSelectGame={game => navigate(`/scorebook?game=${game.id}`)} playersById={playersById} />
          </section>
          <section className="panel">
            <div className="section-head">
              <h2>Matchup Controls</h2>
              <span className="muted">Manually repair matchups if needed</span>
            </div>
            <div className="inline-actions">
              <button className="ghost-button" onClick={toggleChampionshipReset} type="button">
                {championshipResetGame ? 'Use Winner Take All' : 'Add Reset Game'}
              </button>
              {isCommissioner && <button className="ghost-button" onClick={() => setShowAddGame(true)} type="button">+ Add Game</button>}
              {isCommissioner && (
                <button className="solid-button" disabled={!canEndTournament} onClick={endTournament} type="button">
                  End Tournament
                </button>
              )}
            </div>
            <div className="feed-list">
              {filteredGames.map(game => (
                <div className="lineup-row" key={game.id}>
                  <button className="ghost-button" onClick={() => { setEditingGame(game); setForm({ teamA: game.team_a_player_id || '', teamB: game.team_b_player_id || '' }) }} type="button">
                    <Pencil size={14} /><span>{game.game_code}</span>
                  </button>
                  <div className="page-stack" style={{ gap: '0.2rem', minWidth: 0 }}>
                    <strong>{normalizeStageLabel(game.stage)}</strong>
                    <span className="muted">
                      <span style={{ color: game.status === 'complete' && game.winner_player_id === game.team_a_player_id ? '#4ade80' : game.status === 'complete' ? '#fb7185' : undefined }}>
                        <PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} playerId={game.team_a_player_id} playersById={playersById} />
                      </span>
                      {' vs '}
                      <span style={{ color: game.status === 'complete' && game.winner_player_id === game.team_b_player_id ? '#4ade80' : game.status === 'complete' ? '#fb7185' : undefined }}>
                        <PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} playerId={game.team_b_player_id} playersById={playersById} />
                      </span>
                    </span>
                  </div>
                  <button className="icon-button" onClick={() => deleteGame(game)} type="button"><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      {editingGame && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <div className="section-head">
              <h2>Edit {editingGame.game_code}</h2>
              <span className="muted">{normalizeStageLabel(editingGame.stage)}</span>
            </div>
            <label><span className="muted">Team A</span>
              <select onChange={e => setForm(c => ({ ...c, teamA: e.target.value }))} value={form.teamA}>
                <option value="">Select player</option>
                {players.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <label><span className="muted">Team B</span>
              <select onChange={e => setForm(c => ({ ...c, teamB: e.target.value }))} value={form.teamB}>
                <option value="">Select player</option>
                {players.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <div className="modal-actions">
              <button className="ghost-button" onClick={() => setEditingGame(null)} type="button">Cancel</button>
              <button className="solid-button" onClick={saveMatchup} type="button">Save Matchup</button>
            </div>
          </div>
        </div>
      )}

      {showAddGame && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <div className="section-head"><h2>Add Game</h2></div>
            <label><span className="muted">Stage Name</span>
              <input type="text" value={addGameForm.stage} onChange={e => setAddGameForm(c => ({ ...c, stage: e.target.value }))} placeholder="e.g. Exhibition, Finals" />
            </label>
            <label><span className="muted">Team A</span>
              <select onChange={e => setAddGameForm(c => ({ ...c, teamA: e.target.value }))} value={addGameForm.teamA}>
                <option value="">Select player</option>
                {players.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <label><span className="muted">Team B</span>
              <select onChange={e => setAddGameForm(c => ({ ...c, teamB: e.target.value }))} value={addGameForm.teamB}>
                <option value="">Select player</option>
                {players.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <div className="modal-actions">
              <button className="ghost-button" onClick={() => setShowAddGame(false)} type="button">Cancel</button>
              <button className="solid-button" onClick={addManualGame} type="button">Add Game</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
