import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowRight, MapPin, Moon, Sun } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { useAuth } from '../context/AuthContext'
import { useSeason } from '../context/SeasonContext'
import { useToast } from '../context/ToastContext'
import PlayerTag from '../components/PlayerTag'
import TeamLogo from '../components/TeamLogo'
import { formatSeasonLabel } from '../utils/season'
import { buildScorebookPath } from '../utils/scorebookRouting'
import { getOrderedStadiums, getStadiumTimeLabel, normalizeIsNightForStadium, stadiumTimeToggleDisabled } from '../utils/stadiums'
import { calculateOutsForPa } from '../utils/statsCalculator'
import { buildSeasonTeamIdentity, getTeamPrimaryColor, getTeamShortName } from '../utils/teamIdentity'

function getStatusTone(status) {
  if (status === 'completed') return { bg: 'rgba(34,197,94,0.12)', border: 'rgba(34,197,94,0.35)', color: '#86EFAC' }
  if (status === 'in_progress') return { bg: 'rgba(234,179,8,0.12)', border: 'rgba(234,179,8,0.35)', color: '#FDE68A' }
  return { bg: 'rgba(59,130,246,0.10)', border: 'rgba(59,130,246,0.30)', color: '#93C5FD' }
}

function deriveLiveInningState(outsRecorded = 0) {
  const normalizedOuts = Math.max(0, Number(outsRecorded || 0))
  const halfInning = Math.floor(normalizedOuts / 3)
  return {
    inning: Math.floor(halfInning / 2) + 1,
    isTop: halfInning % 2 === 0,
  }
}

function getGameUpdateText(game, liveOutsByGameId = {}) {
  if (!game) return 'Unavailable'
  if (game.status === 'completed') return 'Final'
  if (game.status === 'in_progress') {
    const { inning, isTop } = deriveLiveInningState(liveOutsByGameId[String(game.id)] || 0)
    return `${isTop ? 'Top' : 'Bottom'} ${inning}`
  }
  if (game.status === 'scheduled') return ''
  return formatSeasonLabel(game.status || '')
}

function shouldShowLiveScore(game) {
  return ['in_progress', 'completed'].includes(game?.status)
}

function getWinningTeamId(game) {
  if (game?.status !== 'completed') return null
  if (game.winner_team_id) return game.winner_team_id
  const homeScore = Number(game.home_score)
  const awayScore = Number(game.away_score)
  if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore) || homeScore === awayScore) return null
  return homeScore > awayScore ? game.home_team_id : game.away_team_id
}

function TeamValue({ value, highlighted = false }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        justifyContent: 'flex-end',
        minWidth: 60,
      }}
    >
      {highlighted ? (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 4,
            minWidth: 44,
            padding: '4px 8px',
            borderRadius: 999,
            border: '1px solid rgba(34,197,94,0.35)',
            background: 'rgba(34,197,94,0.14)',
            color: '#86EFAC',
            fontWeight: 800,
            fontSize: 18,
            lineHeight: 1,
          }}
        >
          <ArrowRight size={12} strokeWidth={2.5} />
          <span>{value}</span>
        </span>
      ) : (
        <span style={{ color: '#F8FAFC', fontWeight: 800, fontSize: 18, textAlign: 'right' }}>{value}</span>
      )}
    </span>
  )
}

