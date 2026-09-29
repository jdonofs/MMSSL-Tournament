import { lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeftRight } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { createRefreshCoordinator } from '../utils/refreshCoordinator'
import { isPregameGameStatus } from '../utils/teamLineupDraft'
import { fielderIsCurrent } from '../utils/fielderStints.js'
import { useGameSession } from '../context/GameSessionContext'
import { runnerAssignmentsForSave } from '../features/scorebook/domain/plateAppearance'
import { syncPlateAppearanceRunnerOpportunities } from '../features/scorebook/services/plateAppearanceService'
import { useToast } from '../context/ToastContext'
import { useTournament } from '../context/TournamentContext'
import { useAuth } from '../context/AuthContext'
import { battedBallResults, calculateOutsForPa, filterRunEventsForCharacter, inningsPitchedFromOuts, isCreditedHit, isOfficialAtBat, normalizeRbiForPaResult, summarizeBatting, summarizePitching } from '../utils/statsCalculator'
import { estimateExitVelocity, exitVelocityDistanceFt, ROBBED_HR_WALL_MARGIN_FT, ROBBED_HR_CARRY_FT } from '../utils/hitDistanceStats'
import { STADIUM_CONFIGS, estimateHitDistance, estimateHitAngle, estimateWallDistanceAtAngle, getFielderFieldSpot } from '../components/FieldPlayBuilder'
import { charactersHaveGoodChemistry } from '../utils/chemistryHighlights'
import { formatCharacterDisplayName, getCharacterChemistryName } from '../utils/mii'
import useTournamentTeamIdentity from '../hooks/useTournamentTeamIdentity'
import usePitchCount from '../hooks/usePitchCount'
import useScorebookData from '../features/scorebook/hooks/useScorebookData'
import useScorebookBettingData from '../features/scorebook/hooks/useScorebookBettingData'
import useRunnerStatePersistence from '../features/scorebook/hooks/useRunnerStatePersistence'
import useLiveGamePersistence from '../features/scorebook/hooks/useLiveGamePersistence'
import useActivePaPersistence from '../features/scorebook/hooks/useActivePaPersistence'
import useLineupEditor from '../features/scorebook/hooks/useLineupEditor'
import useGameCompletion from '../features/scorebook/hooks/useGameCompletion'
import GameLifecycleRecoveryBanner from '../features/scorebook/components/GameLifecycleRecoveryBanner'
import { assembleErrorNotation, assembleNotation, parseFielderChainFromNotation } from '../utils/notation'
import { buildBettingEntityLabel, estimateLiveWinProbability, generateGameOdds, mergeOddsWithExistingRows, recalculateOdds } from '../utils/oddsEngine'
import { buildOddsGenerationContext as buildSharedOddsGenerationContext } from '../utils/oddsContext'
import { resolveFirstInningNoRun, resolveOnPA } from '../utils/betResolution'
import { buildScorebookPath } from '../utils/scorebookRouting'
import { shouldStartFreshTrackerSession } from '../utils/trackerLiveFeed'
const AtBatEditor = lazy(() => import('./AtBatEditor'))
// Only tracker games can open this tab, and it pulls in the field/spray charts,
// so it stays out of the scorebook bundle every other game pays for.
const TrackerLivePreview = lazy(() => import('../components/TrackerLivePreview'))
import { getTeamAbbreviation, getTeamPrimaryColor, getTeamShortName } from '../utils/teamIdentity'
import { DEFAULT_REGULATION_INNINGS, deriveOffense, getFinalStatusLabel, normalizeRegulationInnings } from '../utils/gameRules'
import { getHandedness } from '../utils/characterHandedness'
import { getForcedRunnerIds, shouldNullifyRunsOnInningEndingForce } from '../utils/forcePlay'
import { assignAuthoritativePitchNumbers } from '../utils/pitchSequence'
import {
  HIT_RESULTS,
  NEEDS_RESOLUTION,
  BASE_COVERING_POSITION,
  BASE_STEP_ORDER,
  buildPendingAssignment,
  computePendingState,
  getRbiFromAssignments,
  didBatterScore,
  extractNextRunners,
  getHomeAssignments,
  getOutAssignments,
  pendingLeavesRunnersOnBase,
  normalizeLiveRunner,
  getNextBase,
  getLeadForcedRunnerId,
  mapPositionToForcedBase,
  inferLikelyForcedOutId,
  shouldResolveOutAssignments,
  computePendingOutState,
  runnerFloorBase,
  stepBaseValue,
  computeForcedChainIds,
  computeFallbackSafePosition,
  isHomeRunResult,
  computeBaselineRunnerAssignments,
  buildRunnerEntriesFromAssignments,
  applyManualRunnerStep,
  applyManualRunnerOut,
  applyManualRunnerReenter,
  applyManualRunnerDestination,
  derivePendingResult,
  computeImmediateNextRunners,
  getRunsScoredOnPa,
} from '../utils/runnerAssignment'
import {
  buildStadiumKeyByGameId,
  normalizeIsNightForStadium,
} from '../utils/stadiums'
import { enrichPlateAppearancesWithDerivedHitTracking } from '../utils/hitFieldDerivation'
import { useConfirmedAction, useUnsavedChangesGuard } from '../hooks/useUnsavedChangesGuard'
import { useRegisterUnsavedChanges } from '../context/UnsavedChangesContext'
import UnsavedChangesPrompt from '../components/UnsavedChangesPrompt'
import { normalizeLiveState } from '../features/scorebook/domain/liveState'
import {
  errorsFromPAs,
  getPaScoringRuns,
  hitsFromPAs,
  inningRunsFromPAs,
  inningRunsFromRows,
  runsFromPAs,
  runsThisHalfFromPAs,
} from '../features/scorebook/domain/scoreboard'
import {
  buildScoringPlayDescription,
  formatPlayResultText,
  normalizeBatterHandedness,
  resolveBattedBallDirection,
} from '../features/scorebook/domain/battedBall'
import {
  buildPitchRowsForSave,
  buildRunRowsForSave,
  comparePitchOrder,
  nextPaNumber,
  normalizePa,
  normalizeSavedPaRunScored,
  stripDbManagedFields,
} from '../features/scorebook/domain/plateAppearance'
import { buildDisplayedPitchingStints } from '../features/scorebook/domain/display'
import { getActivePaStorageKey, sanitizeRunnersForOffense } from '../features/scorebook/domain/runnerState'
import { canFinalizeInPlaySelection, effectiveErrorPositions } from '../features/scorebook/domain/inPlay'
import { C } from '../features/scorebook/components/theme'
import { EditStadiumModal } from '../features/scorebook/components/StadiumControls'
import {
  AddGameModal,
  EndGameConfirmModal,
  ReopenGameConfirmModal,
  ResetGameConfirmModal,
} from '../features/scorebook/components/GameActionModals'
import { SectionCard } from '../features/scorebook/components/ScorebookPrimitives'
import Diamond from '../features/scorebook/components/ScorebookDiamond'
import ScorebookGameView from '../features/scorebook/components/ScorebookGameView'
import ScorebookLineupsView from '../features/scorebook/components/ScorebookLineupsView'
import ScorebookAdminView from '../features/scorebook/components/ScorebookAdminView'
import ScorekeeperGameHeader from '../features/scorebook/components/ScorekeeperGameHeader'
import ScorekeeperLineupStatus from '../features/scorebook/components/ScorekeeperLineupStatus'
import ScorekeeperGameEndBanner from '../features/scorebook/components/ScorekeeperGameEndBanner'
import ScorekeeperPitchControls from '../features/scorebook/components/ScorekeeperPitchControls'
import ScorekeeperActionBar from '../features/scorebook/components/ScorekeeperActionBar'
import ScorekeeperInPlayPanel from '../features/scorebook/components/ScorekeeperInPlayPanel'
import {
  deletePlateAppearanceBundle,
  deletePlateAppearanceChildren,
  fetchCommittedPitchSequence,
  insertPlateAppearancePitches,
  insertPlateAppearanceRuns,
  refreshPlateAppearanceBundle,
  rollbackRestoredPlateAppearance,
  restorePlateAppearanceBundle,
  savePlateAppearanceRecord,
  undoLatestPlateAppearance,
} from '../features/scorebook/services/plateAppearanceService'
import {
  createTournamentGame,
  deletePitchingStint,
  insertPitchingStint,
  replaceInningScoreRows,
  updateGameRecord,
  updatePitchingStint,
  updatePitchingStintStats,
} from '../features/scorebook/services/gameService'
import {
  deleteGameOddsRow,
  fetchGameOdds,
  hasRelatedPitcherPropBets,
  persistScorebookOddsRows,
} from '../features/scorebook/services/oddsService'
import {
  fetchTrackerLiveStats,
  updateTrackerTeamMapping,
} from '../features/scorebook/services/trackerService'
import {
  AtBatEditorScorebookView,
  TrackerScorebookView,
} from '../features/scorebook/components/ScorebookLazyViews'

function batterHandednessForName(characterName) {
  return normalizeBatterHandedness(getHandedness(characterName).bats)
}

function batterHandednessForPa(pa, charactersById = {}) {
  return batterHandednessForName(charactersById[pa.character_id]?.name)
}

function batterHandednessForLineupEntry(entry, charactersById = {}) {
  return batterHandednessForName(charactersById[entry?.character_id]?.name)
}

// The tracker only knows the game's built-in vanilla team skins (whichever
// of the 12 default captains was selected in Dolphin), which have no
// relation to this league's custom drafted team names on their own — but
// this league's convention is that a team's cosmetic identity follows
// whichever captain character they drafted (see CAPTAIN_TEAM_MAP in
// teamIdentity.js), so the captain on a team's roster reliably tells us
// which vanilla team name in the tracker's output is theirs.
const CAPTAIN_TO_TRACKER_TEAM_NAME = {
  Mario: 'Mario Fireballs',
  Luigi: 'Luigi Knights',
  'Donkey Kong': 'DK Wilds',
  'Diddy Kong': 'Diddy Monkeys',
  Peach: 'Peach Monarchs',
  Daisy: 'Daisy Flowers',
  Wario: 'Wario Muscles',
  Waluigi: 'Waluigi Spitballs',
  Yoshi: 'Yoshi Eggs',
  Bowser: 'Bowser Monsters',
  Birdo: 'Birdo Bows',
  'Bowser Jr.': 'Jr. Rookies',
  'Bowser Jr': 'Jr. Rookies',
}

const CONTACT_RESULTS = new Set(['foul', 'in_play'])
const POSITION_LABELS = {
  1: 'P',
  2: 'C',
  3: '1B',
  4: '2B',
  5: '3B',
  6: 'SS',
  7: 'LF',
  8: 'CF',
  9: 'RF',
}
const OUTCOME_BUTTONS = [
  { result: '1B', zone: 'green' }, { result: '2B', zone: 'green' },
  { result: '3B', zone: 'green' }, { result: 'HR',  zone: 'green' }, { result: 'IPHR', zone: 'green' },
  { result: 'K',  zone: 'red'   }, { result: 'GO',  zone: 'red'   },
  { result: 'FO', zone: 'red'   }, { result: 'LO',  zone: 'red'   },
  { result: 'BB', zone: 'blue'  }, { result: 'HBP', zone: 'blue'  },
  { result: 'SF',  zone: 'blue'  }, { result: 'SH',  zone: 'blue'  },
]
// Fallback used until the game-history-calibrated odds_engine_weights row has
// loaded (or if it has none yet) — equal thirds, same as a freshly-seeded row.
const DEFAULT_ODDS_WEIGHTS = { char_stats_weight: 0.333, historical_weight: 0.333, live_weight: 0.334 }

