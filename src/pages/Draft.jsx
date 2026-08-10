import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronLeft, ChevronRight, RotateCcw, X, Zap } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { fetchAllRows } from '../utils/fetchAllRows'
import { useAuth } from '../context/AuthContext'
import { useSeason } from '../context/SeasonContext'
import { useToast } from '../context/ToastContext'
import { useTournament } from '../context/TournamentContext'
import PlayerTag from '../components/PlayerTag'
import { buildCharacterGameHistory, buildCharacterPitchingGameHistory, buildCharacterFieldingGameHistory, MIN_PA_PER_GAME, summarizePitching } from '../utils/statsCalculator'
import { analyzeCharacterTalent, getTalentTierMeta } from '../utils/characterAnalysis'
import CharacterPortrait from '../components/CharacterPortrait'
import StatIcon from '../components/StatIcon'
import { chemBreakdown, chemScore } from '../data/chemistry'
import { formatCharacterDisplayName, getCharacterChemistryName, isMiiCharacter, MII_COLOR_OPTIONS } from '../utils/mii'
import { buildTournamentTeamIdentityMap, getCaptainIdentityFromName, getTeamShortName, isCaptainCharacterName } from '../utils/teamIdentity'
import { getCurrentDraftState, normalizeSeasonDraftPicks, snakeOrder } from '../utils/draftOrder'

function trendSymbol(history) {
  const valid = (history || []).filter(t => t.perfScore !== null)
  if (valid.length < 2) return null
  const last = valid[valid.length - 1].perfScore
  const prev = valid.slice(0, -1).reduce((s, t) => s + t.perfScore, 0) / (valid.length - 1)
  if (last > prev + 0.4) return '↑'
  if (last < prev - 0.4) return '↓'
  return '→'
}

// ─── Shared sub-components ────────────────────────────────────────────────────
function Portrait({ name, size = 36, style = {} }) {
  return <CharacterPortrait name={name} size={size} style={style} />
}


function getCompactDraftBoardName(name, miiColor) {
  const displayName = formatCharacterDisplayName(name, miiColor)
  if (displayName.length <= 10) return displayName

  if (name === 'Mii' && miiColor) {
    const compactColor = String(miiColor)
      .trim()
      .split(/\s+/)
      .map((part) => part[0] || '')
      .join('')
      .toUpperCase()
    return `${compactColor} Mii`
  }

  const words = String(displayName)
    .replace(/\./g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)

  if (words.length === 1) return words[0].slice(0, 8)

  const lastWord = words[words.length - 1]
  if (/^Jr$/i.test(lastWord)) {
    return `${words.slice(0, -1).map((word) => word[0]).join('').toUpperCase()}Jr`
  }

  const initials = words.map((word) => word[0]).join('').toUpperCase()
  if (initials.length >= 2 && initials.length <= 4) return initials

  return `${words[0].slice(0, 5)} ${lastWord[0] || ''}`.trim()
}


