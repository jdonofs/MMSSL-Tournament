import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../../../supabaseClient'
import { getOrderedStadiums } from '../../../utils/stadiums'
import { createRefreshCoordinator } from '../../../utils/refreshCoordinator'
import { normalizePa } from '../domain/plateAppearance'

export default function useScorebookData({
  gameSession,
  tournamentId,
  selectedGameId,
  pushToast,
}) {
  const [games, setGames] = useState([])
  const [players, setPlayers] = useState([])
  const [lineups, setLineups] = useState([])
  const [savedTeamLineups, setSavedTeamLineups] = useState([])
  const [characters, setCharacters] = useState([])
  const [draftPicks, setDraftPicks] = useState([])
  const [plateAppearances, setPlateAppearances] = useState([])
  const [pitchingStints, setPitchingStints] = useState([])
  const [pitches, setPitches] = useState([])
  const [gameFielders, setGameFielders] = useState([])
  const [runsScored, setRunsScored] = useState([])
  const [inningScores, setInningScores] = useState([])
  const [stadiums, setStadiums] = useState([])
  const [stadiumGameLog, setStadiumGameLog] = useState([])
  const [pitchHistoryLoadedScope, setPitchHistoryLoadedScope] = useState(null)
  const [dataLoaded, setDataLoaded] = useState(false)

  const deferRealtimeUntilRef = useRef(0)
  const gameFieldersRefreshSeqRef = useRef(0)
  const locallyDeletedPaIdsRef = useRef(new Set())
  const pitchHistoryLoadedScopeRef = useRef(null)
  const scorebookTables = gameSession?.tables || {}
  const isSeasonGame = gameSession?.sourceType === 'season'
  const scorebookDataScope = `${gameSession?.sourceType || 'unknown'}:${gameSession?.sourceId || 'none'}:${gameSession?.gameId || 'none'}`

  useEffect(() => {
    let cancelled = false
    // The session provider refreshes after live-state writes. Keep an already
    // verified snapshot editable while that same game's background refresh is
    // in flight; clearing this flag here unmounted every scoring control and
    // made the scorebook visibly flash after each entry.
    const hasUsableSnapshot = pitchHistoryLoadedScopeRef.current === scorebookDataScope
    if (!hasUsableSnapshot) {
      pitchHistoryLoadedScopeRef.current = null
      setPitchHistoryLoadedScope(null)
    }

    async function load() {
      try {
        const {
          games: gamesData = [],
          players: playersData = [],
          lineups: lineupsData = [],
          characters: charsData = [],
          draftPicks: picksData = [],
          plateAppearances: pasData = [],
          pitchingStints: pitchData = [],
          pitches: pitchRowsData,
          pitchLoadError = null,
          loadError = null,
          gameFielders: fieldersData = [],
          runsScored: runsData = [],
          inningScores: inningScoresData = [],
          stadiums: stadiumsData = [],
          stadiumGameLog: stadiumLogData = [],
          savedTeamLineups: savedTeamLineupsData = [],
        } = await gameSession.loadScorebookData()
        if (cancelled) return
        if (loadError || pitchLoadError || !Array.isArray(pitchRowsData)) {
          throw loadError || pitchLoadError || new Error('The selected game pitch history could not be loaded.')
        }

        setGames(gamesData || [])
        setPlayers(playersData || [])
        // Lineups/characters are refetched on every season-data refresh (e.g. live_state
        // pushes during scoring). A transient empty result shouldn't blank out the
        // already-rendered lineup/batter — keep the previous data in that case. And if
        // we just saved a lineup/fielding change locally, this refetch may hit a
        // lagging replica — keep our optimistic rows for the selected game until the
        // defer window passes so the recording page doesn't revert to stale data.
        const preserveSelectedGameRows = (prevRows, nextRows) => {
          if (!selectedGameId) return nextRows
          if (Date.now() >= deferRealtimeUntilRef.current) return nextRows
          const currentGameRows = prevRows.filter((row) => String(row.game_id) === String(selectedGameId))
          if (!currentGameRows.length) return nextRows
          return [...nextRows.filter((row) => String(row.game_id) !== String(selectedGameId)), ...currentGameRows]
        }
        setLineups(prev => preserveSelectedGameRows(prev, (lineupsData && lineupsData.length) ? lineupsData : (prev.length ? prev : lineupsData)))
        setSavedTeamLineups(savedTeamLineupsData || [])
        setCharacters(prev => (charsData && charsData.length) ? charsData : (prev.length ? prev : charsData))
        const visiblePAs = (pasData || [])
          .map(normalizePa)
          .filter((pa) => !locallyDeletedPaIdsRef.current.has(String(pa.id)))
        const visiblePitches = (pitchRowsData || [])
          .filter((pitch) => !locallyDeletedPaIdsRef.current.has(String(pitch.pa_id)))
        const visibleRuns = (runsData || [])
          .filter((run) => !locallyDeletedPaIdsRef.current.has(String(run.pa_id)))
        setDraftPicks(picksData || [])
        setPlateAppearances(prev => preserveSelectedGameRows(prev, visiblePAs))
        setPitchingStints(prev => preserveSelectedGameRows(prev, (pitchData && pitchData.length) ? pitchData : (prev.length ? prev : pitchData)))
        setPitches(prev => preserveSelectedGameRows(prev, visiblePitches))
        setGameFielders(prev => preserveSelectedGameRows(prev, (fieldersData && fieldersData.length) ? fieldersData : (prev.length ? prev : fieldersData)))
        setRunsScored(prev => preserveSelectedGameRows(prev, visibleRuns))
        setInningScores(inningScoresData || [])
        setStadiums(getOrderedStadiums(stadiumsData || []))
        setStadiumGameLog(stadiumLogData || [])
        pitchHistoryLoadedScopeRef.current = scorebookDataScope
        setPitchHistoryLoadedScope(scorebookDataScope)
        setDataLoaded(true)
      } catch (error) {
        if (cancelled) return
        if (hasUsableSnapshot) {
          console.warn('[scorebook load] refresh failed; preserving the verified local snapshot', error)
          return
        }
        pitchHistoryLoadedScopeRef.current = null
        setPitchHistoryLoadedScope(null)
        pushToast({
          title: 'Pitch history unavailable',
          message: `${error.message} Scorekeeping is disabled so an incomplete pitch total cannot be saved.`,
          type: 'error',
        })
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [gameSession, tournamentId, pushToast, scorebookDataScope, selectedGameId])

  const shouldDeferRealtimeMerge = useCallback((currentRows = [], nextRows = [], getId = (row) => row.id) => {
    if (Date.now() > deferRealtimeUntilRef.current) return false
    if (nextRows.length < currentRows.length) return true
    if (nextRows.length !== currentRows.length) return false
    const currentIds = currentRows.map((row) => String(getId(row))).sort()
    const nextIds = nextRows.map((row) => String(getId(row))).sort()
    return currentIds.length > 0 && currentIds.every((id, index) => id === nextIds[index])
  }, [])

  const fetchGameData = useCallback(async () => {
    if (!selectedGameId) return
    const [lineupResult, paResult, stintResult, pitchResult, fielderResult, runResult, inningResult] = await Promise.all([
      supabase.from(scorebookTables.lineups).select('*').eq('game_id', selectedGameId).order('batting_order'),
      supabase.from(scorebookTables.plateAppearances).select('*').eq('game_id', selectedGameId).order('pa_number'),
      supabase.from(scorebookTables.pitchingStints).select('*').eq('game_id', selectedGameId).order('created_at'),
      supabase.from(scorebookTables.pitches).select('*').eq('game_id', selectedGameId).order('pitch_number_game'),
      supabase.from(scorebookTables.gameFielders).select('*').eq('game_id', selectedGameId).order('created_at'),
      supabase.from(scorebookTables.runsScored).select('*').eq('game_id', selectedGameId).order('created_at'),
      supabase.from(scorebookTables.inningScores).select('*').eq('game_id', selectedGameId).order('inning'),
    ])

    const failures = [lineupResult, paResult, stintResult, pitchResult, fielderResult, runResult, inningResult]
      .map((result) => result.error)
      .filter(Boolean)
    if (failures.length) console.warn('[scorebook] authoritative game refresh was partial', failures)

    if (!lineupResult.error) {
      setLineups((current) => [...current.filter((row) => String(row.game_id) !== String(selectedGameId)), ...(lineupResult.data || [])])
    }
    if (!paResult.error) {
      const authoritativePAs = (paResult.data || []).map(normalizePa)
      setPlateAppearances((current) => [...current.filter((row) => String(row.game_id) !== String(selectedGameId)), ...authoritativePAs])
    }
    if (!stintResult.error) {
      setPitchingStints((current) => [...current.filter((row) => String(row.game_id) !== String(selectedGameId)), ...(stintResult.data || [])])
    }
    if (!pitchResult.error) {
      setPitches((current) => [...current.filter((row) => String(row.game_id) !== String(selectedGameId)), ...(pitchResult.data || [])])
    }
    if (!fielderResult.error) {
      setGameFielders((current) => [...current.filter((row) => String(row.game_id) !== String(selectedGameId)), ...(fielderResult.data || [])])
    }
    if (!runResult.error) {
      setRunsScored((current) => [...current.filter((row) => String(row.game_id) !== String(selectedGameId)), ...(runResult.data || [])])
    }
    if (!inningResult.error) {
      const authoritativeInnings = isSeasonGame
        ? (inningResult.data || []).map((entry) => ({
            ...entry,
            player_id: gameSession.playerIdByTeamId?.[entry.team_id] || null,
          }))
        : (inningResult.data || [])
      setInningScores((current) => [...current.filter((row) => String(row.game_id) !== String(selectedGameId)), ...authoritativeInnings])
    }
  }, [selectedGameId, scorebookTables, isSeasonGame, gameSession?.playerIdByTeamId])

  useEffect(() => {
    if (!selectedGameId) return

    const pendingRefreshes = new Map()
    const refreshCoordinator = createRefreshCoordinator({
      delayMs: 100,
      maxWaitMs: 500,
      isPaused: () => document.visibilityState === 'hidden',
      run: async () => {
        const refreshes = [...pendingRefreshes.values()]
        pendingRefreshes.clear()
        await Promise.all(refreshes.map((refresh) => refresh()))
      },
      onError: (error) => console.warn('[scorebook realtime] coalesced refresh failed', error),
    })
    const coalesce = (key, refresh) => () => {
      pendingRefreshes.set(key, refresh)
      refreshCoordinator.request()
    }
    const requestAuthoritativeRefresh = () => {
      pendingRefreshes.clear()
      pendingRefreshes.set('authoritative', fetchGameData)
      refreshCoordinator.request({ immediate: true })
    }
    let hasSubscribed = false

    const channel = supabase
      .channel(`sb-${selectedGameId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: scorebookTables.lineups, filter: `game_id=eq.${selectedGameId}` }, coalesce('lineups', async () => {
        const { data, error } = await supabase.from(scorebookTables.lineups).select('*').eq('game_id', selectedGameId).order('batting_order')
        if (error) {
          console.warn('[scorebook realtime] lineup refresh failed; preserving local rows', error)
          return
        }
        const nextRows = data || []
        setLineups((current) => {
          const currentGameRows = current.filter((row) => String(row.game_id) === String(selectedGameId))
          if (shouldDeferRealtimeMerge(currentGameRows, nextRows)) return current
          return [...current.filter((row) => String(row.game_id) !== String(selectedGameId)), ...nextRows]
        })
      }))
      .on('postgres_changes', { event: '*', schema: 'public', table: scorebookTables.plateAppearances, filter: `game_id=eq.${selectedGameId}` }, coalesce('plateAppearances', async () => {
        const { data, error } = await supabase.from(scorebookTables.plateAppearances).select('*').eq('game_id', selectedGameId).order('created_at')
        if (error) {
          console.warn('[scorebook realtime] plate-appearance refresh failed; preserving local rows', error)
          return
        }
        const nextRows = (data || [])
          .map(normalizePa)
          .filter((pa) => !locallyDeletedPaIdsRef.current.has(String(pa.id)))
        setPlateAppearances((current) => {
          const currentGameRows = current.filter((row) => String(row.game_id) === String(selectedGameId))
          if (shouldDeferRealtimeMerge(currentGameRows, nextRows)) return current
          return [...current.filter((row) => String(row.game_id) !== String(selectedGameId)), ...nextRows]
        })
      }))
      .on('postgres_changes', { event: '*', schema: 'public', table: scorebookTables.pitchingStints, filter: `game_id=eq.${selectedGameId}` }, coalesce('pitchingStints', async () => {
        const { data, error } = await supabase.from(scorebookTables.pitchingStints).select('*').eq('game_id', selectedGameId).order('created_at')
        if (error) {
          console.warn('[scorebook realtime] pitching refresh failed; preserving local rows', error)
          return
        }
        const nextRows = data || []
        setPitchingStints((current) => {
          const currentGameRows = current.filter((row) => String(row.game_id) === String(selectedGameId))
          if (shouldDeferRealtimeMerge(currentGameRows, nextRows)) return current
          return [...current.filter((row) => String(row.game_id) !== String(selectedGameId)), ...nextRows]
        })
      }))
      .on('postgres_changes', { event: '*', schema: 'public', table: scorebookTables.pitches, filter: `game_id=eq.${selectedGameId}` }, coalesce('pitches', async () => {
        const { data, error } = await supabase.from(scorebookTables.pitches).select('*').eq('game_id', selectedGameId).order('created_at')
        if (error) {
          console.warn('[scorebook realtime] pitch refresh failed; preserving local rows', error)
          return
        }
        const nextRows = (data || [])
          .filter((pitch) => !locallyDeletedPaIdsRef.current.has(String(pitch.pa_id)))
        setPitches((current) => {
          const currentGameRows = current.filter((row) => String(row.game_id) === String(selectedGameId))
          if (shouldDeferRealtimeMerge(currentGameRows, nextRows)) return current
          return [...current.filter((row) => String(row.game_id) !== String(selectedGameId)), ...nextRows]
        })
      }))
      .on('postgres_changes', { event: '*', schema: 'public', table: scorebookTables.gameFielders, filter: `game_id=eq.${selectedGameId}` }, coalesce('gameFielders', async () => {
        const refreshSequence = ++gameFieldersRefreshSeqRef.current
        const { data, error } = await supabase.from(scorebookTables.gameFielders).select('*').eq('game_id', selectedGameId).order('created_at')
        // A fielding swap emits several row events. Their follow-up SELECTs can
        // resolve out of order; only the newest request is allowed to replace
        // the lineup, or an older eight-player intermediate snapshot can win.
        if (refreshSequence !== gameFieldersRefreshSeqRef.current) return
        if (error) {
          console.warn('[scorebook realtime] fielder refresh failed; preserving local rows', error)
          return
        }
        const nextRows = data || []
        setGameFielders((current) => {
          const currentGameRows = current.filter((row) => String(row.game_id) === String(selectedGameId))
          if (shouldDeferRealtimeMerge(currentGameRows, nextRows)) return current
          return [...current.filter((row) => String(row.game_id) !== String(selectedGameId)), ...nextRows]
        })
      }))
      .on('postgres_changes', { event: '*', schema: 'public', table: scorebookTables.runsScored, filter: `game_id=eq.${selectedGameId}` }, coalesce('runsScored', async () => {
        const { data, error } = await supabase.from(scorebookTables.runsScored).select('*').eq('game_id', selectedGameId).order('created_at')
        if (error) {
          console.warn('[scorebook realtime] run refresh failed; preserving local rows', error)
          return
        }
        const nextRows = (data || [])
          .filter((run) => !locallyDeletedPaIdsRef.current.has(String(run.pa_id)))
        setRunsScored((current) => {
          const currentGameRows = current.filter((row) => String(row.game_id) === String(selectedGameId))
          if (shouldDeferRealtimeMerge(currentGameRows, nextRows)) return current
          return [...current.filter((row) => String(row.game_id) !== String(selectedGameId)), ...nextRows]
        })
      }))
      .on('postgres_changes', { event: '*', schema: 'public', table: scorebookTables.inningScores, filter: `game_id=eq.${selectedGameId}` }, coalesce('inningScores', async () => {
        const query = supabase.from(scorebookTables.inningScores).select('*').eq('game_id', selectedGameId).order('inning')
        const { data, error } = isSeasonGame
          ? await query.eq('season_id', gameSession?.sourceId)
          : await query
        if (error) {
          console.warn('[scorebook realtime] inning-score refresh failed; preserving local rows', error)
          return
        }
        const normalized = isSeasonGame
          ? (data || []).map((entry) => ({
              ...entry,
              player_id: gameSession.playerIdByTeamId?.[entry.team_id] || null,
            }))
          : (data || [])
        setInningScores((current) => {
          const currentGameRows = current.filter((row) => String(row.game_id) === String(selectedGameId))
          if (shouldDeferRealtimeMerge(currentGameRows, normalized, (row) => `${row.inning}:${row.player_id || row.team_id || row.id}`)) {
            return current
          }
          return [...current.filter((row) => String(row.game_id) !== String(selectedGameId)), ...normalized]
        })
      }))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: scorebookTables.games, filter: `id=eq.${selectedGameId}` }, coalesce('game', async () => {
        const { data } = await supabase.from(scorebookTables.games).select('*').eq('id', selectedGameId).single()
        if (!data) return
        const stadiumByName = Object.fromEntries(stadiums.map((stadium) => [stadium.name, stadium]))
        const normalized = isSeasonGame
          ? {
              ...data,
              source_id: data.season_id,
              tournament_id: data.season_id,
              stadium_id: stadiumByName[data.stadium]?.id || null,
              game_code: data.stage ? `S${data.season_id}-${data.stage}` : `R${data.round_number}-G${data.id}`,
              team_a_player_id: gameSession.playerIdByTeamId?.[data.away_team_id] || null,
              team_b_player_id: gameSession.playerIdByTeamId?.[data.home_team_id] || null,
              winner_player_id: gameSession.playerIdByTeamId?.[data.winner_team_id] || null,
              team_a_runs: Number(data.away_score || 0),
              team_b_runs: Number(data.home_score || 0),
              status: data.status === 'completed' ? 'complete' : data.status === 'in_progress' ? 'active' : data.status === 'scheduled' ? 'pending' : data.status,
            }
          : data
        setGames((current) => current.map((game) => (String(game.id) === String(normalized.id) ? normalized : game)))
      }))
      .subscribe((status) => {
        if (status !== 'SUBSCRIBED') return
        if (hasSubscribed) requestAuthoritativeRefresh()
        hasSubscribed = true
      })
    return () => {
      gameFieldersRefreshSeqRef.current += 1
      refreshCoordinator.dispose()
      pendingRefreshes.clear()
      supabase.removeChannel(channel)
    }
  }, [selectedGameId, scorebookTables, isSeasonGame, gameSession?.sourceId, gameSession?.playerIdByTeamId, stadiums, shouldDeferRealtimeMerge, fetchGameData])

  // Belt-and-suspenders refetch for edits made in another tab (the At-Bat
  // Data page's "Edit At-Bat" link opens in one) — the realtime subscription
  // above should already catch these, but resyncs on refocus too in case a
  // given table isn't in the realtime publication, same pattern already used
  // for team lineups above. Deliberately does NOT run through
  // shouldDeferRealtimeMerge — that guard exists to protect the few seconds
  // right after a local save from a lagging read-replica, which doesn't
  // apply here (a refocus fires well after any such window, often minutes
  // later). Applying it here actively defeats the point of a "just trust the
  // fresh fetch" resync: if local state has drifted for any reason (a stale
  // extra row, a miscount), the guard's "fewer rows than we already have ->
  // skip" rule would keep discarding the correct fetch forever.
  useEffect(() => {
    if (!selectedGameId) return
    const recoveryCoordinator = createRefreshCoordinator({
      delayMs: 75,
      maxWaitMs: 250,
      isPaused: () => document.visibilityState === 'hidden',
      run: fetchGameData,
      onError: (error) => console.warn('[scorebook recovery] authoritative refresh failed', error),
    })
    const resync = () => recoveryCoordinator.request()
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') recoveryCoordinator.request({ immediate: true })
    }
    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('focus', resync)
    window.addEventListener('online', resync)
    return () => {
      recoveryCoordinator.dispose()
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('focus', resync)
      window.removeEventListener('online', resync)
    }
  }, [selectedGameId, fetchGameData])

  useEffect(() => {
    if (!gameSession?.sourceId || !scorebookTables.draftPicks) return
    const sourceField = isSeasonGame ? 'season_id' : 'tournament_id'
    const channel = supabase
      .channel(`scorebook-roster-${gameSession.sourceId}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: scorebookTables.draftPicks, filter: `${sourceField}=eq.${gameSession.sourceId}` }, (payload) => {
        setDraftPicks((current) => {
          const changed = payload.eventType === 'DELETE' ? payload.old : payload.new
          if (changed?.id == null) return current
          const withoutChanged = current.filter((row) => String(row.id) !== String(changed.id))
          if (payload.eventType === 'DELETE') return withoutChanged
          return [...withoutChanged, changed].sort((a, b) => {
            if (!isSeasonGame) return Number(a.pick_number || 0) - Number(b.pick_number || 0)
            return String(a.created_at || '').localeCompare(String(b.created_at || ''))
          })
        })
      })
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [gameSession?.sourceId, scorebookTables.draftPicks, isSeasonGame])

  useEffect(() => {
    const channel = supabase
      .channel(`scorebook-stadiums-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stadiums' }, (payload) => {
        setStadiums((current) => {
          const changed = payload.eventType === 'DELETE' ? payload.old : payload.new
          if (changed?.id == null) return current
          const withoutChanged = current.filter((row) => String(row.id) !== String(changed.id))
          return getOrderedStadiums(payload.eventType === 'DELETE' ? withoutChanged : [...withoutChanged, changed])
        })
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: scorebookTables.stadiumGameLog, filter: isSeasonGame ? `season_id=eq.${gameSession?.sourceId}` : undefined }, (payload) => {
        setStadiumGameLog((current) => {
          const changed = payload.eventType === 'DELETE' ? payload.old : payload.new
          if (changed?.id == null) return current
          const withoutChanged = current.filter((row) => String(row.id) !== String(changed.id))
          if (payload.eventType === 'DELETE') return withoutChanged
          return [...withoutChanged, changed].sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
        })
      })
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [scorebookTables.stadiumGameLog, isSeasonGame, gameSession?.sourceId])

  return {
    games,
    setGames,
    players,
    setPlayers,
    lineups,
    setLineups,
    savedTeamLineups,
    setSavedTeamLineups,
    characters,
    setCharacters,
    draftPicks,
    setDraftPicks,
    plateAppearances,
    setPlateAppearances,
    pitchingStints,
    setPitchingStints,
    pitches,
    setPitches,
    gameFielders,
    setGameFielders,
    runsScored,
    setRunsScored,
    inningScores,
    setInningScores,
    stadiums,
    setStadiums,
    stadiumGameLog,
    setStadiumGameLog,
    pitchHistoryLoadedScope,
    dataLoaded,
    scorebookDataScope,
    fetchGameData,
    deferRealtimeUntilRef,
    locallyDeletedPaIdsRef,
  }
}