function estimateHomeWinProbability({
  homeScore = 0,
  awayScore = 0,
  currentInning = 1,
  isTop = true,
  outsInHalf = 0,
  regulationInnings = 3,
  runnersOccupied = 0,
  balls = 0,
  strikes = 0,
  status = 'active',
  paCount = 0,
  oddsContext = null,
}) {
  return estimateLiveWinProbability({
    game: oddsContext?.game,
    homeRoster: oddsContext?.homeRoster || [],
    awayRoster: oddsContext?.awayRoster || [],
    homeHistorical: oddsContext?.homeHistorical || {},
    awayHistorical: oddsContext?.awayHistorical || {},
    playerProps: oddsContext?.playerProps || {},
    state: {
      homeScore,
      awayScore,
      currentInning,
      isTop,
      outsInHalf,
      regulationInnings,
      runnersOccupied,
      balls,
      strikes,
      status,
      paCount,
    },
  })
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function Scorebook() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { pushToast } = useToast()
  const gameSession = useGameSession()
  const scorebookTables = gameSession?.tables || {}
  const isSeasonGame = gameSession?.sourceType === 'season'
  const addSourceFields = useCallback((payload = {}) => {
    if (!isSeasonGame) return payload
    return {
      ...payload,
      season_id: gameSession?.sourceId || payload.season_id || null,
    }
  }, [isSeasonGame, gameSession?.sourceId])
  const betResolutionConfig = useMemo(() => (
    isSeasonGame
      ? {
          betsTable: scorebookTables.bets,
          gameOddsTable: scorebookTables.gameOdds,
          ledgerTable: scorebookTables.bettingLedger,
          plateAppearancesTable: scorebookTables.plateAppearances,
          runsScoredTable: scorebookTables.runsScored,
          enableCalibrationLogging: false,
          enableWeightAdjustment: false,
          wagerField: 'wager_dollars',
          payoutField: 'potential_payout_dollars',
          ledgerChangeField: 'dollars_change',
          sourceIdField: 'season_id',
          sourceIdValue: gameSession?.sourceId || null,
        }
      : {}
  ), [isSeasonGame, scorebookTables, gameSession?.sourceId])
  const { viewedTournament, currentTournament } = useTournament()
  const tournament = viewedTournament || currentTournament
  const { player, session } = useAuth()
  const { identitiesByPlayerId } = useTournamentTeamIdentity(tournament?.id)
  const isCommissioner = player?.is_commissioner === true
  const isScorekeeper = Boolean(player && (player.is_commissioner || player.scorebook_access))

  // ── Data state ─────────────────────────────────────────────────────────────
  const [selectedGameId, setSelectedGameId] = useState(gameSession?.gameId ? String(gameSession.gameId) : '')
  const {
    games,
    setGames,
    players,
    lineups,
    setLineups,
    savedTeamLineups,
    setSavedTeamLineups,
    characters,
    draftPicks,
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
    stadiumGameLog,
    pitchHistoryLoadedScope,
    dataLoaded,
    scorebookDataScope,
    fetchGameData,
    deferRealtimeUntilRef,
    locallyDeletedPaIdsRef,
  } = useScorebookData({
    gameSession,
    tournamentId: tournament?.id,
    selectedGameId,
    pushToast,
  })
  const [stadiumEditModalOpen, setStadiumEditModalOpen] = useState(false)
  const [stadiumEditForm, setStadiumEditForm] = useState({ stadiumId: '', isNight: false })
  const [stadiumEditSaving, setStadiumEditSaving] = useState(false)
  const { gameBets, oddsEngineWeights } = useScorebookBettingData({
    selectedGameId,
    betsTable: scorebookTables.bets,
  })

  // ── UI state ───────────────────────────────────────────────────────────────
  // A `?view=` query param (e.g. from a Team page game-log link wanting the read-only recap,
  // not the live scoring UI) overrides the scorekeeper/spectator role-based default below.
  const [viewMode, setViewMode] = useState(() => (
    searchParams.get('view') || (player && (player.is_commissioner || player.scorebook_access) ? 'liveTracker' : 'game')
  ))
  const [viewedInning, setViewedInning] = useState(null)
  const [overrideBatterIdx, setOverrideBatterIdx] = useState(null)
  const [showOutsBanner, setShowOutsBanner] = useState(false)
  const [gameEndBanner, setGameEndBanner] = useState(null)
  // outsRecorded at the moment the scorekeeper last dismissed the game-end
  // banner via "Continue Playing" — the reload-recovery effect below re-derives
  // that same banner from persisted data on every render where its trigger
  // conditions still hold, which (without this) meant clearing the banner just
  // made it reappear on the very next render. Once outsRecorded moves past this
  // value (a real additional out gets recorded), the dismissal no longer
  // applies and a genuinely new end-of-game condition can show the banner again.
  const dismissedGameEndOutsRef = useRef(null)
  const [editingPa, setEditingPa] = useState(null)
  const [adminRunnerBase, setAdminRunnerBase] = useState('first')
  const [adminRunnerCharacterId, setAdminRunnerCharacterId] = useState('')
  const [showAddGame, setShowAddGame] = useState(false)
  const [addGameForm, setAddGameForm] = useState({ teamA: '', teamB: '', stage: '', stadiumId: '', isNight: false })
  const [starPitchActive, setStarPitchActive] = useState(false)
  const [starHitUsed, setStarHitUsed] = useState(false)
  const [starHitPending, setStarHitPending] = useState(false)
  const [starHitConnected, setStarHitConnected] = useState(false)
  const [pitchActionSheet, setPitchActionSheet] = useState(null)
  const [pendingPitchEvent, setPendingPitchEvent] = useState(null)
  const [paPitchRows, setPaPitchRows] = useState([])
  const paPitchRowsRef = useRef([])
  const [inPlayState, setInPlayState] = useState(null)
  const [rbiOverlay, setRbiOverlay] = useState(null)
  const [autoAdvanceDiamond] = useState(false)

  // ── Runner state ───────────────────────────────────────────────────────────
  // Each slot: { characterId, playerId } | null
  const [runners, setRunners] = useState({ first: null, second: null, third: null })
  const [runnersHistory, setRunnersHistory] = useState([])
  const [pendingPA, setPendingPA] = useState(null)
  const [isDragOverMound, setIsDragOverMound] = useState(false)
  const [selectedPitcher, setSelectedPitcher] = useState(null) // { charId, playerId }
  const [viewedLineupSide, setViewedLineupSide] = useState('A')
  const [viewportWidth, setViewportWidth] = useState(() => typeof window !== 'undefined' ? window.innerWidth : 1280)
  const isNarrowViewport = viewportWidth <= 720
  useEffect(() => {
    const handleResize = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])
  const isStackedInPlayLayout = viewportWidth <= 980
  const [showEndGameConfirm, setShowEndGameConfirm] = useState(false)
  const [redoAction, setRedoAction] = useState(null)
  const [isUndoInFlight, setIsUndoInFlight] = useState(false)
  const [queuedUndoCorrection, setQueuedUndoCorrection] = useState(null)

  const outsRef = useRef(0)
  const autoPitcherAssignRef = useRef(null)
  const isSavingRef = useRef(false)
  const saveWatchdogRef = useRef(null)
  const pitchActionPendingRef = useRef(false)
  const pitchActionUnlockRef = useRef(null)
  const undoInFlightRef = useRef(false)
  const queuedUndoCorrectionRef = useRef(null)
  const pitcherChangePendingRef = useRef(false)
  const [isPitchActionPending, setIsPitchActionPending] = useState(false)

  // Tournament settings
  const regulationInnings = normalizeRegulationInnings(
    gameSession?.innings ?? tournament?.innings,
    DEFAULT_REGULATION_INNINGS,
  )
  const mercyOn  = gameSession?.mercyRule ?? tournament?.mercy_rule !== false
  const mercyLimit = Math.max(1, Number(gameSession?.mercyRuleDifferential || 10))

  const pushRunners = useCallback((next) => {
    setRunnersHistory(prev => [...prev, { ...runners }])
    setRunners(next)
  }, [runners])

  const popRunners = useCallback(() => {
    if (!runnersHistory.length) return
    // Apply both updates in the same tick — deferring setRunners to a microtask
    // (the previous approach) let several unrelated re-renders land in between
    // (each undo await triggers its own setPlateAppearances/setPitches/etc.),
    // so the runner diamond would flash through stale states before the
    // restored one finally showed up a beat later.
    setRunnersHistory(runnersHistory.slice(0, -1))
    setRunners(runnersHistory[runnersHistory.length - 1])
  }, [runnersHistory])

  const resetRunners = useCallback((clearHistory = true) => {
    setRunners({ first: null, second: null, third: null })
    if (clearHistory) setRunnersHistory([])
  }, [])

  const unlockPitchActions = useCallback(() => {
    pitchActionPendingRef.current = false
    setIsPitchActionPending(false)
    if (pitchActionUnlockRef.current) {
      clearTimeout(pitchActionUnlockRef.current)
      pitchActionUnlockRef.current = null
    }
  }, [])

  const lockPitchActions = useCallback((unlockAfterMs = null) => {
    pitchActionPendingRef.current = true
    setIsPitchActionPending(true)
    if (pitchActionUnlockRef.current) clearTimeout(pitchActionUnlockRef.current)
    if (unlockAfterMs != null) {
      pitchActionUnlockRef.current = setTimeout(() => {
        unlockPitchActions()
      }, unlockAfterMs)
    } else {
      pitchActionUnlockRef.current = null
    }
  }, [unlockPitchActions])

  const deferRealtimeHydration = useCallback((holdMs = 1200) => {
    deferRealtimeUntilRef.current = Date.now() + holdMs
  }, [])

  const removeRunnerFromBase = useCallback((baseKey) => {
    if (!['first', 'second', 'third'].includes(baseKey)) return
    setRunners((current) => ({ ...current, [baseKey]: null }))
  }, [])

  useEffect(() => {
    setSelectedGameId(gameSession?.gameId ? String(gameSession.gameId) : '')
  }, [gameSession?.gameId])

  // ── Derived state ──────────────────────────────────────────────────────────
  const filteredGames = useMemo(
    () => games.filter(g => !gameSession?.sourceId || g.tournament_id === gameSession.sourceId),
    [games, gameSession?.sourceId],
  )
  const selectedGame  = filteredGames.find(g => String(g.id) === String(selectedGameId))
  const isGameComplete = selectedGame?.status === 'complete' || selectedGame?.status === 'completed'
  const isGamePregame = isPregameGameStatus(selectedGame?.status)
  const canEditScorebook = Boolean(
    isScorekeeper
    && selectedGame
    && selectedGame.stats_source !== 'tracker'
    && !isGameComplete
    && dataLoaded
    && pitchHistoryLoadedScope === scorebookDataScope
  )
  const selectedGameLiveState = useMemo(
    () => normalizeLiveState(selectedGame?.live_state),
    [selectedGame?.live_state],
  )
  const playersById   = useMemo(() => Object.fromEntries(players.map(p => [p.id, p])), [players])
  const charactersById = useMemo(() => Object.fromEntries(characters.map(c => [c.id, c])), [characters])
  const charactersByName = useMemo(() => Object.fromEntries(characters.map((character) => [character.name, character])), [characters])
  // Shared by both the plain-click handler and the middle-click-friendly <a> links
  // in the Game View tab (MiddleClickLink needs a real `to`/`state` pair up front
  // rather than an onClick that fires navigate() imperatively).
  const getCharacterLinkTarget = useCallback((characterId) => {
    const character = charactersById[characterId]
    if (!character) return null
    const ownerPick = draftPicks.find((pick) => Number(pick.character_id) === Number(characterId) && pick.is_active !== false) || null
    const currentOwner = ownerPick ? { player_id: ownerPick.player_id } : null
    return {
      to: `/character/${characterId}/career`,
      state: {
        backTo: window.location.pathname + window.location.search,
        character,
        allCharactersById: Object.fromEntries(characters.map((entry) => [entry.name, entry])),
        playersById,
        identitiesByPlayerId,
        currentOwner,
        currentContext: gameSession?.sourceId ? { type: isSeasonGame ? 'season' : 'tournament', id: gameSession.sourceId } : null,
        rosterNames: [],
      },
    }
  }, [charactersById, characters, draftPicks, playersById, identitiesByPlayerId, gameSession?.sourceId, isSeasonGame])
  const openCharacterPage = useCallback((characterId) => {
    const target = getCharacterLinkTarget(characterId)
    if (!target) return
    navigate(target.to, { state: target.state })
  }, [getCharacterLinkTarget, navigate])
  const stadiumsById = useMemo(() => Object.fromEntries(stadiums.map((stadium) => [stadium.id, stadium])), [stadiums])
  const stadiumKeyByGameId = useMemo(
    () => buildStadiumKeyByGameId(games, stadiums, stadiumGameLog),
    [games, stadiums, stadiumGameLog],
  )
  const trackedPlateAppearances = useMemo(
    () => enrichPlateAppearancesWithDerivedHitTracking(plateAppearances, stadiumKeyByGameId),
    [plateAppearances, stadiumKeyByGameId],
  )
  const selectedStadium = selectedGame?.stadium_id ? stadiumsById[selectedGame.stadium_id] : null
  const STADIUM_NAME_TO_KEY = {
    'Mario Stadium': 'mario_stadium',
    'Yoshi Park': 'yoshi_park',
    'Wario City': 'wario_city',
    'Daisy Cruiser': 'daisy_cruiser',
    'Peach Ice Garden': 'peach_ice_garden',
    'DK Jungle': 'dk_jungle',
    'Bowser Jr. Playroom': 'bowser_jr_playroom',
    'Bowser Castle': 'bowser_castle',
    'Luigi\'s Mansion': 'luigis_mansion',
  }
  const stadiumKey = STADIUM_NAME_TO_KEY[selectedStadium?.name] ?? null
  const selectedAddGameStadium = addGameForm.stadiumId ? stadiumsById[addGameForm.stadiumId] : stadiums[0] || null

  const openStadiumEditModal = useCallback(() => {
    if (!selectedGame) return
    setStadiumEditForm({
      stadiumId: selectedStadium?.id || stadiums[0]?.id || '',
      isNight: Boolean(selectedGame.is_night),
    })
    setStadiumEditModalOpen(true)
  }, [selectedGame, selectedStadium, stadiums])

  const saveStadiumEdit = useCallback(async () => {
    if (!selectedGame) return
    const stadium = stadiumsById[stadiumEditForm.stadiumId]
    if (!stadium) return
    const nextIsNight = normalizeIsNightForStadium(stadium, stadiumEditForm.isNight)
    // The scheduled game row is the live source of truth. Historical log rows are only
    // written when a game is completed, so editing setup here should touch the game row only.
    const patch = isSeasonGame
      ? { stadium: stadium.name, is_night: nextIsNight }
      : { stadium_id: stadium.id, is_night: nextIsNight }

    setStadiumEditSaving(true)
    try {
      const { error } = await updateGameRecord({ tables: scorebookTables, gameId: selectedGame.id, patch })
      if (error) throw error

      setGames((current) => current.map((game) => (
        String(game.id) === String(selectedGame.id)
          ? { ...game, ...patch, stadium_id: stadium.id }
          : game
      )))
      setStadiumEditModalOpen(false)
      pushToast({ title: 'Stadium updated', message: `${stadium.name} set for this game.`, type: 'success' })
    } catch (error) {
      pushToast({ title: 'Unable to update stadium', message: error.message, type: 'error' })
    } finally {
      setStadiumEditSaving(false)
    }
  }, [selectedGame, stadiumsById, stadiumEditForm, isSeasonGame, scorebookTables.games, pushToast])

  const [videoUrlDraft, setVideoUrlDraft] = useState('')
  const [videoUrlSaving, setVideoUrlSaving] = useState(false)

  useEffect(() => {
    setVideoUrlDraft(selectedGame?.video_url || '')
  }, [selectedGame])

  const saveVideoUrl = useCallback(async () => {
    if (!selectedGame) return
    setVideoUrlSaving(true)
    try {
      const patch = { video_url: videoUrlDraft || null }
      const { error } = await updateGameRecord({ tables: scorebookTables, gameId: selectedGame.id, patch })
      if (error) throw error

      setGames((current) => current.map((game) => (
        String(game.id) === String(selectedGame.id) ? { ...game, ...patch } : game
      )))
      pushToast({ title: 'Video URL saved', type: 'success' })
    } catch (error) {
      pushToast({ title: 'Unable to save video URL', message: error.message, type: 'error' })
    } finally {
      setVideoUrlSaving(false)
    }
  }, [selectedGame, videoUrlDraft, scorebookTables.games, pushToast])

  const [trackerStats, setTrackerStats] = useState(null)
  const [trackerModeSaving, setTrackerModeSaving] = useState(false)

  useEffect(() => {
    if (!selectedGame || selectedGame.stats_source !== 'tracker' || !scorebookTables.trackerLiveStats) {
      setTrackerStats(null)
      return
    }
    let cancelled = false
    const loadTrackerStats = async () => {
      const { data, error } = await fetchTrackerLiveStats({ tables: scorebookTables, gameId: selectedGame.id })
      if (!cancelled && !error) setTrackerStats(shouldStartFreshTrackerSession(selectedGame, 0) ? null : data || null)
    }
    if (shouldStartFreshTrackerSession(selectedGame, 0)) setTrackerStats(null)
    loadTrackerStats()
    if (['complete', 'completed'].includes(selectedGame.status)) {
      return () => { cancelled = true }
    }
    const refreshCoordinator = createRefreshCoordinator({
      run: loadTrackerStats,
      delayMs: 100,
      maxWaitMs: 500,
      isPaused: () => document.visibilityState === 'hidden',
    })
    let hasSubscribed = false
    const channel = supabase
      .channel(`scorebook-tracker-${selectedGame.id}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: scorebookTables.trackerLiveStats,
        filter: `game_id=eq.${selectedGame.id}`,
      }, () => refreshCoordinator.request())
      .subscribe((status) => {
        if (status !== 'SUBSCRIBED') return
        if (hasSubscribed) refreshCoordinator.request({ immediate: true })
        hasSubscribed = true
      })
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') refreshCoordinator.request({ immediate: true })
    }
    const handleOnline = () => refreshCoordinator.request({ immediate: true })
    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('online', handleOnline)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('online', handleOnline)
      refreshCoordinator.dispose()
      supabase.removeChannel(channel)
    }
  }, [selectedGame?.id, selectedGame?.stats_source, selectedGame?.status,
    selectedGame?.away_score, selectedGame?.home_score,
    selectedGame?.team_a_runs, selectedGame?.team_b_runs, scorebookTables.trackerLiveStats])

  const setStatsSource = useCallback(async (nextSource) => {
    if (!selectedGame) return
    setTrackerModeSaving(true)
    try {
      const patch = { stats_source: nextSource }
      const { error } = await updateGameRecord({ tables: scorebookTables, gameId: selectedGame.id, patch })
      if (error) throw error
      setGames((current) => current.map((game) => (
        String(game.id) === String(selectedGame.id) ? { ...game, ...patch } : game
      )))
      pushToast({
        title: nextSource === 'tracker' ? 'Live Stat Tracker enabled' : 'Switched to manual scorebook',
        type: 'success',
      })
    } catch (error) {
      pushToast({ title: 'Unable to update stats source', message: error.message, type: 'error' })
    } finally {
      setTrackerModeSaving(false)
    }
  }, [selectedGame, scorebookTables.games, pushToast])

  // The tracker only knows the game's built-in vanilla team skins (e.g.
  // "Wario Muscles"), which have no relation to this league's custom
  // drafted team names — that can't be auto-matched, so the commissioner
  // assigns it once per game and it's persisted on the tracker row.
  const assignTrackerTeam = useCallback(async (trackerTeamName, side) => {
    if (!selectedGame || !scorebookTables.trackerLiveStats) return
    const nextMapping = { ...(trackerStats?.team_mapping || {}), [trackerTeamName]: side }
    setTrackerModeSaving(true)
    try {
      const { error } = await updateTrackerTeamMapping({
        tables: scorebookTables,
        gameId: selectedGame.id,
        teamMapping: nextMapping,
      })
      if (error) throw error
      setTrackerStats((current) => (current ? { ...current, team_mapping: nextMapping } : current))
    } catch (error) {
      pushToast({ title: 'Unable to save team mapping', message: error.message, type: 'error' })
    } finally {
      setTrackerModeSaving(false)
    }
  }, [selectedGame, trackerStats, scorebookTables.trackerLiveStats, pushToast])

  useEffect(() => {
    setViewedInning(null)
    setGameEndBanner(null)
    setPendingPA(null)
    resetRunners()
    setSelectedPitcher(null)
  }, [selectedGameId, resetRunners])

  useEffect(() => {
    if (!stadiums.length) return
    setAddGameForm((current) => {
      if (current.stadiumId && stadiumsById[current.stadiumId]) {
        return {
          ...current,
          isNight: normalizeIsNightForStadium(stadiumsById[current.stadiumId], current.isNight),
        }
      }
      return {
        ...current,
        stadiumId: stadiums[0].id,
        isNight: normalizeIsNightForStadium(stadiums[0], current.isNight),
      }
    })
  }, [stadiums, stadiumsById])

  const gamePAs = useMemo(
    () => trackedPlateAppearances.filter(p => String(p.game_id) === String(selectedGameId)).sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
    [trackedPlateAppearances, selectedGameId],
  )


  const gamePitching = useMemo(
    () => pitchingStints.filter(p => String(p.game_id) === String(selectedGameId)),
    [pitchingStints, selectedGameId],
  )
  const gamePitches = useMemo(
    () => pitches.filter((pitch) => String(pitch.game_id) === String(selectedGameId)).sort(comparePitchOrder),
    [pitches, selectedGameId],
  )
  const gameFielderRows = useMemo(
    () => gameFielders
      .filter((fielder) => String(fielder.game_id) === String(selectedGameId))
      .map((fielder) => {
        const characterName = fielder.character
          || fielder.character_name
          || (fielder.character_id ? charactersById[fielder.character_id]?.name : '')
          || ''
        const characterId = fielder.character_id
          ?? (characterName ? charactersByName[characterName]?.id ?? null : null)
        return {
          ...fielder,
          ...(characterName ? { character: characterName } : {}),
          ...(characterId != null ? { character_id: characterId } : {}),
        }
      }),
    [gameFielders, selectedGameId, charactersById, charactersByName],
  )
  const gameRuns = useMemo(
    () => runsScored.filter((run) => String(run.game_id) === String(selectedGameId)),
    [runsScored, selectedGameId],
  )
  const gameInningScores = useMemo(
    () => inningScores.filter((row) => String(row.game_id) === String(selectedGameId)),
    [inningScores, selectedGameId],
  )
  const gameLineups = useMemo(
    () => lineups.filter(l => String(l.game_id) === String(selectedGameId)).sort((a, b) => a.batting_order - b.batting_order),
    [lineups, selectedGameId],
  )

  // Which team bats first (top of inning 1) — stored on the game row so it's
  // shared across every scorekeeper's device and every recorded plate appearance
  // uses the same batting order. Can only be flipped before the first PA is
  // recorded, since changing it mid-game would re-attribute completed innings to
  // the wrong team.
  const homeAwaySwapped = !!selectedGame?.home_away_swapped
  const toggleHomeAwaySwap = useCallback(async () => {
    if (!selectedGame) return
    if (gamePAs.length > 0) {
      pushToast({ title: 'Cannot swap now', message: 'Home/Away can only be swapped before the first plate appearance is recorded.', type: 'error' })
      return
    }
    const next = !selectedGame.home_away_swapped
    const { error } = await updateGameRecord({
      tables: scorebookTables,
      gameId: selectedGame.id,
      patch: { home_away_swapped: next },
    })
    if (error) {
      pushToast({ title: 'Swap failed', message: error.message, type: 'error' })
      return
    }
    setGames((current) => current.map((g) => (String(g.id) === String(selectedGame.id) ? { ...g, home_away_swapped: next } : g)))
  }, [selectedGame, gamePAs.length, scorebookTables.games, pushToast])

  const outsRecorded = useMemo(() => gamePAs.reduce((s, pa) => s + calculateOutsForPa(pa.result, pa.outs_on_play), 0), [gamePAs])
  useEffect(() => { outsRef.current = outsRecorded }, [outsRecorded])

  const outsInHalf = outsRecorded % 3
  const selectionOutsInHalf = useMemo(() => {
    if (!editingPa) return outsInHalf
    const editingIndex = gamePAs.findIndex((pa) => String(pa.id) === String(editingPa.id))
    if (editingIndex === -1) return outsInHalf
    const outsBeforeEditingPa = gamePAs
      .slice(0, editingIndex)
      .reduce((sum, pa) => sum + calculateOutsForPa(pa.result, pa.outs_on_play), 0)
    return outsBeforeEditingPa % 3
  }, [editingPa, gamePAs, outsInHalf])
  const offense = useMemo(() => {
    if (!selectedGame) return null
    // Tracker games never accumulate plate_appearances rows (calculateOutsForPa
    // has nothing to sum), so outsRecorded-derived offense would stay frozen
    // at inning 1 forever. The tracker bridge writes inning/half into the same
    // live_state field manual scoring uses, so prefer that when present.
    if (selectedGame.stats_source === 'tracker' && selectedGameLiveState) {
      const isTop = selectedGameLiveState.isTop
      const inning = selectedGameLiveState.inning || 1
      const awayPlayerId = selectedGame.home_away_swapped ? selectedGame.team_b_player_id : selectedGame.team_a_player_id
      const homePlayerId = selectedGame.home_away_swapped ? selectedGame.team_a_player_id : selectedGame.team_b_player_id
      return {
        battingPlayerId: isTop ? awayPlayerId : homePlayerId,
        pitchingPlayerId: isTop ? homePlayerId : awayPlayerId,
        inning, isTop, halfLabel: `${isTop ? 'Top' : 'Bot'} ${inning}`,
      }
    }
    return deriveOffense(selectedGame, outsRecorded)
  }, [selectedGame, outsRecorded, selectedGameLiveState])

  // True once an error has occurred in the CURRENT half-inning that would have been the
  // inning-ending 3rd out (batter reaches on error with 2 outs already recorded) — per
  // official scoring, the inning should already be over at that point, so every run that
  // scores afterward this half, however cleanly, is unearned. Reconstructed from gamePAs
  // (not a mutable ref) so it stays correct across undo/redo/edits and resets naturally at
  // each half-inning boundary via the outs-mod-3 walk.
  const inningExtendedByError = useMemo(() => {
    let outsInHalfSoFar = 0
    let extended = false
    for (const pa of gamePAs) {
      if (pa.is_error && outsInHalfSoFar === 2) extended = true
      outsInHalfSoFar += calculateOutsForPa(pa.result, pa.outs_on_play)
      if (outsInHalfSoFar >= 3) {
        outsInHalfSoFar = 0
        extended = false
      }
    }
    return extended
  }, [gamePAs])

  // Batting/pitching team display info
  const battingPlayer  = selectedGame ? playersById[offense?.battingPlayerId]  : null
  const pitchingPlayer = selectedGame ? playersById[offense?.pitchingPlayerId] : null
  const teamAPlayer    = selectedGame ? playersById[selectedGame.team_a_player_id] : null
  const teamBPlayer    = selectedGame ? playersById[selectedGame.team_b_player_id] : null
  const teamAIdentity  = identitiesByPlayerId[selectedGame?.team_a_player_id] || null
  const teamBIdentity  = identitiesByPlayerId[selectedGame?.team_b_player_id] || null
  const teamAName      = getTeamShortName(teamAIdentity) || teamAIdentity?.teamName || teamAPlayer?.name || 'Team A'
  const teamBName      = getTeamShortName(teamBIdentity) || teamBIdentity?.teamName || teamBPlayer?.name || 'Team B'
  const battingIdentity  = identitiesByPlayerId[offense?.battingPlayerId] || null
  const pitchingIdentity = identitiesByPlayerId[offense?.pitchingPlayerId] || null
  const teamAColor     = getTeamPrimaryColor(teamAIdentity, teamAPlayer?.color) || C.blue
  const teamBColor     = getTeamPrimaryColor(teamBIdentity, teamBPlayer?.color) || C.red
  const teamAAbbreviation = getTeamAbbreviation(teamAIdentity || teamAPlayer) || teamAName.slice(0, 4).toUpperCase()
  const teamBAbbreviation = getTeamAbbreviation(teamBIdentity || teamBPlayer) || teamBName.slice(0, 4).toUpperCase()
  const teamALogoUrl   = teamAIdentity?.teamLogoUrl || teamAPlayer?.team_logo_url || null
  const teamBLogoUrl   = teamBIdentity?.teamLogoUrl || teamBPlayer?.team_logo_url || null
  const teamALogoKey   = teamAIdentity?.teamLogoKey || null
  const teamBLogoKey   = teamBIdentity?.teamLogoKey || null
  const battingColor   = getTeamPrimaryColor(battingIdentity, battingPlayer?.color)   || C.accent
  const pitchingColor  = getTeamPrimaryColor(pitchingIdentity, pitchingPlayer?.color) || C.muted

  // Not gated on is_captain — any of the 12 known captain-eligible characters
  // being on a team's roster at all is enough to know which vanilla tracker
  // team name is theirs (a roster with more than one just takes the first;
  // this only needs to be right, not exhaustive, since it's a starting guess
  // the Admin tab lets a commissioner override).
  const getTeamCaptainName = useCallback((playerId) => {
    if (!playerId) return null
    const picks = draftPicks.filter((p) => String(p.player_id) === String(playerId) && p.character_id)
    const match = picks.find((p) => CAPTAIN_TO_TRACKER_TEAM_NAME[charactersById[p.character_id]?.name])
    return match ? charactersById[match.character_id]?.name || null : null
  }, [draftPicks, charactersById])
  const teamACaptainName = selectedGame ? getTeamCaptainName(selectedGame.team_a_player_id) : null
  const teamBCaptainName = selectedGame ? getTeamCaptainName(selectedGame.team_b_player_id) : null
  const teamAExpectedTrackerName = teamACaptainName ? CAPTAIN_TO_TRACKER_TEAM_NAME[teamACaptainName] : null
  const teamBExpectedTrackerName = teamBCaptainName ? CAPTAIN_TO_TRACKER_TEAM_NAME[teamBCaptainName] : null

  // Auto-assign the tracker's vanilla team names to Team A/B the moment they
  // appear, using each team's drafted captain (see CAPTAIN_TO_TRACKER_TEAM_NAME
  // above) — no manual step needed when the captain resolves cleanly. Only
  // falls back to the manual buttons in the Admin tab when a captain can't be
  // resolved or doesn't match one of the 12 known captain names.
  useEffect(() => {
    if (!selectedGame || selectedGame.stats_source !== 'tracker' || !trackerStats) return
    const trackerTeamNames = new Set([
      ...Object.keys(trackerStats.live_feed?.score || {}),
      ...(trackerStats.live_feed?.matchup ? [trackerStats.live_feed.matchup.left, trackerStats.live_feed.matchup.right] : []),
    ])
    const mapping = trackerStats.team_mapping || {}
    if (teamAExpectedTrackerName && trackerTeamNames.has(teamAExpectedTrackerName) && !mapping[teamAExpectedTrackerName]) {
      assignTrackerTeam(teamAExpectedTrackerName, 'A')
    }
    if (teamBExpectedTrackerName && trackerTeamNames.has(teamBExpectedTrackerName) && !mapping[teamBExpectedTrackerName]) {
      assignTrackerTeam(teamBExpectedTrackerName, 'B')
    }
  }, [selectedGame, trackerStats, teamAExpectedTrackerName, teamBExpectedTrackerName, assignTrackerTeam])

  // Emergency fallback for a bridge finalization failure. The normal tracker
  // path records play-by-play, settles bets, locks markets, and completes the
  // game automatically; this button deliberately applies only the visible
  // final score so an operator can recover without duplicating settlement.
  const applyTrackerFinalResult = useCallback(async () => {
    if (!selectedGame || !trackerStats?.live_feed?.gameEnded) return
    const scoreEntries = trackerStats.live_feed.score || {}
    const mapping = trackerStats.team_mapping || {}
    const teamAKey = Object.keys(mapping).find((key) => mapping[key] === 'A')
    const teamBKey = Object.keys(mapping).find((key) => mapping[key] === 'B')
    const teamARuns = teamAKey ? scoreEntries[teamAKey] : null
    const teamBRuns = teamBKey ? scoreEntries[teamBKey] : null
    if (teamARuns == null || teamBRuns == null) {
      pushToast({
        title: 'Assign the tracker teams first',
        message: `Tracker reported: ${Object.entries(scoreEntries).map(([k, v]) => `${k} ${v}`).join(', ') || 'nothing'}. Use the Live Stat Tracker card below to assign each tracker team to ${teamAName} or ${teamBName}.`,
        type: 'error',
      })
      return
    }
    const winnerPlayerId = teamARuns === teamBRuns ? null
      : teamARuns > teamBRuns ? selectedGame.team_a_player_id : selectedGame.team_b_player_id
    setTrackerModeSaving(true)
    try {
      const patch = { status: 'complete', team_a_runs: teamARuns, team_b_runs: teamBRuns, winner_player_id: winnerPlayerId }
      // season_schedule names all four differently, and the tournament names
      // are not columns there -- so this fallback failed on every season game.
      const rowPatch = isSeasonGame
        ? {
            status: 'completed',
            away_score: teamARuns,
            home_score: teamBRuns,
            winner_team_id: winnerPlayerId ? gameSession.teamIdByPlayerId?.[winnerPlayerId] ?? null : null,
          }
        : patch
      const { error } = await updateGameRecord({ tables: scorebookTables, gameId: selectedGame.id, patch: rowPatch })
      if (error) throw error
      setGames((current) => current.map((game) => (
        String(game.id) === String(selectedGame.id) ? { ...game, ...patch } : game
      )))
      pushToast({
        title: 'Final score applied',
        message: 'Game marked complete. Bet settlement and bracket/standings advancement still need to be handled manually for tracker games.',
        type: 'success',
      })
    } catch (error) {
      pushToast({ title: 'Unable to apply final score', message: error.message, type: 'error' })
    } finally {
      setTrackerModeSaving(false)
    }
  }, [selectedGame, trackerStats, teamAName, teamBName, scorebookTables, isSeasonGame, gameSession.teamIdByPlayerId, pushToast])

  const currentInning  = offense?.inning || 1
  const currentHalfIdx = Math.floor(outsRecorded / 3)

  // Current (batting) lineup — offensive team
  const currentLineup = useMemo(
    () => gameLineups.filter(l => l.player_id === offense?.battingPlayerId),
    [gameLineups, offense],
  )
  // Defensive lineup — pitching team (draggable to mound)
  const defensiveLineup = useMemo(
    () => gameLineups.filter(l => l.player_id === offense?.pitchingPlayerId),
    [gameLineups, offense],
  )

  const autoIdx = useMemo(() => {
    if (!currentLineup.length) return 0
    return gamePAs.filter(pa => pa.player_id === offense?.battingPlayerId).length % currentLineup.length
  }, [gamePAs, currentLineup, offense])
  const currentHalfPaCount = useMemo(
    () => gamePAs.filter(
      (pa) => Number(pa.inning) === Number(currentInning) && String(pa.player_id) === String(offense?.battingPlayerId),
    ).length,
    [gamePAs, currentInning, offense?.battingPlayerId],
  )

  const effectiveBatterIdx = overrideBatterIdx !== null
    ? overrideBatterIdx % Math.max(currentLineup.length, 1)
    : autoIdx
  // Tracker games have no plate_appearances to index into the lineup with —
  // the bridge resolves the tracker's batter character to this game's own
  // roster and writes it into live_state.batterCharacterId, so use that
  // directly (falling back to the lineup entry if it's on today's lineup,
  // for the batting-order number).
  const trackerBatter = (selectedGame?.stats_source === 'tracker' && selectedGameLiveState?.batterCharacterId)
    ? (currentLineup.find((l) => Number(l.character_id) === Number(selectedGameLiveState.batterCharacterId)) || {
        character_id: selectedGameLiveState.batterCharacterId,
        player_id: selectedGameLiveState.batterPlayerId,
        batting_order: null,
      })
    : null
  const currentBatter  = trackerBatter || currentLineup[effectiveBatterIdx]
  const currentBatterHandedness = batterHandednessForLineupEntry(currentBatter, charactersById)
  const onDeckBatter   = currentLineup[(effectiveBatterIdx + 1) % Math.max(currentLineup.length, 1)]

  // Current pitcher — tracker games have no pitching_stints row, so build one
  // from live_state.pitcherCharacterId the same way as the batter above.
  const currentPitcherStint = useMemo(() => {
    if (selectedGame?.stats_source === 'tracker') {
      if (!selectedGameLiveState?.pitcherCharacterId) return null
      // The tracker bridge now creates/updates a real pitching_stints row for
      // whoever's pitching — prefer that (it has the live IP/H/R/K/pitch
      // count) and only fall back to a bare id-only placeholder for the brief
      // window before that row has synced down to this client.
      const stints = gamePitching.filter((s) => String(s.character_id) === String(selectedGameLiveState.pitcherCharacterId))
      return stints[stints.length - 1] || { character_id: selectedGameLiveState.pitcherCharacterId, player_id: selectedGameLiveState.pitcherPlayerId, id: null }
    }
    if (!offense) return null
    const stints = gamePitching.filter(s => s.player_id === offense.pitchingPlayerId)
    return stints[stints.length - 1] ?? null
  }, [gamePitching, offense, selectedGame, selectedGameLiveState])
  const currentPitcherChar = currentPitcherStint ? charactersById[currentPitcherStint.character_id] : null
  const adminRunnerOptions = useMemo(() => {
    const occupiedIds = new Set([
      runners.first?.characterId,
      runners.second?.characterId,
      runners.third?.characterId,
    ].filter(Boolean).map(String))
    return currentLineup.filter((entry) => !occupiedIds.has(String(entry.character_id)))
  }, [currentLineup, runners.first?.characterId, runners.second?.characterId, runners.third?.characterId])
  const addAdminRunner = useCallback(() => {
    const selectedEntry = currentLineup.find((entry) => String(entry.character_id) === String(adminRunnerCharacterId))
    if (!selectedEntry) {
      pushToast({ title: 'Pick a runner', message: 'Choose a batter from the current offensive lineup first.', type: 'error' })
      return
    }
    if (!['first', 'second', 'third'].includes(adminRunnerBase)) {
      pushToast({ title: 'Pick a base', message: 'Choose which base to populate.', type: 'error' })
      return
    }
    if (runners[adminRunnerBase]) {
      pushToast({ title: 'Base occupied', message: 'Clear that base before adding a new runner.', type: 'error' })
      return
    }
    setRunners((current) => ({
      ...current,
      [adminRunnerBase]: {
        characterId: selectedEntry.character_id,
        playerId: selectedEntry.player_id,
        chargedToPitcherId: currentPitcherStint?.character_id ?? null,
        chargedToPitcherPlayerId: currentPitcherStint?.player_id ?? null,
      },
    }))
    setAdminRunnerCharacterId('')
  }, [adminRunnerBase, adminRunnerCharacterId, currentLineup, currentPitcherStint, pushToast, runners])
  const currentPitcherPitchRows = useMemo(() => (
    currentPitcherChar
      ? gamePitches.filter((pitch) => pitch.pitcher_id === currentPitcherChar.name)
      : []
  ), [gamePitches, currentPitcherChar])
  useEffect(() => {
    if (!adminRunnerCharacterId) return
    if (!currentLineup.some((entry) => String(entry.character_id) === String(adminRunnerCharacterId))) {
      setAdminRunnerCharacterId('')
    }
  }, [adminRunnerCharacterId, currentLineup])
  const activePaNumber = editingPa?.pa_number ?? nextPaNumber(gamePAs)
  const currentPitcherStorageKey = `${scorebookDataScope}:${currentPitcherStint?.id || currentPitcherStint?.character_id || 'none'}`
  const currentActivePaScope = selectedGameId && currentBatter?.id
    ? `${selectedGameId}:${activePaNumber}:${currentBatter.id}`
    : null
  const {
    balls,
    strikes,
    pitchNumber,
    resetPa: resetPitchCount,
    restoreState: restorePitchState,
    getCounts: getPitchCounts,
    recordBall,
    recordStrike,
    recordFoul,
    recordHbp,
    recordInPlay,
    undoPitch,
  } = usePitchCount({
    pitcherKey: currentPitcherStorageKey,
    initialPitchNumber: currentPitcherPitchRows.length,
  })
  const clearRedoAction = useCallback(() => {
    setRedoAction(null)
  }, [])

  const restoreActivePaSnapshot = useCallback((snapshot) => {
    if (!snapshot) return
    restorePitchState({
      balls: Number(snapshot.balls || 0),
      strikes: Number(snapshot.strikes || 0),
      pitchNumber: Number(snapshot.pitchNumber || 0),
    })
    const restoredRows = Array.isArray(snapshot.paPitchRows) ? snapshot.paPitchRows : []
    paPitchRowsRef.current = restoredRows
    setPaPitchRows(restoredRows)
    setPendingPA(snapshot.pendingPA || null)
    setPitchActionSheet(snapshot.pitchActionSheet || null)
    setPendingPitchEvent(snapshot.pendingPitchEvent || null)
    setInPlayState(snapshot.inPlayState || null)
    setRbiOverlay(snapshot.rbiOverlay || null)
    setStarPitchActive(Boolean(snapshot.starPitchActive))
    setStarHitUsed(Boolean(snapshot.starHitUsed))
    setStarHitPending(Boolean(snapshot.starHitPending))
    setStarHitConnected(Boolean(snapshot.starHitConnected))
  }, [restorePitchState])

  const buildActivePaSnapshot = useCallback(() => ({
    balls,
    strikes,
    pitchNumber,
    paPitchRows,
    pendingPA,
    pitchActionSheet,
    pendingPitchEvent,
    inPlayState,
    rbiOverlay,
    starPitchActive,
    starHitUsed,
    starHitPending,
    starHitConnected,
  }), [
    balls,
    strikes,
    pitchNumber,
    paPitchRows,
    pendingPA,
    pitchActionSheet,
    pendingPitchEvent,
    inPlayState,
    rbiOverlay,
    starPitchActive,
    starHitUsed,
    starHitPending,
    starHitConnected,
  ])

  const cancelPendingResolution = useCallback(() => {
    if (pendingPA?.rollbackSnapshot) {
      restoreActivePaSnapshot(pendingPA.rollbackSnapshot)
      return
    }
    setPendingPA(null)
  }, [pendingPA, restoreActivePaSnapshot])

  const cancelInPlaySelection = useCallback(() => {
    pitchActionPendingRef.current = false
    if (inPlayState?.rollbackSnapshot) {
      restoreActivePaSnapshot(inPlayState.rollbackSnapshot)
      return
    }
    setInPlayState(null)
    setPendingPitchEvent(null)
  }, [inPlayState, restoreActivePaSnapshot])

  const activeDefensiveFielders = useMemo(() => {
    if (!offense) return {}
    const defensiveTeamId = isSeasonGame
      ? gameSession.teamIdByPlayerId?.[offense.pitchingPlayerId] || null
      : offense.pitchingPlayerId
    return gameFielderRows.reduce((acc, row) => {
      if (
        String(row.team_id) === String(defensiveTeamId) &&
        fielderIsCurrent(row, currentInning)
      ) {
        acc[String(row.position)] = row
      }
      return acc
    }, {})
  }, [gameFielderRows, offense, currentInning, isSeasonGame, gameSession.teamIdByPlayerId])

  const currentHalfHasError = useMemo(() => (
    offense
      ? gamePAs.some((pa) => Number(pa.inning) === Number(currentInning) && String(pa.player_id) === String(offense.battingPlayerId) && pa.is_error)
      : false
  ), [gamePAs, offense, currentInning])

  const teamRosters = useMemo(() => {
    if (!selectedGame) return { teamA: [], teamB: [] }
    const picks = draftPicks.filter(p => p.tournament_id === selectedGame.tournament_id)
    return {
      teamA: picks.filter(p => p.player_id === selectedGame.team_a_player_id),
      teamB: picks.filter(p => p.player_id === selectedGame.team_b_player_id),
    }
  }, [draftPicks, selectedGame])

  const buildRosterCharMap = useCallback((picks) => Object.fromEntries(
    picks
      .filter((p) => p.character_id && charactersById[p.character_id])
      .map((p) => {
        const character = charactersById[p.character_id]
        return [p.character_id, {
          ...character,
          miiColor: p.mii_color,
          displayName: formatCharacterDisplayName(character.name, p.mii_color),
          chemistryName: getCharacterChemistryName(character.name, p.mii_color),
        }]
      }),
  ), [charactersById])

  const rosterCharMaps = useMemo(() => ({
    A: buildRosterCharMap(teamRosters.teamA),
    B: buildRosterCharMap(teamRosters.teamB),
  }), [buildRosterCharMap, teamRosters])

  const inningScoreMaps = useMemo(() => {
    if (!selectedGame) return { a: {}, b: {} }
    if (!gameInningScores.length) {
      return {
        a: inningRunsFromPAs(gamePAs, selectedGame.team_a_player_id, gameRuns),
        b: inningRunsFromPAs(gamePAs, selectedGame.team_b_player_id, gameRuns),
      }
    }
    return {
      a: inningRunsFromRows(gameInningScores, selectedGame.team_a_player_id),
      b: inningRunsFromRows(gameInningScores, selectedGame.team_b_player_id),
    }
  }, [selectedGame, gameInningScores, gamePAs, gameRuns])

  const scores = useMemo(() => {
    if (!selectedGame) return { a: 0, b: 0, aByInning: {}, bByInning: {}, aHits: 0, bHits: 0, aErrors: 0, bErrors: 0 }
    if (selectedGame.status === 'complete') {
      return {
        a: Number(selectedGame.team_a_runs || 0),
        b: Number(selectedGame.team_b_runs || 0),
        aByInning: inningScoreMaps.a,
        bByInning: inningScoreMaps.b,
        aHits: hitsFromPAs(gamePAs, selectedGame.team_a_player_id),
        bHits: hitsFromPAs(gamePAs, selectedGame.team_b_player_id),
        aErrors: errorsFromPAs(gamePAs, selectedGame.team_a_player_id, selectedGame.team_b_player_id),
        bErrors: errorsFromPAs(gamePAs, selectedGame.team_b_player_id, selectedGame.team_a_player_id),
      }
    }
    return {
      a: runsFromPAs(gamePAs, selectedGame.team_a_player_id, gameRuns),
      b: runsFromPAs(gamePAs, selectedGame.team_b_player_id, gameRuns),
      aByInning: inningScoreMaps.a,
      bByInning: inningScoreMaps.b,
      aHits: hitsFromPAs(gamePAs, selectedGame.team_a_player_id),
      bHits: hitsFromPAs(gamePAs, selectedGame.team_b_player_id),
      aErrors: errorsFromPAs(gamePAs, selectedGame.team_a_player_id, selectedGame.team_b_player_id),
      bErrors: errorsFromPAs(gamePAs, selectedGame.team_b_player_id, selectedGame.team_a_player_id),
    }
  }, [gamePAs, selectedGame, inningScoreMaps, gameRuns])

  // Home/Away ordering for the line score strip. `homeAwaySwapped` (from the
  // game row) determines which team actually bats in the top of the inning —
  // the "away" row is always drawn first, "home" second.
  const lineScoreRows = useMemo(() => {
    const teamARow = { battingSide: homeAwaySwapped ? 'home' : 'away', abbreviation: teamAAbbreviation, color: teamAColor, logoKey: teamALogoKey, logoUrl: teamALogoUrl, teamName: teamAName, scoreMap: scores.aByInning, runs: scores.a, hits: scores.aHits, errors: scores.aErrors }
    const teamBRow = { battingSide: homeAwaySwapped ? 'away' : 'home', abbreviation: teamBAbbreviation, color: teamBColor, logoKey: teamBLogoKey, logoUrl: teamBLogoUrl, teamName: teamBName, scoreMap: scores.bByInning, runs: scores.b, hits: scores.bHits, errors: scores.bErrors }
    return teamARow.battingSide === 'away' ? [teamARow, teamBRow] : [teamBRow, teamARow]
  }, [homeAwaySwapped, teamAAbbreviation, teamAColor, teamALogoKey, teamALogoUrl, teamAName, teamBAbbreviation, teamBColor, teamBLogoKey, teamBLogoUrl, teamBName, scores])

  const tournamentGameIds = useMemo(
    () => new Set(filteredGames.map(g => String(g.id))),
    [filteredGames],
  )

  // Cumulative stats shown in Game View (lineup AVG/OBP/SLG, pitcher ERA, etc.) should be a
  // snapshot as of the game being viewed — not live season/tournament-to-date numbers that keep
  // shifting every time a later game gets scored. `round_number` (season) reflects true schedule
  // order even when rows were bulk-imported; `created_at` can't be trusted for that (a whole bulk-
  // imported tournament/season can share one identical timestamp), but each row's own `id` is
  // still assigned in real creation order, so it's a safe fallback for tournament games.
  const gameOrderKey = useCallback((g) => (
    g?.round_number != null ? Number(g.round_number) : Number(g?.id)
  ), [])

  const statsThroughGameIds = useMemo(() => {
    if (!selectedGame) return tournamentGameIds
    const cutoff = gameOrderKey(selectedGame)
    return new Set(
      filteredGames
        .filter((g) => gameOrderKey(g) <= cutoff)
        .map((g) => String(g.id)),
    )
  }, [filteredGames, selectedGame, gameOrderKey, tournamentGameIds])

  const characterSeasonStats = useMemo(() => {
    if (!currentBatter) return null
    const tournPAs = plateAppearances.filter(pa =>
      pa.character_id === currentBatter.character_id &&
      statsThroughGameIds.has(String(pa.game_id)),
    )
    return summarizeBatting(tournPAs)
  }, [plateAppearances, currentBatter, statsThroughGameIds])

  const characterCareerStats = useMemo(() => {
    if (!currentBatter) return null
    return summarizeBatting(plateAppearances.filter(pa => pa.character_id === currentBatter.character_id))
  }, [plateAppearances, currentBatter])

  const currentBatterGamePAs = useMemo(() => {
    if (!currentBatter) return []
    return gamePAs.filter(pa => pa.character_id === currentBatter.character_id && pa.player_id === currentBatter.player_id)
  }, [gamePAs, currentBatter])
  const currentBatterGameSummary = useMemo(
    () => summarizeBatting(currentBatterGamePAs),
    [currentBatterGamePAs],
  )

  const teamALineup = useMemo(
    () => gameLineups.filter((entry) => String(entry.player_id) === String(selectedGame?.team_a_player_id)),
    [gameLineups, selectedGame?.team_a_player_id],
  )
  const teamBLineup = useMemo(
    () => gameLineups.filter((entry) => String(entry.player_id) === String(selectedGame?.team_b_player_id)),
    [gameLineups, selectedGame?.team_b_player_id],
  )

  const {
    teamAId,
    teamBId,
    lineupDrafts,
    setLineupDrafts,
    selectedLineupMoveId,
    selectedFieldingPlayer,
    lineupSaveStatus,
    lineupDirty,
    changePitcherRef,
    handleLineupDragStart,
    handleLineupNumberClick,
    handleDropOnLineupSlot,
    setFieldingPositionsForTeam,
    setSelectedFieldingPlayerForTeam,
    handleSaveLineupTeam,
    handleSaveAllDirtyLineups,
    discardLineupChanges,
  } = useLineupEditor({
    addSourceFields,
    canEditScorebook,
    charactersById,
    currentInning,
    currentPitcherStint,
    deferRealtimeHydration,
    gameFielderRows,
    gameLineups,
    gamePAs,
    gameSession,
    isGamePregame,
    isGameComplete,
    isSeasonGame,
    offense,
    playersById,
    pushToast,
    savedTeamLineups,
    scorebookTables,
    selectedGame,
    setGameFielders,
    setLineups,
    setSavedTeamLineups,
    setViewMode,
    teamALineup,
    teamBLineup,
    teamRosters,
    viewMode,
  })

  // The At-Bat Editor tab reports its own dirty state here since its draft
  // lives inside AtBatEditor, not Scorebook — folded into the same leave-page
  // guard as lineup edits below. atBatPanelRef lets the "Save & Leave" flow
  // trigger that component's save without lifting its whole draft up into
  // Scorebook.

  const atBatPanelRef = useRef(null)
  const inPlayDetailsFooterRef = useRef(null)
  const inPlayStageRef = useRef(null)

  useLayoutEffect(() => {
    const stage = inPlayState?.stage || null
    // Land directly on the BACK/CONFIRM row when the details step opens (no
    // animated scroll) so the scorekeeper isn't stuck scrolling past the
    // diamond/preview every play.
    if (stage === 'details' && inPlayStageRef.current !== 'details') {
      inPlayDetailsFooterRef.current?.scrollIntoView({ behavior: 'instant', block: 'end' })
      window.scrollBy({ top: 60, behavior: 'instant' })
    }
    inPlayStageRef.current = stage
  }, [inPlayState?.stage])
  const [atBatDataDirty, setAtBatDataDirty] = useState(false)

  const anyLineupDirty = lineupDirty.A || lineupDirty.B
  const anyUnsavedChanges = anyLineupDirty || atBatDataDirty
  const unsavedChangesMessage = anyLineupDirty && atBatDataDirty
    ? 'You have unsaved lineup/fielding changes and unsaved at-bat data changes. Save them before leaving, or discard them?'
    : atBatDataDirty
      ? 'You have unsaved at-bat data changes. Save them before leaving, or discard them?'
      : 'You have unsaved lineup/fielding changes. Save them before leaving, or discard them?'

  const handleSaveAllDirtyAndAtBat = useCallback(async () => {
    await handleSaveAllDirtyLineups()
    if (atBatDataDirty) await atBatPanelRef.current?.save?.()
  }, [handleSaveAllDirtyLineups, atBatDataDirty])

  // "Discard & Leave" must actively clear the dirty flags, not just let
  // navigation/view-mode proceed — the lineup-dirty reset effect above only
  // runs while viewMode === 'lineups', so leaving that tab (or the route)
  // without this would leave lineupDirty/atBatDataDirty stuck true forever,
  // re-triggering the unsaved-changes prompt on every subsequent navigation
  // even though there's nothing left to discard.
  const handleDiscardAllDirtyAndAtBat = useCallback(() => {
    discardLineupChanges()
    if (atBatDataDirty) atBatPanelRef.current?.discard?.()
  }, [discardLineupChanges, atBatDataDirty])

  const lineupBlocker = useUnsavedChangesGuard(anyUnsavedChanges)
  useRegisterUnsavedChanges(anyUnsavedChanges, handleSaveAllDirtyAndAtBat)

  // Switching Scorebook's own tabs (Game View/Scorebook/Lineups/At-Bat Data/
  // Admin) is a same-page state change, not a router navigation, so the
  // route-level blocker above never sees it — this guards that path for
  // both lineup/fielding and At-Bat Data drafts (see viewTabs below).
  const { run: runViewChange, blocker: viewChangeBlocker } = useConfirmedAction(anyUnsavedChanges)

  const currentEntryKey = currentBatter ? `${currentBatter.player_id}:${currentBatter.character_id}` : null
  const lineupStatsByEntryKey = useMemo(() => {
    const next = {}
    gameLineups.forEach((entry) => {
      const key = `${entry.player_id}:${entry.character_id}`
      const gamePasForEntry = gamePAs.filter((pa) => String(pa.player_id) === String(entry.player_id) && Number(pa.character_id) === Number(entry.character_id))
      const sourcePasForEntry = plateAppearances.filter((pa) => statsThroughGameIds.has(String(pa.game_id)) && String(pa.player_id) === String(entry.player_id) && Number(pa.character_id) === Number(entry.character_id))
      const gameStats = summarizeBatting(gamePasForEntry, filterRunEventsForCharacter(gameRuns, entry.character_id, gamePasForEntry))
      const sourceStats = summarizeBatting(sourcePasForEntry, filterRunEventsForCharacter(runsScored, entry.character_id, sourcePasForEntry))
      next[key] = { game: gameStats, source: sourceStats }
    })
    return next
  }, [gameLineups, gamePAs, plateAppearances, statsThroughGameIds, gameRuns, runsScored])

  // Season/tournament-cumulative ERA for the Game View pitcher log — same
  // "as of this game" scope as lineupStatsByEntryKey's AVG/OBP/SLG above, just built
  // from stints instead of PAs since summarizePitching aggregates over stints.
  const pitchingSourceStatsByCharacterKey = useMemo(() => {
    const relevantStints = pitchingStints.filter((stint) => statsThroughGameIds.has(String(stint.game_id)))
    const grouped = {}
    relevantStints.forEach((stint) => {
      const key = `${stint.player_id}:${stint.character_id}`
      grouped[key] = grouped[key] || []
      grouped[key].push(stint)
    })
    return Object.fromEntries(
      Object.entries(grouped).map(([key, stints]) => [key, summarizePitching(stints)]),
    )
  }, [pitchingStints, statsThroughGameIds])

  const runsByPaId = useMemo(() => (
    gameRuns.reduce((acc, run) => {
      const key = String(run.pa_id || '')
      if (!key) return acc
      acc[key] = acc[key] || []
      acc[key].push(run)
      return acc
    }, {})
  ), [gameRuns])

  const scoringSummary = useMemo(() => {
    if (!selectedGame) return []
    let awayScore = 0
    let homeScore = 0
    let lastLeaderPlayerId = null
    return gamePAs.reduce((rows, pa) => {
      const scoringRuns = getPaScoringRuns(pa, runsByPaId)
      if (!scoringRuns) return rows

      const isAwayBatting = String(pa.player_id) === String(selectedGame.team_a_player_id)
      if (isAwayBatting) awayScore += scoringRuns
      else homeScore += scoringRuns

      const leaderPlayerId = awayScore === homeScore
        ? null
        : awayScore > homeScore
          ? selectedGame.team_a_player_id
          : selectedGame.team_b_player_id

      rows.push({
        id: pa.id,
        inning: Number(pa.inning || 1),
        half: isAwayBatting ? 'top' : 'bottom',
        battingPlayerId: pa.player_id,
        batterCharacterId: pa.character_id,
        awayScore,
        homeScore,
        scoringRuns,
        leaderPlayerId,
        leaderChanged: leaderPlayerId !== lastLeaderPlayerId,
        createdAt: pa.created_at,
        pitcherId: pa.pitcher_id,
        pitcherPlayerId: pa.pitcher_player_id,
        chargedToPitcherId: runsByPaId[String(pa.id)]?.[0]?.charged_to_pitcher_id || pa.pitcher_id || null,
        chargedToPitcherPlayerId: runsByPaId[String(pa.id)]?.[0]?.charged_to_pitcher_player_id || pa.pitcher_player_id || null,
        description: buildScoringPlayDescription(pa, scoringRuns, runsByPaId[String(pa.id)] || [], charactersById),
      })
      lastLeaderPlayerId = leaderPlayerId
      return rows
    }, [])
  }, [selectedGame, gamePAs, runsByPaId, charactersById])

  const effectiveGameStatus = useMemo(() => {
    if (!selectedGame) return 'pending'
    if (isGameComplete) return 'complete'
    if (selectedGame.status === 'active') return 'active'
    if (selectedGameLiveState || gamePAs.length > 0) return 'active'
    return selectedGame.status || 'pending'
  }, [selectedGame, isGameComplete, selectedGameLiveState, gamePAs.length])

  const displayBalls = canEditScorebook ? balls : Number(selectedGameLiveState?.balls || 0)
  const displayStrikes = canEditScorebook ? strikes : Number(selectedGameLiveState?.strikes || 0)
  const livePitchNumberIsRecoverable = Boolean(selectedGameLiveState)
    && (Number(selectedGameLiveState.balls || 0) > 0 || Number(selectedGameLiveState.strikes || 0) > 0)
    && (!selectedGameLiveState.pitcherStintId || String(selectedGameLiveState.pitcherStintId) === String(currentPitcherStint?.id))
  const displayPitchNumber = canEditScorebook
    ? pitchNumber
    : livePitchNumberIsRecoverable
      ? Math.max(Number(currentPitcherPitchRows.length), Number(selectedGameLiveState.pitchNumber ?? currentPitcherPitchRows.length))
      : Number(currentPitcherPitchRows.length)
  const displayOutsInHalf = canEditScorebook ? outsInHalf : Number(selectedGameLiveState?.outsInHalf ?? outsInHalf)
  const displayRunners = useMemo(() => {
    // The scorekeeper's own `runners` state is authoritative and always current —
    // it's never stale, so it should render as-is (including a runner an Admin
    // adds at the very start of a half, before any PA is recorded). The
    // start-of-half blanking below only guards against `selectedGameLiveState`,
    // which can lag a beat behind reality via realtime propagation and could
    // otherwise flash the previous half's runners for viewers.
    if (canEditScorebook) return runners
    const nextRunners = selectedGameLiveState?.runners || { first: null, second: null, third: null }
    // A tracker snapshot writes inning, PA and runners together and its runner
    // feed is authoritative. The manual anti-flicker heuristic below hid a
    // genuine first-PA runner when stale inning metadata made currentHalfPaCount
    // look like zero; never discard an explicit tracker base snapshot.
    if (selectedGame?.stats_source === 'tracker') return nextRunners
    if (displayOutsInHalf === 0 && currentHalfPaCount === 0) {
      return { first: null, second: null, third: null }
    }
    return nextRunners
  }, [canEditScorebook, runners, selectedGame?.stats_source, selectedGameLiveState?.runners, displayOutsInHalf, currentHalfPaCount])
  const gameWinProbabilityContext = useMemo(() => {
    if (!selectedGame) return null
    return buildSharedOddsGenerationContext({
      game: selectedGame,
      draftPicks,
      charactersById,
      gamePAs,
      gamePitching,
      allGames: games,
      allPAs: trackedPlateAppearances,
      allPitching: pitchingStints,
      stadiumsById,
      stadiumGameLog,
      playersById,
      currentInning,
      scores,
      totalInnings: regulationInnings,
      bets: gameBets,
      oddsWeights: oddsEngineWeights,
    })
  }, [
    selectedGame,
    draftPicks,
    charactersById,
    gamePAs,
    gamePitching,
    games,
    trackedPlateAppearances,
    pitchingStints,
    stadiumsById,
    stadiumGameLog,
    playersById,
    currentInning,
    scores,
    regulationInnings,
    gameBets,
    oddsEngineWeights,
  ])

  // estimateHomeWinProbability assumes "away" = team A and "home" = team B, with
  // `isTop` meaning the away team (team A) is batting. `offense.isTop` only tells
  // us whether it's structurally the top of the inning, which (when swapped) can
  // mean team B is batting — so derive isTop from which team is actually batting.
  const isTeamABatting = offense ? String(offense.battingPlayerId) === String(selectedGame?.team_a_player_id) : true
  // Which line-score row (away/home) reflects the half-inning currently being played —
  // null once the game is final, since no half is "active" anymore.
  const activeBattingSide = effectiveGameStatus === 'complete'
    ? null
    : (isTeamABatting === !homeAwaySwapped ? 'away' : 'home')
  const currentWinProbability = useMemo(() => estimateHomeWinProbability({
    homeScore: scores.b,
    awayScore: scores.a,
    currentInning,
    isTop: isTeamABatting,
    outsInHalf: displayOutsInHalf,
    regulationInnings,
    runnersOccupied: [displayRunners.first, displayRunners.second, displayRunners.third].filter(Boolean).length,
    balls: displayBalls,
    strikes: displayStrikes,
    status: effectiveGameStatus,
    paCount: gamePAs.length,
    oddsContext: gameWinProbabilityContext,
  }), [
    scores.b,
    scores.a,
    currentInning,
    isTeamABatting,
    displayOutsInHalf,
    regulationInnings,
    displayRunners.first,
    displayRunners.second,
    displayRunners.third,
    displayBalls,
    displayStrikes,
    effectiveGameStatus,
    gamePAs.length,
    gameWinProbabilityContext,
  ])

  const winProbabilityPoints = useMemo(() => {
    if (!selectedGame) return []
    const points = [{
      label: 'Start',
      probability: estimateHomeWinProbability({
        homeScore: 0,
        awayScore: 0,
        currentInning: 1,
        isTop: true,
        outsInHalf: 0,
        regulationInnings,
        status: 'pending',
        paCount: 0,
        oddsContext: gameWinProbabilityContext,
      }),
      description: 'Game start',
      score: `${teamAAbbreviation} 0 - ${teamBAbbreviation} 0`,
    }]
    let teamAScore = 0
    let teamBScore = 0
    let outsBefore = 0
    const swapped = !!selectedGame.home_away_swapped

    gamePAs.forEach((pa, index) => {
      const scoringRuns = getPaScoringRuns(pa, runsByPaId)
      const isTeamABatting = String(pa.player_id) === String(selectedGame.team_a_player_id)
      // Team A bats in the top of the inning unless home/away is swapped.
      const isTop = swapped ? !isTeamABatting : isTeamABatting
      const outsAfter = outsBefore + calculateOutsForPa(pa.result, pa.outs_on_play)
      if (scoringRuns) {
        if (isTeamABatting) teamAScore += scoringRuns
        else teamBScore += scoringRuns
      }
      const batterName = charactersById[pa.character_id]?.name || 'Unknown'
      points.push({
        label: `${isTop ? 'Top' : 'Bot'} ${Number(pa.inning || 1)}`,
        description: scoringRuns > 0
          ? buildScoringPlayDescription(pa, scoringRuns, runsByPaId[String(pa.id)] || [], charactersById)
          : `${batterName} ${formatPlayResultText(pa)}`,
        probability: estimateHomeWinProbability({
          homeScore: swapped ? teamAScore : teamBScore,
          awayScore: swapped ? teamBScore : teamAScore,
          currentInning: Number(pa.inning || 1),
          isTop,
          outsInHalf: outsAfter % 3,
          regulationInnings,
          status: 'active',
          paCount: index + 1,
          oddsContext: gameWinProbabilityContext,
        }),
        score: `${teamAAbbreviation} ${teamAScore} - ${teamBAbbreviation} ${teamBScore}`,
      })
      outsBefore = outsAfter
    })

    const finalLabel = effectiveGameStatus === 'complete'
      ? getFinalStatusLabel(selectedGame, regulationInnings)
      : (offense?.halfLabel || 'Live')
    // currentWinProbability is team B's win probability (swap-independent); the
    // chart's home/away labels and colors flip with the swap, so the plotted
    // probability needs to flip too — same conversion as `currentHomeProbability`.
    const currentHomeProbability = swapped ? 1 - currentWinProbability : currentWinProbability
    if (points.length > 1) {
      const lastPoint = points[points.length - 1]
      lastPoint.label = finalLabel
      lastPoint.probability = currentHomeProbability
      lastPoint.score = `${teamAAbbreviation} ${scores.a} - ${teamBAbbreviation} ${scores.b}`
      if (effectiveGameStatus === 'complete') lastPoint.description = 'Game complete'
    } else {
      points.push({
        label: finalLabel,
        probability: currentHomeProbability,
        description: effectiveGameStatus === 'complete' ? 'Game complete' : 'Game start',
        score: `${teamAAbbreviation} ${scores.a} - ${teamBAbbreviation} ${scores.b}`,
      })
    }
    return points
  }, [selectedGame, gamePAs, regulationInnings, offense?.halfLabel, currentWinProbability, runsByPaId, charactersById, teamAAbbreviation, teamBAbbreviation, scores.a, scores.b, effectiveGameStatus, gameWinProbabilityContext])

  const teamAExpectedPitcherId = lineupDrafts.A?.fielding?.pitcher ? Number(lineupDrafts.A.fielding.pitcher) : null
  const teamBExpectedPitcherId = lineupDrafts.B?.fielding?.pitcher ? Number(lineupDrafts.B.fielding.pitcher) : null

  const teamAPitching = useMemo(
    () => buildDisplayedPitchingStints(
      [...gamePitching].filter((stint) => String(stint.player_id) === String(selectedGame?.team_a_player_id)),
      selectedGame?.team_a_player_id,
      // The "expected pitcher" placeholder previews who's about to take the mound in a live
      // game — it should never appear on a completed game's box score, since lineupDrafts is
      // per-player state that can carry a stale planned-pitcher value long after the game ended.
      isGameComplete ? null : teamAExpectedPitcherId,
    ),
    [gamePitching, selectedGame?.team_a_player_id, teamAExpectedPitcherId, isGameComplete],
  )
  const teamBPitching = useMemo(
    () => buildDisplayedPitchingStints(
      [...gamePitching].filter((stint) => String(stint.player_id) === String(selectedGame?.team_b_player_id)),
      selectedGame?.team_b_player_id,
      isGameComplete ? null : teamBExpectedPitcherId,
    ),
    [gamePitching, selectedGame?.team_b_player_id, teamBExpectedPitcherId, isGameComplete],
  )

  const pitcherDecisionSummary = useMemo(() => {
    if (!selectedGame || selectedGame.status !== 'complete') return { winning: null, losing: null }
    const flaggedWinning = gamePitching.find((stint) => stint.win)
    const flaggedLosing = gamePitching.find((stint) => stint.loss)
    if (flaggedWinning || flaggedLosing) {
      return { winning: flaggedWinning || null, losing: flaggedLosing || null }
    }

    const winnerPlayerId = selectedGame.winner_player_id || (scores.a > scores.b ? selectedGame.team_a_player_id : scores.b > scores.a ? selectedGame.team_b_player_id : null)
    if (!winnerPlayerId) return { winning: null, losing: null }

    let decisivePlay = null
    for (const play of scoringSummary) {
      if (play.leaderChanged && String(play.leaderPlayerId) === String(winnerPlayerId)) {
        decisivePlay = play
      }
    }
    if (!decisivePlay) {
      return {
        winning: [...gamePitching].filter((stint) => String(stint.player_id) === String(winnerPlayerId)).slice(-1)[0] || null,
        losing: null,
      }
    }

    const winningCandidates = [...gamePitching]
      .filter((stint) => String(stint.player_id) === String(winnerPlayerId) && new Date(stint.created_at).getTime() <= new Date(decisivePlay.createdAt).getTime())
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    const winning = winningCandidates[winningCandidates.length - 1]
      || [...gamePitching].filter((stint) => String(stint.player_id) === String(winnerPlayerId)).slice(-1)[0]
      || null

    let losing = null
    if (decisivePlay.chargedToPitcherId || decisivePlay.chargedToPitcherPlayerId) {
      const losingCandidates = [...gamePitching]
        .filter((stint) => (
          (!decisivePlay.chargedToPitcherId || Number(stint.character_id) === Number(decisivePlay.chargedToPitcherId))
          && (!decisivePlay.chargedToPitcherPlayerId || String(stint.player_id) === String(decisivePlay.chargedToPitcherPlayerId))
        ))
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      losing = losingCandidates[losingCandidates.length - 1] || null
    }

    if (!losing) {
      const losingPlayerId = String(winnerPlayerId) === String(selectedGame.team_a_player_id) ? selectedGame.team_b_player_id : selectedGame.team_a_player_id
      const fallbackCandidates = [...gamePitching]
        .filter((stint) => String(stint.player_id) === String(losingPlayerId) && new Date(stint.created_at).getTime() <= new Date(decisivePlay.createdAt).getTime())
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      losing = fallbackCandidates[fallbackCandidates.length - 1]
        || [...gamePitching].filter((stint) => String(stint.player_id) === String(losingPlayerId)).slice(-1)[0]
        || null
    }

    return { winning, losing }
  }, [selectedGame, gamePitching, scoringSummary, scores.a, scores.b])

  const pitcherDecisionLabels = useMemo(() => {
    const labels = {}
    if (pitcherDecisionSummary.winning?.id != null) labels[pitcherDecisionSummary.winning.id] = 'W'
    if (pitcherDecisionSummary.losing?.id != null) labels[pitcherDecisionSummary.losing.id] = 'L'
    const savePitcher = gamePitching.find((stint) => stint.save)
    if (savePitcher?.id != null) labels[savePitcher.id] = 'SV'
    return labels
  }, [pitcherDecisionSummary, gamePitching])

  useEffect(() => {
    if (!offense?.battingPlayerId) return
    setRunners((current) => sanitizeRunnersForOffense(current, offense))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offense?.battingPlayerId])

  const localActivePaRestoreRef = useActivePaPersistence({
    selectedGameId,
    currentActivePaScope,
    activePaNumber,
    currentPitcherPitchRows,
    currentPitcherStorageKey,
    currentPitcherStintId: currentPitcherStint?.id,
    restorePitchState,
    selectedGameLiveState,
    currentBatterPlayerId: currentBatter?.player_id,
    currentBatterCharacterId: currentBatter?.character_id,
    deferRealtimeUntilRef,
    balls,
    strikes,
    pitchNumber,
    paPitchRows,
    paPitchRowsRef,
    starHitUsed,
    starHitPending,
    starHitConnected,
    starPitchActive,
    pitchActionSheet,
    pendingPitchEvent,
    inPlayState,
    rbiOverlay,
    setStarPitchActive,
    setPitchActionSheet,
    setPendingPitchEvent,
    setPaPitchRows,
    setInPlayState,
    setRbiOverlay,
    setStarHitUsed,
    setStarHitPending,
    setStarHitConnected,
  })

  useEffect(() => {
    if (!redoAction) return
    if (redoAction.type === 'pa' && String(redoAction.gameId) !== String(selectedGameId)) {
      setRedoAction(null)
      return
    }
    if (redoAction.type === 'pitch' && redoAction.scope !== currentActivePaScope) {
      setRedoAction(null)
    }
  }, [redoAction, selectedGameId, currentActivePaScope])

  const previewRunners = useMemo(
    () => (pendingPA?.assignments?.length ? extractNextRunners(pendingPA) : runners),
    [pendingPA, runners],
  )

  const previewHomeRunners = useMemo(
    () => (pendingPA?.assignments?.length ? getHomeAssignments(pendingPA) : []),
    [pendingPA],
  )

  const previewOuts = useMemo(
    () => (pendingPA?.assignments?.length ? getOutAssignments(pendingPA).length : 0),
    [pendingPA],
  )


  const runnerStateLoadedScope = useRunnerStatePersistence({
    selectedGameId,
    currentHalfIdx,
    offense,
    selectedGame,
    selectedGameLiveState,
    runners,
    setRunners,
    runnersHistory,
    setRunnersHistory,
  })

  const [isSaving, setIsSaving] = useState(false)
  const canRecordOutcome = Boolean(currentPitcherStint) && (!isSaving || isUndoInFlight) && !isPitchActionPending && canEditScorebook

  useEffect(() => () => {
    if (saveWatchdogRef.current) clearTimeout(saveWatchdogRef.current)
    if (pitchActionUnlockRef.current) clearTimeout(pitchActionUnlockRef.current)
  }, [])

  useLiveGamePersistence({
    selectedGame,
    selectedGameId,
    selectedGameLiveState,
    canEditScorebook,
    isGameComplete,
    isSeasonGame,
    gamesTable: scorebookTables.games,
    accessToken: session?.access_token,
    offense,
    currentHalfIdx,
    runnerStateLoadedScope,
    currentBatter,
    onDeckBatter,
    runners,
    runnersHistory,
    outsInHalf,
    balls,
    strikes,
    pitchNumber,
    currentPitcherStint,
    activePaNumber,
    paPitchRows,
    pendingPA,
    pitchActionSheet,
    pendingPitchEvent,
    inPlayState,
    rbiOverlay,
    starPitchActive,
    starHitUsed,
    starHitPending,
    starHitConnected,
    gamePaCount: gamePAs.length,
  })

  useEffect(() => {
    if (!isScorekeeper) {
      setViewMode('game')
    } else if (!searchParams.get('view')) {
      setViewMode(selectedGame?.stats_source === 'tracker' ? 'liveTracker' : 'scorebook')
    }
  }, [isScorekeeper])

  useEffect(() => {
    if (!isGameComplete) return
    setEditingPa(null)
    setPendingPA(null)
    setShowOutsBanner(false)
    setGameEndBanner(null)
    setSelectedPitcher(null)
    setIsDragOverMound(false)
    setOverrideBatterIdx(null)
    setStarPitchActive(false)
    setStarHitUsed(false)
    setStarHitPending(false)
    setStarHitConnected(false)
    setPitchActionSheet(null)
    setPendingPitchEvent(null)
    paPitchRowsRef.current = []
    setPaPitchRows([])
    setInPlayState(null)
    setRbiOverlay(null)
    setShowEndGameConfirm(false)
    resetPitchCount()
    if (selectedGame?.id) {
      try { sessionStorage.removeItem(getActivePaStorageKey(selectedGame.id)) } catch {}
    }
  }, [isGameComplete, selectedGame?.id, resetPitchCount])

  const completedHalfCount = Math.floor(outsRecorded / 3)

  const maxInning = useMemo(() => {
    const completedInnings = Math.ceil(completedHalfCount / 2)
    // A finished game shows only the innings actually played. `currentInning` (from
    // deriveOffense) always points at the *next* half-inning, so once the game is
    // complete it overshoots by one and must not be used here — fall back to the
    // recorded final_inning, or the count of completed innings, instead.
    if (effectiveGameStatus === 'complete') {
      const recordedFinalInning = Number(selectedGame?.final_inning)
      if (Number.isFinite(recordedFinalInning) && recordedFinalInning >= 1) return recordedFinalInning
      return Math.max(completedInnings, 1)
    }
    const highestPlayedInning = Math.max(currentInning, completedInnings, 1)
    return Math.max(regulationInnings, highestPlayedInning > regulationInnings ? highestPlayedInning : 0)
  }, [completedHalfCount, regulationInnings, currentInning, effectiveGameStatus, selectedGame?.final_inning])
  const innings   = useMemo(() => Array.from({ length: maxInning }, (_, i) => i + 1), [maxInning])

  const backPath = isSeasonGame
    ? (selectedGame?.stage ? '/season/schedule?view=playoffs' : '/season/schedule')
    : '/bracket'
  const backLabel = isSeasonGame
    ? (selectedGame?.stage ? 'Back to Season Playoffs' : 'Back to Season Schedule')
    : 'Back to Tournament Bracket'

  // ── Game-end check ─────────────────────────────────────────────────────────
  const checkGameEnd = useCallback(({
    inning,
    isTop,
    halfCompleted = false,
    currentScores,
    previousScores = currentScores,
  }) => {
    if (!selectedGame || isGameComplete || !currentScores) return null

    // `isTop`/`currentScores.a`/`currentScores.b` are swap-independent (team A /
    // team B totals, top of inning is structural). Map them to away/home using
    // the swap flag so "home" always means the team batting in the bottom half.
    const swapped = !!selectedGame.home_away_swapped
    const awayPlayerId = swapped ? selectedGame.team_b_player_id : selectedGame.team_a_player_id
    const homePlayerId = swapped ? selectedGame.team_a_player_id : selectedGame.team_b_player_id
    const awayScore = Number((swapped ? currentScores.b : currentScores.a) || 0)
    const homeScore = Number((swapped ? currentScores.a : currentScores.b) || 0)
    if (awayScore === homeScore) return null

    const awayBefore = Number((swapped ? previousScores?.b : previousScores?.a) || 0)
    const homeBefore = Number((swapped ? previousScores?.a : previousScores?.b) || 0)
    const winnerId = awayScore > homeScore ? awayPlayerId : homePlayerId
    const diff = Math.abs(awayScore - homeScore)
    const homeWonAfterTop = Boolean(halfCompleted && isTop && Number(inning || 0) >= regulationInnings && homeScore > awayScore)
    const homeWalkOff = Boolean(!halfCompleted && !isTop && Number(inning || 0) >= regulationInnings && homeScore > awayScore && homeBefore <= awayBefore)
    const inningEndedWithWinner = Boolean(halfCompleted && !isTop && Number(inning || 0) >= regulationInnings)
    const mercyEndedGame = Boolean(
      mercyOn
      && diff >= mercyLimit
      && halfCompleted
      && (
        !isTop
        || homeWonAfterTop
      ),
    )

    if (homeWalkOff) {
      return { type: 'regulation', winnerId: homePlayerId, inning }
    }
    if (mercyEndedGame) {
      return { type: 'mercy', winnerId, inning }
    }
    if (homeWonAfterTop || inningEndedWithWinner) {
      return { type: 'regulation', winnerId, inning }
    }
    return null
  }, [selectedGame, isGameComplete, mercyOn, mercyLimit, regulationInnings])

  // Re-derive the game-end banner from persisted data once loaded. Without this,
  // a scorer who reloads (or reopens the tab) right after the last out — without
  // clicking Mark Complete/Continue Playing on the live banner — loses the
  // banner for good, since it otherwise only ever gets set as a one-off side
  // effect of confirming that specific play. Fires at the start of every half
  // inning (same condition the live path checks under), so it's a no-op except
  // when the completion condition was met but never acted on.
  useEffect(() => {
    if (!dataLoaded || !canEditScorebook || !selectedGame || isGameComplete || gameEndBanner) return
    if (outsInHalf !== 0 || currentHalfPaCount !== 0 || gamePAs.length === 0 || outsRecorded < 3) return
    if (dismissedGameEndOutsRef.current === outsRecorded) return
    // `offense` already rolled over to the upcoming half — re-derive the half
    // that just ended (same inputs the live confirm-handler saw) so isTop/inning
    // match what actually decided the game, not the phantom next at-bat.
    const endedHalfOffense = deriveOffense(selectedGame, outsRecorded - 3)
    const end = checkGameEnd({
      inning: endedHalfOffense.inning,
      isTop: endedHalfOffense.isTop,
      halfCompleted: true,
      currentScores: scores,
      previousScores: scores,
    })
    if (end) setGameEndBanner(end)
  }, [dataLoaded, canEditScorebook, isGameComplete, gameEndBanner, selectedGame, outsInHalf, currentHalfPaCount, gamePAs.length, outsRecorded, scores, checkGameEnd])

  // ── Sync scores ────────────────────────────────────────────────────────────
  async function syncScores(freshPAs, game, freshRuns = []) {
    const awayRuns = runsFromPAs(freshPAs, game.team_a_player_id, freshRuns)
    const homeRuns = runsFromPAs(freshPAs, game.team_b_player_id, freshRuns)
    const payload = isSeasonGame
      ? { away_score: awayRuns, home_score: homeRuns }
      : { team_a_runs: awayRuns, team_b_runs: homeRuns }
    setGames((current) => current.map((entry) => (
      String(entry.id) === String(game.id)
        ? {
            ...entry,
            ...(isSeasonGame
              ? {
                  away_score: awayRuns,
                  home_score: homeRuns,
                  team_a_runs: awayRuns,
                  team_b_runs: homeRuns,
                }
              : {
                  team_a_runs: awayRuns,
                  team_b_runs: homeRuns,
                }),
          }
        : entry
    )))
    await updateGameRecord({ tables: scorebookTables, gameId: game.id, patch: payload })
  }

  async function syncInningScores({ freshPAs = [], freshRuns = [], game }) {
    if (!game || !scorebookTables.inningScores) return

    const rows = freshRuns.length
      ? freshRuns.reduce((acc, run) => {
          const key = `${run.inning}:${run.scoring_player_id}`
          acc[key] = acc[key] || { inning: Number(run.inning || 1), playerId: run.scoring_player_id, runs: 0 }
          acc[key].runs += 1
          return acc
        }, {})
      : freshPAs.reduce((acc, pa) => {
          const runs = getPaScoringRuns(pa)
          if (!runs) return acc
          const key = `${pa.inning}:${pa.player_id}`
          acc[key] = acc[key] || { inning: Number(pa.inning || 1), playerId: pa.player_id, runs: 0 }
          acc[key].runs += runs
          return acc
        }, {})

    const payload = Object.values(rows).map((entry) => (
      isSeasonGame
        ? addSourceFields({
            game_id: game.id,
            team_id: gameSession.teamIdByPlayerId?.[entry.playerId] || null,
            inning: entry.inning,
            runs: entry.runs,
          })
        : {
            game_id: game.id,
            player_id: entry.playerId,
            inning: entry.inning,
            runs: entry.runs,
      }
    )).filter((entry) => (isSeasonGame ? entry.team_id : entry.player_id))

    const normalizedRows = payload.map((entry) => ({
      ...entry,
      player_id: entry.player_id || gameSession.playerIdByTeamId?.[entry.team_id] || null,
    }))

    setInningScores((current) => [
      ...current.filter((row) => String(row.game_id) !== String(game.id)),
      ...normalizedRows,
    ])

    const { error } = await replaceInningScoreRows({ tables: scorebookTables, gameId: game.id, rows: payload })
    if (error) throw error
  }

  // ── Save plate appearance ──────────────────────────────────────────────────
  const buildOddsGenerationContext = useCallback((overridePitching = gamePitching, overridePAs = gamePAs) => {
    return buildSharedOddsGenerationContext({
      game: selectedGame,
      draftPicks,
      charactersById,
      gamePAs: overridePAs,
      gamePitching: overridePitching,
      allGames: games,
      allPAs: trackedPlateAppearances,
      allPitching: pitchingStints,
      stadiumsById,
      stadiumGameLog,
      playersById,
      currentInning,
      scores,
      bets: gameBets,
      oddsWeights: oddsEngineWeights,
    })
  }, [
    charactersById,
    currentInning,
    gamePAs,
    gamePitching,
    draftPicks,
    games,
    pitchingStints,
    trackedPlateAppearances,
    playersById,
    scores,
    selectedGame,
    stadiumGameLog,
    stadiumsById,
    gameBets,
    oddsEngineWeights,
  ])

  const upsertChangedOdds = useCallback(async (changedRows) => {
    if (!selectedGame || !changedRows.length) return
    const { data: existingOdds } = await fetchGameOdds({ tables: scorebookTables, gameId: selectedGame.id })
    const payload = mergeOddsWithExistingRows(changedRows, existingOdds || []).map((row) => {
      const sanitized = Object.fromEntries(
        Object.entries(row).filter(([, value]) => value !== null && value !== undefined),
      )
      return sanitized
    })
    const toUpdate = Object.values(
      payload
        .filter((row) => row.id != null)
        .reduce((acc, row) => {
          acc[row.id] = row
          return acc
        }, {}),
    )
    const toInsert = Object.values(
      payload
        .filter((row) => row.id == null)
        .reduce((acc, row) => {
          acc[`${row.bet_type}::${row.target_entity || 'game'}`] = row
          return acc
        }, {}),
    )

    await persistScorebookOddsRows({
      tables: scorebookTables,
      updates: toUpdate,
      inserts: toInsert,
    })
  }, [selectedGame, scorebookTables.gameOdds])

  const ensureLiveOdds = useCallback(async (overridePitching = gamePitching, overridePAs = gamePAs) => {
    if (!selectedGame) return []
    const { data: currentOdds } = await fetchGameOdds({ tables: scorebookTables, gameId: selectedGame.id })
    if ((currentOdds || []).length) return currentOdds || []

    const generationContext = buildOddsGenerationContext(overridePitching, overridePAs)
    if (!generationContext) return []

    const generatedRows = generateGameOdds(
      generationContext.game,
      generationContext.homeRoster,
      generationContext.awayRoster,
      generationContext.homeHistorical,
      generationContext.awayHistorical,
      generationContext.playerProps,
      oddsEngineWeights || DEFAULT_ODDS_WEIGHTS,
    )

    await upsertChangedOdds(generatedRows)
    return generatedRows
  }, [selectedGame, gamePitching, gamePAs, buildOddsGenerationContext, upsertChangedOdds, oddsEngineWeights])

  useEffect(() => {
    if (!selectedGame || selectedGame.status === 'complete') return
    ensureLiveOdds().catch((error) => {
      pushToast({ title: 'Odds sync failed', message: error.message, type: 'error' })
    })
  }, [selectedGame?.id, selectedGame?.status, ensureLiveOdds, pushToast])

  // Manual scorebooks may reflect the count mid-at-bat. Tracker games are
  // priced only by the bridge after a completed plate appearance.
  const syncLiveOddsForCount = useCallback(async (nextBalls, nextStrikes) => {
    if (!selectedGame || selectedGame.stats_source === 'tracker' || effectiveGameStatus === 'complete' || !gameWinProbabilityContext) return
    try {
      const currentOdds = await ensureLiveOdds(gamePitching, gamePAs)
      const changedRows = recalculateOdds(currentOdds || [], {
        oddsContext: gameWinProbabilityContext,
        liveState: {
          homeScore: scores.b,
          awayScore: scores.a,
          currentInning,
          isTop: isTeamABatting,
          outsInHalf,
          regulationInnings,
          runnersOccupied: [runners?.first, runners?.second, runners?.third].filter(Boolean).length,
          balls: nextBalls,
          strikes: nextStrikes,
          paCount: gamePAs.length,
          status: 'active',
        },
      })
      await upsertChangedOdds(changedRows)
    } catch (bettingError) {
      pushToast({ title: 'Odds refresh failed', message: bettingError.message, type: 'error' })
    }
  }, [selectedGame, effectiveGameStatus, gameWinProbabilityContext, ensureLiveOdds, gamePitching, gamePAs, scores.a, scores.b, currentInning, isTeamABatting, outsInHalf, regulationInnings, runners, upsertChangedOdds, pushToast])

  const recomputePitchingStatsForGame = useCallback(async (overridePAs, overridePitching = gamePitching, overrideRuns = gameRuns, overridePitches = gamePitches) => {
    if (!selectedGame || !overridePitching.length) return

    const stints = [...overridePitching].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    const pas = [...overridePAs].sort((a, b) => {
      const paA = Number(a.pa_number)
      const paB = Number(b.pa_number)
      const hasPaA = Number.isFinite(paA) && paA > 0
      const hasPaB = Number.isFinite(paB) && paB > 0
      if (hasPaA && hasPaB && paA !== paB) return paA - paB
      if (hasPaA !== hasPaB) return hasPaA ? -1 : 1
      return new Date(a.created_at) - new Date(b.created_at) || Number(a.id || 0) - Number(b.id || 0)
    })
    const nextStatsByStintId = Object.fromEntries(
      stints.map((stint) => [stint.id, {
        innings_pitched: 0,
        hits_allowed: 0,
        runs_allowed: 0,
        earned_runs: 0,
        walks: 0,
        strikeouts: 0,
        hr_allowed: 0,
        pitches_thrown: 0,
        strikes_thrown: 0,
        _outsRecorded: 0,
      }]),
    )

    let outsBeforePa = 0
    pas.forEach((pa) => {
      const defense = deriveOffense(selectedGame, outsBeforePa)
      // Prefer the pitcher recorded directly on the PA at save time (see savePA's pitcher_id/
      // pitcher_player_id) — it's authoritative regardless of row insertion order. Falling back
      // to "most recent stint created before this PA" breaks for bulk-imported/backfilled games,
      // where every stint's created_at can land after every PA's (all stints inserted in one
      // batch once the whole game was already recorded), silently zeroing out real box scores.
      let activeStint = null
      if (pa.pitcher_id != null) {
        // A pitcher who re-enters after being pulled gets a second stints row
        // with the same character_id/player_id — plain .find() would always
        // grab the earliest one, dumping every PA from the second outing back
        // onto the first and leaving the re-entry stint's stats stuck at 0.
        // Disambiguate by which of the same-pitcher stints was actually open
        // when this PA happened; only fall back to the earliest match when
        // none qualify (the bulk-import case the comment above describes).
        const candidateStints = stints.filter((stint) => (
          String(stint.character_id) === String(pa.pitcher_id) && String(stint.player_id) === String(defense.pitchingPlayerId)
        ))
        const eligibleCandidates = candidateStints.filter((stint) => (
          new Date(stint.created_at).getTime() <= new Date(pa.created_at).getTime()
        ))
        activeStint = eligibleCandidates[eligibleCandidates.length - 1] || candidateStints[0] || null
      }
      if (!activeStint) {
        const eligibleStints = stints.filter(
          (stint) =>
            String(stint.player_id) === String(defense.pitchingPlayerId) &&
            new Date(stint.created_at).getTime() <= new Date(pa.created_at).getTime(),
        )
        activeStint = eligibleStints[eligibleStints.length - 1]
      }
      if (activeStint) {
        const next = nextStatsByStintId[activeStint.id]
        const outs = calculateOutsForPa(pa.result, pa.outs_on_play)
        const paRuns = overrideRuns.filter((run) => String(run.pa_id) === String(pa.id))

        next._outsRecorded += outs
        if (isCreditedHit(pa)) next.hits_allowed += 1
        if (isCreditedHit(pa) && isHomeRunResult(pa.result)) next.hr_allowed += 1
        if (pa.result === 'BB') next.walks += 1
        if (pa.result === 'K') next.strikeouts += 1
        // Every pitch of this PA belongs to whichever stint the PA itself was
        // attributed to above — reuses that same re-entry-aware resolution
        // rather than re-deriving it per pitch from the pitches table's own
        // pitcher_id (a character name, not the id these stints key off of).
        const paPitches = overridePitches.filter((pitch) => String(pitch.pa_id) === String(pa.id))
        next.pitches_thrown += paPitches.length
        // A "strike" for the PC-ST count is every pitch except a ball or a hit
        // batsman — called/swinging strikes, fouls, and balls put in play all count.
        next.strikes_thrown += paPitches.filter((pitch) => pitch.result !== 'ball' && pitch.result !== 'hbp').length

        if (paRuns.length > 0) {
          paRuns.forEach((run) => {
            let target = next
            if (Number(run.charged_to_pitcher_id) !== Number(activeStint.character_id)) {
              // Inherited runner from a different pitcher: find their most recent stint before this PA.
              const chargedStints = stints.filter(
                (s) => Number(s.character_id) === Number(run.charged_to_pitcher_id) &&
                  new Date(s.created_at).getTime() <= new Date(pa.created_at).getTime()
              )
              const chargedStint = chargedStints[chargedStints.length - 1]
              if (chargedStint) target = nextStatsByStintId[chargedStint.id]
            }
            target.runs_allowed += 1
            if (run.is_earned_run !== false) target.earned_runs += 1
          })
        } else {
          // No runsScored rows (legacy savePA path): fall back to PA fields, charge active pitcher.
          const fallbackRuns = getPaScoringRuns(pa)
          if (fallbackRuns > 0) {
            next.runs_allowed += fallbackRuns
            if (pa.is_earned_run !== false) next.earned_runs += fallbackRuns
          }
        }
      }
      outsBeforePa += calculateOutsForPa(pa.result, pa.outs_on_play)
    })

    Object.values(nextStatsByStintId).forEach((entry) => {
      entry.innings_pitched = inningsPitchedFromOuts(entry._outsRecorded)
      delete entry._outsRecorded
    })

    // Always resend every stint's full stats rather than diffing against the
    // locally cached values and skipping writes that "look" unchanged: the
    // local cache gets optimistically updated below regardless of whether the
    // database write actually lands, so a single dropped/failed update would
    // make a diff check think the row is already correct and skip it forever
    // after — silently freezing that pitcher's stats in the database even
    // though the UI still shows the right numbers locally.
    await updatePitchingStintStats({
      tables: scorebookTables,
      updates: stints.map((stint) => ({
        stintId: stint.id,
        patch: nextStatsByStintId[stint.id],
      })),
    })

    setPitchingStints((current) => current.map((stint) => (
      nextStatsByStintId[stint.id]
        ? { ...stint, ...nextStatsByStintId[stint.id] }
        : stint
    )))
  }, [selectedGame, gamePitching, gameRuns, gamePitches])

  // ── Runner resolution toggles ──────────────────────────────────────────────
  const handleSetRunnerDestination = useCallback((assignmentId, destination) => {
    setPendingPA(prev => {
      if (!prev) return prev
      const duplicateBaseOwner = ['first', 'second', 'third'].includes(destination)
        ? prev.assignments.find((assignment) => assignment.id !== assignmentId && assignment.destination === destination)
        : null

      return {
        ...prev,
        assignments: prev.assignments.map((assignment) => {
          if (assignment.id === assignmentId) return { ...assignment, destination }
          if (duplicateBaseOwner && assignment.id === duplicateBaseOwner.id) return { ...assignment, destination: 'out' }
          return assignment
        }),
      }
    })
  }, [])

  const buildBatterRunner = useCallback((reachedOnError = false) => ({
    characterId: currentBatter?.character_id,
    playerId: currentBatter?.player_id,
    chargedToPitcherId: currentPitcherStint?.character_id,
    chargedToPitcherPlayerId: currentPitcherStint?.player_id,
    reachedOnError,
  }), [currentBatter, currentPitcherStint])

  // ── Merged runner plan (runner placement panel) ────────────────────────────
  // Recomputes live as the fielder chain/trajectory change (same prediction
  // logic as before), then layers any manual destination overrides on top so
  // those survive further fielder taps until the scorer changes them again.
  const runnerPlanBaseline = useMemo(() => {
    if (!inPlayState) return []
    const batterRunner = buildBatterRunner(inPlayState.resultType === 'error')
    const baseline = computeBaselineRunnerAssignments(inPlayState, runners, batterRunner)
    return buildRunnerEntriesFromAssignments(baseline, runners)
  }, [inPlayState, runners, buildBatterRunner])

  const runnerPlan = useMemo(() => {
    const overrides = inPlayState?.manualRunnerPositions || {}
    return runnerPlanBaseline.map((entry) => (overrides[entry.id] ? { ...entry, ...overrides[entry.id] } : entry))
  }, [runnerPlanBaseline, inPlayState?.manualRunnerPositions])

  const updateRunnerPlanManual = useCallback((updater) => {
    setInPlayState((current) => {
      if (!current) return current
      const nextEntries = updater(runnerPlan, runners)
      const manualRunnerPositions = {}
      nextEntries.forEach((entry) => {
        const baselineEntry = runnerPlanBaseline.find((e) => e.id === entry.id)
        if (!baselineEntry) return
        if (baselineEntry.position !== entry.position || baselineEntry.outSource !== entry.outSource || baselineEntry.preOutPosition !== entry.preOutPosition) {
          manualRunnerPositions[entry.id] = { position: entry.position, outSource: entry.outSource, preOutPosition: entry.preOutPosition, manual: true }
        }
      })
      return { ...current, manualRunnerPositions }
    })
  }, [runnerPlan, runnerPlanBaseline, runners])

  const handleRunnerSetPosition = useCallback((id, position) => (
    updateRunnerPlanManual((entries) => applyManualRunnerDestination(entries, id, position))
  ), [updateRunnerPlanManual])

  // Live preview of the base state implied by the runner-placement panel's
  // current selections, shown on the runner-placement screen so the
  // scorekeeper can see the result before hitting Confirm.
  const runnerPlacementPreview = useMemo(() => {
    if (!inPlayState || inPlayState.stage !== 'details') return null
    const preview = { first: null, second: null, third: null }
    runnerPlan.forEach((entry) => {
      if (['first', 'second', 'third'].includes(entry.position) && entry.runner?.characterId) {
        preview[entry.position] = { characterId: entry.runner.characterId }
      }
    })
    return preview
  }, [inPlayState, runnerPlan])

  // Same geometry guess finalizeInPlay uses to auto-flag a Buddy Jump as a HR
  // rob (generic field marker for whoever made the catch vs. the stadium's wall
  // distance at that angle) — recomputed live here so the HR ROB toggle below
  // can show the current best guess before the scorekeeper corrects it.
  const buddyJumpAutoRobbedHr = useMemo(() => {
    if (!inPlayState?.isBuddyJump) return false
    const fielderChain = inPlayState.fielderChain || []
    const primaryPosition = fielderChain[1] || fielderChain[0] || null
    const stadiumConfig = stadiumKey ? STADIUM_CONFIGS[stadiumKey] : null
    if (!primaryPosition || !stadiumConfig) return false
    const spot = getFielderFieldSpot(primaryPosition, stadiumConfig)
    if (!spot) return false
    const rawHitDistanceFt = estimateHitDistance(spot, stadiumConfig)
    const hitAngleDeg = estimateHitAngle(spot, stadiumConfig)
    if (rawHitDistanceFt == null || hitAngleDeg == null) return false
    const wallDistanceFt = estimateWallDistanceAtAngle(hitAngleDeg, stadiumConfig)
    if (wallDistanceFt == null) return false
    return rawHitDistanceFt >= wallDistanceFt - ROBBED_HR_WALL_MARGIN_FT
  }, [inPlayState?.isBuddyJump, inPlayState?.fielderChain, stadiumKey])

  const buddyJumpEffectiveRobbedHr = inPlayState?.robbedHrOverride ?? buddyJumpAutoRobbedHr

  const buildRunEvent = useCallback((runner, earnedOverride) => {
    if (!runner?.characterId || !runner?.playerId) return null
    return {
      playerId: runner.playerId,
      characterId: runner.characterId,
      chargedToPitcherId: runner.chargedToPitcherId,
      chargedToPitcherPlayerId: runner.chargedToPitcherPlayerId,
      isEarnedRun: earnedOverride ?? (!inningExtendedByError && !runner.reachedOnError),
    }
  }, [inningExtendedByError])

  // Shared by the confirm button (user-reviewed) and the auto-skip path
  // (bases empty, nothing to decide) so both commit identically.
  const commitPendingPA = useCallback(async (pending) => {
    if (!pending || !currentBatter || !canEditScorebook) return false
    const resolvedResult = derivePendingResult(pending)
    const outAssignments = getOutAssignments(pending)
    const inningEndsOnThisPlay = pending.outResolution && (selectionOutsInHalf + outAssignments.length >= 3)
    const wipeRunsOnPlay = shouldNullifyRunsOnInningEndingForce({
      inningEnds: inningEndsOnThisPlay,
      assignments: pending.assignments,
      runnersAtStart: runners,
    })
    const occupiedBases = pending.assignments
      .filter((assignment) => ['first', 'second', 'third'].includes(assignment.destination))
      .map((assignment) => assignment.destination)
    if (new Set(occupiedBases).size !== occupiedBases.length) {
      pushToast({ title: 'Runner conflict', message: 'Only one runner can occupy each base.', type: 'error' })
      return false
    }
    // A fielder's choice is the one batted-ball out-resolution result that can
    // legitimately record zero outs — the defense went for a runner elsewhere
    // (or would have had the batter at first) and nobody ended up retired.
    if (pending.outResolution && outAssignments.length < 1 && resolvedResult !== 'FC') {
      pushToast({ title: 'Missing out', message: 'This play needs at least one out assigned before it can be saved.', type: 'error' })
      return false
    }
    if (pending.outResolution && outAssignments.length > 3) {
      pushToast({ title: 'Too many outs', message: 'Only one, two, or three outs can be recorded on a single play.', type: 'error' })
      return false
    }
    const { result, assignments, paMeta = {}, pitchRows = paPitchRowsRef.current } = pending
    const creditedAssignments = wipeRunsOnPlay ? [] : assignments
    const runEvents = creditedAssignments
      .filter((assignment) => assignment.destination === 'home')
      .map((assignment) => buildRunEvent(assignment.runner, paMeta.isEarnedRun))
      .filter(Boolean)
    // No RBI on a fielder's choice — same rule as ROE — even when a run scores on the
    // same play, unless the batter is charged an error credit elsewhere (isError handles that).
    const finalRbi = (result === 'ROE' || resolvedResult === 'FC') ? 0 : getRbiFromAssignments(creditedAssignments)
    // Push the new base state synchronously, before awaiting the save, rather than after.
    // saveEnhancedPA updates `gamePAs` (which currentBatter/activePaNumber are derived from)
    // partway through its own work, then goes on to await several more network round-trips
    // (betting/odds resolution, score/inning sync) before this await resolves. If `runners`
    // only changed once all of that finished, there'd be a window — sometimes 1-2 seconds —
    // where the live-state-publish effect sees the NEW batter alongside the OLD runners, and
    // persists that inconsistent snapshot to season_schedule.live_state. If the tab closes or
    // loses connection in that window (e.g. a scorekeeper locking their phone right after
    // tapping Confirm), the stale snapshot is what every future session hydrates from — a
    // runner who already scored/advanced reappears on their old base. Every other save path
    // (BB/HBP/HR/SF/SH/outs) already calls saveEnhancedPA without awaiting it first, which
    // keeps pushRunners in the same synchronous tick — mirror that ordering here.
    if (!inningEndsOnThisPlay) pushRunners(extractNextRunners(pending))
    await saveEnhancedPA({
      result: resolvedResult || result,
      rbi: finalRbi,
      runScored: !wipeRunsOnPlay && didBatterScore(assignments),
      pitchRows,
      runEvents,
      // The authoritative out count for this play — covers a runner put out
      // on the bases during an otherwise-safe hit/error, which the result
      // code alone (calculateOutsForPa) can't see.
      outsOnPlay: outAssignments.length,
      runnerAssignments: runnerAssignmentsForSave({ assignments, cancelRuns: wipeRunsOnPlay }),
      ...paMeta,
      // paMeta.starHitRbi is a placeholder 0 set before runners were resolved (see the
      // NEEDS_RESOLUTION branch that builds pendingPA) — the real RBI is only known now, once
      // this play's runner assignments are final. starHitResult is only non-null when this PA
      // actually used a star hit, so that's the signal for whether to credit it here.
      starHitRbi: paMeta.starHitResult != null ? finalRbi : 0,
      isOfficialAb: pending.outResolution ? !['SF', 'SH'].includes(resolvedResult) : paMeta.isOfficialAb,
      fielderChoiceOut: pending.outResolution ? resolvedResult === 'FC' : paMeta.fielderChoiceOut,
      nextRunners: inningEndsOnThisPlay ? { first: null, second: null, third: null } : extractNextRunners(pending),
    })
    return true
  }, [canEditScorebook, currentBatter, buildRunEvent, saveEnhancedPA, pushRunners, pushToast, selectionOutsInHalf, runners])

  const confirmPendingPA = useCallback(async () => {
    if (!pendingPA) return
    const committed = await commitPendingPA(pendingPA)
    if (committed) setPendingPA(null)
  }, [pendingPA, commitPendingPA])

  // A correction tap may arrive before the two delete requests behind Undo
  // finish. Keep the first tap instead of dropping it behind the save lock;
  // it will be dispatched against the restored batter/count as soon as the
  // local undo snapshot is installed.
  const queueCorrectionDuringUndo = useCallback((action) => {
    if (!undoInFlightRef.current) return false
    if (!queuedUndoCorrectionRef.current) {
      queuedUndoCorrectionRef.current = action
      setQueuedUndoCorrection(action)
    }
    return true
  }, [])

  const appendPitchEvent = useCallback((event) => {
    if (!event) return event
    clearRedoAction()
    deferRealtimeHydration(2000)
    const enrichedEvent = {
      ...event,
      // Balls + strikes is not a pitch count once a batter fouls pitches off
      // with two strikes. The synchronous row ref is the real PA sequence.
      pitchNumberPa: paPitchRowsRef.current.length + 1,
      pitcherCharacterId: currentPitcherStint?.character_id || null,
      pitcherPlayerId: currentPitcherStint?.player_id || null,
      pitcherId: currentPitcherChar?.name || '',
      pitcherPlayer: playersById[currentPitcherStint?.player_id]?.name || '',
    }
    paPitchRowsRef.current = [...paPitchRowsRef.current, enrichedEvent]
    setPaPitchRows(paPitchRowsRef.current)
    setStarPitchActive(false)
    return enrichedEvent
  }, [clearRedoAction, currentPitcherChar?.name, currentPitcherStint?.character_id, currentPitcherStint?.player_id, playersById, deferRealtimeHydration])

  // star_pitch_used marks whether the star pitch was the DECISIVE pitch of the at-bat
  // (the one that ended it — walk/K/HBP/in-play). A star pitch fouled off or taken for
  // a ball/strike earlier in the count still counts toward that pitch's own is_star_pitch
  // flag (and the used/ball/strike tallies in summarizeStarPitching, which read straight
  // off the pitch log), but doesn't count toward "vs Star Pitch" outcome stats (AVG, HR,
  // success rate) unless it's actually what the batter put in play or struck out on.

  const handlePitchBall = useCallback(() => {
    if (queueCorrectionDuringUndo({ type: 'ball' })) return
    if (!canEditScorebook || pitchActionPendingRef.current || isSavingRef.current) return
    if (starHitUsed) return
    pitchActionPendingRef.current = true
    const pitchEvent = appendPitchEvent(recordBall(starPitchActive))
    if (!pitchEvent) {
      pitchActionPendingRef.current = false
      return
    }
    if (!pitchEvent.completedPa) {
      pitchActionPendingRef.current = false
      syncLiveOddsForCount(pitchEvent.pitch.count_balls_after, pitchEvent.pitch.count_strikes_after)
      return
    }
    lockPitchActions()

    const batterRunner = buildBatterRunner(false)
    const pending = computePendingState('BB', runners, batterRunner)
    const runEvents = getHomeAssignments(pending)
      .map((assignment) => buildRunEvent(assignment.runner))
      .filter(Boolean)
    saveEnhancedPA({
      result: 'BB',
      rbi: getRbiFromAssignments(pending.assignments),
      runScored: didBatterScore(pending.assignments),
      pitchRows: paPitchRowsRef.current,
      isOfficialAb: false,
      starPitchUsed: starPitchActive,
      runEvents,
      nextRunners: extractNextRunners(pending),
    })
    pushRunners(extractNextRunners(pending))
  }, [canEditScorebook, recordBall, starPitchActive, appendPitchEvent, buildBatterRunner, runners, saveEnhancedPA, pushRunners, starHitUsed, buildRunEvent, syncLiveOddsForCount, lockPitchActions, queueCorrectionDuringUndo])

  const handlePitchFoul = useCallback(() => {
    if (queueCorrectionDuringUndo({ type: 'foul' })) return
    if (!canEditScorebook || pitchActionPendingRef.current || isSavingRef.current) return
    pitchActionPendingRef.current = true
    const usedStarHitOnPitch = starHitUsed
    const pitchEvent = appendPitchEvent(recordFoul(starPitchActive))
    pitchActionPendingRef.current = false
    if (!pitchEvent) return
    if (usedStarHitOnPitch) {
      setStarHitPending(true)
      setStarHitConnected(true)
      setStarHitUsed(false)
    }
    syncLiveOddsForCount(pitchEvent.pitch.count_balls_after, pitchEvent.pitch.count_strikes_after)
  }, [canEditScorebook, recordFoul, starPitchActive, appendPitchEvent, starHitUsed, syncLiveOddsForCount, queueCorrectionDuringUndo])

  const handlePitchHbp = useCallback(() => {
    if (queueCorrectionDuringUndo({ type: 'hbp' })) return
    if (!canEditScorebook || pitchActionPendingRef.current || isSavingRef.current) return
    if (starHitUsed) return
    pitchActionPendingRef.current = true
    const pitchEvent = appendPitchEvent(recordHbp(starPitchActive))
    if (!pitchEvent) {
      pitchActionPendingRef.current = false
      return
    }
    lockPitchActions()
    const batterRunner = buildBatterRunner(false)
    const pending = computePendingState('HBP', runners, batterRunner)
    const runEvents = getHomeAssignments(pending)
      .map((assignment) => buildRunEvent(assignment.runner))
      .filter(Boolean)
    saveEnhancedPA({
      result: 'HBP',
      rbi: getRbiFromAssignments(pending.assignments),
      runScored: didBatterScore(pending.assignments),
      pitchRows: paPitchRowsRef.current,
      isOfficialAb: false,
      starPitchUsed: starPitchActive,
      runEvents,
      nextRunners: extractNextRunners(pending),
    })
    pushRunners(extractNextRunners(pending))
  }, [canEditScorebook, recordHbp, starPitchActive, appendPitchEvent, buildBatterRunner, runners, saveEnhancedPA, pushRunners, starHitUsed, buildRunEvent, lockPitchActions, queueCorrectionDuringUndo])

  const handleStrikeChoice = useCallback((type) => {
    if (queueCorrectionDuringUndo({ type: 'strike', strikeType: type })) return
    if (!canEditScorebook || pitchActionPendingRef.current || isSavingRef.current) return
    pitchActionPendingRef.current = true
    const usedStarHitOnPitch = starHitUsed
    const pitchEvent = appendPitchEvent(recordStrike(type, starPitchActive))
    if (!pitchEvent) {
      pitchActionPendingRef.current = false
      return
    }
    if (usedStarHitOnPitch) {
      setStarHitPending(true)
      setStarHitUsed(false)
    }
    setPitchActionSheet(null)
    if (!pitchEvent.completedPa) {
      pitchActionPendingRef.current = false
      syncLiveOddsForCount(pitchEvent.pitch.count_balls_after, pitchEvent.pitch.count_strikes_after)
      return
    }
    lockPitchActions()
    saveEnhancedPA({
      result: 'K',
      strikeoutType: pitchEvent.completedPa.strikeoutType,
      pitchRows: paPitchRowsRef.current,
      starPitchUsed: starPitchActive,
      starHitResult: usedStarHitOnPitch || starHitPending ? 'Out' : null,
    })
    // A strikeout doesn't move any runners, but undo (reopenLastCompletedPA/undoLastPA)
    // pops exactly one runnersHistory entry per completed PA — without this push here,
    // that pop would land on the snapshot from an earlier PA instead, silently dropping
    // whichever runner reached base since then.
    pushRunners({ ...runners })
  }, [canEditScorebook, recordStrike, starPitchActive, appendPitchEvent, saveEnhancedPA, starHitPending, starHitUsed, syncLiveOddsForCount, lockPitchActions, pushRunners, runners, queueCorrectionDuringUndo])

  const handlePitchInPlay = useCallback(() => {
    if (queueCorrectionDuringUndo({ type: 'in_play' })) return
    if (!canEditScorebook || pitchActionPendingRef.current || isSavingRef.current) return
    // "In play" ends the pitch immediately, but the scorer may still back out of
    // the provisional result picker. Keep a pre-pitch snapshot so backing out
    // restores count + pitch history instead of leaking phantom pitches.
    // pitchActionPendingRef stays true until finalizeInPlay saves or cancelInPlaySelection rolls back.
    pitchActionPendingRef.current = true
    const rollbackSnapshot = buildActivePaSnapshot()
    const usedStarHitOnPitch = starHitUsed
    const pitchEvent = appendPitchEvent(recordInPlay(starPitchActive))
    if (!pitchEvent) {
      pitchActionPendingRef.current = false
      return
    }
    if (usedStarHitOnPitch) {
      setStarHitPending(true)
      setStarHitConnected(true)
      setStarHitUsed(false)
    }
    setPendingPitchEvent(pitchEvent)
    setInPlayState({
      stage: 'result',
      pitchEvent,
      pitchRows: paPitchRowsRef.current,
      usedStarHit: usedStarHitOnPitch || starHitPending,
      resultType: null,
      result: null,
      trajectory: null,
      fielderChain: [],
      rollbackSnapshot,
    })
  }, [canEditScorebook, buildActivePaSnapshot, recordInPlay, starPitchActive, appendPitchEvent, starHitPending, starHitUsed, queueCorrectionDuringUndo])

  const finalizeInPlay = useCallback(async (state) => {
    if (!canEditScorebook || !canFinalizeInPlaySelection(state, activeDefensiveFielders, charactersHaveGoodChemistry)) return
    // Freeze the build-the-play/runner-placement UI the instant a save starts.
    // commitPendingPA below pushes the new base state synchronously, ahead of
    // its awaited saveEnhancedPA call — if the details screen were still live
    // at that point, runnerPlan would recompute against the *new* runners
    // (which already has the batter on base) while inPlayState/state still
    // describe the play that just put them there, so the batter would
    // briefly render twice: once as themselves, once as the "runner" they
    // just became. Leaving the 'details' stage suppresses that render until
    // inPlayState is cleared for good below.
    setInPlayState((current) => (current ? { ...current, stage: 'submitting' } : current))
    const usedStarHit = Boolean(state.usedStarHit || starHitPending || starHitUsed)
    const fielderChain = state.fielderChain || []
    // A Buddy Jump's chain is [assist, putout] — the second fielder tapped is
    // the one who actually made the catch, reversing the usual "last fielder
    // in the chain = putout" convention used for grounders/relays elsewhere.
    const primaryPosition = state.result === 'HR'
      ? null
      : (state.isBuddyJump ? (fielderChain[1] || fielderChain[0] || null) : (fielderChain[0] || null))
    const notation = state.result === 'HR'
      ? ''
      : (primaryPosition ? assembleNotation(state.trajectory, fielderChain) : '')
    const batterRunner = buildBatterRunner(state.resultType === 'error')
    const stadiumConfig = stadiumKey ? STADIUM_CONFIGS[stadiumKey] : null
    // The scorekeeper only marks who touched the ball live — the fielder's
    // position on the field diagram stands in as the effective landing spot.
    // Precise location (and home run direction/distance) is added later in
    // At-Bat Data Entry.
    const effectiveLandingSpot = primaryPosition ? getFielderFieldSpot(primaryPosition, stadiumConfig) : null
    const rawHitDistanceFt = effectiveLandingSpot ? estimateHitDistance(effectiveLandingSpot, stadiumConfig) : null
    const hitAngleDeg = effectiveLandingSpot ? estimateHitAngle(effectiveLandingSpot, stadiumConfig) : null
    const direction = resolveBattedBallDirection(primaryPosition, hitAngleDeg, currentBatterHandedness)
    // A Buddy Jump catch near the fence is a candidate home run robbery — the
    // tapped catch point understates true distance since the ball was caught
    // before it could keep carrying, so exit velocity would read low if we
    // stored the raw catch-point distance for these plays.
    const wallDistanceFt = state.isBuddyJump && hitAngleDeg != null && stadiumConfig
      ? estimateWallDistanceAtAngle(hitAngleDeg, stadiumConfig)
      : null
    const geometryRobbedHr = Boolean(
      state.isBuddyJump && wallDistanceFt != null && rawHitDistanceFt != null
      && rawHitDistanceFt >= wallDistanceFt - ROBBED_HR_WALL_MARGIN_FT,
    )
    // The geometry estimate is only a guess based on the fielder's generic field
    // marker, not the actual catch point — the HR ROB toggle on the details screen
    // lets the scorekeeper confirm or correct it before saving.
    const isRobbedHr = state.isBuddyJump ? (state.robbedHrOverride ?? geometryRobbedHr) : false
    const hitDistanceFt = isRobbedHr ? wallDistanceFt + ROBBED_HR_CARRY_FT : rawHitDistanceFt
    const buddyJumpFields = state.isBuddyJump ? {
      isBuddyJump: true,
      buddyJumpAssistPosition: fielderChain[0] || null,
      buddyJumpPutoutPosition: fielderChain[1] || null,
      isRobbedHr,
    } : {}

    if (isHomeRunResult(state.result)) {
      const runnersToScore = [runners.first, runners.second, runners.third, batterRunner].filter(Boolean)
      await saveEnhancedPA({
        result: state.result,
        rbi: runnersToScore.length,
        runScored: true,
        trajectory: state.trajectory,
        hitLocation: primaryPosition,
        hitNotation: notation,
        direction,
        landingSpot: effectiveLandingSpot,
        hitDistanceFt,
        hitAngleDeg,
        pitchRows: state.pitchRows,
        // Each runner's own reachedOnError flag (set when they originally reached base)
        // decides earned status here — a runner who reached on an earlier error is still
        // unearned when a teammate's clean home run brings them home.
        runEvents: runnersToScore.map((runner) => buildRunEvent(runner)).filter(Boolean),
        starPitchUsed: state.pitchEvent?.pitch?.is_star_pitch,
        starHitResult: usedStarHit ? state.result : null,
        starHitRbi: usedStarHit ? runnersToScore.length : 0,
        nextRunners: { first: null, second: null, third: null },
      })
      pushRunners({ first: null, second: null, third: null })
      return
    }

    // Runner placement for every non-HR in-play result is decided on the
    // merged build-the-play + runner-placement screen (runnerPlan, defaulted
    // to the auto-detected placement and optionally overridden by the scorer) —
    // finalizeInPlay just converts that plan into assignments and commits.
    const planAssignments = runnerPlan.map((entry) => ({
      ...buildPendingAssignment(entry.id, entry.runner, entry.origin, entry.position, entry.id === 'batter'),
      ...(entry.position === 'out' && entry.preOutPosition ? { attemptedBase: entry.preOutPosition } : {}),
    }))

    // Every fielder charged with an error on this play, regardless of result
    // type — a clean hit/out that a fielder then booted still scores as that
    // hit/out (1B, GO, whatever), the ERROR toggle just layers error credit
    // onto whoever was tapped while it was on. A ROE with nothing explicitly
    // marked still defaults to the first fielder in the chain (see
    // effectiveErrorPositions), since ROE is an error by definition. is_error
    // is independent of `result` throughout the stats pipeline, so this
    // credits each fielder's error and zeroes RBI/earned-run status for the
    // play without misclassifying it as a different result.
    const errorPositions = effectiveErrorPositions(state)
    const primaryErrorPosition = errorPositions[0] || null
    const primaryErrorFielder = primaryErrorPosition ? activeDefensiveFielders[primaryErrorPosition] : null
    const errorFields = errorPositions.length ? {
      isError: true,
      errorPosition: primaryErrorPosition,
      errorCharacter: primaryErrorFielder?.character || null,
      errorPlayer: primaryErrorFielder?.player_name || null,
      isEarnedRun: false,
    } : {}
    const isNicePlay = Boolean(state.nicePlay && fielderChain[0])

    if (state.resultType === 'hit' && NEEDS_RESOLUTION.has(state.result)) {
      // Imply the putout fielder for any runner thrown out advancing on this hit — see
      // BASE_COVERING_POSITION. Appending it after fielderChain makes it the notation's
      // last (putout) fielder, downgrading whoever actually touched the ball to an assist.
      const runnerOutCoveringPositions = runnerPlan
        .filter((entry) => entry.id !== 'batter' && entry.position === 'out')
        .map((entry) => BASE_COVERING_POSITION[entry.preOutPosition])
        .filter(Boolean)
      const hitFielderChain = [...fielderChain, ...runnerOutCoveringPositions]
      const hitNotation = errorPositions.length
        ? assembleErrorNotation(state.trajectory, hitFielderChain, errorPositions)
        : assembleNotation(state.trajectory, hitFielderChain)
      const pending = {
        result: state.result,
        assignments: planAssignments,
        pitchRows: state.pitchRows,
        rollbackSnapshot: state.rollbackSnapshot || null,
        paMeta: {
          trajectory: state.trajectory,
          hitLocation: primaryPosition,
          hitNotation,
          direction,
          landingSpot: effectiveLandingSpot,
          hitDistanceFt,
          hitAngleDeg,
          starPitchUsed: state.pitchEvent?.pitch?.is_star_pitch,
          starHitResult: usedStarHit ? state.result : null,
          starHitRbi: usedStarHit ? 0 : 0,
          isNicePlay,
          ...errorFields,
        },
      }
      const committed = await commitPendingPA(pending)
      if (committed) {
        setInPlayState(null)
      } else {
        // commitPendingPA rejects (runner conflict / missing or too many outs)
        // via a toast + early return, without ever reaching saveEnhancedPA — so
        // nothing else unlocks the pitch actions or the 'submitting' stage this
        // function set above. Left as-is, the details/confirm panel never comes
        // back (nothing renders for 'submitting') and every other pitch button
        // stays disabled until a full page refresh. Send the scorer back to the
        // details screen so they can fix the assignment and retry.
        setInPlayState((current) => (current ? { ...current, stage: 'details' } : current))
      }
      return
    }

    if (state.resultType === 'error') {
      const pending = {
        result: 'ROE',
        assignments: planAssignments,
        pitchRows: state.pitchRows,
        rollbackSnapshot: state.rollbackSnapshot || null,
        paMeta: {
          trajectory: state.trajectory,
          hitLocation: primaryPosition,
          hitNotation: notation,
          direction,
          landingSpot: effectiveLandingSpot,
          hitDistanceFt,
          hitAngleDeg,
          errorNotation: assembleErrorNotation(state.trajectory, fielderChain, errorPositions),
          starPitchUsed: state.pitchEvent?.pitch?.is_star_pitch,
          starHitResult: usedStarHit ? 'Error' : null,
          isNicePlay,
          ...errorFields,
        },
      }
      const committed = await commitPendingPA(pending)
      if (committed) {
        setInPlayState(null)
      } else {
        // commitPendingPA rejects (runner conflict / missing or too many outs)
        // via a toast + early return, without ever reaching saveEnhancedPA — so
        // nothing else unlocks the pitch actions or the 'submitting' stage this
        // function set above. Left as-is, the details/confirm panel never comes
        // back (nothing renders for 'submitting') and every other pitch button
        // stays disabled until a full page refresh. Send the scorer back to the
        // details screen so they can fix the assignment and retry.
        setInPlayState((current) => (current ? { ...current, stage: 'details' } : current))
      }
      return
    }

    // Covers every remaining in-play result (GO/FO/LO/SF/SH), including any
    // caught-ball result with the Buddy Jump modifier turned on. Because Buddy
    // Jump is metadata instead of its own result, an SF stays an SF when the
    // runner from third scores. Bases-empty plays still have only the batter
    // marked out, and an out can also carry an error charge via the same
    // ERROR-toggle fields as the hit/ROE branches above.
    const pending = {
      result: state.result,
      assignments: planAssignments,
      outResolution: true,
      originalResult: state.result,
      pitchRows: state.pitchRows,
      rollbackSnapshot: state.rollbackSnapshot || null,
      paMeta: {
        trajectory: state.trajectory,
        hitLocation: primaryPosition,
        hitNotation: errorPositions.length ? assembleErrorNotation(state.trajectory, fielderChain, errorPositions) : notation,
        direction,
        landingSpot: effectiveLandingSpot,
        hitDistanceFt,
        hitAngleDeg,
        starPitchUsed: state.pitchEvent?.pitch?.is_star_pitch,
        starHitResult: usedStarHit ? 'Out' : null,
        isNicePlay,
        ...errorFields,
        ...buddyJumpFields,
      },
    }
    const committed = await commitPendingPA(pending)
    if (committed) {
      setInPlayState(null)
    } else {
      // See the NEEDS_RESOLUTION/error branches above — commitPendingPA can
      // reject this (e.g. an out-count mismatch on a multi-runner assignment)
      // without ever unlocking pitch actions or leaving the 'submitting' stage
      // this function set earlier, which would otherwise freeze the scorebook.
      setInPlayState((current) => (current ? { ...current, stage: 'details' } : current))
    }
  }, [canEditScorebook, buildBatterRunner, runners, runnerPlan, saveEnhancedPA, pushRunners, activeDefensiveFielders, buildRunEvent, starHitPending, starHitUsed, commitPendingPA, currentBatterHandedness, stadiumKey])

  // ── Next half-inning ───────────────────────────────────────────────────────
  const handleNextHalfInning = useCallback(async () => {
    if (!canEditScorebook || !selectedGame) return
    const newHalfIdx = Math.floor(outsRecorded / 3)
    if (selectedGame && newHalfIdx >= 2 && scores.a + scores.b === 0) {
      try {
        await resolveFirstInningNoRun(selectedGame.id, betResolutionConfig)
      } catch (error) {
        pushToast({ title: 'First inning resolution failed', message: error.message, type: 'error' })
      }
    }
    if (newHalfIdx > 0) {
      const justFinishedTop = newHalfIdx % 2 === 1
      const justFinishedInning = justFinishedTop ? Math.ceil(newHalfIdx / 2) : (newHalfIdx / 2)
      const end = checkGameEnd({
        inning: justFinishedInning,
        isTop: justFinishedTop,
        halfCompleted: true,
        currentScores: scores,
        previousScores: scores,
      })
      if (end) {
        setGameEndBanner(end)
        setShowOutsBanner(false)
        setOverrideBatterIdx(null)
        resetRunners(true)
        return
      }
    }
    setShowOutsBanner(false)
    setOverrideBatterIdx(null)
    setPendingPA(null)
    setSelectedPitcher(null)
    resetRunners(true)
  }, [canEditScorebook, outsRecorded, selectedGame, scores, checkGameEnd, pushToast, resetRunners])

  // Auto-advance to the next half-inning instead of showing a "3 outs" confirmation.
  useEffect(() => {
    if (showOutsBanner && !gameEndBanner) {
      handleNextHalfInning()
    }
  }, [showOutsBanner, gameEndBanner, handleNextHalfInning])

  // ── Undo last PA ───────────────────────────────────────────────────────────

  async function saveEnhancedPA({
    result,
    rbi = 0,
    runScored = false,
    trajectory = null,
    hitLocation = null,
    hitNotation = null,
    direction = null,
    landingSpot = null,
    hitDistanceFt = null,
    hitAngleDeg = null,
    starHitResult = null,
    starHitRbi = 0,
    starPitchUsed = false,
    isError = false,
    errorPosition = null,
    errorCharacter = null,
    errorPlayer = null,
    errorNotation = null,
    isEarnedRun = true,
    isNicePlay = false,
    strikeoutType = null,
    isOfficialAb = true,
    fielderChoiceOut = false,
    isBuddyJump = false,
    buddyJumpAssistPosition = null,
    buddyJumpPutoutPosition = null,
    isRobbedHr = false,
    pitchRows = [],
    runEvents = [],
    nextRunners = runners,
    outsOnPlay = null,
    runnerAssignments = null,
  }) {
    if (!selectedGame || !offense || !currentBatter || !currentPitcherStint || isGameComplete) {
      return { halfCompleted: false, end: null }
    }
    if (isSavingRef.current) return { halfCompleted: false, end: null }
    isSavingRef.current = true
    // Capture outs-before-this-PA synchronously, before any awaits below run.
    // Otherwise React can flush the `outsRef.current = outsRecorded` effect
    // (triggered by setPlateAppearances further down) while we're awaiting,
    // making outsRef already reflect this PA's outs by the time we read it —
    // which makes halfCompleted always false and the half/game-end checks
    // never fire.
    const outsBeforePa = outsRef.current
    setIsSaving(true)
    lockPitchActions()
    // Realtime callbacks fire as soon as the insert lands, before the explicit
    // post-save refetch below has necessarily observed every new row. Keep a
    // lagging callback from replacing the complete local game log with a shorter
    // snapshot while this save is in flight.
    deferRealtimeHydration(120000)
    if (saveWatchdogRef.current) clearTimeout(saveWatchdogRef.current)
    // Diagnostic timing: the save chain is a long sequence of Supabase round
    // trips, and we've seen it occasionally blow past the watchdog with no
    // reproducible trigger. Rather than guess again, log how long each step
    // actually took so the *next* occurrence tells us exactly which step
    // stalled instead of leaving us speculating blind.
    let saveStepLabel = 'begin'
    const saveStartedAt = performance.now()
    let saveStepStartedAt = saveStartedAt
    const saveStepLog = []
    const markSaveStep = (nextLabel) => {
      const now = performance.now()
      saveStepLog.push(`${saveStepLabel}: ${Math.round(now - saveStepStartedAt)}ms`)
      saveStepLabel = nextLabel
      saveStepStartedAt = now
    }
    saveWatchdogRef.current = setTimeout(() => {
      if (!isSavingRef.current) return
      console.warn(
        `[savePA] slow-save watchdog — still on step "${saveStepLabel}" (running ${Math.round(performance.now() - saveStepStartedAt)}ms). Completed steps:`,
        saveStepLog,
      )
      pushToast({
        title: 'Scorebook is still saving',
        message: `The save is taking longer than usual (current step: ${saveStepLabel}). Controls will stay locked until it finishes so the play cannot be recorded twice.`,
        type: 'info',
      })
    }, 15000)

    try {
    const normalizedRunScored = normalizeSavedPaRunScored(result, runScored, runEvents, currentBatter)
    const normalizedOfficialAb = isOfficialAtBat({ result })
    const existingPitchRows = editingPa
      ? gamePitches
        .filter((pitch) => String(pitch.pa_id) === String(editingPa.id))
        .map(stripDbManagedFields)
      : []
    const existingRunRows = editingPa
      ? gameRuns
        .filter((run) => String(run.pa_id) === String(editingPa.id))
        .map(stripDbManagedFields)
      : []
    const paPayload = {
      game_id: selectedGame.id,
      player_id: currentBatter.player_id,
      character_id: currentBatter.character_id,
      batting_team_id: editingPa?.batting_team_id ?? (
        isSeasonGame
          ? (gameSession.teamIdByPlayerId?.[currentBatter.player_id] ?? null)
          : currentBatter.player_id
      ),
      defensive_team_id: editingPa?.defensive_team_id ?? (
        isSeasonGame
          ? (gameSession.teamIdByPlayerId?.[offense.pitchingPlayerId] ?? null)
          : offense.pitchingPlayerId
      ),
      pitcher_id: editingPa?.pitcher_id ?? currentPitcherStint.character_id,
      pitcher_player_id: editingPa?.pitcher_player_id ?? currentPitcherStint.player_id,
      runner_on_first_before: editingPa?.runner_on_first_before ?? Boolean(runners.first),
      runner_on_second_before: editingPa?.runner_on_second_before ?? Boolean(runners.second),
      runner_on_third_before: editingPa?.runner_on_third_before ?? Boolean(runners.third),
      inning: editingPa?.inning ?? offense.inning,
      pa_number: editingPa?.pa_number ?? nextPaNumber(gamePAs),
      result,
      outs_on_play: calculateOutsForPa(result, outsOnPlay),
      runner_assignments: runnerAssignmentsForSave({
        assignments: runnerAssignments,
        result,
        runners,
        batter: buildBatterRunner(isError),
      }),
      rbi: normalizeRbiForPaResult(result, rbi, isError),
      run_scored: normalizedRunScored,
      trajectory,
      hit_location: hitLocation,
      hit_notation: hitNotation,
      direction,
      hit_x: landingSpot?.x ?? null,
      hit_y: landingSpot?.y ?? null,
      hit_distance_ft: hitDistanceFt,
      hit_angle_deg: hitAngleDeg,
      hit_stadium_key: landingSpot ? stadiumKey : null,
      // Re-scoring an existing PA can change its distance (new location tap);
      // if it already had a hang time on file, its exit velocity/launch angle
      // were derived from the *old* distance and need to be recomputed here too
      // — otherwise they're left stale, same class of bug handleSavePlayLocation
      // guards against for the location-viewer's own edit path.
      ...(editingPa?.hang_time_sec != null ? (() => {
        const config = landingSpot && stadiumKey ? STADIUM_CONFIGS[stadiumKey] : null
        const distanceFt = exitVelocityDistanceFt({
          isRobbedHr: editingPa.is_robbed_hr,
          hitDistanceFt,
          hitAngleDeg,
        }, config)
        const recomputed = distanceFt != null ? estimateExitVelocity(distanceFt, Number(editingPa.hang_time_sec)) : null
        return { exit_velocity_mph: recomputed?.exitVelocityMph ?? null, launch_angle_deg: recomputed?.launchAngleDeg ?? null }
      })() : {}),
      star_hit_used: Boolean(starHitPending || starHitUsed),
      // starHitConnected only gets flipped true by the pitch-by-pitch FOUL/IN-PLAY handlers —
      // outcome-button shortcuts (e.g. clicking HR directly) and pendingPA resolution bypass those,
      // so they'd otherwise save a hit/contact-out with star_hit_connected still false. A batted-ball
      // result (any hit, or a contact out) is proof of contact on its own regardless of which path
      // recorded it, so let that override the flag rather than trust it as the sole source of truth.
      star_hit_connected: Boolean(starHitConnected) || ((starHitPending || starHitUsed) && battedBallResults.has(result)),
      star_hit_result: starHitResult,
      star_hit_rbi: Number(starHitRbi || 0),
      star_pitch_used: Boolean(starPitchUsed),
      star_pitch_successful: Boolean(starPitchUsed && calculateOutsForPa(result, outsOnPlay) > 0),
      is_error: Boolean(isError),
      error_position: errorPosition,
      error_character: errorCharacter,
      error_player: errorPlayer,
      error_notation: errorNotation,
      is_earned_run: Boolean(isEarnedRun),
      is_nice_play: Boolean(isNicePlay),
      strikeout_type: strikeoutType,
      is_official_ab: normalizedOfficialAb,
      fielder_choice_out: Boolean(fielderChoiceOut),
      is_buddy_jump: Boolean(isBuddyJump),
      buddy_jump_assist_position: buddyJumpAssistPosition,
      buddy_jump_putout_position: buddyJumpPutoutPosition,
      is_robbed_hr: Boolean(isRobbedHr),
    }

    markSaveStep('insert-pa')
    const { data: savedPa, error } = await savePlateAppearanceRecord({
      tables: scorebookTables,
      payload: addSourceFields(paPayload),
      plateAppearanceId: editingPa ? editingPa.id : null,
    })
    if (error) {
      if (error.code === '23505') {
        pushToast({
          title: 'Play already saved',
          message: 'Another scorekeeper saved this plate appearance first. The scorebook will refresh to the authoritative game state.',
          type: 'info',
        })
        await fetchGameData()
        return { halfCompleted: false, end: null }
      }
      if (
        error.message?.includes('trajectory')
        || error.message?.includes('hit_location')
        || error.message?.includes('star_hit_used')
        || error.message?.includes('pitcher_id')
        || error.message?.includes('is_official_ab')
        || error.message?.includes('hit_distance_ft')
        || error.message?.includes('hit_angle_deg')
        || error.message?.includes('hit_stadium_key')
        || error.message?.includes('hit_x')
        || error.message?.includes('hit_y')
        || error.message?.includes('runner_on_first_before')
        || error.message?.includes('runner_on_second_before')
        || error.message?.includes('runner_on_third_before')
        || error.message?.includes('is_buddy_jump')
        || error.message?.includes('buddy_jump_assist_position')
        || error.message?.includes('buddy_jump_putout_position')
        || error.message?.includes('is_robbed_hr')
      ) {
        pushToast({
          title: 'Missing scorebook migration',
          message: 'Your Supabase schema is behind. Apply the scorebook overhaul migration, then save again.',
          type: 'error',
        })
        return { halfCompleted: false, end: null }
      }
      pushToast({ title: 'Save failed', message: error.message, type: 'error' })
      return { halfCompleted: false, end: null }
    }
    clearRedoAction()

    let pitchPayload = buildPitchRowsForSave({
      pitchRows,
      gameId: selectedGame.id,
      paId: savedPa.id,
      currentPitcherName: currentPitcherChar?.name || '',
      currentPitcherStint,
      playersById,
      batterName: charactersById[currentBatter.character_id]?.name || '',
      inning: editingPa?.inning ?? offense.inning,
      isTop: offense.isTop,
      pitchNumber,
    })
    let committedPitchNumber = Number(pitchNumber || 0)
    if (!editingPa && pitchPayload.length) {
      // `usePitchCount` keeps the UI responsive, but realtime/live-state
      // hydration can race the next rapid PA and briefly rewind its local
      // pitcher total. Number persisted pitches from the database's committed
      // rows so tournament and season logs stay contiguous and authoritative.
      markSaveStep('fetch-pitch-sequence')
      const { data: committedPitchRows, error: pitchSequenceError } = await fetchCommittedPitchSequence({
        tables: scorebookTables,
        gameId: selectedGame.id,
      })
      if (pitchSequenceError) {
        console.warn('[savePA] authoritative pitch sequence read failed; retaining local numbering', pitchSequenceError)
      } else {
        const authoritativeSequence = assignAuthoritativePitchNumbers(pitchPayload, committedPitchRows || [])
        pitchPayload = authoritativeSequence.rows
        const { latestByPitcher } = authoritativeSequence
        committedPitchNumber = Number(latestByPitcher[String(currentPitcherChar?.name || '')] || committedPitchNumber)
      }
    }
    const runPayload = buildRunRowsForSave({
      runEvents,
      gameId: selectedGame.id,
      paId: savedPa.id,
      inning: editingPa?.inning ?? offense.inning,
      isTop: offense.isTop,
      currentPitcherStint,
    })
    const restoreSavedPaState = async () => {
      if (editingPa) {
        await restorePlateAppearanceBundle({
          tables: scorebookTables,
          plateAppearanceId: savedPa.id,
          plateAppearancePayload: addSourceFields(stripDbManagedFields(editingPa)),
          pitchRows: existingPitchRows.map(addSourceFields),
          runRows: existingRunRows.map(addSourceFields),
        })
        return
      }

      await deletePlateAppearanceBundle({ tables: scorebookTables, plateAppearanceId: savedPa.id })
    }

    if (editingPa) {
      markSaveStep('delete-pitch-run')
      const [{ error: deletePitchError }, { error: deleteRunError }] = await deletePlateAppearanceChildren({
        tables: scorebookTables,
        plateAppearanceId: savedPa.id,
      })
      if (deletePitchError || deleteRunError) {
        try {
          await restoreSavedPaState()
        } catch (restoreError) {
          pushToast({ title: 'Scorebook restore failed', message: restoreError.message, type: 'error' })
        }
        pushToast({
          title: 'Edit sync failed',
          message: deletePitchError?.message || deleteRunError?.message || 'Could not replace the saved pitch/run rows for this PA.',
          type: 'error',
        })
        return { halfCompleted: false, end: null }
      }
    }

    if (pitchPayload.length) {
      markSaveStep('insert-pitches')
      const { error: pitchInsertError } = await insertPlateAppearancePitches({
        tables: scorebookTables,
        rows: pitchPayload.map(addSourceFields),
      })
      if (pitchInsertError) {
        try {
          await restoreSavedPaState()
        } catch (restoreError) {
          pushToast({ title: 'Scorebook restore failed', message: restoreError.message, type: 'error' })
        }
        pushToast({
          title: 'Pitch save failed',
          message: pitchInsertError.message,
          type: 'error',
        })
        return { halfCompleted: false, end: null }
      }
    }

    if (runPayload.length) {
      markSaveStep('insert-runs')
      const { error: runsInsertError } = await insertPlateAppearanceRuns({
        tables: scorebookTables,
        rows: runPayload.map(addSourceFields),
      })
      if (runsInsertError) {
        try {
          await restoreSavedPaState()
        } catch (restoreError) {
          pushToast({ title: 'Scorebook restore failed', message: restoreError.message, type: 'error' })
        }
        pushToast({
          title: 'Run save failed',
          message: runsInsertError.message,
          type: 'error',
        })
        return { halfCompleted: false, end: null }
      }
    }

    try {
      await syncPlateAppearanceRunnerOpportunities({
        tables: scorebookTables,
        pa: savedPa,
        outsBefore: selectionOutsInHalf,
      })
    } catch (error) {
      pushToast({ title: 'Play saved; baserunning stats need a refresh', message: error.message, type: 'error' })
    }

    markSaveStep('fetch-fresh-rows')
    const [paRefresh, pitchRefresh, runRefresh] = await refreshPlateAppearanceBundle({
      tables: scorebookTables,
      gameId: selectedGame.id,
    })

    // The PA/pitch inserts above are already committed. If this follow-up read
    // fails (or briefly returns a lagging, shorter snapshot), treating `null` as
    // `[]` erases the local game history and resets the next pitch to 1. Build a
    // complete optimistic snapshot from the rows we just committed and only
    // replace it when the refresh proves it contains at least that much data.
    const normalizedSavedPa = normalizePa(savedPa)
    const optimisticPAs = editingPa
      ? gamePAs.map((pa) => (String(pa.id) === String(savedPa.id) ? normalizedSavedPa : pa))
      : [...gamePAs, normalizedSavedPa]
    const optimisticPitches = [
      ...gamePitches.filter((pitch) => String(pitch.pa_id) !== String(savedPa.id)),
      ...pitchPayload.map(addSourceFields),
    ]
    const optimisticRuns = [
      ...gameRuns.filter((run) => String(run.pa_id) !== String(savedPa.id)),
      ...runPayload.map(addSourceFields),
    ]

    const refreshedPAs = (paRefresh.data || []).map(normalizePa)
    const refreshedPitches = pitchRefresh.data || []
    const refreshedRuns = runRefresh.data || []
    const paRefreshComplete = !paRefresh.error
      && refreshedPAs.length >= optimisticPAs.length
      && refreshedPAs.some((pa) => String(pa.id) === String(savedPa.id))
    const pitchRefreshComplete = !pitchRefresh.error
      && refreshedPitches.length >= optimisticPitches.length
      && (
        pitchPayload.length === 0
        || refreshedPitches.filter((pitch) => String(pitch.pa_id) === String(savedPa.id)).length >= pitchPayload.length
      )
    const runRefreshComplete = !runRefresh.error
      && refreshedRuns.length >= optimisticRuns.length
      && (
        runPayload.length === 0
        || refreshedRuns.filter((run) => String(run.pa_id) === String(savedPa.id)).length >= runPayload.length
      )

    const allPAs = paRefreshComplete
      ? refreshedPAs.map((pa) => (String(pa.id) === String(savedPa.id) ? normalizedSavedPa : pa))
      : optimisticPAs
    const allPitches = pitchRefreshComplete ? refreshedPitches : optimisticPitches
    const allRuns = runRefreshComplete ? refreshedRuns : optimisticRuns
    const refreshProblems = [
      !paRefreshComplete && `plate appearances${paRefresh.error ? ` (${paRefresh.error.message})` : ' (incomplete snapshot)'}`,
      !pitchRefreshComplete && `pitches${pitchRefresh.error ? ` (${pitchRefresh.error.message})` : ' (incomplete snapshot)'}`,
      !runRefreshComplete && `runs${runRefresh.error ? ` (${runRefresh.error.message})` : ' (incomplete snapshot)'}`,
    ].filter(Boolean)
    if (refreshProblems.length) {
      console.warn('[savePA] post-save refresh was incomplete; retained committed local rows:', refreshProblems)
      pushToast({
        title: 'Play saved; refresh delayed',
        message: `The play was recorded, but ${refreshProblems.join(', ')} did not refresh cleanly. The complete local scorebook was preserved.`,
        type: 'info',
      })
    }

    deferRealtimeHydration()
    setPlateAppearances(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...allPAs])
    setPitches(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...allPitches])
    setRunsScored(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...allRuns])
    markSaveStep('sync-scores')
    await syncScores(allPAs, selectedGame, allRuns)
    markSaveStep('sync-inning-scores')
    await syncInningScores({ freshPAs: allPAs, freshRuns: allRuns, game: selectedGame })
    markSaveStep('recompute-pitching-stats')
    await recomputePitchingStatsForGame(allPAs, gamePitching, allRuns, allPitches)

    if (!editingPa) {
      try {
        markSaveStep('resolve-bets')
        await resolveOnPA(selectedGame.id, { ...paPayload, id: savedPa.id }, betResolutionConfig)
        markSaveStep('ensure-live-odds')
        const currentOdds = await ensureLiveOdds(gamePitching, allPAs)
        const recalcOuts = allPAs.reduce((s, pa) => s + calculateOutsForPa(pa.result, pa.outs_on_play), 0)
        const recalcOffense = deriveOffense(selectedGame, recalcOuts)
        // The odds model's "home"/"away"/isTop convention is team-A=away/team-B=home,
        // independent of the swap — so derive these from which team is batting,
        // not the structural top/bottom of the inning.
        const recalcIsTeamABatting = String(recalcOffense.battingPlayerId) === String(selectedGame.team_a_player_id)
        const recalcHomeScore = runsFromPAs(allPAs, selectedGame.team_b_player_id, allRuns)
        const recalcAwayScore = runsFromPAs(allPAs, selectedGame.team_a_player_id, allRuns)
        const freshOddsContext = buildSharedOddsGenerationContext({
          game: selectedGame,
          draftPicks,
          charactersById,
          gamePAs: allPAs,
          gamePitching,
          allGames: games,
          allPAs: trackedPlateAppearances,
          allPitching: pitchingStints,
          stadiumsById,
          stadiumGameLog,
          playersById,
          currentInning: recalcOffense.inning,
          scores: { a: recalcAwayScore, b: recalcHomeScore },
          totalInnings: regulationInnings,
          bets: gameBets,
          oddsWeights: oddsEngineWeights,
        })
        const changedRows = recalculateOdds(currentOdds || [], {
          battingSide: isTeamABatting ? 'away' : 'home',
          isTop: isTeamABatting,
          paCount: allPAs.length,
          runsThisHalf: runsThisHalfFromPAs(allPAs, currentBatter.player_id, offense.inning, allRuns),
          generationContext: { ...freshOddsContext, weights: oddsEngineWeights || DEFAULT_ODDS_WEIGHTS },
          oddsContext: freshOddsContext,
          liveState: {
            homeScore: recalcHomeScore,
            awayScore: recalcAwayScore,
            currentInning: recalcOffense.inning,
            isTop: recalcIsTeamABatting,
            outsInHalf: recalcOuts % 3,
            regulationInnings,
            runnersOccupied: [nextRunners?.first, nextRunners?.second, nextRunners?.third].filter(Boolean).length,
            balls: 0,
            strikes: 0,
            paCount: allPAs.length,
            status: 'active',
          },
        }, paPayload)
        markSaveStep('upsert-odds')
        await upsertChangedOdds(changedRows)
      } catch (bettingError) {
        pushToast({ title: 'Betting update failed', message: bettingError.message, type: 'error' })
      }
    }
    markSaveStep('done')
    const saveTotalMs = Math.round(performance.now() - saveStartedAt)
    // Only surface the breakdown for saves that were actually slow enough to
    // matter — logging every routine save would bury the signal we're after.
    if (saveTotalMs > 3000) {
      console.warn(`[savePA] slow save: ${saveTotalMs}ms total. Step breakdown:`, saveStepLog)
    }

    const nextScores = {
      a: runsFromPAs(allPAs, selectedGame.team_a_player_id, allRuns),
      b: runsFromPAs(allPAs, selectedGame.team_b_player_id, allRuns),
    }
    const newOuts = allPAs.reduce((sum, pa) => sum + calculateOutsForPa(pa.result, pa.outs_on_play), 0)
    const prevHalf = Math.floor(outsBeforePa / 3)
    const newHalf = Math.floor(newOuts / 3)
    const halfCompleted = newHalf > prevHalf
    const end = checkGameEnd({
      inning: offense.inning,
      isTop: offense.isTop,
      halfCompleted,
      currentScores: nextScores,
      previousScores: scores,
    })
    if (end) {
      setGameEndBanner(end)
      setShowOutsBanner(false)
    } else if (halfCompleted) {
      setShowOutsBanner(true)
    }
    if (end || halfCompleted) resetRunners(false)

    if (navigator.vibrate) navigator.vibrate(50)
    setEditingPa(null)
    setOverrideBatterIdx(null)
    setStarPitchActive(false)
    setPitchActionSheet(null)
    setPendingPitchEvent(null)
    paPitchRowsRef.current = []
    setPaPitchRows([])
    setInPlayState(null)
    setRbiOverlay(null)
    setStarHitUsed(false)
    setStarHitPending(false)
    setStarHitConnected(false)
    // `committedPitchNumber` was computed above from *this* pitcher's rows —
    // the one who just finished the half. When the half completes, the next
    // PA belongs to the opposing team's pitcher, whose count this closure
    // never looked up; stamping their card with the outgoing pitcher's
    // number would flash the wrong total right as the buttons unfreeze. Let
    // the automatic pitcherKey-based reset (in usePitchCount / the active-PA
    // hydration effect) own it instead once the render past this point sees
    // the new pitcher.
    restorePitchState({ balls: 0, strikes: 0, pitchNumber: halfCompleted || end ? 0 : committedPitchNumber })
    if (selectedGame?.id) {
      try { sessionStorage.removeItem(getActivePaStorageKey(selectedGame.id)) } catch {}
    }
    return { halfCompleted, end }
    } finally {
      if (saveWatchdogRef.current) {
        clearTimeout(saveWatchdogRef.current)
        saveWatchdogRef.current = null
      }
      deferRealtimeHydration()
      isSavingRef.current = false
      setIsSaving(false)
      unlockPitchActions()
    }
  }

  const currentPitcherGameLine = useMemo(() => ({
    ip: currentPitcherStint?.innings_pitched ?? 0,
    h: currentPitcherStint?.hits_allowed ?? 0,
    r: currentPitcherStint?.runs_allowed ?? 0,
    er: currentPitcherStint?.earned_runs ?? 0,
    bb: currentPitcherStint?.walks ?? 0,
    k: currentPitcherStint?.strikeouts ?? 0,
  }), [currentPitcherStint])
  const currentBatterLink = useMemo(
    () => (currentBatter ? getCharacterLinkTarget(currentBatter.character_id) : null),
    [currentBatter, getCharacterLinkTarget],
  )
  const currentPitcherLink = useMemo(
    () => (currentPitcherChar ? getCharacterLinkTarget(currentPitcherStint.character_id) : null),
    [currentPitcherChar, currentPitcherStint, getCharacterLinkTarget],
  )

  const beginPersistentUndo = useCallback(() => {
    if (isSavingRef.current) return false
    undoInFlightRef.current = true
    isSavingRef.current = true
    setIsUndoInFlight(true)
    setIsSaving(true)
    return true
  }, [])

  const releasePersistentUndo = useCallback(({ discardQueuedCorrection = false } = {}) => {
    undoInFlightRef.current = false
    isSavingRef.current = false
    setIsUndoInFlight(false)
    setIsSaving(false)
    if (discardQueuedCorrection) {
      queuedUndoCorrectionRef.current = null
      setQueuedUndoCorrection(null)
    }
  }, [])

  const deleteLatestPaPersisted = useCallback(async (paId) => {
    const { error } = await undoLatestPlateAppearance({
      isSeasonGame,
      gameId: selectedGame.id,
      plateAppearanceId: paId,
    })
    if (error) throw error
  }, [isSeasonGame, selectedGame?.id])

  // Undo (undo_latest_season_pa/undo_latest_tournament_pa) only deletes the PA's own
  // pitches/runs/row — it has no way to revert a mid-game pitching change, since that's a
  // separate action (changePitcher) not tied to any one PA. If the PA just undone was the
  // only one thrown under the pitcher currently on the mound, that pitcher's stint is left
  // as a stale, stat-less "ghost" that still reads as the current pitcher (currentPitcherStint
  // just takes the last stint for the side) and can even wrongly inherit a W/L/S. Clean it up
  // by deleting that now-empty stint so the previous pitcher becomes current again — but only
  // when it's safe: the stint must be the *most recent* one for that pitching player (an even
  // newer stint means it's already been superseded, unrelated to this undo) and there must be
  // an earlier stint to fall back to (otherwise it's just the starter with nothing recorded
  // yet, which is normal). Returns the pruned stints list for callers that need it immediately.
  const pruneOrphanedPitchingStint = useCallback(async (undonePa, remainingPAs, stints) => {
    if (undonePa?.pitcher_id == null || undonePa?.pitcher_player_id == null) return stints
    const sameSide = stints.filter((s) => (
      String(s.character_id) === String(undonePa.pitcher_id) && String(s.player_id) === String(undonePa.pitcher_player_id)
    ))
    if (!sameSide.length) return stints
    const undoneAt = new Date(undonePa.created_at).getTime()
    const eligible = sameSide.filter((s) => new Date(s.created_at).getTime() <= undoneAt)
    const staleStint = eligible[eligible.length - 1] || sameSide[0]
    if (!staleStint) return stints

    const stintsForPlayer = stints
      .filter((s) => String(s.player_id) === String(staleStint.player_id))
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    const staleIndex = stintsForPlayer.findIndex((s) => String(s.id) === String(staleStint.id))
    if (staleIndex === -1 || staleIndex !== stintsForPlayer.length - 1) return stints // superseded by a newer stint
    if (staleIndex === 0) return stints // starting pitcher, nothing to fall back to

    const stillReferenced = remainingPAs.some((pa) => {
      if (String(pa.pitcher_id) !== String(staleStint.character_id) || String(pa.pitcher_player_id) !== String(staleStint.player_id)) return false
      const candidates = sameSide.filter((s) => new Date(s.created_at).getTime() <= new Date(pa.created_at).getTime())
      const resolved = candidates[candidates.length - 1]
      return resolved && String(resolved.id) === String(staleStint.id)
    })
    if (stillReferenced) return stints

    const { error } = await deletePitchingStint({ tables: scorebookTables, stintId: staleStint.id })
    if (error) {
      console.warn('[scorebook undo] failed to prune orphaned pitching stint', error)
      return stints
    }
    setPitchingStints((current) => current.filter((s) => String(s.id) !== String(staleStint.id)))
    return stints.filter((s) => String(s.id) !== String(staleStint.id))
  }, [scorebookTables.pitchingStints])

  const undoLastPA = useCallback(async () => {
    if (isGameComplete || !gamePAs.length || !selectedGame) return
    // Keep one persistent undo in flight at a time. The UI rolls back
    // optimistically below, while the database deletes finish in the background.
    if (!beginPersistentUndo()) return
    let interactionReleased = false
    deferRealtimeHydration(30000)
    const last = [...gamePAs].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]
    const lastPitches = gamePitches
      .filter((pitch) => String(pitch.pa_id) === String(last.id))
      .sort(comparePitchOrder)
    const restoredPitchNumber = lastPitches.length
      ? Math.max(0, Number(lastPitches[0].pitch_number_game || pitchNumber) - 1)
      : pitchNumber
    const redoSnapshot = {
      type: 'pa',
      gameId: String(selectedGame.id),
      pa: stripDbManagedFields(last),
      pitches: lastPitches.map(stripDbManagedFields),
      runs: gameRuns
        .filter((run) => String(run.pa_id) === String(last.id))
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
        .map(stripDbManagedFields),
      runnersAfter: { ...runners },
    }
    locallyDeletedPaIdsRef.current.add(String(last.id))
    const optimisticPAs = gamePAs.filter((pa) => String(pa.id) !== String(last.id))
    const optimisticPitches = gamePitches.filter((pitch) => String(pitch.pa_id) !== String(last.id))
    const optimisticRuns = gameRuns.filter((run) => String(run.pa_id) !== String(last.id))
    const runnersHistoryBeforeUndo = runnersHistory.map((entry) => ({ ...entry }))
    const previousRedoAction = redoAction
    localActivePaRestoreRef.current = {
      gameId: selectedGame.id,
      paNumber: Number(last.pa_number || gamePAs.length),
      batterPlayerId: last.player_id,
      batterCharacterId: last.character_id,
      balls: 0,
      strikes: 0,
      pitchNumber: restoredPitchNumber,
      paPitchRows: [],
    }
    setRedoAction(redoSnapshot)
    setPlateAppearances(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...optimisticPAs])
    setPitches(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...optimisticPitches])
    setRunsScored(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...optimisticRuns])
    setShowOutsBanner(false)
    setGameEndBanner(null)
    setPendingPA(null)
    paPitchRowsRef.current = []
    setPaPitchRows([])
    restorePitchState({ balls: 0, strikes: 0, pitchNumber: restoredPitchNumber })
    setStarPitchActive(false)
    setStarHitUsed(false)
    setStarHitPending(false)
    setStarHitConnected(false)
    setPitchActionSheet(null)
    setPendingPitchEvent(null)
    setInPlayState(null)
    setRbiOverlay(null)
    popRunners()
    try { sessionStorage.removeItem(getActivePaStorageKey(selectedGame.id)) } catch {}
    if (navigator.vibrate) navigator.vibrate(30)

    try {
      await deleteLatestPaPersisted(last.id)

      releasePersistentUndo()
      interactionReleased = true

      // Let React paint the restored batter/count and dispatch a correction tap
      // before derived score/stat maintenance starts. If that correction already
      // began saving a replacement PA, its save path owns the fresh recompute.
      await new Promise((resolve) => setTimeout(resolve, 0))
      try {
        if (!isSavingRef.current) {
          await syncScores(optimisticPAs, selectedGame, optimisticRuns)
          await syncInningScores({ freshPAs: optimisticPAs, freshRuns: optimisticRuns, game: selectedGame })
          const prunedStints = await pruneOrphanedPitchingStint(last, optimisticPAs, gamePitching)
          await recomputePitchingStatsForGame(optimisticPAs, prunedStints, optimisticRuns, optimisticPitches)
        }
      } catch (maintenanceError) {
        // The PA deletion already committed. Do not visually resurrect it just
        // because a derived scoreboard/stat refresh failed afterward.
        console.warn('[scorebook undo] derived-state refresh failed after committed undo', maintenanceError)
        pushToast({
          title: 'Undo saved',
          message: `The play was removed, but its derived stats need a refresh: ${maintenanceError.message}`,
          type: 'error',
        })
      }
    } catch (error) {
      locallyDeletedPaIdsRef.current.delete(String(last.id))
      localActivePaRestoreRef.current = null
      setPlateAppearances(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...gamePAs])
      setPitches(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...gamePitches])
      setRunsScored(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...gameRuns])
      setRunners(runners)
      setRunnersHistory(runnersHistoryBeforeUndo)
      setRedoAction(previousRedoAction)
      paPitchRowsRef.current = []
      setPaPitchRows([])
      restorePitchState({ balls: 0, strikes: 0, pitchNumber })
      if (error.code === '23505') {
        pushToast({
          title: 'Game changed before undo',
          message: 'Another scorekeeper saved a play first. The scorebook will refresh to the authoritative game state.',
          type: 'info',
        })
        await fetchGameData()
      } else {
        pushToast({ title: 'Undo failed', message: error.message, type: 'error' })
      }
    } finally {
      if (!interactionReleased) releasePersistentUndo({ discardQueuedCorrection: true })
    }
  }, [isGameComplete, gamePAs, selectedGame, gamePitches, gameRuns, runners, runnersHistory, redoAction, pitchNumber, pushToast, popRunners, recomputePitchingStatsForGame, pruneOrphanedPitchingStint, gamePitching, deferRealtimeHydration, restorePitchState, beginPersistentUndo, releasePersistentUndo, deleteLatestPaPersisted, fetchGameData])

  // Undo should always feel like "take back one pitch" — including the pitch
  // that just completed the previous at-bat. undoLastPA (above) throws away
  // the *entire* just-finished PA and hands the batter a fresh 0-0 count,
  // which is right when there's nothing to reopen (e.g. an admin-entered
  // result with no pitch log) but wrong the moment that PA actually had a
  // pitch sequence (e.g. a 2-strike count that ended on the 3rd pitch) —
  // the previous batter should come back up mid-count, one pitch lighter,
  // not with the whole at-bat erased.
  const dbPitchRowToLocalEntry = (row) => ({
    pitchNumberGame: Number(row.pitch_number_game || 0),
    pitchNumberPa: Number(row.pitch_number_pa || 0),
    pitcherId: row.pitcher_id || '',
    pitcherPlayer: row.pitcher_player || '',
    pitch: {
      result: row.result,
      count_balls_before: Number(row.count_balls_before || 0),
      count_strikes_before: Number(row.count_strikes_before || 0),
      count_balls_after: Number(row.count_balls_after || 0),
      count_strikes_after: Number(row.count_strikes_after || 0),
      is_star_pitch: Boolean(row.is_star_pitch),
    },
  })

  const reopenLastCompletedPA = useCallback(async (lastPitches) => {
    if (isGameComplete || !gamePAs.length || !selectedGame) return
    // See undoLastPA: keep the database cleanup single-flight even though the
    // batter/count are restored optimistically.
    if (!beginPersistentUndo()) return
    let interactionReleased = false
    // Deleting this PA's pitches below changes currentPitcherPitchRows.length, which
    // re-runs the sessionStorage-hydration effect before the live_state publish effect
    // has caught up to the restored count — hold that effect off live-state hydration
    // for a bit so it trusts the snapshot we write below instead of stale DB state.
    deferRealtimeHydration(30000)
    const last = [...gamePAs].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]
    const redoSnapshot = {
      type: 'pa',
      gameId: String(selectedGame.id),
      pa: stripDbManagedFields(last),
      pitches: lastPitches.map(stripDbManagedFields),
      runs: gameRuns
        .filter((run) => String(run.pa_id) === String(last.id))
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
        .map(stripDbManagedFields),
      runnersAfter: { ...runners },
    }

    const remainingRows = lastPitches.slice(0, -1).map(dbPitchRowToLocalEntry)
    const removedRow = dbPitchRowToLocalEntry(lastPitches[lastPitches.length - 1])
    const restoredBalls = removedRow.pitch.count_balls_before
    const restoredStrikes = removedRow.pitch.count_strikes_before
    const restoredPitchNumber = Math.max(0, removedRow.pitchNumberGame - 1)

    locallyDeletedPaIdsRef.current.add(String(last.id))
    const optimisticPAs = gamePAs.filter((pa) => String(pa.id) !== String(last.id))
    const optimisticPitches = gamePitches.filter((pitch) => String(pitch.pa_id) !== String(last.id))
    const optimisticRuns = gameRuns.filter((run) => String(run.pa_id) !== String(last.id))
    const runnersHistoryBeforeUndo = runnersHistory.map((entry) => ({ ...entry }))
    const previousRedoAction = redoAction
    // `currentActivePaScope` still describes the on-deck batter at this point.
    // Store an identity-based restore instead; the hydration effect applies it
    // after removing the completed PA makes this batter current again.
    localActivePaRestoreRef.current = {
      gameId: selectedGame.id,
      paNumber: Number(last.pa_number || gamePAs.length),
      batterPlayerId: last.player_id,
      batterCharacterId: last.character_id,
      balls: restoredBalls,
      strikes: restoredStrikes,
      pitchNumber: restoredPitchNumber,
      paPitchRows: remainingRows,
    }
    setRedoAction(redoSnapshot)
    setPlateAppearances(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...optimisticPAs])
    setPitches(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...optimisticPitches])
    setRunsScored(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...optimisticRuns])
    setShowOutsBanner(false)
    setGameEndBanner(null)
    setPendingPA(null)
    setPitchActionSheet(null)
    setPendingPitchEvent(null)
    setInPlayState(null)
    setRbiOverlay(null)
    setStarPitchActive(false)
    setStarHitUsed(false)
    setStarHitPending(false)
    setStarHitConnected(false)
    popRunners()
    paPitchRowsRef.current = remainingRows
    setPaPitchRows(remainingRows)
    restorePitchState({ balls: restoredBalls, strikes: restoredStrikes, pitchNumber: restoredPitchNumber })
    try { sessionStorage.removeItem(getActivePaStorageKey(selectedGame.id)) } catch {}
    if (navigator.vibrate) navigator.vibrate(30)

    try {
      await deleteLatestPaPersisted(last.id)

      releasePersistentUndo()
      interactionReleased = true

      await new Promise((resolve) => setTimeout(resolve, 0))
      try {
        if (!isSavingRef.current) {
          await syncScores(optimisticPAs, selectedGame, optimisticRuns)
          await syncInningScores({ freshPAs: optimisticPAs, freshRuns: optimisticRuns, game: selectedGame })
          const prunedStints = await pruneOrphanedPitchingStint(last, optimisticPAs, gamePitching)
          await recomputePitchingStatsForGame(optimisticPAs, prunedStints, optimisticRuns, optimisticPitches)
        }
      } catch (maintenanceError) {
        console.warn('[scorebook undo] derived-state refresh failed after committed reopen', maintenanceError)
        pushToast({
          title: 'Undo saved',
          message: `The pitch was removed, but its derived stats need a refresh: ${maintenanceError.message}`,
          type: 'error',
        })
      }
    } catch (error) {
      locallyDeletedPaIdsRef.current.delete(String(last.id))
      localActivePaRestoreRef.current = null
      setPlateAppearances(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...gamePAs])
      setPitches(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...gamePitches])
      setRunsScored(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...gameRuns])
      setRunners(runners)
      setRunnersHistory(runnersHistoryBeforeUndo)
      setRedoAction(previousRedoAction)
      paPitchRowsRef.current = []
      setPaPitchRows([])
      restorePitchState({ balls: 0, strikes: 0, pitchNumber })
      if (error.code === '23505') {
        pushToast({
          title: 'Game changed before undo',
          message: 'Another scorekeeper saved a play first. The scorebook will refresh to the authoritative game state.',
          type: 'info',
        })
        await fetchGameData()
      } else {
        pushToast({ title: 'Undo failed', message: error.message, type: 'error' })
      }
    } finally {
      if (!interactionReleased) releasePersistentUndo({ discardQueuedCorrection: true })
    }
  }, [isGameComplete, gamePAs, selectedGame, gamePitches, gameRuns, runners, runnersHistory, redoAction, pitchNumber, pushToast, popRunners, recomputePitchingStatsForGame, pruneOrphanedPitchingStint, gamePitching, restorePitchState, deferRealtimeHydration, beginPersistentUndo, releasePersistentUndo, deleteLatestPaPersisted, fetchGameData])

  const undoLastPitch = useCallback(() => {
    if (isGameComplete || !paPitchRows.length) return
    const removedPitch = paPitchRows[paPitchRows.length - 1]
    setRedoAction({
      type: 'pitch',
      scope: currentActivePaScope,
      snapshot: {
        balls,
        strikes,
        pitchNumber,
        paPitchRows,
        pendingPA,
        pitchActionSheet,
        pendingPitchEvent,
        inPlayState,
        rbiOverlay,
        starPitchActive,
        starHitUsed,
        starHitPending,
        starHitConnected,
      },
    })
    undoPitch(removedPitch)
    paPitchRowsRef.current = paPitchRowsRef.current.slice(0, -1)
    setPaPitchRows(paPitchRowsRef.current)
    setPendingPA(null)
    setPitchActionSheet(null)
    setPendingPitchEvent(null)
    setInPlayState(null)
    setRbiOverlay(null)
    setStarPitchActive(false)
    if (paPitchRows.length <= 1) {
      setStarHitUsed(false)
      setStarHitPending(false)
      setStarHitConnected(false)
    }
    if (navigator.vibrate) navigator.vibrate(20)
  }, [isGameComplete, balls, strikes, pitchNumber, paPitchRows, pendingPA, pitchActionSheet, pendingPitchEvent, inPlayState, rbiOverlay, starPitchActive, starHitUsed, starHitPending, starHitConnected, currentActivePaScope, undoPitch])

  const canRedoAction = Boolean(
    redoAction
    && (
      (redoAction.type === 'pa' && String(redoAction.gameId) === String(selectedGameId))
      || (redoAction.type === 'pitch' && redoAction.scope === currentActivePaScope)
    )
  )
  const canUndoAction = Boolean(canEditScorebook && !isSaving && (gamePAs.length || paPitchRows.length))
  const canRedoUiAction = Boolean(canEditScorebook && !isSaving && canRedoAction)

  const handleRedoAction = useCallback(async () => {
    if (isGameComplete || isSaving || isSavingRef.current || !redoAction) return

    // Capture before any awaits — see comment in saveEnhancedPA.
    const outsBeforeRedo = outsRef.current

    if (redoAction.type === 'pitch') {
      if (redoAction.scope !== currentActivePaScope) return
      restoreActivePaSnapshot(redoAction.snapshot)
      clearRedoAction()
      if (navigator.vibrate) navigator.vibrate(20)
      return
    }

    if (!selectedGame || String(redoAction.gameId) !== String(selectedGame.id)) return

    // Same reentrancy hazard as undoLastPA/reopenLastCompletedPA below — several
    // sequential Supabase round trips before gamePAs reflects the restore.
    if (isSavingRef.current) return
    isSavingRef.current = true
    setIsSaving(true)
    try {
    deferRealtimeHydration(30000)
    // Sanitize again at execution time so a Redo snapshot captured before a
    // client update cannot retain display-only fields in component state.
    const restoredPaPayload = stripDbManagedFields(redoAction.pa)
    const { data: restoredPa, error } = await savePlateAppearanceRecord({
      tables: scorebookTables,
      payload: restoredPaPayload,
    })
    if (error) {
      pushToast({ title: 'Redo failed', message: error.message, type: 'error' })
      return
    }

    const restoredPitchRows = (redoAction.pitches || []).map((pitch) => ({ ...pitch, pa_id: restoredPa.id }))
    const restoredRunRows = (redoAction.runs || []).map((run) => ({ ...run, pa_id: restoredPa.id }))
    const rollbackRestoredPa = async () => {
      await rollbackRestoredPlateAppearance({
        tables: scorebookTables,
        plateAppearanceId: restoredPa.id,
      })
    }

    if (redoAction.pitches?.length) {
      const { error: pitchInsertError } = await insertPlateAppearancePitches({
        tables: scorebookTables,
        rows: restoredPitchRows,
      })
      if (pitchInsertError) {
        await rollbackRestoredPa()
        pushToast({ title: 'Pitch restore failed', message: pitchInsertError.message, type: 'error' })
        return
      }
    }

    if (redoAction.runs?.length) {
      const { error: runsInsertError } = await insertPlateAppearanceRuns({
        tables: scorebookTables,
        rows: restoredRunRows,
      })
      if (runsInsertError) {
        await rollbackRestoredPa()
        pushToast({ title: 'Run restore failed', message: runsInsertError.message, type: 'error' })
        return
      }
    }

    const [paRefresh, pitchRefresh, runRefresh] = await refreshPlateAppearanceBundle({
      tables: scorebookTables,
      gameId: selectedGame.id,
    })
    try {
      await syncPlateAppearanceRunnerOpportunities({ tables: scorebookTables, pa: restoredPa, outsBefore: outsBeforeRedo % 3 })
    } catch (error) {
      pushToast({ title: 'Redo saved; baserunning stats need a refresh', message: error.message, type: 'error' })
    }
    const optimisticPAs = [...gamePAs, normalizePa(restoredPa)]
    const optimisticPitches = [...gamePitches, ...restoredPitchRows]
    const optimisticRuns = [...gameRuns, ...restoredRunRows]
    const paRefreshComplete = !paRefresh.error
      && (paRefresh.data || []).length >= optimisticPAs.length
      && (paRefresh.data || []).some((pa) => String(pa.id) === String(restoredPa.id))
    const pitchRefreshComplete = !pitchRefresh.error
      && (pitchRefresh.data || []).length >= optimisticPitches.length
      && (
        restoredPitchRows.length === 0
        || (pitchRefresh.data || []).filter((pitch) => String(pitch.pa_id) === String(restoredPa.id)).length >= restoredPitchRows.length
      )
    const runRefreshComplete = !runRefresh.error
      && (runRefresh.data || []).length >= optimisticRuns.length
      && (
        restoredRunRows.length === 0
        || (runRefresh.data || []).filter((run) => String(run.pa_id) === String(restoredPa.id)).length >= restoredRunRows.length
      )
    const allPAs = paRefreshComplete ? (paRefresh.data || []).map(normalizePa) : optimisticPAs
    const allPitches = pitchRefreshComplete ? (pitchRefresh.data || []) : optimisticPitches
    const allRuns = runRefreshComplete ? (runRefresh.data || []) : optimisticRuns
    if (!paRefreshComplete || !pitchRefreshComplete || !runRefreshComplete) {
      console.warn('[redoPA] post-restore refresh was incomplete; retained the optimistic local restore')
      pushToast({
        title: 'Redo saved; refresh delayed',
        message: 'The plate appearance was restored and the complete local scorebook was preserved.',
        type: 'info',
      })
    }
    deferRealtimeHydration()
    setPlateAppearances(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...allPAs])
    setPitches(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...allPitches])
    setRunsScored(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...allRuns])
    await syncScores(allPAs, selectedGame, allRuns)
    await syncInningScores({ freshPAs: allPAs, freshRuns: allRuns, game: selectedGame })
    await recomputePitchingStatsForGame(allPAs, gamePitching, allRuns, allPitches)

    const newOuts = allPAs.reduce((sum, pa) => sum + calculateOutsForPa(pa.result, pa.outs_on_play), 0)
    const prevHalf = Math.floor(outsBeforeRedo / 3)
    const newHalf = Math.floor(newOuts / 3)

    setShowOutsBanner(newHalf > prevHalf)
    setGameEndBanner(null)
    setPendingPA(null)
    paPitchRowsRef.current = []
    setPaPitchRows([])
    setStarPitchActive(false)
    setStarHitUsed(false)
    setStarHitPending(false)
    setStarHitConnected(false)
    setPitchActionSheet(null)
    setPendingPitchEvent(null)
    setInPlayState(null)
    setRbiOverlay(null)
    pushRunners(redoAction.runnersAfter || { first: null, second: null, third: null })
    try { sessionStorage.removeItem(getActivePaStorageKey(selectedGame.id)) } catch {}
    clearRedoAction()
    if (navigator.vibrate) navigator.vibrate(30)
    } finally {
      isSavingRef.current = false
      setIsSaving(false)
    }
  }, [isGameComplete, isSaving, redoAction, currentActivePaScope, selectedGame, restoreActivePaSnapshot, clearRedoAction, pushToast, recomputePitchingStatsForGame, gamePitching, gamePAs, gamePitches, gameRuns, pushRunners, deferRealtimeHydration])

  const handleUndoAction = useCallback(() => {
    // Check the ref (not just the `isSaving` state, which lags a render behind
    // the ref during the async undo/redo functions below) so a fast double-tap
    // can't slip a second call in before React re-renders with the disabled button.
    if (!canEditScorebook || isSaving || isSavingRef.current) return
    if (paPitchRows.length) {
      undoLastPitch()
      return
    }
    if (!gamePAs.length) return
    const last = [...gamePAs].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]
    const lastPitches = gamePitches
      .filter((pitch) => String(pitch.pa_id) === String(last.id))
      .sort(comparePitchOrder)
    // A PA with 0-1 pitches (e.g. an admin-entered result) has nothing to
    // reopen one pitch into — undo the whole plate appearance instead.
    if (lastPitches.length < 2) {
      undoLastPA()
      return
    }
    reopenLastCompletedPA(lastPitches)
  }, [canEditScorebook, isSaving, paPitchRows.length, gamePAs, gamePitches, undoLastPitch, undoLastPA, reopenLastCompletedPA])

  // Replay a correction tapped during persistent Undo against the now-restored
  // batter/count. Clearing the ref first guarantees it can only run once.
  useEffect(() => {
    if (isUndoInFlight || !queuedUndoCorrection) return
    queuedUndoCorrectionRef.current = null
    setQueuedUndoCorrection(null)
    switch (queuedUndoCorrection.type) {
      case 'ball':
        handlePitchBall()
        break
      case 'foul':
        handlePitchFoul()
        break
      case 'hbp':
        handlePitchHbp()
        break
      case 'strike':
        handleStrikeChoice(queuedUndoCorrection.strikeType)
        break
      case 'in_play':
        handlePitchInPlay()
        break
      default:
        break
    }
  }, [isUndoInFlight, queuedUndoCorrection, handlePitchBall, handlePitchFoul, handlePitchHbp, handleStrikeChoice, handlePitchInPlay])


  const {
    lifecycleRecovery,
    markGameComplete,
    reopenCompletedGame,
    resetGameForTesting,
    resetGameBusy,
    setShowReopenGameConfirm,
    setShowResetGameConfirm,
    showReopenGameConfirm,
    showResetGameConfirm,
  } = useGameCompletion({
    betResolutionConfig,
    canManageLifecycle: isScorekeeper,
    charactersById,
    currentInning,
    gameSession,
    isCommissioner,
    isGameComplete,
    isSeasonGame,
    playersById,
    pushToast,
    refreshGameData: fetchGameData,
    regulationInnings,
    scorebookTables,
    scores,
    selectedGame,
    setGameEndBanner,
    setGames,
    setShowOutsBanner,
  })
  // Shown above every scorebook view, including the tracker box score that
  // tracker-fed games use, so it is there whichever view the game opens in.
  const scorebookToolbar = isScorekeeper
    ? <GameLifecycleRecoveryBanner recovery={lifecycleRecovery} />
    : null


  // ── Swap home / away teams ────────────────────────────────────────────────
  const swapTeams = useCallback(async () => {
    if (!selectedGame) return
    const { error } = await updateGameRecord({
      tables: scorebookTables,
      gameId: selectedGame.id,
      patch: {
        team_a_player_id: selectedGame.team_b_player_id,
        team_b_player_id: selectedGame.team_a_player_id,
        team_a_runs: selectedGame.team_b_runs,
        team_b_runs: selectedGame.team_a_runs,
      },
    })
    if (error) { pushToast({ title: 'Swap failed', message: error.message, type: 'error' }); return }
    setGames(cur => cur.map(g => g.id === selectedGame.id ? {
      ...g,
      team_a_player_id: g.team_b_player_id,
      team_b_player_id: g.team_a_player_id,
      team_a_runs: g.team_b_runs,
      team_b_runs: g.team_a_runs,
    } : g))
    pushToast({ title: 'Teams swapped — Away/Home flipped', type: 'success' })
  }, [selectedGame, pushToast, scorebookTables.games])

  // ── Pitcher change (drag to mound or double-tap) ──────────────────────────
  const changePitcher = useCallback(async (playerId, characterId) => {
    if (!selectedGame || !canEditScorebook) return
    if (Number(currentPitcherStint?.character_id) === Number(characterId)) return
    // The auto-assign effect and a manual mound tap/drag can both call this
    // for the same half-inning turnover before either's insert round-trips
    // back into currentPitcherStint — without a lock both pass the guard
    // above and each inserts their own stint row for the same pitcher,
    // producing a duplicate 0-inning "ghost" line in the pitching box score.
    if (pitcherChangePendingRef.current) return
    pitcherChangePendingRef.current = true
    const previousPitcherStint = currentPitcherStint
    const newStint = {
      game_id: selectedGame.id, player_id: playerId, character_id: characterId,
      innings_pitched: 0, hits_allowed: 0, runs_allowed: 0, earned_runs: 0, walks: 0, strikeouts: 0, hr_allowed: 0, pitches_thrown: 0, strikes_thrown: 0,
    }
    let data, error
    try {
      ({ data, error } = await insertPitchingStint({ tables: scorebookTables, row: addSourceFields(newStint) }))
    } finally {
      pitcherChangePendingRef.current = false
    }
    if (error) { pushToast({ title: 'Pitcher change failed', message: error.message, type: 'error' }); return }
    // Optimistic update — don't wait for realtime to refresh the mound, and
    // hold off the next data reload from clobbering it with a lagging read
    deferRealtimeHydration()
    const nextPitcherName = charactersById[characterId]?.name || ''
    const nextPitchNumber = nextPitcherName
      ? gamePitches.filter((pitch) => pitch.pitcher_id === nextPitcherName).length
      : 0
    // Update the count in the same batch as the optimistic stint change. If the
    // stint renders first with the previous pitcher's number, the live-state
    // publisher can persist that stale number under the new stint id and then
    // hydrate it back as if it were authoritative.
    // Read balls/strikes fresh (ref-backed) rather than from this callback's
    // closure — a pitch thrown while the stint insert above was in flight would
    // otherwise be silently reverted by a stale pre-await value here.
    const freshCounts = getPitchCounts()
    restorePitchState({ balls: freshCounts.balls, strikes: freshCounts.strikes, pitchNumber: nextPitchNumber })
    if (data) setPitchingStints(cur => [...cur, data])

    // Keep the in-game lineup draft aligned with the new pitcher so future
    // half-innings use the live game projection rather than falling back to the
    // pregame saved team_lineups snapshot.
    const changedTeam = String(playerId) === String(selectedGame.team_a_player_id) ? 'A'
      : String(playerId) === String(selectedGame.team_b_player_id) ? 'B' : null
    if (changedTeam) {
      setLineupDrafts((current) => {
        const draftForTeam = current[changedTeam] || { order: [], fielding: {} }
        return { ...current, [changedTeam]: { ...draftForTeam, fielding: { ...draftForTeam.fielding, pitcher: characterId } } }
      })
    }
    try {
      const nextPitching = data ? [...gamePitching, data] : gamePitching
      const generationContext = buildOddsGenerationContext(nextPitching, gamePAs)
      const currentOdds = await ensureLiveOdds(nextPitching, gamePAs)
      const changedRows = recalculateOdds(currentOdds || [], {
        pitcherSwap: true,
        generationContext: generationContext ? { ...generationContext, weights: oddsEngineWeights || DEFAULT_ODDS_WEIGHTS } : null,
      })
      await upsertChangedOdds(changedRows)

      // The old pitcher can no longer rack up strikeouts — if nobody has bet
      // on their k_prop yet, remove it entirely instead of leaving it locked.
      if (previousPitcherStint && Number(previousPitcherStint.character_id) !== Number(characterId)) {
        const oldChar = charactersById[previousPitcherStint.character_id]
        const oldPlayer = playersById[previousPitcherStint.player_id]
        const oldLabel = oldChar ? buildBettingEntityLabel(oldChar, oldPlayer) : null
        const staleKProp = oldLabel
          ? (currentOdds || []).find((row) => row.bet_type === 'k_prop' && row.target_entity === oldLabel)
          : null
        if (staleKProp?.id) {
          // season_bets has no game_odds_id column — it isn't tied to a specific
          // odds row, so match on the same (game, bet_type, target_entity) key
          // used to look up the stale prop above instead.
          const hasRelatedBets = await hasRelatedPitcherPropBets({
            tables: scorebookTables,
            isSeasonGame,
            gameId: selectedGame.id,
            gameOddsId: staleKProp.id,
            targetEntity: oldLabel,
          })
          if (!hasRelatedBets) {
            await deleteGameOddsRow({ tables: scorebookTables, gameOddsId: staleKProp.id })
          }
        }
      }
    } catch (bettingError) {
      pushToast({ title: 'Odds refresh failed', message: bettingError.message, type: 'error' })
    }
    pushToast({ title: `Pitcher → ${charactersById[characterId]?.name}`, type: 'success' })
  }, [selectedGame, canEditScorebook, charactersById, playersById, pushToast, gamePitching, gamePitches, currentPitcherStint, buildOddsGenerationContext, gamePAs, upsertChangedOdds, ensureLiveOdds, scorebookTables.pitchingStints, scorebookTables.bets, scorebookTables.gameOdds, addSourceFields, deferRealtimeHydration, isSeasonGame, lineupDrafts, gameSession?.sourceId, restorePitchState, getPitchCounts])

  // Keep a stable ref to the latest changePitcher so saveTeamLineup (defined
  // earlier in the component) can trigger pitcher changes without a circular
  // dependency.
  useEffect(() => { changePitcherRef.current = changePitcher }, [changePitcher])

  const handleMoundDragOver = useCallback((e) => { e.preventDefault(); setIsDragOverMound(true) }, [])
  const handleMoundDragLeave = useCallback(() => setIsDragOverMound(false), [])
  const handleMoundDrop = useCallback(async (e) => {
    if (!canEditScorebook) return
    e.preventDefault()
    setIsDragOverMound(false)
    const charId   = parseInt(e.dataTransfer.getData('pitcherCharId'), 10)
    const playerId = e.dataTransfer.getData('pitcherPlayerId')
    if (!charId || !playerId) return
    if (playerId !== offense?.pitchingPlayerId) {
      pushToast({ title: 'Wrong team', message: 'Only the pitching team\'s players can be dragged to the mound.', type: 'error' })
      return
    }
    if (charId === currentPitcherStint?.character_id) return
    await changePitcher(playerId, charId)
  }, [canEditScorebook, offense, currentPitcherStint, changePitcher, pushToast])

  const handlePitcherDragStart = useCallback((charId, playerId) => (e) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('pitcherCharId', String(charId))
    e.dataTransfer.setData('pitcherPlayerId', String(playerId))
  }, [])

  // Tap-to-select pitcher: first tap selects (purple), second tap confirms change
  const handlePitcherItemClick = useCallback(async (charId, playerId) => {
    if (!canEditScorebook) return
    if (charId === currentPitcherStint?.character_id) return // already pitching
    if (selectedPitcher?.charId === charId) {
      // Second tap — confirm
      await changePitcher(playerId, charId)
      setSelectedPitcher(null)
    } else {
      // First tap — select
      setSelectedPitcher({ charId, playerId })
    }
  }, [canEditScorebook, currentPitcherStint, selectedPitcher, changePitcher])

  // Mound click still works as an alternative confirm
  const handleMoundClick = useCallback(async () => {
    if (!canEditScorebook) return
    if (!selectedPitcher) return
    if (selectedPitcher.playerId !== offense?.pitchingPlayerId) {
      pushToast({ title: 'Wrong team', message: 'Only the pitching team can be assigned to the mound.', type: 'error' })
      setSelectedPitcher(null)
      return
    }
    await changePitcher(selectedPitcher.playerId, selectedPitcher.charId)
    setSelectedPitcher(null)
  }, [canEditScorebook, selectedPitcher, offense, changePitcher, pushToast])

  useEffect(() => {
    if (!selectedGame || isGameComplete || !offense?.pitchingPlayerId || currentPitcherStint || !defensiveLineup.length) return

    const assignKey = `${selectedGame.id}-${offense.pitchingPlayerId}`
    if (autoPitcherAssignRef.current === assignKey) return

    autoPitcherAssignRef.current = assignKey
    const team = String(offense.pitchingPlayerId) === String(selectedGame.team_a_player_id) ? 'A'
      : String(offense.pitchingPlayerId) === String(selectedGame.team_b_player_id) ? 'B' : null
    // Prefer the authoritative game_fielders position-1 assignment — already seeded
    // correctly by syncGameLineupsFromRoster the moment the game was created — over
    // lineupDrafts, which stays empty until the Lineups tab has been visited or the
    // pregame team_lineups poll has landed. A game opened straight from the normal
    // "Start Game" flow (Schedule page) never visits the Lineups tab first, so relying
    // on lineupDrafts here meant the very first pitcher of the game silently defaulted
    // to whoever bats leadoff instead of the actually-saved pitcher.
    const teamId = team === 'A' ? teamAId : teamBId
    const fielderPitcherRow = gameFielderRows.find((row) => (
      String(row.team_id) === String(teamId)
      && Number(row.position) === 1
      && fielderIsCurrent(row, currentInning)
    ))
    const desiredPitcherCharId = fielderPitcherRow
      ? defensiveLineup.find((entry) => charactersById[entry.character_id]?.name === fielderPitcherRow.character)?.character_id
      : (team ? Number(lineupDrafts[team]?.fielding?.pitcher || 0) : 0)
    const seededPitcher = defensiveLineup.find((entry) => Number(entry.character_id) === Number(desiredPitcherCharId))
    const pitcherToUse = seededPitcher || defensiveLineup[0] || null
    if (!pitcherToUse?.character_id) {
      autoPitcherAssignRef.current = null
      return
    }
    changePitcher(offense.pitchingPlayerId, pitcherToUse.character_id).finally(() => {
      if (autoPitcherAssignRef.current === assignKey) autoPitcherAssignRef.current = null
    })
  }, [selectedGame?.id, selectedGame?.team_a_player_id, selectedGame?.team_b_player_id, isGameComplete, offense?.pitchingPlayerId, currentPitcherStint?.id, defensiveLineup, gameFielderRows, teamAId, teamBId, currentInning, charactersById, lineupDrafts, changePitcher])

  // ── Add game ───────────────────────────────────────────────────────────────
  const addGame = useCallback(async () => {
    if (!tournament || !selectedAddGameStadium) return
    const highestCode = Math.max(...filteredGames.map(g => parseInt(String(g.game_code || '').replace(/\D/g, '') || '0')), 0)
    const { data, error } = await createTournamentGame({ row: {
      tournament_id: tournament.id,
      game_code: `G${highestCode + 1}`,
      stage: addGameForm.stage || 'Game',
      team_a_player_id: addGameForm.teamA || null,
      team_b_player_id: addGameForm.teamB || null,
      stadium_id: selectedAddGameStadium.id,
      is_night: normalizeIsNightForStadium(selectedAddGameStadium, addGameForm.isNight),
      team_a_runs: 0, team_b_runs: 0, status: 'pending', stats_source: 'tracker',
    } })
    if (error) { pushToast({ title: 'Error', message: error.message, type: 'error' }); return }
    setGames(cur => [...cur, data])
    setShowAddGame(false)
    setAddGameForm({
      teamA: '',
      teamB: '',
      stage: '',
      stadiumId: selectedAddGameStadium.id,
      isNight: normalizeIsNightForStadium(selectedAddGameStadium, false),
    })
    pushToast({ title: `${data.game_code} added`, type: 'success' })
    navigate(buildScorebookPath({ gameId: data.id, source: isSeasonGame ? 'season' : 'tournament' }))
  }, [tournament, filteredGames, addGameForm, pushToast, selectedAddGameStadium, navigate, isSeasonGame])

  // ─── Loading state ──────────────────────────────────────────────────────────
  if (!dataLoaded) {
    return (
      <div>
        <div className="page-head"><span className="brand-kicker">Live Scorebook</span><h1>Scorebook</h1></div>
        <section className="panel" style={{ textAlign: 'center', padding: 40 }}>
          <p className="muted">Loading scorebook…</p>
        </section>
      </div>
    )
  }

  // ─── Empty state ────────────────────────────────────────────────────────────
  if (!selectedGame) {
    const emptyMessage = filteredGames.length === 0
      ? (isSeasonGame ? 'No games are available for this season yet.' : 'No games created yet for this tournament.')
      : `This scorebook view needs a specific game. Open one from ${isSeasonGame ? 'the season schedule or playoff bracket' : 'the tournament bracket'}.`

    return (
      <div>
        <div className="page-head"><span className="brand-kicker">Live Scorebook</span><h1>Scorebook</h1></div>
        <section className="panel" style={{ textAlign: 'center', padding: 40 }}>
          <p className="muted" style={{ marginBottom: 16 }}>{emptyMessage}</p>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
            <button className="ghost-button" onClick={() => navigate(backPath)} type="button">{backLabel}</button>
            {!isSeasonGame && filteredGames.length === 0 && isCommissioner && (
              <button className="solid-button" onClick={() => setShowAddGame(true)} type="button">+ Add Game</button>
            )}
          </div>
        </section>
        {showAddGame && <AddGameModal players={players} stadiums={stadiums} addGameForm={addGameForm} setAddGameForm={setAddGameForm} onAdd={addGame} onClose={() => setShowAddGame(false)} />}
      </div>
    )
  }

  if (!selectedGame && filteredGames.length === 0) {
    return (
      <div>
        <div className="page-head"><span className="brand-kicker">Live Scorebook</span><h1>Scorebook</h1></div>
        <section className="panel" style={{ textAlign: 'center', padding: 40 }}>
          <p className="muted" style={{ marginBottom: 16 }}>No games created yet for this tournament.</p>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
            <button className="ghost-button" onClick={() => navigate('/bracket')} type="button">Go to Bracket →</button>
            {isCommissioner && (
              <button className="solid-button" onClick={() => setShowAddGame(true)} type="button">+ Add Game</button>
            )}
          </div>
        </section>
        {showAddGame && <AddGameModal players={players} stadiums={stadiums} addGameForm={addGameForm} setAddGameForm={setAddGameForm} onAdd={addGame} onClose={() => setShowAddGame(false)} />}
      </div>
    )
  }

  // ── Spectator mode ──────────────────────────────────────────────────────────
  const viewTabs = isScorekeeper ? (
    <div style={{ padding: '10px 12px 0' }}>
      <div style={{ display: 'inline-flex', gap: 6, padding: 4, borderRadius: 999, border: `1px solid ${C.border}`, background: `${C.card}DD` }}>
        {[
          { key: 'game', label: 'Game View' },
          ...(selectedGame && (selectedGame.stats_source === 'tracker'
            || !['complete', 'completed'].includes(selectedGame.status))
            ? [{ key: 'liveTracker', label: 'Live Tracker' }] : []),
          ...(selectedGame?.stats_source === 'tracker'
            ? [] : [{ key: 'scorebook', label: 'Manual Scorebook' }]),
          { key: 'atBatEditor', label: 'At-Bat Editor' },
          { key: 'lineups', label: 'Lineups' },
          { key: 'admin', label: 'Admin' },
        ].map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => runViewChange(() => setViewMode(tab.key))}
            style={{
              border: 'none',
              borderRadius: 999,
              padding: '8px 14px',
              cursor: 'pointer',
              background: viewMode === tab.key ? C.accent : 'transparent',
              color: viewMode === tab.key ? '#000' : '#E2E8F0',
              fontSize: 13,
              fontWeight: 800,
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <UnsavedChangesPrompt
        blocker={viewChangeBlocker}
        onSave={handleSaveAllDirtyAndAtBat}
        onDiscard={handleDiscardAllDirtyAndAtBat}
        message={unsavedChangesMessage}
      />
    </div>
  ) : null

  const renderGameView = () => (
    <ScorebookGameView
      toolbar={scorebookToolbar}
      tabs={viewTabs}
      game={{
        selectedGame,
        effectiveGameStatus,
        regulationInnings,
        selectedStadium,
        isScorekeeper,
      }}
      teams={{
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
      }}
      matchup={{
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
      }}
      tables={{
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
      }}
      actions={{
        openStadiumEditModal,
        setViewedLineupSide,
        getCharacterLinkTarget,
      }}
      stadiumModal={{
        open: stadiumEditModalOpen,
        stadiums,
        form: stadiumEditForm,
        setForm: setStadiumEditForm,
        onSave: saveStadiumEdit,
        onClose: () => setStadiumEditModalOpen(false),
        saving: stadiumEditSaving,
      }}
    />
  )

  const renderLineupsView = () => (
    <ScorebookLineupsView
      toolbar={scorebookToolbar}
      tabs={viewTabs}
      selectedGame={selectedGame}
      currentInning={currentInning}
      isNarrowViewport={isNarrowViewport}
      state={{
        teamAName,
        teamBName,
        lineupDrafts,
        rosterCharMaps,
        selectedFieldingPlayer,
        selectedLineupMoveId,
        lineupDirty,
        lineupSaveStatus,
      }}
      actions={{
        handleDropOnLineupSlot,
        handleLineupDragStart,
        openCharacterPage,
        handleLineupNumberClick,
        setFieldingPositionsForTeam,
        setSelectedFieldingPlayerForTeam,
        handleSaveLineupTeam,
      }}
    />
  )

  const renderAdminView = () => (
    <ScorebookAdminView
      toolbar={scorebookToolbar}
      tabs={viewTabs}
      state={{
        selectedGame,
        isSeasonGame,
        videoUrlDraft,
        videoUrlSaving,
        trackerModeSaving,
        trackerStats,
        canEditScorebook,
        battingColor,
        battingIdentity,
        battingPlayer,
        runners,
        charactersById,
        adminRunnerBase,
        adminRunnerCharacterId,
        adminRunnerOptions,
        canUndoAction,
        isGameComplete,
        isCommissioner,
        resetGameBusy,
      }}
      actions={{
        setVideoUrlDraft,
        saveVideoUrl,
        setStatsSource,
        applyTrackerFinalResult,
        removeRunnerFromBase,
        setAdminRunnerBase,
        setAdminRunnerCharacterId,
        addAdminRunner,
        handleUndoAction,
        openReopenConfirm: () => setShowReopenGameConfirm(true),
        openResetConfirm: () => setShowResetGameConfirm(true),
      }}
    />
  )

  // Both of these are opened from buttons inside the Admin tab, which returns
  // early below — so rendering them only in the scorekeeper view at the bottom
  // of this component means the button sets state that nothing is listening
  // to and looks completely dead. Kept as one fragment so the two places that
  // need them cannot drift apart.
  const gameActionModals = (
    <>
      {showResetGameConfirm && (
        <ResetGameConfirmModal
          teamAName={teamAName}
          teamBName={teamBName}
          busy={resetGameBusy}
          onConfirm={resetGameForTesting}
          onClose={() => setShowResetGameConfirm(false)}
        />
      )}
      {showReopenGameConfirm && (
        <ReopenGameConfirmModal
          scores={scores}
          teamAName={teamAName}
          teamBName={teamBName}
          teamAColor={teamAColor}
          teamBColor={teamBColor}
          onConfirm={() => reopenCompletedGame()}
          onClose={() => setShowReopenGameConfirm(false)}
        />
      )}
    </>
  )

  // Tracker-fed games have no play-by-play data for the granular manual-entry
  // grid to work from — route everything except Admin (where the mode gets
  // toggled), Lineups (pregame setup, unaffected), and the At-Bat Editor
  // (works for any game) to the read-only tracker box score instead.
  if (viewMode === 'liveTracker' && isScorekeeper) {
    return <><TrackerScorebookView toolbar={scorebookToolbar} tabs={viewTabs} selectedGame={selectedGame} isSeasonGame={isSeasonGame} TrackerComponent={TrackerLivePreview} /><UnsavedChangesPrompt blocker={lineupBlocker} onSave={handleSaveAllDirtyAndAtBat} onDiscard={handleDiscardAllDirtyAndAtBat} message={unsavedChangesMessage} /></>
  }

  if (viewMode === 'scorebook' && isScorekeeper && selectedGame?.stats_source === 'tracker') {
    return <><TrackerScorebookView toolbar={scorebookToolbar} tabs={viewTabs} selectedGame={selectedGame} isSeasonGame={isSeasonGame} TrackerComponent={TrackerLivePreview} /><UnsavedChangesPrompt blocker={lineupBlocker} onSave={handleSaveAllDirtyAndAtBat} onDiscard={handleDiscardAllDirtyAndAtBat} message={unsavedChangesMessage} /></>
  }

  if (selectedGame?.stats_source === 'tracker' && viewMode !== 'admin' && viewMode !== 'lineups' && viewMode !== 'atBatEditor') {
    return <>{renderGameView()}<UnsavedChangesPrompt blocker={lineupBlocker} onSave={handleSaveAllDirtyAndAtBat} onDiscard={handleDiscardAllDirtyAndAtBat} message={unsavedChangesMessage} /></>
  }

  if (viewMode === 'atBatEditor' && isScorekeeper) {
    return <><AtBatEditorScorebookView toolbar={scorebookToolbar} tabs={viewTabs} selectedGame={selectedGame} isSeasonGame={isSeasonGame} editorRef={atBatPanelRef} onDirtyChange={setAtBatDataDirty} EditorComponent={AtBatEditor} /><UnsavedChangesPrompt blocker={lineupBlocker} onSave={handleSaveAllDirtyAndAtBat} onDiscard={handleDiscardAllDirtyAndAtBat} message={unsavedChangesMessage} /></>
  }

  if (viewMode === 'lineups' && isScorekeeper) {
    return <>{renderLineupsView()}<UnsavedChangesPrompt blocker={lineupBlocker} onSave={handleSaveAllDirtyAndAtBat} onDiscard={handleDiscardAllDirtyAndAtBat} message={unsavedChangesMessage} /></>
  }

  if (viewMode === 'admin' && isScorekeeper) {
    return <>{renderAdminView()}{gameActionModals}<UnsavedChangesPrompt blocker={lineupBlocker} onSave={handleSaveAllDirtyAndAtBat} onDiscard={handleDiscardAllDirtyAndAtBat} message={unsavedChangesMessage} /></>
  }

  if (viewMode === 'game' || !isScorekeeper) {
    return <>{renderGameView()}<UnsavedChangesPrompt blocker={lineupBlocker} onSave={handleSaveAllDirtyAndAtBat} onDiscard={handleDiscardAllDirtyAndAtBat} message={unsavedChangesMessage} /></>
  }

  // ── Scorekeeper mode ────────────────────────────────────────────────────────
  return (
    <div className="scorebook-page-wrapper" style={{ color: C.text, paddingBottom: 90, margin: '-1.25rem -1.25rem 0' }}>
      <UnsavedChangesPrompt blocker={lineupBlocker} onSave={handleSaveAllDirtyAndAtBat} onDiscard={handleDiscardAllDirtyAndAtBat} message={unsavedChangesMessage} />
      {scorebookToolbar}
      {viewTabs}

      <ScorekeeperGameHeader
        game={{
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
        }}
        teams={{
          battingColor,
          battingIdentity,
          battingPlayer,
          pitchingColor,
          pitchingIdentity,
          pitchingPlayer,
          identitiesByPlayerId,
          playersById,
        }}
        matchup={{
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
        }}
        lineScore={{ lineScoreRows, viewedInning, setViewedInning }}
        actions={{ openStadiumEditModal, toggleHomeAwaySwap }}
      />

      {/* ── Main content ── */}
      <div style={{ padding: '8px 10px 0' }}>

        <ScorekeeperLineupStatus
          game={{ gameLineups, inPlayState, isGameComplete, isScorekeeper, selectedGame }}
          lineups={{
            battingColor,
            canEditScorebook,
            charactersById,
            currentLineup,
            currentPitcherChar,
            defensiveLineup,
            effectiveBatterIdx,
            isNarrowViewport,
            pitchingColor,
            selectedPitcher,
          }}
          actions={{ handlePitcherDragStart, handlePitcherItemClick, setShowReopenGameConfirm }}
        />

        <ScorekeeperGameEndBanner
          banner={{ gameEndBanner, showOutsBanner }}
          teams={{ identitiesByPlayerId, playersById }}
          scores={scores}
          regulationInnings={regulationInnings}
          actions={{
            markGameComplete,
            continuePlaying: () => {
              dismissedGameEndOutsRef.current = outsRecorded
              setGameEndBanner(null)
            },
          }}
        />

        <ScorekeeperPitchControls
          visibility={{
            canEditScorebook,
            currentBatter,
            gameEndBanner,
            inPlayState,
            pendingPA,
            pitchActionSheet,
            showOutsBanner,
          }}
          pitch={{
            canRecordOutcome,
            charactersById,
            editingPa,
            isPitchActionPending,
            isSaving,
            starHitUsed,
            starPitchActive,
          }}
          actions={{
            handlePitchBall,
            handlePitchFoul,
            handlePitchHbp,
            handlePitchInPlay,
            handleStrikeChoice,
            setEditingPa,
            setStarHitConnected,
            setStarHitUsed,
            setStarPitchActive,
          }}
        />


        <ScorekeeperInPlayPanel
          visibility={{ canEditScorebook, gameEndBanner, inPlayState, showOutsBanner }}
          play={{
            activeDefensiveFielders,
            buddyJumpAutoRobbedHr,
            buddyJumpEffectiveRobbedHr,
            charactersById,
            isStackedInPlayLayout,
            runnerPlacementPreview,
            runnerPlan,
            runners,
            selectionOutsInHalf,
            stadiumKey,
          }}
          actions={{ cancelInPlaySelection, finalizeInPlay, handleRunnerSetPosition, setInPlayState }}
          inPlayDetailsFooterRef={inPlayDetailsFooterRef}
        />
        <ScorekeeperActionBar
          inPlayState={inPlayState}
          canUndoAction={canUndoAction}
          canRedoUiAction={canRedoUiAction}
          isGameComplete={isGameComplete}
          actions={{
            handleRedoAction,
            handleUndoAction,
            openEndGameConfirm: () => setShowEndGameConfirm(true),
          }}
        />
      </div>

      {/* ── Add Game Modal ── */}
      {showAddGame && <AddGameModal players={players} stadiums={stadiums} addGameForm={addGameForm} setAddGameForm={setAddGameForm} onAdd={addGame} onClose={() => setShowAddGame(false)} />}
      {stadiumEditModalOpen && (
        <EditStadiumModal
          stadiums={stadiums}
          stadiumEditForm={stadiumEditForm}
          setStadiumEditForm={setStadiumEditForm}
          onSave={saveStadiumEdit}
          onClose={() => setStadiumEditModalOpen(false)}
          saving={stadiumEditSaving}
        />
      )}

      {/* ── Scorebook Access Modal ── */}
      {/* ── End Game Confirmation Modal ── */}
      {showEndGameConfirm && (
        <EndGameConfirmModal
          scores={scores}
          teamAName={teamAName}
          teamBName={teamBName}
          teamAColor={teamAColor}
          teamBColor={teamBColor}
          onConfirm={() => { setShowEndGameConfirm(false); markGameComplete() }}
          onClose={() => setShowEndGameConfirm(false)}
        />
      )}
      {gameActionModals}
    </div>
  )
}

// ─── Add Game Modal (shared) ──────────────────────────────────────────────────