const SORT_KEY_TIER = {
  value:      { tierKey: 'battingTier',  icon: 'batting' },
  pitchValue: { tierKey: 'pitchingTier', icon: 'pitching' },
  fieldValue: { tierKey: 'fieldingTier', icon: 'fielding' },
  speedValue: { tierKey: 'speedTier',    icon: 'speed' },
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function Draft() {
  return <DraftExperience mode="tournament" />
}

export function DraftExperience({ mode = 'tournament' }) {
  const navigate = useNavigate()
  const { player, is_logged_in } = useAuth()
  const { pushToast } = useToast()
  const { currentTournament, allTournaments } = useTournament()
  const { currentSeason, seasonTeams, allSeasons } = useSeason()
  const isSeasonMode = mode === 'season'
  const activeDraftContext = isSeasonMode ? currentSeason : currentTournament

  const [players, setPlayers] = useState([])
  const [characters, setCharacters] = useState([])
  const [allDraftPicks, setAllDraftPicks] = useState([])
  const [plateAppearances, setPlateAppearances] = useState([])
  const [pitchingStints, setPitchingStints] = useState([])
  const [games, setGames] = useState([])
  const [seasonPlateAppearances, setSeasonPlateAppearances] = useState([])
  const [seasonPitchingStints, setSeasonPitchingStints] = useState([])
  const [gameFielders, setGameFielders] = useState([])
  const [seasonGameFielders, setSeasonGameFielders] = useState([])
  const [allSeasonTeams, setAllSeasonTeams] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState('ovr')
  const [sortDesc, setSortDesc] = useState(true)
  const [availabilityFilter, setAvailabilityFilter] = useState('available')
  const [pendingMiiPick, setPendingMiiPick] = useState(null)
  const [isAutoDrafting, setIsAutoDrafting] = useState(false)
  const [draftError, setDraftError] = useState('')
  const [pendingReveal, setPendingReveal] = useState(null)
  const [myPendingPick, setMyPendingPick] = useState(null)
  const [isRevealing, setIsRevealing] = useState(false)
  const [isMobileBoard, setIsMobileBoard] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.innerWidth <= 480
  })
  const [skipReveal, setSkipReveal] = useState(() => {
    try { return localStorage.getItem('draft-skip-reveal') === 'true' } catch { return false }
  })
  const latestPendingPickRef = useRef(null)

  const hasLoadedRef = useRef(false)
  useEffect(() => {
    const load = async () => {
      if (!hasLoadedRef.current) setLoading(true)
      const [
        { data: pData }, { data: cData }, { data: dData }, { data: paData }, { data: gData }, { data: pitchData }, { data: seasonPaData },
        { data: seasonPitchData }, { data: fieldersData }, { data: seasonFieldersData }, { data: seasonTeamsData },
        { data: gamePitchesData }, { data: seasonGamePitchesData },
      ] = await Promise.all([
        fetchAllRows(() => supabase.from('players').select('*').order('created_at')),
        fetchAllRows(() => supabase.from('characters').select('*').order('name')),
        isSeasonMode
          ? fetchAllRows(() => supabase.from('season_roster').select('*').eq('season_id', activeDraftContext?.id || -1).order('created_at'))
          : fetchAllRows(() => supabase.from('draft_picks').select('*').order('pick_number')),
        fetchAllRows(() => supabase.from('plate_appearances').select('game_id,character_id,player_id,result,run_scored,rbi,is_error,error_character,error_position,hit_location,defensive_team_id,inning')),
        fetchAllRows(() => supabase.from('games').select('id,tournament_id')),
        fetchAllRows(() => supabase.from('pitching_stints').select('*')),
        fetchAllRows(() => supabase.from('season_plate_appearances').select('game_id,character_id,player_id,result,run_scored,rbi,season_id,is_error,error_character,error_position,hit_location,defensive_team_id,inning')),
        fetchAllRows(() => supabase.from('season_pitching_stints').select('*')),
        fetchAllRows(() => supabase.from('game_fielders').select('*')),
        fetchAllRows(() => supabase.from('season_game_fielders').select('*')),
        fetchAllRows(() => supabase.from('season_teams').select('id,player_id')),
        fetchAllRows(() => supabase.from('pitches').select('game_id,pitcher_id')),
        fetchAllRows(() => supabase.from('season_pitches').select('game_id,pitcher_id')),
      ])
      // A pitching_stints row is created the moment a pitcher takes the mound (Scorebook's
      // mound-assignment bookkeeping), before they've necessarily thrown a pitch — if pulled again
      // without facing a batter, that stint sits at 0 IP forever but would still count as a "game"
      // pitched. Drop stints with no matching row in `pitches`/`season_pitches` (by game_id +
      // pitcher name, since pitches.pitcher_id is a name string, not character_id).
      const nameByCharId = Object.fromEntries((cData || []).map((c) => [String(c.id), c.name]))
      const thrownKeys = new Set((gamePitchesData || []).map((p) => `${p.game_id}:${p.pitcher_id}`))
      const seasonThrownKeys = new Set((seasonGamePitchesData || []).map((p) => `${p.game_id}:${p.pitcher_id}`))
      const stintsWithPitches = (pitchData || []).filter((s) => thrownKeys.has(`${s.game_id}:${nameByCharId[String(s.character_id)]}`))
      const seasonStintsWithPitches = (seasonPitchData || []).filter((s) => seasonThrownKeys.has(`${s.game_id}:${nameByCharId[String(s.character_id)]}`))
      const orderedPlayers = isSeasonMode
        ? [...(seasonTeams || [])]
            .sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0))
            .map((team) => (pData || []).find((playerRow) => playerRow.id === team.player_id))
            .filter(Boolean)
        : (() => {
            const draftOrder = activeDraftContext?.draft_order || activeDraftContext?.player_ids || []
            if (!draftOrder.length) return pData || []
            const playersById = Object.fromEntries((pData || []).map((entry) => [entry.id, entry]))
            return draftOrder.map((playerId) => playersById[playerId]).filter(Boolean)
          })()
      const charactersByName = Object.fromEntries((cData || []).map((entry) => [entry.name, entry]))
      const normalizedSeasonPicks = isSeasonMode
        ? normalizeSeasonDraftPicks(dData || [], activeDraftContext?.id, seasonTeams, charactersByName)
        : (dData || [])

      setPlayers(orderedPlayers)
      setCharacters(cData || [])
      setAllDraftPicks(normalizedSeasonPicks)
      setPlateAppearances(paData || [])
      setGames(gData || [])
      setPitchingStints(stintsWithPitches)
      setSeasonPlateAppearances(seasonPaData || [])
      setSeasonPitchingStints(seasonStintsWithPitches)
      setGameFielders(fieldersData || [])
      setSeasonGameFielders(seasonFieldersData || [])
      setAllSeasonTeams(seasonTeamsData || [])
      setLoading(false)
      hasLoadedRef.current = true
    }
    load()
  }, [isSeasonMode, activeDraftContext?.id, activeDraftContext?.draft_order, activeDraftContext?.player_ids, seasonTeams])

  const refreshSeasonDraftPicks = useCallback(async () => {
    if (!isSeasonMode || !activeDraftContext?.id) return
    const [{ data }, { data: charsData }] = await Promise.all([
      supabase.from('season_roster').select('*').eq('season_id', activeDraftContext.id).order('created_at'),
      supabase.from('characters').select('*').order('name'),
    ])
    const charactersByName = Object.fromEntries((charsData || []).map((entry) => [entry.name, entry]))
    setAllDraftPicks(normalizeSeasonDraftPicks(data || [], activeDraftContext.id, seasonTeams, charactersByName))
  }, [activeDraftContext?.id, isSeasonMode, seasonTeams])

  useEffect(() => {
    if (!activeDraftContext?.id) return
    const ch = supabase
      .channel(isSeasonMode ? `season-draft-${activeDraftContext.id}` : `draft-${activeDraftContext.id}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: isSeasonMode ? 'season_roster' : 'draft_picks',
        filter: `${isSeasonMode ? 'season_id' : 'tournament_id'}=eq.${activeDraftContext.id}`,
      }, async () => {
        if (isSeasonMode) {
          await refreshSeasonDraftPicks()
          return
        }
        const { data } = await supabase.from('draft_picks').select('*').eq('tournament_id', activeDraftContext.id).order('pick_number')
        setAllDraftPicks(cur => [...cur.filter(p => p.tournament_id !== activeDraftContext.id), ...(data || [])])
      })
      .subscribe()
    return () => supabase.removeChannel(ch)
  }, [activeDraftContext?.id, isSeasonMode, refreshSeasonDraftPicks])

  useEffect(() => {
    try { localStorage.setItem('draft-skip-reveal', String(skipReveal)) } catch { /* ignore */ }
  }, [skipReveal])

  useEffect(() => {
    const handleResize = () => setIsMobileBoard(window.innerWidth <= 480)
    handleResize()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  // Channel used to tell the presentation screen to advance to its next slide.
  const presentationChannelRef = useRef(null)
  useEffect(() => {
    if (!activeDraftContext?.id) {
      presentationChannelRef.current = null
      return undefined
    }
    const channelName = isSeasonMode ? `season-presentation-${activeDraftContext.id}` : `presentation-${activeDraftContext.id}`
    const ch = supabase.channel(channelName)
    ch.subscribe()
    presentationChannelRef.current = ch
    return () => {
      supabase.removeChannel(ch)
      presentationChannelRef.current = null
    }
  }, [activeDraftContext?.id, isSeasonMode])

  const advancePresentationSlide = useCallback(() => {
    presentationChannelRef.current?.send({ type: 'broadcast', event: 'advance', payload: {} })
  }, [])

  const retreatPresentationSlide = useCallback(() => {
    presentationChannelRef.current?.send({ type: 'broadcast', event: 'back', payload: {} })
  }, [])

  useEffect(() => {
    latestPendingPickRef.current = myPendingPick
  }, [myPendingPick])

  // Channel used to send a player's pick to the commissioner for manual reveal (no spoilers on the presentation).
  const pendingPickChannelRef = useRef(null)
  useEffect(() => {
    if (!activeDraftContext?.id) {
      pendingPickChannelRef.current = null
      return undefined
    }
    const channelName = isSeasonMode ? `season-pending-pick-${activeDraftContext.id}` : `pending-pick-${activeDraftContext.id}`
    const ch = supabase.channel(channelName)
    ch.on('broadcast', { event: 'pick-pending' }, ({ payload }) => {
      setPendingReveal(payload)
    })
    ch.on('broadcast', { event: 'pick-cleared' }, () => {
      setPendingReveal(null)
      setMyPendingPick(null)
    })
    ch.on('broadcast', { event: 'sync-pending-request' }, () => {
      if (player?.is_commissioner) return
      const pendingPick = latestPendingPickRef.current
      if (!pendingPick) return
      ch.send({ type: 'broadcast', event: 'pick-pending', payload: pendingPick })
    })
    ch.subscribe((status) => {
      if (status === 'SUBSCRIBED' && player?.is_commissioner) {
        ch.send({ type: 'broadcast', event: 'sync-pending-request', payload: {} })
      }
    })
    pendingPickChannelRef.current = ch
    return () => {
      supabase.removeChannel(ch)
      pendingPickChannelRef.current = null
    }
  }, [activeDraftContext?.id, isSeasonMode, player?.is_commissioner])

  const draftPicks = useMemo(
    () => allDraftPicks.filter(p => p.tournament_id === activeDraftContext?.id),
    [allDraftPicks, activeDraftContext?.id]
  )

  // Clear any pending (unrevealed) pick once the pick count changes — a pick was made or undone.
  useEffect(() => {
    setPendingReveal(null)
    setMyPendingPick(null)
  }, [draftPicks.length])
  const picksByCharacter = useMemo(
    () => Object.fromEntries(draftPicks.map(p => [p.character_id, p])),
    [draftPicks]
  )
  const playersById = useMemo(() => Object.fromEntries(players.map(p => [p.id, p])), [players])
  const charactersById = useMemo(() => Object.fromEntries(characters.map(c => [c.id, c])), [characters])
  const teamIdentitiesByPlayerId = useMemo(
    () => {
      if (!isSeasonMode) {
        return buildTournamentTeamIdentityMap(draftPicks, charactersById, {}, playersById)
      }
      return Object.fromEntries(
        (seasonTeams || []).map((team) => [team.player_id, {
          playerId: team.player_id,
          teamName: team.team_name || 'Season Team',
          teamMascot: team.team_mascot || null,
          teamLogoKey: team.team_logo_key || null,
          teamLogoUrl: team.logo_url || null,
        }]),
      )
    },
    [draftPicks, charactersById, isSeasonMode, seasonTeams],
  )

  // Historical performance per character per game, across tournaments and seasons
  // (exclude the event currently being drafted — you can't know how someone does
  // in the tournament/season you're drafting for).
  const historicalGames = useMemo(
    () => games.filter(g => g.tournament_id !== activeDraftContext?.id),
    [games, activeDraftContext?.id]
  )
  const historicalPAs = useMemo(() => {
    const hGameIds = new Set(historicalGames.map(g => g.id))
    return plateAppearances.filter(pa => hGameIds.has(pa.game_id))
  }, [plateAppearances, historicalGames])
  const historicalSeasonPAs = useMemo(() => {
    if (!isSeasonMode) return seasonPlateAppearances
    return seasonPlateAppearances.filter(pa => String(pa.season_id) !== String(activeDraftContext?.id))
  }, [seasonPlateAppearances, isSeasonMode, activeDraftContext?.id])

  const tournHistories = useMemo(
    () => buildCharacterGameHistory(historicalPAs, historicalGames, allTournaments || [], historicalSeasonPAs, allSeasons || []),
    [historicalPAs, historicalGames, allTournaments, historicalSeasonPAs, allSeasons]
  )

  const charactersByName = useMemo(
    () => Object.fromEntries(characters.map((entry) => [entry.name, entry])),
    [characters],
  )
  const playerNameById = useMemo(
    () => Object.fromEntries((players || []).map((player) => [player.id, player.name])),
    [players],
  )
  // Built from every season's teams (not just the one being drafted) since the fielding history
  // below pools chances across all past seasons and tournaments — resolving a historical team_id
  // only against the active draft's roster would silently drop or misattribute every other
  // season's team-relative comparison.
  const seasonTeamPlayerById = useMemo(
    () => Object.fromEntries((allSeasonTeams || []).map((team) => [team.id, team.player_id])),
    [allSeasonTeams],
  )

  const historicalPitchingStints = useMemo(() => {
    const hGameIds = new Set(historicalGames.map(g => g.id))
    return pitchingStints.filter(stint => hGameIds.has(stint.game_id))
  }, [pitchingStints, historicalGames])
  const historicalSeasonPitchingStints = useMemo(() => {
    if (!isSeasonMode) return seasonPitchingStints
    return seasonPitchingStints.filter(stint => String(stint.season_id) !== String(activeDraftContext?.id))
  }, [seasonPitchingStints, isSeasonMode, activeDraftContext?.id])

  const pitchingTournHistories = useMemo(
    () => buildCharacterPitchingGameHistory(historicalPitchingStints, historicalGames, allTournaments || [], historicalSeasonPitchingStints, allSeasons || [], null, playerNameById),
    [historicalPitchingStints, historicalGames, allTournaments, historicalSeasonPitchingStints, allSeasons, playerNameById]
  )

  const fieldingTournHistories = useMemo(
    () => buildCharacterFieldingGameHistory(
      historicalPAs, gameFielders, historicalGames, allTournaments || [],
      historicalSeasonPAs, seasonGameFielders, allSeasons || [], charactersByName, seasonTeamPlayerById,
    ),
    [historicalPAs, gameFielders, historicalGames, allTournaments, historicalSeasonPAs, seasonGameFielders, allSeasons, charactersByName, seasonTeamPlayerById]
  )

  const getCharacterAnalysis = useCallback(
    (character) => character
      ? analyzeCharacterTalent(character, tournHistories[character.id], pitchingTournHistories[character.id], fieldingTournHistories[character.id])
      : null,
    [tournHistories, pitchingTournHistories, fieldingTournHistories],
  )

  // All-game history (includes the current event)
  const allTournHistories = useMemo(
    () => buildCharacterGameHistory(plateAppearances, games, allTournaments || [], seasonPlateAppearances, allSeasons || []),
    [plateAppearances, games, allTournaments, seasonPlateAppearances, allSeasons]
  )

  const pitchingHistoryByCharacter = useMemo(() => {
    const gameByIdMap = Object.fromEntries(games.map(g => [g.id, g]))
    const tournById = Object.fromEntries((allTournaments || []).map(t => [t.id, t]))
    const byCharTournament = {}
    for (const stint of pitchingStints) {
      const game = gameByIdMap[stint.game_id]
      if (!game || !stint.character_id) continue
      const tid = game.tournament_id
      const cid = stint.character_id
      if (!byCharTournament[cid]) byCharTournament[cid] = {}
      if (!byCharTournament[cid][tid]) byCharTournament[cid][tid] = []
      byCharTournament[cid][tid].push(stint)
    }
    const result = {}
    for (const [charId, byT] of Object.entries(byCharTournament)) {
      result[charId] = Object.entries(byT)
        .map(([tid, stints]) => {
          const t = tournById[tid]
          return {
            tournamentId: tid,
            tournamentNumber: t?.tournament_number ?? '?',
            rawStints: stints,
            ...summarizePitching(stints),
          }
        })
        .sort((a, b) => (a.tournamentNumber > b.tournamentNumber ? 1 : -1))
    }
    return result
  }, [pitchingStints, games, allTournaments])

  // Draft order
  const baseDraftState = useMemo(
    () => getCurrentDraftState(players, draftPicks),
    [players, draftPicks]
  )
  const seasonRosterCountsByTeamId = useMemo(() => {
    if (!isSeasonMode) return {}
    return draftPicks.reduce((acc, pick) => {
      const teamId = String(pick.team_id || '')
      if (!teamId) return acc
      acc[teamId] = (acc[teamId] || 0) + 1
      return acc
    }, {})
  }, [draftPicks, isSeasonMode])
  const seasonTeamsMissingRosterSpots = useMemo(() => {
    if (!isSeasonMode) return []
    return (seasonTeams || [])
      .map((team) => ({
        ...team,
        rosterCount: Number(seasonRosterCountsByTeamId[String(team.id)] || 0),
      }))
      .filter((team) => team.rosterCount < 9)
  }, [isSeasonMode, seasonTeams, seasonRosterCountsByTeamId])
  const seasonMissingRosterSlots = useMemo(
    () => seasonTeamsMissingRosterSpots.reduce((sum, team) => sum + Math.max(0, 9 - team.rosterCount), 0),
    [seasonTeamsMissingRosterSpots],
  )
  const seasonDraftCompletionBlocked = Boolean(isSeasonMode && baseDraftState.isDraftComplete && seasonTeamsMissingRosterSpots.length > 0)
  const totalPicks = baseDraftState.totalPicks
  const currentPickNumber = seasonDraftCompletionBlocked ? draftPicks.length + 1 : baseDraftState.currentPickNumber
  const round = seasonDraftCompletionBlocked ? Math.ceil(currentPickNumber / Math.max(players.length, 1)) : baseDraftState.round
  const pickInRound = seasonDraftCompletionBlocked ? (currentPickNumber - 1) % Math.max(players.length, 1) : baseDraftState.pickInRound
  const currentDrafter = seasonDraftCompletionBlocked
    ? players.find((entry) => String(entry.id) === String(seasonTeamsMissingRosterSpots[0]?.player_id)) || null
    : baseDraftState.currentDrafter
  const isDraftComplete = baseDraftState.isDraftComplete && !seasonDraftCompletionBlocked
  const draftStatusOpen = isSeasonMode ? activeDraftContext?.status === 'draft' : activeDraftContext?.status === 'drafting'
  const picksRemaining = seasonDraftCompletionBlocked
    ? seasonMissingRosterSlots
    : Math.max(0, totalPicks - draftPicks.length)
  const isYourTurn = !isDraftComplete && currentDrafter?.id === player?.id
  const canDraft = draftStatusOpen && !isDraftComplete
  const playersWithCaptainPick = useMemo(
    () => new Set(
      draftPicks
        .filter((pick) => Number(pick.pick_number || 0) <= players.length)
        .filter((pick) => pick.character_id)
        .map((pick) => pick.player_id),
    ),
    [draftPicks, players.length],
  )
  const isCaptainRoundLocked = players.length > 0 && playersWithCaptainPick.size < players.length

  const myRosterNames = useMemo(() => {
    if (!player?.id) return []
    return draftPicks
      .filter(p => p.player_id === player.id && p.character_id)
      .map(p => {
        const character = charactersById[p.character_id]
        return character ? getCharacterChemistryName(character.name, p.mii_color) : null
      })
      .filter(Boolean)
  }, [draftPicks, player?.id, charactersById])

  const allDraftedNames = useMemo(
    () => draftPicks.filter(p => p.character_id).map(p => charactersById[p.character_id]?.name).filter(Boolean),
    [draftPicks, charactersById]
  )
  const showDraftedMetadata = availabilityFilter === 'drafted' || availabilityFilter === 'all'
  const draftBoardActionButtonWidth = isMobileBoard ? 40 : 56
  const draftBoardActionColumnWidth = isMobileBoard ? 48 : 64
  const draftBoardColumns = showDraftedMetadata
    ? (
        isMobileBoard
          ? `22px minmax(0, 1fr) 24px 24px 24px 24px 26px 42px 20px 24px ${draftBoardActionColumnWidth}px`
          : `32px 1fr 46px 46px 46px 46px 46px 120px 44px 52px ${draftBoardActionColumnWidth}px`
      )
    : (
        isMobileBoard
          ? `22px minmax(0, 1fr) 24px 24px 24px 24px 26px ${draftBoardActionColumnWidth}px`
          : `32px 1fr 46px 46px 46px 46px 46px ${draftBoardActionColumnWidth}px`
      )
  const draftBoardMinWidth = isMobileBoard ? 0 : showDraftedMetadata ? 620 : 460
  const draftBoardGap = isMobileBoard ? 2 : 4
  const draftBoardHeaderPadding = isMobileBoard ? '4px 2px' : '4px 6px'
  const draftBoardRowPadding = isMobileBoard ? '6px 2px' : '7px 6px'
  const draftBoardHeaderFontSize = isMobileBoard ? 9 : 10
  const draftBoardValueFontSize = isMobileBoard ? 11 : 13
  const draftBoardMetaFontSize = isMobileBoard ? 9 : 10
  const draftBoardPortraitSize = isMobileBoard ? 22 : 28
  const draftBoardActionButtonStyle = {
    width: draftBoardActionButtonWidth,
    minHeight: isMobileBoard ? 24 : 28,
    padding: isMobileBoard ? '4px 2px' : '4px 6px',
    borderRadius: 6,
    fontSize: isMobileBoard ? 10 : 11,
    fontWeight: 700,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    justifySelf: 'center',
    whiteSpace: 'nowrap',
    lineHeight: 1,
  }

  const sortedCharacters = useMemo(() => {
    let list = characters
      .filter((c) => {
        const isDrafted = Boolean(picksByCharacter[c.id])
        if (availabilityFilter === 'all') return true
        if (availabilityFilter === 'drafted') return isDrafted
        return !isDrafted
      })
      .filter(c => c.name.toLowerCase().includes(search.toLowerCase()))
    if (isCaptainRoundLocked) {
      list = list.filter(c => isCaptainCharacterName(c.name))
    }
    const sorted = [...list].sort((a, b) => {
      let compareVal = 0
      if (sortKey === 'value') compareVal = (getCharacterAnalysis(b)?.battingScore || 0) - (getCharacterAnalysis(a)?.battingScore || 0)
      else if (sortKey === 'ovr') compareVal = (getCharacterAnalysis(b)?.overallRaw || 0) - (getCharacterAnalysis(a)?.overallRaw || 0)
      else if (sortKey === 'pitchValue') compareVal = (getCharacterAnalysis(b)?.pitchingScore || 0) - (getCharacterAnalysis(a)?.pitchingScore || 0)
      else if (sortKey === 'fieldValue') compareVal = (getCharacterAnalysis(b)?.fieldingScore || 0) - (getCharacterAnalysis(a)?.fieldingScore || 0)
      else if (sortKey === 'speedValue') compareVal = (getCharacterAnalysis(b)?.speedScore || 0) - (getCharacterAnalysis(a)?.speedScore || 0)
      else if (sortKey === 'history') {
        const ha = (tournHistories[a.id] || []).filter(t => t.perfScore !== null)
        const hb = (tournHistories[b.id] || []).filter(t => t.perfScore !== null)
        const sa = ha.length ? ha.reduce((s, t) => s + t.perfScore, 0) / ha.length : 0
        const sb = hb.length ? hb.reduce((s, t) => s + t.perfScore, 0) / hb.length : 0
        compareVal = sb - sa
      }
      else if (sortKey === 'chemistry') {
        const sa = chemScore(a.name, myRosterNames) ?? -999
        const sb = chemScore(b.name, myRosterNames) ?? -999
        compareVal = sb - sa
      }
      else if (sortKey === 'tournaments') {
        const ha = (tournHistories[a.id] || []).length
        const hb = (tournHistories[b.id] || []).length
        compareVal = hb - ha
      }
      else if (sortKey === 'trend') {
        const ta = trendSymbol(tournHistories[a.id])
        const tb = trendSymbol(tournHistories[b.id])
        const tval = { '↑': 3, '→': 1, '↓': -1 }
        compareVal = (tval[tb] || 0) - (tval[ta] || 0)
      }
      else if (sortKey === 'round') {
        const ra = picksByCharacter[a.id]?.round ?? 9999
        const rb = picksByCharacter[b.id]?.round ?? 9999
        compareVal = ra - rb
      }
      else if (sortKey === 'pick_number') {
        const pa = picksByCharacter[a.id]?.pick_number ?? 9999
        const pb = picksByCharacter[b.id]?.pick_number ?? 9999
        compareVal = pa - pb
      }
      else compareVal = b[sortKey] - a[sortKey]
      
      return sortDesc ? compareVal : -compareVal
    })
    return sorted
  }, [characters, picksByCharacter, availabilityFilter, isCaptainRoundLocked, search, sortKey, sortDesc, tournHistories, getCharacterAnalysis, myRosterNames])

  const openCharacterPage = useCallback((id) => {
    const character = charactersById[id]
    if (!character) return
    const pick = picksByCharacter[id]
    const currentOwner = pick ? { player_id: pick.player_id } : null
    navigate(`/character/${id}/career`, {
      state: {
        backTo: window.location.pathname + window.location.search,
        character,
        allCharactersById: Object.fromEntries(characters.map((entry) => [entry.name, entry])),
        playersById,
        identitiesByPlayerId: teamIdentitiesByPlayerId,
        currentOwner,
        currentContext: activeDraftContext?.id ? { type: isSeasonMode ? 'season' : 'tournament', id: activeDraftContext.id } : null,
        rosterNames: myRosterNames,
        profileData: {
          gameHistory: tournHistories[id] || [],
          pitchingGameHistory: pitchingTournHistories[id] || [],
          fieldingGameHistory: fieldingTournHistories[id] || [],
        },
      },
    })
  }, [charactersById, picksByCharacter, navigate, characters, playersById, teamIdentitiesByPlayerId, activeDraftContext, isSeasonMode, myRosterNames, tournHistories, pitchingTournHistories, fieldingTournHistories])

  const handleHeaderClick = useCallback((key) => {
    if (sortKey === key) {
      setSortDesc(prev => !prev)
    } else {
      setSortKey(key)
      setSortDesc(true)
    }
  }, [sortKey])

  const validateCaptainPick = useCallback((targetPlayerId, character) => {
    const playerHasPick = draftPicks.some((pick) => pick.player_id === targetPlayerId && pick.character_id)
    if (!playerHasPick) {
      if (!isCaptainCharacterName(character?.name)) {
        return 'Your first pick must be a captain.'
      }
    }
    return ''
  }, [draftPicks])

  const insertDraftPick = useCallback(async ({ targetPlayerId, characterId, miiColor = null }) => {
    const character = charactersById[characterId]
    const firstPickForPlayer = !draftPicks.some((pick) => pick.player_id === targetPlayerId && pick.character_id)
    const captainIdentity = getCaptainIdentityFromName(character?.name)
    if (isSeasonMode) {
      const targetTeam = (seasonTeams || []).find((team) => team.player_id === targetPlayerId)
      if (!targetTeam) {
        return { error: { message: 'Unable to find season team for this player.' } }
      }
      const seasonPayload = {
        season_id: activeDraftContext.id,
        team_id: targetTeam.id,
        character_name: character?.name,
        acquired_via: activeDraftContext?.league_type === 'keeper' ? 'draft' : 'draft',
        is_active: true,
        round,
        pick_number: currentPickNumber,
        pick_in_round: pickInRound + 1,
      }
      const { error } = await supabase.from('season_roster').insert(seasonPayload)
      if (!error && firstPickForPlayer && captainIdentity) {
        await supabase.from('season_teams').update({
          team_logo_key: captainIdentity.logoKey,
        }).eq('id', targetTeam.id)
      }
      return { error }
    }
    const payload = {
      tournament_id: activeDraftContext.id,
      pick_number: currentPickNumber,
      round,
      pick_in_round: pickInRound + 1,
      player_id: targetPlayerId,
      character_id: characterId,
    }
    if (miiColor) payload.mii_color = miiColor
    if (firstPickForPlayer && captainIdentity) {
      payload.is_captain = true
      payload.captain_character_name = character.name === 'Bowser Jr' ? 'Bowser Jr.' : character.name
      payload.team_logo_key = captainIdentity.logoKey
    }

    const { error } = await supabase.from('draft_picks').insert(payload)
    if (error && miiColor && error.message?.includes('mii_color')) {
      return {
        error: {
          ...error,
          message: 'The database is missing the new mii_color column. Apply the latest Supabase migration, then try the Mii pick again.',
        },
      }
    }
    return { error }
  }, [charactersById, activeDraftContext?.id, activeDraftContext?.league_type, currentPickNumber, draftPicks, round, pickInRound, isSeasonMode, seasonTeams])

  const finalizeDraftPick = useCallback(async ({ targetPlayerId, character, miiColor, toastTitle, toastVerb }) => {
    const { error } = await insertDraftPick({ targetPlayerId, characterId: character.id, miiColor })
    if (error) { pushToast({ title: `${toastTitle} failed`, message: error.message, type: 'error' }); return false }
    if (!isSeasonMode) {
      const { data } = await supabase.from('draft_picks').select('*').eq('tournament_id', activeDraftContext.id).order('pick_number')
      setAllDraftPicks(cur => [...cur.filter(p => p.tournament_id !== activeDraftContext.id), ...(data || [])])
    }
    setDraftError('')
    pushToast({ title: toastTitle, message: `${getTeamShortName(teamIdentitiesByPlayerId[targetPlayerId]) || playersById[targetPlayerId]?.name} ${toastVerb} ${formatCharacterDisplayName(character.name, miiColor)}.`, type: 'success' })
    return true
  }, [activeDraftContext, insertDraftPick, isSeasonMode, teamIdentitiesByPlayerId, playersById, pushToast])

  const submitDraftPick = useCallback(async (character, miiColor = null) => {
    if (!character || !activeDraftContext) return
    if (!canDraft) {
      pushToast({ title: isDraftComplete ? 'Draft complete' : 'Draft locked', message: isDraftComplete ? 'No picks remain in this draft.' : 'Drafting is not currently open.', type: 'error' })
      return
    }
    if (!currentDrafter) return
    if (!isYourTurn) { pushToast({ title: 'Not your pick', message: 'Wait for your turn.', type: 'error' }); return }
    const captainError = validateCaptainPick(currentDrafter.id, character)
    if (captainError) {
      setDraftError(captainError)
      pushToast({ title: 'Captain required', message: captainError, type: 'error' })
      return
    }
    if (skipReveal) {
      const ok = await finalizeDraftPick({ targetPlayerId: currentDrafter.id, character, miiColor, toastTitle: 'Pick submitted', toastVerb: 'drafted' })
      if (ok) { setPendingMiiPick(null) }
      return
    }
    const pendingPickPayload = { playerId: currentDrafter.id, characterId: character.id, miiColor }
    pendingPickChannelRef.current?.send({ type: 'broadcast', event: 'pick-pending', payload: pendingPickPayload })
    setPendingReveal(pendingPickPayload)
    setMyPendingPick(pendingPickPayload)
    setDraftError('')
    pushToast({ title: 'Pick sent', message: `Your pick has been sent to the commissioner to reveal.`, type: 'success' })
    setPendingMiiPick(null)
  }, [activeDraftContext, canDraft, currentDrafter, isDraftComplete, isYourTurn, pushToast, validateCaptainPick, skipReveal, finalizeDraftPick])

  const undoLastPick = useCallback(async () => {
    if (!draftPicks.length) return
    const removedPick = draftPicks[draftPicks.length - 1]
    const { error } = await supabase
      .from(isSeasonMode ? 'season_roster' : 'draft_picks')
      .delete()
      .eq('id', removedPick.id)
    if (error) { pushToast({ title: 'Undo failed', message: error.message, type: 'error' }); return }
    if (isSeasonMode) {
      await refreshSeasonDraftPicks()
    } else {
      setAllDraftPicks(cur => cur.filter(p => p.id !== removedPick.id))
    }
    pushToast({ title: 'Pick undone', type: 'success' })
  }, [draftPicks, pushToast, isSeasonMode, refreshSeasonDraftPicks])

  const confirmPendingPick = useCallback(async () => {
    if (!pendingReveal || !activeDraftContext) return
    const character = charactersById[pendingReveal.characterId]
    if (!character) return
    if (!canDraft) {
      pushToast({ title: isDraftComplete ? 'Draft complete' : 'Draft locked', message: isDraftComplete ? 'No picks remain in this draft.' : 'Drafting is not currently open.', type: 'error' })
      return
    }
    const captainError = validateCaptainPick(pendingReveal.playerId, character)
    if (captainError) { pushToast({ title: 'Captain required', message: captainError, type: 'error' }); return }
    setIsRevealing(true)
    const { error } = await insertDraftPick({ targetPlayerId: pendingReveal.playerId, characterId: character.id, miiColor: pendingReveal.miiColor })
    if (error) {
      pushToast({ title: 'Pick failed', message: error.message, type: 'error' })
      setIsRevealing(false)
      return
    }
    if (!isSeasonMode) {
      const { data } = await supabase.from('draft_picks').select('*').eq('tournament_id', activeDraftContext.id).order('pick_number')
      setAllDraftPicks(cur => [...cur.filter(p => p.tournament_id !== activeDraftContext.id), ...(data || [])])
    }
    setDraftError('')
    pendingPickChannelRef.current?.send({ type: 'broadcast', event: 'pick-cleared', payload: {} })
    setPendingReveal(null)
    setMyPendingPick(null)
    pushToast({ title: 'Pick made', message: `${getTeamShortName(teamIdentitiesByPlayerId[pendingReveal.playerId]) || playersById[pendingReveal.playerId]?.name} drafted ${formatCharacterDisplayName(character.name, pendingReveal.miiColor)}.`, type: 'success' })
    setIsRevealing(false)
  }, [pendingReveal, activeDraftContext, charactersById, canDraft, isDraftComplete, validateCaptainPick, insertDraftPick, isSeasonMode, teamIdentitiesByPlayerId, playersById, pushToast])

  const forcePickCharacter = useCallback(async (character, targetPlayerId, miiColor = null) => {
    if (!character || !activeDraftContext) return
    if (!canDraft) {
      pushToast({ title: isDraftComplete ? 'Draft complete' : 'Draft locked', message: isDraftComplete ? 'No picks remain in this draft.' : 'Drafting is not currently open.', type: 'error' })
      return
    }
    const captainError = validateCaptainPick(targetPlayerId, character)
    if (captainError) { pushToast({ title: 'Captain required', message: captainError, type: 'error' }); return }
    if (skipReveal) {
      const ok = await finalizeDraftPick({ targetPlayerId, character, miiColor, toastTitle: 'Pick forced', toastVerb: 'drafted' })
      if (ok) setPendingMiiPick(null)
      return
    }
    pendingPickChannelRef.current?.send({ type: 'broadcast', event: 'pick-pending', payload: { playerId: targetPlayerId, characterId: character.id, miiColor } })
    setPendingReveal({ playerId: targetPlayerId, characterId: character.id, miiColor })
    setDraftError('')
    pushToast({ title: 'Pick sent', message: `Forced pick for ${getTeamShortName(teamIdentitiesByPlayerId[targetPlayerId]) || playersById[targetPlayerId]?.name} is ready to reveal.`, type: 'success' })
    setPendingMiiPick(null)
  }, [activeDraftContext, canDraft, playersById, teamIdentitiesByPlayerId, pushToast, validateCaptainPick, isDraftComplete, skipReveal, finalizeDraftPick])

  const beginDraftPick = useCallback((character) => {
    if (!character) return
    if (!isSeasonMode && isMiiCharacter(character)) {
      setPendingMiiPick({ character, targetPlayerId: null })
      return
    }
    submitDraftPick(character)
  }, [submitDraftPick, isSeasonMode])

  const beginForcePick = useCallback((character, targetPlayerId) => {
    if (!character || !targetPlayerId) return
    if (!isSeasonMode && isMiiCharacter(character)) {
      setPendingMiiPick({ character, targetPlayerId })
      return
    }
    forcePickCharacter(character, targetPlayerId)
  }, [forcePickCharacter, isSeasonMode])

  const confirmPendingMiiPick = useCallback((miiColor) => {
    if (!pendingMiiPick?.character) return
    if (pendingMiiPick.targetPlayerId) {
      forcePickCharacter(pendingMiiPick.character, pendingMiiPick.targetPlayerId, miiColor)
      return
    }
    submitDraftPick(pendingMiiPick.character, miiColor)
  }, [pendingMiiPick, forcePickCharacter, submitDraftPick])

  const autoDraftAll = useCallback(async () => {
    if (!activeDraftContext || !canDraft || players.length === 0 || characters.length === 0 || isCaptainRoundLocked) return
    setIsAutoDrafting(true)

    const draftedIds = new Set(draftPicks.map(p => p.character_id).filter(Boolean))
    const draftedPlayerIds = new Set(draftPicks.filter((pick) => pick.character_id).map((pick) => pick.player_id).filter(Boolean))
    let pickNumber = draftPicks.length + 1
    const inserts = []
    const remaining = totalPicks - draftPicks.length

    for (let i = 0; i < remaining; i++) {
      const rnd = Math.ceil(pickNumber / players.length)
      const orderThisRnd = snakeOrder(players, rnd)
      const pickIdx = (pickNumber - 1) % players.length
      const drafter = orderThisRnd[pickIdx]

      const drafterHasPick = draftedPlayerIds.has(drafter.id)
      const available = characters
        .filter(c => !draftedIds.has(c.id))
        .filter(c => (drafterHasPick ? true : isCaptainCharacterName(c.name)))
      if (available.length === 0) break

      const best = available.reduce((b, c) =>
        (getCharacterAnalysis(c)?.battingScore || 0) > (getCharacterAnalysis(b)?.battingScore || 0) ? c : b
      , available[0])

      const miiColor = isMiiCharacter(best) ? MII_COLOR_OPTIONS[0] : null
      const captainIdentity = getCaptainIdentityFromName(best.name)
      inserts.push(isSeasonMode ? {
        season_id: activeDraftContext.id,
        team_id: (seasonTeams || []).find((team) => team.player_id === drafter.id)?.id || null,
        character_name: best.name,
        acquired_via: activeDraftContext?.league_type === 'keeper' ? 'draft' : 'draft',
        is_active: true,
        round: rnd,
        pick_number: pickNumber,
        pick_in_round: pickIdx + 1,
      } : {
        tournament_id: activeDraftContext.id,
        pick_number: pickNumber,
        round: rnd,
        pick_in_round: pickIdx + 1,
        player_id: drafter.id,
        character_id: best.id,
        ...(!drafterHasPick && captainIdentity ? {
          is_captain: true,
          captain_character_name: best.name === 'Bowser Jr' ? 'Bowser Jr.' : best.name,
          team_logo_key: captainIdentity.logoKey,
        } : {}),
        ...(miiColor ? { mii_color: miiColor } : {}),
      })
      draftedIds.add(best.id)
      draftedPlayerIds.add(drafter.id)
      pickNumber++
    }

    if (inserts.length > 0) {
      const { error } = await supabase.from(isSeasonMode ? 'season_roster' : 'draft_picks').insert(inserts)
      if (error) {
        pushToast({ title: 'Auto draft failed', message: error.message, type: 'error' })
      } else {
        if (isSeasonMode) {
          const captainUpdates = inserts
            .slice(0, Math.max(0, players.length - draftPicks.length))
            .map((entry) => {
              const captainIdentity = getCaptainIdentityFromName(entry.character_name)
              if (!captainIdentity || !entry.team_id) return null
              return supabase.from('season_teams').update({
                team_logo_key: captainIdentity.logoKey,
              }).eq('id', entry.team_id)
            })
            .filter(Boolean)
          if (captainUpdates.length > 0) {
            await Promise.all(captainUpdates)
          }
          await refreshSeasonDraftPicks()
        }
        pushToast({ title: 'Auto draft complete', message: `${inserts.length} picks made.`, type: 'success' })
      }
    }

    setIsAutoDrafting(false)
  }, [activeDraftContext, canDraft, players, draftPicks, characters, totalPicks, tournHistories, getCharacterAnalysis, pushToast, isSeasonMode, seasonTeams, refreshSeasonDraftPicks, isCaptainRoundLocked])

  const autoDraftCaptains = useCallback(async () => {
    if (!activeDraftContext || !canDraft || players.length === 0 || characters.length === 0 || !isCaptainRoundLocked) return
    setIsAutoDrafting(true)

    const draftedIds = new Set(draftPicks.map((pick) => pick.character_id).filter(Boolean))
    const draftedPlayerIds = new Set(draftPicks.filter((pick) => pick.character_id).map((pick) => pick.player_id).filter(Boolean))
    const captainCandidates = characters.filter((entry) => isCaptainCharacterName(entry.name) && !draftedIds.has(entry.id))
    const pendingCaptainPlayers = players.filter((entry) => !draftedPlayerIds.has(entry.id))
    const inserts = []

    for (const drafter of pendingCaptainPlayers) {
      if (!captainCandidates.length) break

      const bestIndex = captainCandidates.reduce((bestSoFar, candidate, index, collection) => {
        const best = collection[bestSoFar]
        const candidateValue = getCharacterAnalysis(candidate)?.pitchingScore || 0
        const bestValue = getCharacterAnalysis(best)?.pitchingScore || 0
        return candidateValue > bestValue ? index : bestSoFar
      }, 0)

      const best = captainCandidates.splice(bestIndex, 1)[0]
      const captainIdentity = getCaptainIdentityFromName(best.name)

      inserts.push(isSeasonMode ? {
        season_id: activeDraftContext.id,
        team_id: (seasonTeams || []).find((team) => team.player_id === drafter.id)?.id || null,
        character_name: best.name,
        acquired_via: activeDraftContext?.league_type === 'keeper' ? 'draft' : 'draft',
        is_active: true,
        round: 1,
        pick_number: draftPicks.length + inserts.length + 1,
        pick_in_round: inserts.length + 1,
      } : {
        tournament_id: activeDraftContext.id,
        pick_number: draftPicks.length + inserts.length + 1,
        round: 1,
        pick_in_round: inserts.length + 1,
        player_id: drafter.id,
        character_id: best.id,
        is_captain: true,
        captain_character_name: best.name === 'Bowser Jr' ? 'Bowser Jr.' : best.name,
        team_logo_key: captainIdentity?.logoKey || null,
      })
      draftedIds.add(best.id)
      draftedPlayerIds.add(drafter.id)
    }

    if (inserts.length > 0) {
      const { error } = await supabase.from(isSeasonMode ? 'season_roster' : 'draft_picks').insert(inserts)
      if (error) {
        pushToast({ title: 'Captain auto draft failed', message: error.message, type: 'error' })
      } else {
        if (isSeasonMode) {
          const captainUpdates = inserts
            .map((entry) => {
              const captainIdentity = getCaptainIdentityFromName(entry.character_name)
              if (!captainIdentity || !entry.team_id) return null
              return supabase.from('season_teams').update({
                team_logo_key: captainIdentity.logoKey,
              }).eq('id', entry.team_id)
            })
            .filter(Boolean)
          if (captainUpdates.length > 0) {
            await Promise.all(captainUpdates)
          }
          await refreshSeasonDraftPicks()
        }
        pushToast({ title: 'Captains auto drafted', message: `${inserts.length} captain pick${inserts.length === 1 ? '' : 's'} made.`, type: 'success' })
      }
    }

    setIsAutoDrafting(false)
  }, [activeDraftContext, canDraft, players, characters, isCaptainRoundLocked, draftPicks, tournHistories, getCharacterAnalysis, isSeasonMode, seasonTeams, pushToast, refreshSeasonDraftPicks])

  return (
    <div style={{ position: 'relative' }}>
      {/* Sticky bar */}
      <div style={{ position: 'sticky', top: 60, zIndex: 19, background: '#0F172A', borderBottom: '1px solid #1E293B', padding: '10px 16px', display: 'flex', alignItems: isMobileBoard ? 'flex-start' : 'center', gap: isMobileBoard ? 12 : 20, flexWrap: 'wrap' }}>
        {[
          { label: 'Pick',      val: loading ? '—' : isDraftComplete ? totalPicks : currentPickNumber },
          { label: 'Round',     val: loading ? '—' : Math.min(round, Math.max(1, Math.ceil(totalPicks / Math.max(players.length, 1)))) },
          { label: 'Remaining', val: loading ? '—' : picksRemaining },
        ].map(({ label, val }) => (
          <div key={label} style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.1 }}>
            <span style={{ fontSize: 10, color: '#64748B', textTransform: 'uppercase', fontWeight: 700 }}>{label}</span>
            <span style={{ fontSize: 18, fontWeight: 800 }}>{val}</span>
          </div>
        ))}
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.1, flex: isMobileBoard ? '1 1 100%' : 1, minWidth: 0 }}>
          <span style={{ fontSize: 10, color: '#64748B', textTransform: 'uppercase', fontWeight: 700 }}>On the clock</span>
          <span style={{ fontSize: 18, fontWeight: 800, color: currentDrafter?.color || '#E2E8F0' }}>
            {loading ? '—' : isDraftComplete ? 'Draft complete' : isYourTurn ? 'You' : <PlayerTag height={24} identitiesByPlayerId={teamIdentitiesByPlayerId} player={currentDrafter} />}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', width: isMobileBoard ? '100%' : 'auto' }}>
          {player?.is_commissioner && (
            <>
              <button
                className="ghost-button"
                onClick={() => window.open(isSeasonMode ? '/season/draft/presentation' : '/draft/presentation', '_blank', 'noopener')}
                type="button"
                style={{ fontSize: 12, padding: '6px 10px' }}
              >
                Presentation Mode
              </button>
              <button className="ghost-button" onClick={retreatPresentationSlide} type="button" style={{ fontSize: 12, padding: '6px 10px', color: '#94A3B8', borderColor: '#94A3B8' }}><ChevronLeft size={14} /> Back Slide</button>
              <button className="ghost-button" onClick={advancePresentationSlide} type="button" style={{ fontSize: 12, padding: '6px 10px', color: '#EAB308', borderColor: '#EAB308' }}><ChevronRight size={14} /> Advance Slide</button>
              <button className="ghost-button" disabled={!draftStatusOpen || !draftPicks.length} onClick={undoLastPick} type="button" style={{ fontSize: 12, padding: '6px 10px' }}><RotateCcw size={14} /> Undo</button>
              <button className="ghost-button" disabled={!canDraft || isAutoDrafting || (!isCaptainRoundLocked && picksRemaining === 0)} onClick={isCaptainRoundLocked ? autoDraftCaptains : autoDraftAll} type="button" style={{ fontSize: 12, padding: '6px 10px', color: '#A78BFA', borderColor: '#A78BFA' }}><Zap size={14} /> {isAutoDrafting ? 'Drafting…' : (isCaptainRoundLocked ? 'Auto Draft Captains' : 'Auto Draft')}</button>
              <label title="When on, picks are made instantly without waiting for commissioner confirmation. Use if you're not running the presentation." style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: skipReveal ? '#EAB308' : '#94A3B8', border: `1px solid ${skipReveal ? '#EAB308' : '#334155'}`, borderRadius: 8, padding: '6px 10px', cursor: 'pointer' }}>
                <input type="checkbox" checked={skipReveal} onChange={(e) => setSkipReveal(e.target.checked)} style={{ margin: 0 }} />
                Skip Pick Reveal
              </label>
            </>
          )}
        </div>
      </div>

      {seasonDraftCompletionBlocked ? (
        <div style={{ margin: '10px 16px 0', padding: '12px 14px', borderRadius: 12, border: '1px solid rgba(248,113,113,0.45)', background: 'rgba(127,29,29,0.22)', color: '#FCA5A5', fontSize: 13, fontWeight: 700 }}>
          Draft completion blocked: {seasonTeamsMissingRosterSpots.map((team) => `${getTeamShortName(teamIdentitiesByPlayerId[team.player_id]) || playersById[team.player_id]?.name || 'Unknown team'} needs ${9 - team.rosterCount}`).join(', ')}.
        </div>
      ) : null}

      {pendingReveal && player?.is_commissioner ? (
        <div style={{ margin: '10px 16px 0', background: '#1E293B', border: '1px solid #EAB30855', borderRadius: 12, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Portrait name={charactersById[pendingReveal.characterId]?.name} size={36} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: '#94A3B8', fontWeight: 700, textTransform: 'uppercase' }}>
              <PlayerTag height={18} identitiesByPlayerId={teamIdentitiesByPlayerId} playerId={pendingReveal.playerId} playersById={playersById} /> picked
            </div>
            <div style={{ fontSize: 16, fontWeight: 800, color: '#FDE68A' }}>
              {formatCharacterDisplayName(charactersById[pendingReveal.characterId]?.name, pendingReveal.miiColor)}
            </div>
          </div>
          <button className="solid-button" disabled={isRevealing} onClick={confirmPendingPick} type="button" style={{ width: 'auto', padding: '8px 16px' }}>
            {isRevealing ? 'Making pick…' : 'Make Pick'}
          </button>
        </div>
      ) : null}

      {myPendingPick && !player?.is_commissioner ? (
        <div style={{ margin: '10px 16px 0', background: '#1E293B', border: '1px solid #33415588', borderRadius: 12, padding: '10px 14px', color: '#94A3B8', fontWeight: 600 }}>
          Pick sent — waiting for the commissioner to reveal {formatCharacterDisplayName(charactersById[myPendingPick.characterId]?.name, myPendingPick.miiColor)}.
        </div>
      ) : null}

      {isCaptainRoundLocked ? (
        <div style={{ margin: '10px 16px 0', background: '#EAB30818', border: '1px solid #EAB30855', borderRadius: 12, padding: '10px 14px', color: '#FDE68A', fontWeight: 700 }}>
          Round 1 — Select your captain.
        </div>
      ) : null}

      {draftError ? (
        <div style={{ margin: '10px 16px 0', background: '#7F1D1D55', border: '1px solid #EF444488', borderRadius: 12, padding: '10px 14px', color: '#FECACA', fontWeight: 700 }}>
          {draftError}
        </div>
      ) : null}

      <div style={{ padding: '0 16px 80px' }}>
        {/* Toolbar */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '12px 0 6px', flexWrap: 'wrap' }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…" style={{ background: '#1E293B', border: '1px solid #334155', borderRadius: 8, color: '#E2E8F0', padding: '7px 12px', fontSize: 14, width: 150 }} />
          <select value={availabilityFilter} onChange={(e) => setAvailabilityFilter(e.target.value)} style={{ background: '#1E293B', border: '1px solid #334155', borderRadius: 8, color: '#E2E8F0', padding: '7px 12px', fontSize: 14 }}>
            <option value="available">Available Only</option>
            <option value="all">All Players</option>
            <option value="drafted">Drafted Players</option>
          </select>
        </div>

        {/* Scrollable character board — overflow on both axes so position:sticky works inside */}
        <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 'calc(100vh - 200px)', WebkitOverflowScrolling: 'touch' }}>
          <div style={{ minWidth: draftBoardMinWidth || undefined }}>

        {/* Column headers — sticky within the scroll container */}
        <div style={{ display: 'grid', gridTemplateColumns: draftBoardColumns, gap: draftBoardGap, padding: draftBoardHeaderPadding, color: '#475569', fontSize: draftBoardHeaderFontSize, fontWeight: 700, textTransform: 'uppercase', borderBottom: '1px solid #1E293B', letterSpacing: '.04em', position: 'sticky', top: 0, zIndex: 10, background: '#0F172A' }}>
          <span />
          <span>Name</span>
          <button onClick={() => handleHeaderClick('value')} type="button" style={{ textAlign: 'center', background: 'none', border: 'none', color: sortKey === 'value' ? '#EAB308' : '#475569', cursor: 'pointer', padding: 0, fontSize: draftBoardHeaderFontSize, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: isMobileBoard ? 0 : 2 }}><StatIcon stat="batting" size={isMobileBoard ? 11 : 13} /> {sortKey === 'value' && (sortDesc ? '↓' : '↑')}</button>
          <button onClick={() => handleHeaderClick('pitchValue')} type="button" style={{ textAlign: 'center', background: 'none', border: 'none', color: sortKey === 'pitchValue' ? '#EAB308' : '#475569', cursor: 'pointer', padding: 0, fontSize: draftBoardHeaderFontSize, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: isMobileBoard ? 0 : 2 }}><StatIcon stat="pitching" size={isMobileBoard ? 11 : 13} /> {sortKey === 'pitchValue' && (sortDesc ? '↓' : '↑')}</button>
          <button onClick={() => handleHeaderClick('fieldValue')} type="button" style={{ textAlign: 'center', background: 'none', border: 'none', color: sortKey === 'fieldValue' ? '#EAB308' : '#475569', cursor: 'pointer', padding: 0, fontSize: draftBoardHeaderFontSize, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: isMobileBoard ? 0 : 2 }}><StatIcon stat="fielding" size={isMobileBoard ? 11 : 13} /> {sortKey === 'fieldValue' && (sortDesc ? '↓' : '↑')}</button>
          <button onClick={() => handleHeaderClick('speedValue')} type="button" style={{ textAlign: 'center', background: 'none', border: 'none', color: sortKey === 'speedValue' ? '#EAB308' : '#475569', cursor: 'pointer', padding: 0, fontSize: draftBoardHeaderFontSize, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: isMobileBoard ? 0 : 2 }}><StatIcon stat="speed" size={isMobileBoard ? 11 : 13} /> {sortKey === 'speedValue' && (sortDesc ? '↓' : '↑')}</button>
          <button onClick={() => handleHeaderClick('ovr')} type="button" style={{ textAlign: 'center', background: 'none', border: 'none', color: sortKey === 'ovr' ? '#EAB308' : '#475569', cursor: 'pointer', padding: 0, fontSize: draftBoardHeaderFontSize, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0 }}>OVR {sortKey === 'ovr' && (sortDesc ? '↓' : '↑')}</button>
          {showDraftedMetadata ? <span style={{ textAlign: 'left' }}>{isMobileBoard ? 'Tm' : 'Team'}</span> : null}
          {showDraftedMetadata ? <button onClick={() => handleHeaderClick('round')} type="button" style={{ textAlign: 'center', background: 'none', border: 'none', color: sortKey === 'round' ? '#EAB308' : '#475569', cursor: 'pointer', padding: 0, fontSize: draftBoardHeaderFontSize, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em' }}>{isMobileBoard ? 'R' : 'Rnd'} {sortKey === 'round' && (sortDesc ? '↓' : '↑')}</button> : null}
          {showDraftedMetadata ? <button onClick={() => handleHeaderClick('pick_number')} type="button" style={{ textAlign: 'center', background: 'none', border: 'none', color: sortKey === 'pick_number' ? '#EAB308' : '#475569', cursor: 'pointer', padding: 0, fontSize: draftBoardHeaderFontSize, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em' }}>{isMobileBoard ? 'Pk' : 'Pick'} {sortKey === 'pick_number' && (sortDesc ? '↓' : '↑')}</button> : null}
          <span />
        </div>

        {/* Rows */}
        {sortedCharacters.map(c => {
          const pick = picksByCharacter[c.id]
          const isDrafted = Boolean(pick)
          const history = tournHistories[c.id] || []
          const analysis = getCharacterAnalysis(c)
          const score = analysis?.displayRatings?.batting ?? 0
          const activeTierInfo = SORT_KEY_TIER[sortKey]
          const activeTier = activeTierInfo ? analysis?.[activeTierInfo.tierKey] : analysis?.tier
          const tierMeta = getTalentTierMeta(activeTier)
          const tierIcon = activeTierInfo?.icon ?? null
          const chemistryName = getCharacterChemistryName(c.name, pick?.mii_color)
          const displayName = formatCharacterDisplayName(c.name, pick?.mii_color)
          const boardDisplayName = isMobileBoard ? getCompactDraftBoardName(c.name, pick?.mii_color) : displayName
          const chemistry = chemBreakdown(chemistryName, myRosterNames)

          return (
            <div
              key={c.id}
              onClick={() => openCharacterPage(c.id)}
              onMouseEnter={e => e.currentTarget.style.background = '#1E293B'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              style={{ display: 'grid', gridTemplateColumns: draftBoardColumns, gap: draftBoardGap, alignItems: 'center', padding: draftBoardRowPadding, borderBottom: '1px solid #0F172A', cursor: 'pointer' }}
            >
              <Portrait name={c.name} size={draftBoardPortraitSize} />
              <div style={{ minWidth: 0, overflow: 'hidden' }}>
                <div title={displayName} style={{ fontWeight: 600, fontSize: isMobileBoard ? 11 : 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{boardDisplayName}</div>
                <div style={{ display: 'flex', gap: isMobileBoard ? 4 : 5, fontSize: draftBoardMetaFontSize, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', alignItems: 'center' }}>
                  {chemistry && <span style={{ color: chemistry.positive === 0 ? '#94A3B8' : '#22C55E' }}>+{chemistry.positive}</span>}
                  {chemistry && <span style={{ color: chemistry.negative === 0 ? '#94A3B8' : '#F87171' }}>-{chemistry.negative}</span>}
                  <span style={{ color: tierMeta.color, display: 'inline-flex', alignItems: 'center', gap: isMobileBoard ? 1 : 2 }}>
                    {tierIcon && <StatIcon stat={tierIcon} size={isMobileBoard ? 8 : 9} style={{ opacity: 0.7 }} />}
                    {isMobileBoard ? tierMeta.label.split(' ')[0] : tierMeta.label}
                  </span>
                </div>
              </div>
              <span style={{ textAlign: 'center', fontSize: draftBoardValueFontSize, fontWeight: 700, color: '#EAB308' }}>{score}</span>
              <span style={{ textAlign: 'center', fontSize: draftBoardValueFontSize, fontWeight: 700, color: '#EF4444' }}>{analysis?.displayRatings?.pitching ?? '—'}</span>
              <span style={{ textAlign: 'center', fontSize: draftBoardValueFontSize, fontWeight: 700, color: '#3B82F6' }}>{analysis?.displayRatings?.fielding ?? '—'}</span>
              <span style={{ textAlign: 'center', fontSize: draftBoardValueFontSize, fontWeight: 700, color: '#A78BFA' }}>{analysis?.displayRatings?.speed ?? '—'}</span>
              <span style={{ textAlign: 'center', fontSize: draftBoardValueFontSize, fontWeight: 700, color: '#64748B' }}>{analysis?.displayRatings?.overall ?? '—'}</span>
              {showDraftedMetadata ? (
                <div style={{ minWidth: 0, overflow: 'hidden' }}>
                  {pick?.player_id ? (
                    <PlayerTag
                      height={isMobileBoard ? 14 : 20}
                      identitiesByPlayerId={teamIdentitiesByPlayerId}
                      playerId={pick.player_id}
                      playersById={playersById}
                      nameMode={isMobileBoard ? 'abbreviation' : 'short'}
                      showLogo={!isMobileBoard}
                      textStyle={{ fontSize: isMobileBoard ? 10 : 12, fontWeight: 600 }}
                      style={{ gap: isMobileBoard ? 4 : 8 }}
                    />
                  ) : <span style={{ fontSize: draftBoardValueFontSize, color: '#64748B' }}>—</span>}
                </div>
              ) : null}
              {showDraftedMetadata ? <span style={{ textAlign: 'center', fontSize: draftBoardValueFontSize, color: '#CBD5E1' }}>{pick?.round || '—'}</span> : null}
              {showDraftedMetadata ? <span style={{ textAlign: 'center', fontSize: draftBoardValueFontSize, color: '#CBD5E1' }}>{pick?.pick_number || '—'}</span> : null}
              {!isDrafted
                ? (
                  !is_logged_in ? <span /> : (
                    player?.is_commissioner && !isYourTurn && canDraft && currentDrafter ? (
                      <button
                        onClick={e => { e.stopPropagation(); beginForcePick(c, currentDrafter.id) }}
                        type="button"
                        style={{ ...draftBoardActionButtonStyle, border: '1px solid #EAB308', background: 'transparent', color: '#EAB308', cursor: 'pointer' }}
                      >
                        {isMobileBoard ? 'Frc' : 'Force'}
                      </button>
                    ) : (
                      <button
                        onClick={e => { e.stopPropagation(); beginDraftPick(c) }}
                        type="button"
                        disabled={!isYourTurn || !canDraft || !!myPendingPick}
                        style={{
                          ...draftBoardActionButtonStyle,
                          border: 'none',
                          background: isYourTurn && canDraft && !myPendingPick ? '#EAB308' : '#1E293B',
                          color: isYourTurn && canDraft && !myPendingPick ? '#000' : '#334155',
                          cursor: isYourTurn && canDraft && !myPendingPick ? 'pointer' : 'default',
                        }}
                      >
                        {isMobileBoard ? 'Pick' : 'Draft'}
                      </button>
                    )
                  )
                )
                : <span style={{ fontSize: draftBoardMetaFontSize, color: '#334155', textAlign: 'center' }}>—</span>}
            </div>
          )
        })}

          </div>{/* end minWidth inner */}
        </div>{/* end overflow-x scroll */}
      </div>


      {pendingMiiPick && (
        <>
          <div onClick={() => setPendingMiiPick(null)} style={{ position: 'fixed', inset: 0, background: '#00000070', zIndex: 59 }} />
          <div style={{ position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: 'min(92vw, 420px)', background: '#0F172A', border: '1px solid #334155', borderRadius: 14, padding: 18, zIndex: 60, boxShadow: '0 18px 50px #00000080' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 800, color: '#E2E8F0' }}>Choose Mii Color</div>
                <div style={{ fontSize: 12, color: '#64748B', marginTop: 4 }}>This pick will be stored with a specific Mii color so we can apply chemistry correctly.</div>
              </div>
              <button onClick={() => setPendingMiiPick(null)} type="button" style={{ background: 'none', border: 'none', color: '#64748B', cursor: 'pointer', padding: 4 }}><X size={18} /></button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
              {MII_COLOR_OPTIONS.map(color => (
                <button key={color} onClick={() => confirmPendingMiiPick(color)} type="button" style={{ background: '#1E293B', border: '1px solid #334155', borderRadius: 10, color: '#E2E8F0', padding: '10px 12px', cursor: 'pointer', fontWeight: 700 }}>
                  {color}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

    </div>
  )
}
