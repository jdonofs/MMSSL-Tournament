import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, MapPin, Moon, Sun } from 'lucide-react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { fetchAllRows } from '../utils/fetchAllRows'
import { useAuth } from '../context/AuthContext'
import { useSeason } from '../context/SeasonContext'
import { useToast } from '../context/ToastContext'
import PlayerTag from '../components/PlayerTag'
import TeamLogo from '../components/TeamLogo'
import { getFinalStatusLabel } from '../utils/gameRules'
import { formatSeasonLabel } from '../utils/season'
import { buildScorebookPath } from '../utils/scorebookRouting'
import { getOrderedStadiums, getStadiumTimeLabel, normalizeIsNightForStadium, stadiumTimeToggleDisabled } from '../utils/stadiums'
import { calculateOutsForPa } from '../utils/statsCalculator'
import { sortSeasonPlayoffGames } from '../utils/seasonPlayoffs'
import { buildSeasonTeamIdentity, getTeamPrimaryColor, getTeamShortName } from '../utils/teamIdentity'
import { applyTrackerLiveStateToGame } from '../utils/trackerLiveFeed'

function getStatusTone(status) {
  if (status === 'completed') return { bg: 'rgba(34,197,94,0.12)', border: 'rgba(34,197,94,0.35)', color: '#86EFAC', pillClass: 'status-complete' }
  if (status === 'in_progress') return { bg: 'rgba(234,179,8,0.12)', border: 'rgba(234,179,8,0.35)', color: '#FDE68A', pillClass: 'status-live' }
  return { bg: 'rgba(59,130,246,0.10)', border: 'rgba(59,130,246,0.30)', color: '#93C5FD', pillClass: 'status-scheduled' }
}

function deriveLiveInningState(outsRecorded = 0) {
  const normalizedOuts = Math.max(0, Number(outsRecorded || 0))
  const halfInning = Math.floor(normalizedOuts / 3)
  return {
    inning: Math.floor(halfInning / 2) + 1,
    isTop: halfInning % 2 === 0,
  }
}