function SeasonGameDetail({
  game,
  teamsById,
  playersById,
  identitiesByPlayerId,
  stadiums,
  onClose,
  onStart,
  onSaveStadium,
  savePending,
  canEditStadium,
  showSetup = false,
}) {
  if (!game) return null
  const homeTeam = teamsById[game.home_team_id]
  const awayTeam = teamsById[game.away_team_id]
  const homePlayer = playersById[homeTeam?.player_id]
  const awayPlayer = playersById[awayTeam?.player_id]
  const orderedStadiums = useMemo(() => getOrderedStadiums(stadiums), [stadiums])
  const selectedStadium = orderedStadiums.find((stadium) => stadium.name === game.stadium) || null
  const normalizedIsNight = normalizeIsNightForStadium(selectedStadium, game.is_night)
  return (
    <div className="modal-backdrop">
      <div className="modal-card" style={{ width: 'min(720px, calc(100vw - 32px))' }}>
        <div className="section-head">
          <div>
            <span className="brand-kicker">Week {game.round_number}</span>
            <h2 style={{ margin: '6px 0 0' }}>
              <span style={{ color: getTeamPrimaryColor(identitiesByPlayerId[homeTeam?.player_id], homePlayer?.color) || 'inherit' }}>{getTeamShortName(identitiesByPlayerId[homeTeam?.player_id]) || homePlayer?.name || homeTeam?.team_name || 'Home'}</span>
              {' vs '}
              <span style={{ color: getTeamPrimaryColor(identitiesByPlayerId[awayTeam?.player_id], awayPlayer?.color) || 'inherit' }}>{getTeamShortName(identitiesByPlayerId[awayTeam?.player_id]) || awayPlayer?.name || awayTeam?.team_name || 'Away'}</span>
            </h2>
          </div>
          <span className="player-pill" style={{ borderColor: getStatusTone(game.status).border, color: getStatusTone(game.status).color }}>
            {formatSeasonLabel(game.status)}
          </span>
        </div>
        <div style={{ display: 'grid', gap: 12 }}>
          <div className="summary-grid">
            <article className="summary-card" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span className="muted">Home</span>
              <PlayerTag height={30} identitiesByPlayerId={identitiesByPlayerId} playerId={homeTeam?.player_id} playersById={playersById} showLogo={false} />
            </article>
            <article className="summary-card" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span className="muted">Away</span>
              <PlayerTag height={30} identitiesByPlayerId={identitiesByPlayerId} playerId={awayTeam?.player_id} playersById={playersById} showLogo={false} />
            </article>
          </div>
          <div className="feed-list">
            <div className="feed-row"><strong>Stadium</strong><span>{game.stadium || 'Not selected yet'}</span></div>
            <div className="feed-row"><strong>Time</strong><span>{selectedStadium ? getStadiumTimeLabel(selectedStadium, normalizedIsNight) : (game.is_night ? 'Night' : 'Day')}</span></div>
            {game.status === 'completed' ? <div className="feed-row"><strong>Final</strong><span>{game.home_score}-{game.away_score}</span></div> : null}
          </div>
          {['scheduled', 'in_progress'].includes(game.status) && (!game.stadium || showSetup) ? (
            <section className="panel" style={{ padding: 14, background: 'rgba(15,23,42,0.55)' }}>
              <div style={{ display: 'grid', gap: 12 }}>
                <div>
                  <strong style={{ display: 'block', marginBottom: 4 }}>Stadium Setup</strong>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {canEditStadium
                      ? 'Pick the park and time before starting the game.'
                      : 'The home team controls the stadium selection for this game.'}
                  </span>
                </div>
                <select
                  value={game.stadium || ''}
                  onChange={(event) => {
                    const stadium = orderedStadiums.find((entry) => entry.name === event.target.value)
                    if (!stadium) return
                    onSaveStadium({
                      ...game,
                      stadium: stadium.name,
                      is_night: normalizeIsNightForStadium(stadium, normalizedIsNight),
                    }, true)
                  }}
                  disabled={savePending || !canEditStadium}
                  style={{ width: '100%', borderRadius: 10, border: '1px solid #334155', background: '#0F172A', color: '#E2E8F0', padding: '10px 12px', fontSize: 14 }}
                >
                  <option value="">Select a stadium</option>
                  {orderedStadiums.map((stadium) => (
                    <option key={stadium.id || stadium.name} value={stadium.name}>
                      {stadium.name}
                    </option>
                  ))}
                </select>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                  <button
                    className="ghost-button"
                    onClick={() => onSaveStadium({
                      ...game,
                      stadium: selectedStadium?.name || game.stadium,
                      is_night: !normalizedIsNight,
                    }, true)}
                    type="button"
                    disabled={savePending || !canEditStadium || !selectedStadium || stadiumTimeToggleDisabled(selectedStadium)}
                  >
                    {normalizedIsNight ? <Moon size={16} /> : <Sun size={16} />}
                    <span>{normalizedIsNight ? 'Night Game' : 'Day Game'}</span>
                  </button>
                  {selectedStadium && (selectedStadium.day_only || selectedStadium.night_only) ? (
                    <span className="muted" style={{ fontSize: 12 }}>
                      {selectedStadium.night_only ? 'This stadium is night-only.' : 'This stadium is day-only.'}
                    </span>
                  ) : null}
                </div>
              </div>
            </section>
          ) : null}
        </div>
        <div className="modal-actions">
          <button className="ghost-button" onClick={onClose} type="button">Close</button>
          {['scheduled', 'in_progress'].includes(game.status) ? (
            <button className="solid-button" disabled={!game.stadium} onClick={() => onStart(game)} type="button">
              {game.status === 'scheduled' ? 'Start Game' : 'Resume Game'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function buildWeekGroups(schedule, gamesPerWeek, totalWeeks) {
  const maxRound = Math.max(0, ...schedule.map((game) => Number(game.round_number || 0)))
  if (maxRound <= totalWeeks) {
    return Array.from({ length: totalWeeks }, (_, index) => ({
      week: index + 1,
      games: schedule.filter((game) => Number(game.round_number || 0) === index + 1),
    })).filter((entry) => entry.games.length)
  }

  const sorted = [...schedule].sort((a, b) => Number(a.id) - Number(b.id))
  const groups = []
  for (let i = 0; i < sorted.length; i += gamesPerWeek) {
    groups.push({
      week: groups.length + 1,
      games: sorted.slice(i, i + gamesPerWeek),
    })
  }
  return groups
}

export default function SeasonSchedule() {
  const navigate = useNavigate()
  const { pushToast } = useToast()
  const { player } = useAuth()
  const { currentSeason, schedule, seasonTeams, seasonPlayersById, refreshSeasons, selectedSeasonId } = useSeason()
  const [selectedWeek, setSelectedWeek] = useState(1)
  const [stadiums, setStadiums] = useState([])
  const [gameModal, setGameModal] = useState(null) // { game, editStadium }
  const [savePending, setSavePending] = useState(false)
  const [scheduleOverrides, setScheduleOverrides] = useState({})
  const [liveOutsByGameId, setLiveOutsByGameId] = useState({})

  useEffect(() => {
    supabase.from('stadiums').select('*').then(({ data }) => {
      setStadiums(getOrderedStadiums(data || []))
    })
  }, [])

  useEffect(() => {
    if (!currentSeason?.id) {
      setLiveOutsByGameId({})
      return undefined
    }

    let active = true
    const loadLiveOuts = async () => {
      const { data, error } = await supabase
        .from('season_plate_appearances')
        .select('game_id, result')
        .eq('season_id', currentSeason.id)

      if (error || !active) return

      const next = {}
      for (const pa of data || []) {
        const gameId = String(pa.game_id || '')
        if (!gameId) continue
        next[gameId] = (next[gameId] || 0) + calculateOutsForPa(pa.result)
      }
      setLiveOutsByGameId(next)
    }

    loadLiveOuts()

    const channel = supabase
      .channel(`season-schedule-live-${currentSeason.id}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_plate_appearances', filter: `season_id=eq.${currentSeason.id}` }, () => {
        loadLiveOuts()
      })
      .subscribe()

    return () => {
      active = false
      supabase.removeChannel(channel)
    }
  }, [currentSeason?.id])

  useEffect(() => {
    if (Object.keys(scheduleOverrides).length === 0) return
    setScheduleOverrides((prev) => {
      const next = { ...prev }
      let changed = false
      for (const game of schedule) {
        const id = String(game.id)
        if (next[id] && game.stadium === next[id].stadium) {
          delete next[id]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [schedule])

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
  const gamesPerWeek = useMemo(() => (seasonTeams.length * (seasonTeams.length - 1)) / 2, [seasonTeams.length])
  const weekGroups = useMemo(
    () => buildWeekGroups(schedule, gamesPerWeek, Number(currentSeason?.games_per_matchup || 0)),
    [schedule, gamesPerWeek, currentSeason?.games_per_matchup],
  )
  const selectedWeekGames = (weekGroups.find((entry) => entry.week === selectedWeek)?.games || weekGroups[0]?.games || [])
    .map((game) => scheduleOverrides[String(game.id)] ? { ...game, ...scheduleOverrides[String(game.id)] } : game)

  const canEditStadiumForGame = useCallback((game) => {
    if (!game) return false
    const pickerTeam = teamsById[game.stadium_picker_team_id] || teamsById[game.home_team_id]
    return Boolean(player?.is_commissioner || (pickerTeam?.player_id && String(pickerTeam.player_id) === String(player?.id)))
  }, [player, teamsById])

  const handleSaveStadium = useCallback(async (nextGame, suppressToast = false) => {
    if (!nextGame) return
    setSavePending(true)
    try {
      const { error } = await supabase
        .from('season_schedule')
        .update({
          stadium: nextGame.stadium,
          is_night: Boolean(nextGame.is_night),
        })
        .eq('id', nextGame.id)
      if (error) throw error

      const patch = { stadium: nextGame.stadium, is_night: Boolean(nextGame.is_night) }
      setScheduleOverrides((prev) => ({ ...prev, [String(nextGame.id)]: patch }))
      setGameModal((current) => (
        current && String(current.game.id) === String(nextGame.id)
          ? { ...current, game: { ...current.game, ...patch } }
          : current
      ))
      refreshSeasons(selectedSeasonId).catch(() => {})

      if (!suppressToast) {
        pushToast({ title: 'Stadium updated', message: `${nextGame.stadium} saved for this game.`, type: 'success' })
      }
    } catch (error) {
      pushToast({ title: 'Unable to save stadium', message: error.message, type: 'error' })
    } finally {
      setSavePending(false)
    }
  }, [pushToast])

  const handleStart = async (game) => {
    try {
      if (!game.stadium) {
        const pickerTeam = teamsById[game.stadium_picker_team_id] || teamsById[game.home_team_id]
        pushToast({
          title: 'Stadium required',
          message: canEditStadiumForGame(game)
            ? 'Choose the stadium before opening the scorebook.'
            : `${getTeamShortName(identitiesByPlayerId[pickerTeam?.player_id]) || pickerTeam?.team_name || 'The home team'} must choose the stadium before the scorebook can be opened.`,
          type: 'error',
        })
        return
      }
      if (game.status === 'scheduled') {
        const { error } = await supabase.from('season_schedule').update({ status: 'in_progress' }).eq('id', game.id)
        if (error) throw error
      }
      navigate(buildScorebookPath({ gameId: game.id, source: 'season' }))
    } catch (error) {
      pushToast({ title: 'Unable to open game', message: error.message, type: 'error' })
    }
  }

  if (!currentSeason) {
    return <div className="page-stack"><div className="page-head"><h1>No season selected.</h1></div></div>
  }

  return (
    <div className="page-stack">
      <div className="page-head">
        <div>
          <span className="brand-kicker">Season Schedule</span>
          <h1>{currentSeason.name}</h1>
        </div>
      </div>

      <section className="panel" style={{ padding: 16 }}>
        <div className="section-head">
          <div className="tab-row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {weekGroups.map((group) => (
              <button
                key={group.week}
                className={`tab-button ${selectedWeek === group.week ? 'tab-button-active' : ''}`}
                onClick={() => setSelectedWeek(group.week)}
                type="button"
              >
                Week {group.week}
              </button>
            ))}
          </div>
        </div>

        <div className="summary-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
          {selectedWeekGames.map((game) => {
            const homeTeam = teamsById[game.home_team_id]
            const awayTeam = teamsById[game.away_team_id]
            const tone = getStatusTone(game.status)
            const showScore = shouldShowLiveScore(game)
            const homeValue = showScore ? Number(game.home_score || 0) : (homeTeam ? `${homeTeam.wins}-${homeTeam.losses}` : '--')
            const awayValue = showScore ? Number(game.away_score || 0) : (awayTeam ? `${awayTeam.wins}-${awayTeam.losses}` : '--')
            const winningTeamId = getWinningTeamId(game)
            const updateText = getGameUpdateText(game, liveOutsByGameId)
            return (
              <button
                key={game.id}
                onClick={() => {
                  if (game.stadium) {
                    handleStart(game)
                  } else {
                    setGameModal({ game, editStadium: true })
                  }
                }}
                type="button"
                style={{
                  background: 'linear-gradient(180deg, rgba(30,41,59,0.98), rgba(15,23,42,0.98))',
                  border: `1px solid ${tone.border}`,
                  borderRadius: 18,
                  padding: 16,
                  textAlign: 'left',
                  color: '#E2E8F0',
                  cursor: 'pointer',
                  display: 'grid',
                  gap: 12,
                  boxShadow: '0 14px 28px rgba(2,6,23,0.28)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, alignItems: 'center', minHeight: 28 }}>
                  {updateText ? (
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        padding: '4px 8px',
                        borderRadius: 999,
                        border: `1px solid ${tone.border}`,
                        background: tone.bg,
                        color: tone.color,
                      }}
                    >
                      {updateText}
                    </span>
                  ) : null}
                </div>
                <div style={{ display: 'grid', gap: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <TeamLogo
                        height={56}
                        logoKey={identitiesByPlayerId[homeTeam?.player_id]?.teamLogoKey}
                        logoUrl={identitiesByPlayerId[homeTeam?.player_id]?.teamLogoUrl}
                        teamName={identitiesByPlayerId[homeTeam?.player_id]?.teamName}
                        placeholder
                      />
                      <span style={{ color: '#F8FAFC', fontWeight: 700, fontSize: 14 }}>{getTeamShortName(identitiesByPlayerId[homeTeam?.player_id]) || homeTeam?.team_name || 'Home'}</span>
                    </div>
                    <TeamValue value={homeValue} highlighted={showScore && winningTeamId === game.home_team_id} />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <TeamLogo
                        height={56}
                        logoKey={identitiesByPlayerId[awayTeam?.player_id]?.teamLogoKey}
                        logoUrl={identitiesByPlayerId[awayTeam?.player_id]?.teamLogoUrl}
                        teamName={identitiesByPlayerId[awayTeam?.player_id]?.teamName}
                        placeholder
                      />
                      <span style={{ color: '#F8FAFC', fontWeight: 700, fontSize: 14 }}>{getTeamShortName(identitiesByPlayerId[awayTeam?.player_id]) || awayTeam?.team_name || 'Away'}</span>
                    </div>
                    <TeamValue value={awayValue} highlighted={showScore && winningTeamId === game.away_team_id} />
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', color: '#94A3B8', fontSize: 13 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {canEditStadiumForGame(game) && ['scheduled', 'in_progress'].includes(game.status) ? (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => { e.stopPropagation(); setGameModal({ game, editStadium: true }) }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.stopPropagation()
                            e.preventDefault()
                            setGameModal({ game, editStadium: true })
                          }
                        }}
                        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit', display: 'inline-flex', alignItems: 'center' }}
                        title="Edit stadium"
                      >
                        <MapPin size={14} />
                      </span>
                    ) : (
                      <MapPin size={14} />
                    )}
                    {game.stadium || 'Stadium TBD'}
                  </span>
                </div>
              </button>
            )
          })}
        </div>
      </section>

      <SeasonGameDetail
        game={gameModal?.game || null}
        teamsById={teamsById}
        playersById={playersById}
        identitiesByPlayerId={identitiesByPlayerId}
        stadiums={stadiums}
        onClose={() => setGameModal(null)}
        onStart={handleStart}
        onSaveStadium={handleSaveStadium}
        savePending={savePending}
        canEditStadium={canEditStadiumForGame(gameModal?.game)}
        showSetup={gameModal?.editStadium || false}
      />
    </div>
  )
}