function getGameUpdateText(game, liveOutsByGameId = {}, regulationInnings) {
  if (!game) return 'Unavailable'
  if (game.status === 'completed') return getFinalStatusLabel(game, regulationInnings)
  if (game.status === 'in_progress') {
    const persistedInning = Number(game.current_inning || game.live_state?.inning || 0)
    const persistedIsTop = game.is_top_inning ?? game.live_state?.isTop ?? game.live_state?.is_top
    const { inning, isTop } = persistedInning > 0
      ? { inning: persistedInning, isTop: persistedIsTop !== false }
      : deriveLiveInningState(liveOutsByGameId[String(game.id)] || 0)
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

function TeamValue({ record, score, outcome = null }) {
  if (record != null) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'baseline', justifyContent: 'flex-end', gap: 4, minWidth: 60 }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: '#64748B' }}>W-L</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)' }}>{record}</span>
      </span>
    )
  }

  const isWinner = outcome === 'win'
  const isLoser = outcome === 'lose'
  return (
    <span
      style={{
        display: 'inline-flex',
        justifyContent: 'flex-end',
        minWidth: 60,
        fontWeight: 800,
        fontSize: 18,
        color: isWinner ? 'var(--success)' : isLoser ? 'var(--muted)' : '#F8FAFC',
      }}
    >
      {score}
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
  onSaveSetup,
  savePending,
  startPending,
  canEditStadium,
  canShowStartGame = false,
  canStartGame = true,
  lockReason = '',
  showSetup = false,
  regulationInnings,
}) {
  const orderedStadiums = useMemo(() => getOrderedStadiums(stadiums), [stadiums])
  const [selectedStadiumName, setSelectedStadiumName] = useState('')
  const [selectedIsNight, setSelectedIsNight] = useState(false)

  useEffect(() => {
    if (!game) {
      setSelectedStadiumName('')
      setSelectedIsNight(false)
      return
    }
    const initialStadium = orderedStadiums.find((stadium) => stadium.name === game.stadium) || null
    setSelectedStadiumName(game.stadium || '')
    setSelectedIsNight(normalizeIsNightForStadium(initialStadium, game.is_night))
  }, [game, orderedStadiums])

  if (!game) return null

  const homeTeam = teamsById[game.home_team_id]
  const awayTeam = teamsById[game.away_team_id]
  const homePlayer = playersById[homeTeam?.player_id]
  const awayPlayer = playersById[awayTeam?.player_id]
  const selectedStadium = orderedStadiums.find((stadium) => stadium.name === selectedStadiumName) || null
  const normalizedIsNight = normalizeIsNightForStadium(selectedStadium, selectedIsNight)
  const displayStadium = showSetup ? selectedStadiumName : game.stadium
  const displayIsNight = showSetup ? normalizedIsNight : normalizeIsNightForStadium(
    orderedStadiums.find((stadium) => stadium.name === game.stadium) || null,
    game.is_night,
  )
  const hasResolvedMatchup = Boolean(homeTeam && awayTeam)
  const canSaveSetup = Boolean(displayStadium) && canEditStadium
  const canStart = Boolean(displayStadium && hasResolvedMatchup && canStartGame)
  const statusLabel = game.status === 'completed'
    ? getFinalStatusLabel(game, regulationInnings)
    : formatSeasonLabel(game.status)

  return (
    <div className="modal-backdrop">
      <div
        className="modal-card"
        style={{
          width: 'min(720px, calc(100vw - 32px))',
          maxHeight: 'min(90vh, 820px)',
          gridTemplateRows: 'auto minmax(0, 1fr) auto',
          overflow: 'hidden',
        }}
      >
        <div className="section-head">
          <div>
            <h2 style={{ margin: '6px 0 0' }}>
              <span style={{ color: getTeamPrimaryColor(identitiesByPlayerId[awayTeam?.player_id], awayPlayer?.color) || 'inherit' }}>{getTeamShortName(identitiesByPlayerId[awayTeam?.player_id]) || awayPlayer?.name || awayTeam?.team_name || 'Away'}</span>
              {' @ '}
              <span style={{ color: getTeamPrimaryColor(identitiesByPlayerId[homeTeam?.player_id], homePlayer?.color) || 'inherit' }}>{getTeamShortName(identitiesByPlayerId[homeTeam?.player_id]) || homePlayer?.name || homeTeam?.team_name || 'Home'}</span>
            </h2>
          </div>
          <span className="player-pill" style={{ borderColor: getStatusTone(game.status).border, color: getStatusTone(game.status).color }}>
            {statusLabel}
          </span>
        </div>
        <div style={{ display: 'grid', gap: 12, overflowY: 'auto', minHeight: 0, paddingRight: 4 }}>
          <div className="summary-grid">
            <article className="summary-card" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span className="muted">Away</span>
              <PlayerTag height={30} identitiesByPlayerId={identitiesByPlayerId} playerId={awayTeam?.player_id} playersById={playersById} showLogo={false} />
            </article>
            <article className="summary-card" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span className="muted">Home</span>
              <PlayerTag height={30} identitiesByPlayerId={identitiesByPlayerId} playerId={homeTeam?.player_id} playersById={playersById} showLogo={false} />
            </article>
          </div>
          <div className="feed-list">
            <div className="feed-row"><strong>Stadium</strong><span>{displayStadium || 'Not selected yet'}</span></div>
            <div className="feed-row"><strong>Time</strong><span>{selectedStadium ? getStadiumTimeLabel(selectedStadium, displayIsNight) : (displayIsNight ? 'Night' : 'Day')}</span></div>
            {lockReason ? <div className="feed-row"><strong>Status</strong><span>{lockReason}</span></div> : null}
            {game.status === 'completed' ? <div className="feed-row"><strong>Final</strong><span>Away {game.away_score} · Home {game.home_score}</span></div> : null}
          </div>
          {(['scheduled', 'in_progress'].includes(game.status) && !game.stadium) || showSetup ? (
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
                {canEditStadium ? (
                  <>
                    <select
                      value={selectedStadiumName}
                      onChange={(event) => {
                        const stadium = orderedStadiums.find((entry) => entry.name === event.target.value)
                        setSelectedStadiumName(event.target.value)
                        setSelectedIsNight(normalizeIsNightForStadium(stadium, selectedIsNight))
                      }}
                      disabled={savePending}
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
                        onClick={() => setSelectedIsNight((current) => !normalizeIsNightForStadium(selectedStadium, current))}
                        type="button"
                        disabled={savePending || !selectedStadium || stadiumTimeToggleDisabled(selectedStadium)}
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
                  </>
                ) : null}
              </div>
            </section>
          ) : null}
        </div>
        <div className="modal-actions">
          <button className="ghost-button" onClick={onClose} type="button">Close</button>
          {showSetup && onSaveSetup && canEditStadium ? (
            <button
              className="ghost-button"
              disabled={!canSaveSetup || savePending}
              onClick={() => onSaveSetup({
                ...game,
                stadium: displayStadium,
                is_night: displayIsNight,
              })}
              type="button"
            >
              {savePending ? 'Saving...' : 'Save Setup'}
            </button>
          ) : null}
          {canShowStartGame && ['scheduled', 'in_progress'].includes(game.status) ? (
            <button
              className="solid-button"
              disabled={!canStart || savePending || startPending}
              onClick={() => onStart({
                ...game,
                stadium: displayStadium,
                is_night: displayIsNight,
              })}
              type="button"
            >
              {startPending ? 'Opening…' : game.status === 'scheduled' ? 'Start Game' : 'Resume Game'}
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

function applyGameOverride(game, overrides = {}) {
  const patch = overrides[String(game.id)]
  return patch ? { ...game, ...patch } : game
}

export default function SeasonSchedule() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { pushToast } = useToast()
  const { player, is_logged_in, isScorekeeper } = useAuth()
  const {
    currentSeason,
    schedule,
    seasonTeams,
    seasonPlayersById,
    refreshSeasons,
    selectedSeasonId,
    standings,
  } = useSeason()
  const [selectedWeek, setSelectedWeek] = useState(1)
  const [stadiums, setStadiums] = useState([])
  const [gameModal, setGameModal] = useState(null) // { game, editStadium }
  const [savePending, setSavePending] = useState(false)
  const [openingGameId, setOpeningGameId] = useState(null)
  const [scheduleOverrides, setScheduleOverrides] = useState({})
  const [liveOutsByGameId, setLiveOutsByGameId] = useState({})
  const [trackerStatsByGameId, setTrackerStatsByGameId] = useState({})
  const liveDataRequestRef = useRef(0)

  useEffect(() => {
    supabase.from('stadiums').select('*').then(({ data }) => {
      setStadiums(getOrderedStadiums(data || []))
    })
  }, [])

  useEffect(() => {
    if (!currentSeason?.id) {
      setLiveOutsByGameId({})
      setTrackerStatsByGameId({})
      return undefined
    }

    let active = true
    const loadLiveData = async () => {
      const requestId = ++liveDataRequestRef.current
      const [{ data, error }, { data: trackerRows, error: trackerError }] = await Promise.all([
        fetchAllRows(() => supabase
          .from('season_plate_appearances')
          .select('game_id,result,outs_on_play')
          .eq('season_id', currentSeason.id)),
        fetchAllRows(() => supabase.from('season_tracker_live_stats').select('*')),
      ])

      if (!active || requestId !== liveDataRequestRef.current) return

      const next = {}
      if (!error) {
        for (const pa of data || []) {
          const gameId = String(pa.game_id || '')
          if (!gameId) continue
          next[gameId] = (next[gameId] || 0) + calculateOutsForPa(pa.result, pa.outs_on_play)
        }
        setLiveOutsByGameId(next)
      }
      if (!trackerError) {
        const seasonGameIds = new Set((schedule || []).map((game) => String(game.id)))
        setTrackerStatsByGameId(Object.fromEntries(
          (trackerRows || [])
            .filter((row) => seasonGameIds.has(String(row.game_id)))
            .map((row) => [String(row.game_id), row]),
        ))
      }
    }

    loadLiveData()

    const channel = supabase
      .channel(`season-schedule-live-${currentSeason.id}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_plate_appearances', filter: `season_id=eq.${currentSeason.id}` }, () => {
        loadLiveData()
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_tracker_live_stats' }, loadLiveData)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_schedule', filter: `season_id=eq.${currentSeason.id}` }, () => {
        loadLiveData()
        refreshSeasons(selectedSeasonId).catch(() => {})
      })
      .subscribe()
    const pollInterval = setInterval(() => {
      if (!document.hidden) loadLiveData()
    }, 3000)

    return () => {
      active = false
      clearInterval(pollInterval)
      supabase.removeChannel(channel)
    }
  }, [currentSeason?.id, refreshSeasons, schedule, selectedSeasonId])

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
  const standingsByTeamId = useMemo(
    () => Object.fromEntries((standings || []).map((team) => [team.id, team])),
    [standings],
  )
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
  const applyLiveGameState = useCallback((game) => {
    const trackerStats = trackerStatsByGameId[String(game.id)]
    if (!trackerStats || game.stats_source !== 'tracker') return game
    return applyTrackerLiveStateToGame(game, trackerStats, {
      isSeason: true,
      teamAPlayerId: teamsById[game.away_team_id]?.player_id,
      teamBPlayerId: teamsById[game.home_team_id]?.player_id,
    })
  }, [teamsById, trackerStatsByGameId])
  const regularSeasonGames = useMemo(
    () => schedule.filter((game) => !game.stage),
    [schedule],
  )
  const gamesPerWeek = useMemo(() => (seasonTeams.length * (seasonTeams.length - 1)) / 2, [seasonTeams.length])
  const weekGroups = useMemo(
    () => buildWeekGroups(regularSeasonGames, gamesPerWeek, Number(currentSeason?.games_per_matchup || 0)),
    [regularSeasonGames, gamesPerWeek, currentSeason?.games_per_matchup],
  )
  const currentWeekIndex = useMemo(
    () => weekGroups.findIndex((entry) => entry.week === selectedWeek),
    [weekGroups, selectedWeek],
  )
  const selectedWeekGames = useMemo(
    () => (weekGroups.find((entry) => entry.week === selectedWeek)?.games || weekGroups[0]?.games || [])
      .map((game) => applyLiveGameState(applyGameOverride(game, scheduleOverrides))),
    [weekGroups, selectedWeek, scheduleOverrides, applyLiveGameState],
  )
  const orderedPlayoffGames = useMemo(
    () => sortSeasonPlayoffGames(
      schedule.filter((game) => Boolean(game.stage)),
      currentSeason?.playoff_format,
      seasonTeams.length,
    ).map((game) => applyLiveGameState(applyGameOverride(game, scheduleOverrides))),
    [schedule, currentSeason?.playoff_format, seasonTeams.length, scheduleOverrides, applyLiveGameState],
  )
  const visiblePlayoffGames = useMemo(
    () => orderedPlayoffGames.filter((game) => game.home_team_id || game.away_team_id),
    [orderedPlayoffGames],
  )
  const hasPlayoffTab = currentSeason?.status === 'playoffs'
    || currentSeason?.status === 'completed'
    || visiblePlayoffGames.length > 0
  const viewParam = searchParams.get('view')
  const defaultView = hasPlayoffTab && currentSeason?.status === 'playoffs' ? 'playoffs' : 'regular'
  const selectedView = hasPlayoffTab && (viewParam ? viewParam === 'playoffs' : defaultView === 'playoffs')
    ? 'playoffs'
    : 'regular'
  const visibleGames = useMemo(
    () => (selectedView === 'playoffs' ? visiblePlayoffGames : selectedWeekGames),
    [selectedView, visiblePlayoffGames, selectedWeekGames],
  )

  const canEditStadiumForGame = useCallback((game) => {
    if (!game) return false
    const pickerTeam = teamsById[game.stadium_picker_team_id] || teamsById[game.home_team_id]
    return Boolean(isScorekeeper || (pickerTeam?.player_id && String(pickerTeam.player_id) === String(player?.id)))
  }, [isScorekeeper, player, teamsById])

  const playoffMetaByGameId = useMemo(() => {
    const meta = {}
    orderedPlayoffGames.forEach((game, index) => {
      const previousGame = orderedPlayoffGames[index - 1] || null
      const previousComplete = !previousGame || previousGame.status === 'completed'
      const missingHome = !game.home_team_id
      const missingAway = !game.away_team_id

      let lockReason = ''
      if (!previousComplete) {
        lockReason = `Complete ${previousGame.stage} first.`
      } else if (missingHome && missingAway) {
        lockReason = 'Waiting for both teams to be determined.'
      } else if (missingHome) {
        lockReason = 'Waiting for the home team slot to be determined.'
      } else if (missingAway) {
        lockReason = 'Waiting for the away team slot to be determined.'
      }

      meta[String(game.id)] = {
        canStartGame: previousComplete && !missingHome && !missingAway,
        lockReason,
      }
    })
    return meta
  }, [orderedPlayoffGames])

  const setSelectedView = useCallback((view) => {
    const next = new URLSearchParams(searchParams)
    next.set('view', view === 'playoffs' ? 'playoffs' : 'regular')
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  const persistGameSetup = useCallback(async (game) => {
    if (!game?.stadium) {
      const pickerTeam = teamsById[game?.stadium_picker_team_id] || teamsById[game?.home_team_id]
      pushToast({
        title: 'Stadium required',
        message: canEditStadiumForGame(game)
          ? 'Choose the stadium before opening the scorebook.'
          : `${getTeamShortName(identitiesByPlayerId[pickerTeam?.player_id]) || pickerTeam?.team_name || 'The home team'} must choose the stadium before the scorebook can be opened.`,
        type: 'error',
      })
      return false
    }

    const patch = { stadium: game.stadium, is_night: Boolean(game.is_night) }
    const { error } = await supabase
      .from('season_schedule')
      .update(patch)
      .eq('id', game.id)
    if (error) throw error

    setScheduleOverrides((prev) => ({ ...prev, [String(game.id)]: patch }))
    setGameModal((current) => (
      current && String(current.game.id) === String(game.id)
        ? { ...current, game: { ...current.game, ...patch } }
        : current
    ))
    return true
  }, [canEditStadiumForGame, identitiesByPlayerId, pushToast, teamsById])

  const handleSaveSetup = useCallback(async (game) => {
    if (!game) return
    setSavePending(true)
    try {
      const saved = await persistGameSetup(game)
      if (!saved) return
      await refreshSeasons(selectedSeasonId)
      setGameModal(null)
    } catch (error) {
      pushToast({ title: 'Unable to save setup', message: error.message, type: 'error' })
    } finally {
      setSavePending(false)
    }
  }, [persistGameSetup, pushToast, refreshSeasons, selectedSeasonId])

  const handleStart = useCallback(async (game) => {
    if (!game) return
    const playoffMeta = game.stage ? playoffMetaByGameId[String(game.id)] : null
    if (game.stage && playoffMeta && !playoffMeta.canStartGame) {
      pushToast({
        title: 'Playoff game locked',
        message: playoffMeta.lockReason || 'Finish earlier playoff games before opening this one.',
        type: 'error',
      })
      return
    }

    setOpeningGameId(String(game.id))
    setSavePending(true)
    try {
      const saved = await persistGameSetup(game)
      if (!saved) return

      if (game.status === 'scheduled') {
        const { error } = await supabase.from('season_schedule').update({ status: 'in_progress' }).eq('id', game.id)
        if (error) throw error
      }

      refreshSeasons(selectedSeasonId).catch(() => {})
      navigate(buildScorebookPath({ gameId: game.id, source: 'season' }))
    } catch (error) {
      pushToast({ title: 'Unable to open game', message: error.message, type: 'error' })
    } finally {
      setOpeningGameId(null)
      setSavePending(false)
    }
  }, [navigate, persistGameSetup, playoffMetaByGameId, pushToast, refreshSeasons, selectedSeasonId])

  const openGameCard = useCallback((game) => {
    if (!game || !is_logged_in) return

    const playoffMeta = game.stage ? playoffMetaByGameId[String(game.id)] : null
    const canOpenNow = game.stage ? Boolean(playoffMeta?.canStartGame && game.stadium) : Boolean(game.stadium)

    if (canOpenNow) {
      handleStart(game)
      return
    }

    setGameModal({
      game,
      editStadium: !game.stadium || canEditStadiumForGame(game),
      canStartGame: playoffMeta?.canStartGame ?? true,
      lockReason: playoffMeta?.lockReason || '',
    })
  }, [canEditStadiumForGame, handleStart, is_logged_in, playoffMetaByGameId])

  if (!currentSeason) {
    return <div className="page-stack"><div className="page-head"><h1>No season selected.</h1></div></div>
  }

  return (
    <div className="page-stack">
      <div className="page-head" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div>
          <span className="brand-kicker">Season Schedule</span>
          <h1>{currentSeason.name}</h1>
        </div>
        <div className="tab-row" style={{ justifyContent: 'flex-end', marginLeft: 'auto' }}>
          <button
            className={`tab-button ${selectedView === 'regular' ? 'tab-button-active' : ''}`}
            onClick={() => setSelectedView('regular')}
            type="button"
          >
            Regular Season
          </button>
          {hasPlayoffTab ? (
            <button
              className={`tab-button ${selectedView === 'playoffs' ? 'tab-button-active' : ''}`}
              onClick={() => setSelectedView('playoffs')}
              type="button"
            >
              Playoffs
            </button>
          ) : null}
        </div>
      </div>

      <section className="panel" style={{ padding: 16 }}>
        {selectedView === 'regular' && weekGroups.length ? (
          <div className="section-head" style={{ justifyContent: 'flex-end' }}>
            <div className="week-stepper">
              <button
                type="button"
                disabled={currentWeekIndex <= 0}
                onClick={() => setSelectedWeek(weekGroups[currentWeekIndex - 1].week)}
                aria-label="Previous week"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="week-stepper-label">
                Week {weekGroups[currentWeekIndex]?.week ?? selectedWeek} of {weekGroups.length}
              </span>
              <button
                type="button"
                disabled={currentWeekIndex < 0 || currentWeekIndex >= weekGroups.length - 1}
                onClick={() => setSelectedWeek(weekGroups[currentWeekIndex + 1].week)}
                aria-label="Next week"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        ) : null}

        {!visibleGames.length ? (
          <div className="summary-card" style={{ minHeight: 140, placeItems: 'center', textAlign: 'center' }}>
            <strong style={{ fontSize: 16, color: '#F8FAFC' }}>
              {selectedView === 'playoffs' ? 'No playoff games are visible yet.' : 'No games scheduled for this week.'}
            </strong>
            <span className="muted" style={{ maxWidth: 420 }}>
              {selectedView === 'playoffs'
                ? 'Matchups will appear as soon as at least one playoff slot is determined.'
                : 'Pick another week or finish generating the season schedule.'}
            </span>
          </div>
        ) : (
        <div className="summary-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
          {visibleGames.map((game) => {
            const homeTeam = teamsById[game.home_team_id]
            const awayTeam = teamsById[game.away_team_id]
            const homeStanding = standingsByTeamId[game.home_team_id] || homeTeam
            const awayStanding = standingsByTeamId[game.away_team_id] || awayTeam
            const isOpeningGame = String(openingGameId) === String(game.id)
            const tone = getStatusTone(game.status)
            const showScore = shouldShowLiveScore(game)
            const winningTeamId = getWinningTeamId(game)
            const updateText = getGameUpdateText(game, liveOutsByGameId, game.innings ?? currentSeason?.innings)
            const playoffMeta = game.stage ? playoffMetaByGameId[String(game.id)] : null
            const isCompleted = game.status === 'completed'
            const isLocked = Boolean(game.stage && playoffMeta && !playoffMeta.canStartGame)
            const canEditStadium = canEditStadiumForGame(game)
            const showSetStadiumPill = !isCompleted && !isLocked && !game.stadium && canEditStadium
            const showStartPill = !isCompleted && !isLocked && Boolean(game.stadium)
            const startLabel = game.status === 'in_progress' ? 'Resume Game' : 'Start Game'
            return (
              <button
                key={game.id}
                onClick={() => {
                  if (isOpeningGame) return
                  openGameCard(game)
                }}
                type="button"
                className="season-game-card"
                aria-busy={isOpeningGame}
                style={{ borderColor: tone.border }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', minHeight: 28 }}>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {game.stage ? (
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 800,
                          letterSpacing: '.04em',
                          textTransform: 'uppercase',
                          padding: '4px 8px',
                          borderRadius: 999,
                          border: '1px solid rgba(148,163,184,0.28)',
                          color: '#CBD5E1',
                        }}
                      >
                        {game.stage}
                      </span>
                    ) : null}
                  </div>
                  {isOpeningGame ? (
                    <span className="status-pill status-live">Opening…</span>
                  ) : updateText ? (
                    <span className={`status-pill ${tone.pillClass}`}>{updateText}</span>
                  ) : null}
                </div>
                <div style={{ display: 'grid', gap: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <TeamLogo
                        height={56}
                        logoKey={identitiesByPlayerId[awayTeam?.player_id]?.teamLogoKey}
                        logoUrl={identitiesByPlayerId[awayTeam?.player_id]?.teamLogoUrl}
                        teamName={identitiesByPlayerId[awayTeam?.player_id]?.teamName}
                        placeholder
                      />
                      <span style={{ color: showScore && winningTeamId === game.away_team_id ? 'var(--success)' : '#F8FAFC', fontWeight: 700, fontSize: 14 }}>{getTeamShortName(identitiesByPlayerId[awayTeam?.player_id]) || awayTeam?.team_name || 'Away TBD'}</span>
                    </div>
                    {showScore ? (
                      <TeamValue score={Number(game.away_score || 0)} outcome={winningTeamId ? (winningTeamId === game.away_team_id ? 'win' : 'lose') : null} />
                    ) : (
                      <TeamValue record={awayStanding ? `${awayStanding.wins}-${awayStanding.losses}` : '--'} />
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <TeamLogo
                        height={56}
                        logoKey={identitiesByPlayerId[homeTeam?.player_id]?.teamLogoKey}
                        logoUrl={identitiesByPlayerId[homeTeam?.player_id]?.teamLogoUrl}
                        teamName={identitiesByPlayerId[homeTeam?.player_id]?.teamName}
                        placeholder
                      />
                      <span style={{ color: showScore && winningTeamId === game.home_team_id ? 'var(--success)' : '#F8FAFC', fontWeight: 700, fontSize: 14 }}>{getTeamShortName(identitiesByPlayerId[homeTeam?.player_id]) || homeTeam?.team_name || 'Home TBD'}</span>
                    </div>
                    {showScore ? (
                      <TeamValue score={Number(game.home_score || 0)} outcome={winningTeamId ? (winningTeamId === game.home_team_id ? 'win' : 'lose') : null} />
                    ) : (
                      <TeamValue record={homeStanding ? `${homeStanding.wins}-${homeStanding.losses}` : '--'} />
                    )}
                  </div>
                </div>
                <div style={{ borderTop: '1px solid var(--line)', paddingTop: 10, display: 'grid', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 12 }}>
                      {canEditStadium ? (
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => {
                            e.stopPropagation()
                            setGameModal({
                              game,
                              editStadium: true,
                              canStartGame: playoffMeta?.canStartGame ?? true,
                              lockReason: playoffMeta?.lockReason || '',
                            })
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.stopPropagation()
                              e.preventDefault()
                              setGameModal({
                                game,
                                editStadium: true,
                                canStartGame: playoffMeta?.canStartGame ?? true,
                                lockReason: playoffMeta?.lockReason || '',
                              })
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
                    {showSetStadiumPill ? (
                      <span className="status-pill" style={{ border: '1px solid var(--line)', color: 'var(--muted)', background: 'transparent' }}>Set Stadium</span>
                    ) : showStartPill ? (
                      <span className="status-pill" style={{ background: 'var(--gold-soft)', color: 'var(--gold)', fontWeight: 700 }}>{startLabel}</span>
                    ) : null}
                  </div>
                  {playoffMeta?.lockReason ? (
                    <span style={{ color: '#FDE68A', fontSize: 12, fontWeight: 600 }}>
                      {playoffMeta.lockReason}
                    </span>
                  ) : null}
                </div>
              </button>
            )
          })}
        </div>
        )}
      </section>

      <SeasonGameDetail
        game={gameModal?.game || null}
        teamsById={teamsById}
        playersById={playersById}
        identitiesByPlayerId={identitiesByPlayerId}
        stadiums={stadiums}
        onClose={() => setGameModal(null)}
        onStart={handleStart}
        onSaveSetup={handleSaveSetup}
        savePending={savePending}
        startPending={String(openingGameId) === String(gameModal?.game?.id)}
        canEditStadium={canEditStadiumForGame(gameModal?.game)}
        canShowStartGame={isScorekeeper}
        canStartGame={gameModal?.canStartGame ?? true}
        lockReason={gameModal?.lockReason || ''}
        showSetup={gameModal?.editStadium || false}
        regulationInnings={gameModal?.game?.innings ?? currentSeason?.innings}
      />
    </div>
  )
}
