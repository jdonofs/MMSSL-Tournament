import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  fetchTeamLineup,
  SEASON_TEAM_LINEUPS,
  swapLineupSlot,
  TOURNAMENT_TEAM_LINEUPS,
} from '../../../utils/teamLineups'
import { reconcileTeamLineupDraft } from '../../../utils/teamLineupDraft'
import {
  FIELD_ID_TO_SCOREBOOK_POSITION,
  FIELD_POSITIONS,
  SCOREBOOK_POSITION_TO_FIELD_ID,
} from '../../../components/RosterLineupWidgets'
import {
  closeGameFielderRows,
  deleteGameFielderRows,
  deleteGameLineupProjection,
  insertGameFielderRows,
  insertGameLineupRows,
  updateGameLineupRows,
} from '../services/lineupService'
import useTeamLineupSync from './useTeamLineupSync'

export default function useLineupEditor({
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
}) {
  // ── Live lineup/fielding editor (commissioner & scorekeepers) ──────────────
  // Mirrors the Roster tab's lineup ordering + fielding diamond (DraggableRosterItem / FieldingView)
  const teamAId = isSeasonGame ? gameSession.teamIdByPlayerId?.[selectedGame?.team_a_player_id] : selectedGame?.team_a_player_id
  const teamBId = isSeasonGame ? gameSession.teamIdByPlayerId?.[selectedGame?.team_b_player_id] : selectedGame?.team_b_player_id
  
  const [lineupDrafts, setLineupDrafts] = useState({ A: { order: [], fielding: {} }, B: { order: [], fielding: {} } })
  const [selectedLineupMoveId, setSelectedLineupMoveId] = useState({ A: null, B: null })
  const [selectedFieldingPlayer, setSelectedFieldingPlayer] = useState({ A: null, B: null })
  const [lineupSaveStatus, setLineupSaveStatus] = useState({ A: 'idle', B: 'idle' })
  // Tracks whether each team's draft has unsaved local edits, so realtime-driven
  // draft rebuilds (from someone else's edits) don't clobber our in-flight edit.
  // lineupDirtyRef is the source of truth read synchronously inside effects;
  // lineupDirty mirrors it in state so the Save button / unsaved-changes
  // guard (which need a reactive value) can read it too.
  const lineupDirtyRef = useRef({ A: false, B: false })
  const [lineupDirty, setLineupDirty] = useState({ A: false, B: false })
  const markLineupDirty = useCallback((team, value) => {
    lineupDirtyRef.current = { ...lineupDirtyRef.current, [team]: value }
    setLineupDirty((current) => ({ ...current, [team]: value }))
  }, [])
  // Tracks the last saved team_lineups payload seen for each team, so pregame
  // sync from Roster/SeasonRoster doesn't re-apply the same snapshot forever.
  const lastSyncedTeamLineupRef = useRef({ A: null, B: null })
  const changePitcherRef = useRef(null)
  const isSyncingLineupsRef = useRef(false)
  const lastSyncedLineupSignatureRef = useRef(null)
  
  const savedTeamLineupsByPlayerId = useMemo(() => Object.fromEntries(
    savedTeamLineups.map((row) => [String(row.player_id), row]),
  ), [savedTeamLineups])
  
  const buildLineupDraft = useCallback((team) => {
    const lineupRows = team === 'A' ? teamALineup : teamBLineup
    const teamId = team === 'A' ? teamAId : teamBId
    const playerId = team === 'A' ? selectedGame?.team_a_player_id : selectedGame?.team_b_player_id
    const roster = team === 'A' ? teamRosters.teamA : teamRosters.teamB
    const savedRow = savedTeamLineupsByPlayerId[String(playerId)]
    const savedDraft = reconcileTeamLineupDraft({
      lineupOrder: savedRow?.lineup_order,
      fieldingPositions: savedRow?.fielding_positions,
    }, roster.map((pick) => pick.character_id).filter(Boolean), FIELD_POSITIONS.map((position) => position.id))
  
    // Once game-specific rows exist they are authoritative. Before then, use
    // the team-level snapshot that arrived with the scorebook's initial load,
    // so opening the Lineups tab never depends on a later polling request.
    const order = lineupRows.length
      ? lineupRows.map((row) => row.character_id)
      : savedDraft.order
    const fielding = lineupRows.length ? {} : { ...savedDraft.fielding }
    if (lineupRows.length) {
      lineupRows.forEach((row) => {
        const charName = charactersById[row.character_id]?.name
        const activeRow = gameFielderRows.find((r) => (
          String(r.team_id) === String(teamId)
          && r.character === charName
          && Number(r.inning_from || 1) <= Number(currentInning)
          && (r.inning_to == null || Number(r.inning_to) >= Number(currentInning))
        ))
        const fieldId = activeRow ? SCOREBOOK_POSITION_TO_FIELD_ID[Number(activeRow.position)] : null
        if (fieldId) fielding[fieldId] = row.character_id
      })
    }
  
    // There's no bench in Sluggers — every player in the lineup fields a
    // position. Fill any positions left empty (e.g. no game_fielders rows
    // yet) with the remaining lineup players in batting order.
    const placedIds = new Set(Object.values(fielding))
    const unplaced = order.filter((charId) => !placedIds.has(charId))
    const emptyFieldIds = FIELD_POSITIONS.map((p) => p.id).filter((fieldId) => !fielding[fieldId])
    unplaced.forEach((charId, index) => {
      if (emptyFieldIds[index]) fielding[emptyFieldIds[index]] = charId
    })
  
    return { order, fielding }
  }, [teamALineup, teamBLineup, teamAId, teamBId, selectedGame?.team_a_player_id, selectedGame?.team_b_player_id, teamRosters, savedTeamLineupsByPlayerId, charactersById, gameFielderRows, currentInning])
  
  // The Live Tracker tab only exists for tracker games. Switching to a manually
  // scored game (or turning the tracker off in Admin) would otherwise leave the
  // tab strip with nothing selected and this tab still rendering.
  useEffect(() => {
    if (viewMode !== 'liveTracker') return
    if (selectedGame && selectedGame.stats_source !== 'tracker') setViewMode('scorebook')
  }, [viewMode, selectedGame?.id, selectedGame?.stats_source])
  
  // Rebuild before paint whenever the user opens Lineups or its source data
  // changes. At this point both the saved team snapshot and the roster came
  // from the initial scorebook load, so there is no follow-up request to await.
  const lineupDraftGameRef = useRef(null)
  useLayoutEffect(() => {
    if (viewMode !== 'lineups' || !selectedGame) return
    const gameChanged = lineupDraftGameRef.current !== selectedGame.id
    lineupDraftGameRef.current = selectedGame.id
    // A new game needs its own seed, and the dedupe ref is what decides
    // whether applyIncomingTeamLineup is allowed to provide one.
    if (gameChanged) lastSyncedTeamLineupRef.current = { A: null, B: null }
    setLineupDrafts((current) => ({
      A: lineupDirtyRef.current.A ? current.A : buildLineupDraft('A'),
      B: lineupDirtyRef.current.B ? current.B : buildLineupDraft('B'),
    }))
  }, [viewMode, selectedGame?.id, buildLineupDraft])
  
  useEffect(() => {
    if (viewMode !== 'lineups' || !selectedGame) return
    setSelectedLineupMoveId({ A: null, B: null })
    setSelectedFieldingPlayer({ A: null, B: null })
    lineupDirtyRef.current = { A: false, B: false }
    setLineupDirty({ A: false, B: false })
    setLineupSaveStatus({ A: 'idle', B: 'idle' })
  }, [viewMode, selectedGame?.id])
  
  
  // Key-order-independent equality for a lineup draft, so comparing against
  // the freshly-rebuilt baseline isn't fooled by object insertion order.
  const lineupDraftKey = (draft) => JSON.stringify({
    order: draft.order,
    fielding: Object.keys(draft.fielding).sort().map((key) => [key, draft.fielding[key]]),
  })
  
  const handleLineupDragStart = useCallback((characterId) => (e) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('characterId', String(characterId))
    e.dataTransfer.setData('lineupCharacterId', String(characterId))
  }, [])
  
  const reorderLineupDraft = useCallback((team, characterId, targetIndex) => {
    setLineupDrafts((current) => {
      const order = swapLineupSlot(current[team].order, characterId, targetIndex)
      if (order === current[team].order) return current
      const nextDraft = { ...current[team], order }
      // Compare against the source-of-truth draft (not just "did this one
      // edit change something") so moving a slot and then moving it back
      // clears the dirty flag instead of leaving a false "unsaved changes".
      const baseline = buildLineupDraft(team)
      markLineupDirty(team, lineupDraftKey(nextDraft) !== lineupDraftKey(baseline))
      return { ...current, [team]: nextDraft }
    })
  }, [markLineupDirty, buildLineupDraft])
  
  const handleLineupNumberClick = useCallback((team, charId, index) => {
    setSelectedLineupMoveId((current) => {
      const sel = current[team]
      if (sel === null) return { ...current, [team]: charId }
      if (sel === charId) return { ...current, [team]: null }
      reorderLineupDraft(team, sel, index)
      return { ...current, [team]: null }
    })
  }, [reorderLineupDraft])
  
  const handleDropOnLineupSlot = useCallback((team, index) => (e) => {
    e.preventDefault()
    const characterId = parseInt(e.dataTransfer.getData('lineupCharacterId'), 10)
    if (characterId) reorderLineupDraft(team, characterId, index)
  }, [reorderLineupDraft])
  
  const setFieldingPositionsForTeam = useCallback((team) => (updater) => {
    setLineupDrafts((current) => {
      const fielding = typeof updater === 'function' ? updater(current[team].fielding) : updater
      const nextDraft = { ...current[team], fielding }
      const baseline = buildLineupDraft(team)
      markLineupDirty(team, lineupDraftKey(nextDraft) !== lineupDraftKey(baseline))
      return { ...current, [team]: nextDraft }
    })
  }, [markLineupDirty, buildLineupDraft])
  
  const setSelectedFieldingPlayerForTeam = useCallback((team) => (updater) => {
    setSelectedFieldingPlayer((current) => {
      const value = typeof updater === 'function' ? updater(current[team]) : updater
      return { ...current, [team]: value }
    })
  }, [])
  
  // Applies a lineup order + fielding assignment for `team` to the live
  // lineups/game_fielders projection for this specific game. The saved
  // team_lineups snapshot only seeds pregame state and is not rewritten here.
  const applyLineupToGame = useCallback(async (team, order, fielding) => {
    if (!selectedGame) return
    const teamId = team === 'A' ? teamAId : teamBId
    const playerId = team === 'A' ? selectedGame.team_a_player_id : selectedGame.team_b_player_id
    const lineupRows = team === 'A' ? teamALineup : teamBLineup
  
    const lineupUpdates = order
      .map((characterId, i) => {
        const row = lineupRows[i]
        if (!row) return null
        if (row.character_id === characterId && row.batting_order === i + 1) return null
        return { rowId: row.id, characterId, battingOrder: i + 1 }
      })
      .filter(Boolean)
  
    const results = await updateGameLineupRows({ tables: scorebookTables, updates: lineupUpdates })
    const failed = results.find((r) => r.error)
    if (failed) {
      pushToast({ title: 'Lineup save failed', message: failed.error.message, type: 'error' })
      return
    }
    const noRowsUpdated = results.find((r) => !r.data || r.data.length === 0)
    if (noRowsUpdated) {
      pushToast({ title: 'Lineup save failed', message: 'No lineup rows were updated. You may not have permission to edit this lineup.', type: 'error' })
      return
    }
  
    // Only touch rows for positions actually present in this `fielding`
    // payload — leave every other position's existing row alone. Otherwise a
    // partial update (e.g. a mid-game pitcher change, which only ever sets
    // `fielding.pitcher`) would close/delete the *entire* defense down to
    // just that one position, since a stale/incomplete saved team_lineups
    // snapshot can legitimately have only one key in `fielding_positions`.
    const mentionedPositions = new Set(
      Object.entries(fielding).filter(([, characterId]) => characterId).map(([fieldId]) => FIELD_ID_TO_SCOREBOOK_POSITION[fieldId]),
    )
    const openRows = gameFielderRows.filter((r) => String(r.team_id) === String(teamId) && r.inning_to == null && mentionedPositions.has(r.position))
    const toClose = openRows.filter((r) => Number(r.inning_from || 1) < Number(currentInning))
    const toDelete = openRows.filter((r) => Number(r.inning_from || 1) >= Number(currentInning))
  
    if (toClose.length) {
      const { error } = await closeGameFielderRows({
        tables: scorebookTables,
        rowIds: toClose.map((row) => row.id),
        inningTo: Number(currentInning) - 1,
      })
      if (error) {
        pushToast({ title: 'Lineup save failed', message: error.message, type: 'error' })
        return
      }
    }
    if (toDelete.length) {
      const { error } = await deleteGameFielderRows({
        tables: scorebookTables,
        rowIds: toDelete.map((row) => row.id),
      })
      if (error) {
        pushToast({ title: 'Lineup save failed', message: error.message, type: 'error' })
        return
      }
    }
  
    const newFielderRows = Object.entries(fielding)
      .filter(([, characterId]) => characterId)
      .map(([fieldId, characterId]) => ({
        game_id: selectedGame.id,
        team_id: teamId,
        player_name: playersById[playerId]?.name || '',
        character: charactersById[characterId]?.name || '',
        position: FIELD_ID_TO_SCOREBOOK_POSITION[fieldId],
        inning_from: currentInning,
        inning_to: null,
      }))
  
    let insertedFielderRows = []
    if (newFielderRows.length) {
      const { data, error } = await insertGameFielderRows({
        tables: scorebookTables,
        rows: newFielderRows.map(addSourceFields),
      })
      if (error) {
        pushToast({ title: 'Lineup save failed', message: error.message, type: 'error' })
        return
      }
      insertedFielderRows = data || newFielderRows.map(addSourceFields)
    }
  
    // Hold off on merging the realtime echo of this save — a read against a lagging
    // replica could otherwise return pre-update rows and clobber the optimistic state below.
    deferRealtimeHydration()
  
    const closedIds = new Set(toClose.map((r) => String(r.id)))
    const deletedIds = new Set(toDelete.map((r) => String(r.id)))
    // An empty `order` means this snapshot doesn't know the batting order at
    // all (e.g. a pitcher-only change) — leave the existing lineup rows
    // alone rather than blanking every character_id to order[idx]===undefined.
    if (order.length) {
      setLineups((current) => current.map((row) => {
        const idx = lineupRows.findIndex((r) => String(r.id) === String(row.id))
        if (idx === -1) return row
        return { ...row, character_id: order[idx], batting_order: idx + 1 }
      }))
    }
    setGameFielders((current) => [
      ...current
        .filter((row) => !deletedIds.has(String(row.id)))
        .map((row) => (closedIds.has(String(row.id)) ? { ...row, inning_to: Number(currentInning) - 1 } : row)),
      ...insertedFielderRows,
    ])
  
    // If this team is currently on defense and the pitcher assignment
    // changed, record an actual pitching change so the mound, game view,
    // scorebook field diagram, and bets tab all update.
    const newPitcherCharId = fielding.pitcher ? Number(fielding.pitcher) : null
    if (newPitcherCharId && offense?.pitchingPlayerId === playerId && newPitcherCharId !== Number(currentPitcherStint?.character_id)) {
      await changePitcherRef.current?.(playerId, newPitcherCharId)
    }
  }, [selectedGame, teamAId, teamBId, teamALineup, teamBLineup, scorebookTables.lineups, scorebookTables.gameFielders, gameFielderRows, currentInning, playersById, charactersById, addSourceFields, pushToast, offense, currentPitcherStint])
  
  const saveTeamLineup = useCallback((team) => {
    const { order, fielding } = lineupDrafts[team]
    return applyLineupToGame(team, order, fielding)
  }, [lineupDrafts, applyLineupToGame])
  
  const applyLineupToGameRef = useRef(null)
  useEffect(() => { applyLineupToGameRef.current = applyLineupToGame }, [applyLineupToGame])
  
  // Shared handler for an incoming team_lineups/season_team_lineups row
  // (from realtime or from the polling fallback below): updates this
  // Scorebook session's draft, and — if this session can write to
  // lineups/game_fielders — applies it there too.
  const applyIncomingTeamLineup = useCallback((team, lineupOrder, fieldingPositions) => {
    const payloadJson = JSON.stringify({ lineupOrder, fieldingPositions })
    if (payloadJson === lastSyncedTeamLineupRef.current[team]) return
    lastSyncedTeamLineupRef.current[team] = payloadJson
  
    const playerId = team === 'A' ? selectedGame?.team_a_player_id : selectedGame?.team_b_player_id
    if (playerId) {
      setSavedTeamLineups((current) => {
        const index = current.findIndex((row) => String(row.player_id) === String(playerId))
        const existing = index === -1 ? null : current[index]
        const existingJson = JSON.stringify({
          lineupOrder: Array.isArray(existing?.lineup_order) ? existing.lineup_order : [],
          fieldingPositions: existing?.fielding_positions && typeof existing.fielding_positions === 'object'
            ? existing.fielding_positions
            : {},
        })
        if (existingJson === payloadJson) return current
        const nextRow = {
          ...existing,
          player_id: playerId,
          lineup_order: lineupOrder,
          fielding_positions: fieldingPositions,
        }
        if (index === -1) return [...current, nextRow]
        const next = [...current]
        next[index] = nextRow
        return next
      })
    }
  
    // Only let saved team_lineups seed lineupDrafts (and, below, lineups/game_fielders)
    // while the game is still pending/scheduled. A zero PA count is not enough
    // to call a game pregame: the tracker marks it live before the first PA is
    // completed, and position changes can happen during that window. Once live,
    // lineups/game_fielders become the authoritative game-specific state — in
    // particular, currentPitcherStint reflects the real in-game pitcher, and
    // lineupDrafts[team].fielding.pitcher is kept aligned with it by changePitcher
    // itself (see "Keep the in-game lineup draft aligned..." above). Without this
    // gate, this poll/realtime handler (which fires every 5s regardless of game
    // state) would keep re-seeding lineupDrafts from the stale pregame snapshot —
    // which is never updated by an in-game pitching change — and the "just took
    // the mound" effect would then silently revert a mid-game pitcher change back
    // to whoever was saved before the game started, inserting a duplicate pitching
    // stint and corrupting that half's pitching line.
    if (isGamePregame && gamePAs.length === 0 && !lineupDirtyRef.current[team]) {
      setLineupDrafts((current) => ({ ...current, [team]: { order: lineupOrder, fielding: fieldingPositions } }))
    }
    if (canEditScorebook && isGamePregame && gamePAs.length === 0 && (gameLineups.length === 0 || gameFielderRows.length === 0)) {
      // Guard against a stale/mismatched team_lineups snapshot (e.g. saved
      // for a different tournament round or before a trade/roster change)
      // ever clobbering this game's actual lineup. This poll/realtime sync
      // fires unconditionally the first time it sees a saved row (and on
      // every 5s tick after that), so without this check a snapshot whose
      // character ids aren't part of this team's *current in-game* lineup
      // gets written straight into lineups/game_fielders — and since those
      // ids don't resolve via charactersById, the whole fielding team (both
      // the lineup row and the field diagram, which read the resulting
      // character_id / character name respectively) renders as "?".
      const gameRosterIds = new Set((team === 'A' ? teamALineup : teamBLineup).map((row) => String(row.character_id)))
      const referencedIds = [...lineupOrder, ...Object.values(fieldingPositions)]
      const isKnownLineup = referencedIds.length > 0 && referencedIds.every((id) => gameRosterIds.has(String(id)))
      if (isKnownLineup) {
        applyLineupToGameRef.current?.(team, lineupOrder, fieldingPositions)
      }
    }
  }, [canEditScorebook, gameFielderRows.length, gameLineups.length, gamePAs.length, isGamePregame, selectedGame?.team_a_player_id, selectedGame?.team_b_player_id, teamALineup, teamBLineup])
  
  useTeamLineupSync({
    sourceId: gameSession?.sourceId,
    isSeasonGame,
    teamAPlayerId: selectedGame?.team_a_player_id,
    teamBPlayerId: selectedGame?.team_b_player_id,
    applyIncomingTeamLineup,
  })
  
  // A pitcher swap made while a team was batting can't be applied to
  // pitching_stints right away (they're not the pitching team yet). Once
  // that team takes the mound, check its game-specific lineup draft against
  // the active pitching stint and apply the change then.
  //
  // This must only run at the moment a team *transitions onto* defense —
  // not on every render where lineupDrafts/currentPitcherStint merely
  // change reference. Otherwise a manual mid-half pitcher change (which
  // updates currentPitcherStint) gets immediately fought and reverted back
  // to the prior pitcher the next time lineupDrafts refreshes.
  const prevDefensivePlayerIdRef = useRef(null)
  // Tracks whether we've observed a defensive side at all yet — without this,
  // the very first run after any remount (tab reload, navigating back to this
  // game) sees prevDefensivePlayerIdRef.current as null and misreads "the
  // team already on defense" as having "just taken the mound", which then
  // force-reverts an already-correct current pitcher back to whatever stale
  // fielding.pitcher happens to be sitting in lineupDrafts.
  const hasSeenDefensiveSideRef = useRef(false)
  useEffect(() => {
    if (!offense?.pitchingPlayerId || !canEditScorebook) return
    const justTookMound = hasSeenDefensiveSideRef.current && prevDefensivePlayerIdRef.current !== offense.pitchingPlayerId
    prevDefensivePlayerIdRef.current = offense.pitchingPlayerId
    hasSeenDefensiveSideRef.current = true
    if (!justTookMound) return
    const team = String(offense.pitchingPlayerId) === String(selectedGame?.team_a_player_id) ? 'A'
      : String(offense.pitchingPlayerId) === String(selectedGame?.team_b_player_id) ? 'B' : null
    if (!team) return
    const desiredPitcherCharId = lineupDrafts[team]?.fielding?.pitcher ? Number(lineupDrafts[team].fielding.pitcher) : null
    if (desiredPitcherCharId && desiredPitcherCharId !== Number(currentPitcherStint?.character_id)) {
      changePitcherRef.current?.(offense.pitchingPlayerId, desiredPitcherCharId)
    }
  }, [offense?.pitchingPlayerId, canEditScorebook, lineupDrafts, currentPitcherStint, selectedGame?.team_a_player_id, selectedGame?.team_b_player_id])
  
  // Lineup/fielding edits are saved explicitly via the Save button rather
  // than autosaved, to avoid races with realtime/poll updates from other
  // viewers clobbering in-flight edits. Other viewers' Lineups tabs pick
  // this up via the realtime subscriptions on `lineups`/`game_fielders`
  // (and rebuild their draft above) once saved.
  const handleSaveLineupTeam = useCallback(async (team) => {
    setLineupSaveStatus((current) => ({ ...current, [team]: 'saving' }))
    try {
      await saveTeamLineup(team)
      markLineupDirty(team, false)
      setLineupSaveStatus((current) => ({ ...current, [team]: 'saved' }))
    } catch (err) {
      setLineupSaveStatus((current) => ({ ...current, [team]: 'error' }))
      throw err
    }
  }, [saveTeamLineup, markLineupDirty])
  
  const handleSaveAllDirtyLineups = useCallback(async () => {
    const teams = ['A', 'B'].filter((team) => lineupDirtyRef.current[team])
    await Promise.all(teams.map((team) => handleSaveLineupTeam(team)))
  }, [handleSaveLineupTeam])
  

  // ── Auto-seed lineups ──────────────────────────────────────────────────────
  const syncGameLineupsFromRoster = useCallback(async () => {
    if (!canEditScorebook) return
    if (!selectedGame || isGameComplete) return
    if (gamePAs.length > 0) return
    // Once a lineup and its fielding assignments exist for this game, leave them
    // alone — re-running the roster-based seed here would silently overwrite any
    // manual edits made in the Lineups tab (e.g. after navigating away and back).
    if (gameLineups.length > 0 && gameFielderRows.length > 0) return
    if (isSyncingLineupsRef.current) return
    isSyncingLineupsRef.current = true
    try {
      const teamLineupsTable = isSeasonGame ? SEASON_TEAM_LINEUPS : TOURNAMENT_TEAM_LINEUPS
      const [savedTeamA, savedTeamB] = await Promise.all([
        fetchTeamLineup({ ...teamLineupsTable, sourceId: gameSession?.sourceId, playerId: selectedGame.team_a_player_id }),
        fetchTeamLineup({ ...teamLineupsTable, sourceId: gameSession?.sourceId, playerId: selectedGame.team_b_player_id }),
      ])
      const buildRows = (roster, playerId, saved) => {
        let picks = roster.filter(p => p.character_id)
        if (saved && Array.isArray(saved.lineupOrder) && saved.lineupOrder.length) {
          const byCharId = Object.fromEntries(picks.map(p => [p.character_id, p]))
          const ordered = saved.lineupOrder.map(id => byCharId[id]).filter(Boolean)
          const rest = picks.filter(p => !saved.lineupOrder.includes(p.character_id))
          picks = [...ordered, ...rest]
        }
        return picks.slice(0, 9).map((pick, i) => ({
          game_id: selectedGame.id,
          player_id: playerId,
          character_id: pick.character_id,
          batting_order: i + 1,
        }))
      }
      const buildFielders = (lineupRows, saved) => {
        const savedPositions = saved?.fieldingPositions && typeof saved.fieldingPositions === 'object'
          ? saved.fieldingPositions
          : {}
        const lineupByCharacterId = Object.fromEntries(lineupRows.map((row) => [row.character_id, row]))
        const seededFielding = {}
  
        Object.entries(savedPositions).forEach(([fieldId, characterId]) => {
          if (!lineupByCharacterId[characterId] || !FIELD_ID_TO_SCOREBOOK_POSITION[fieldId]) return
          seededFielding[fieldId] = characterId
        })
  
        const placedIds = new Set(Object.values(seededFielding).map((characterId) => String(characterId)))
        const remainingRows = lineupRows.filter((row) => !placedIds.has(String(row.character_id)))
        const emptyFieldIds = FIELD_POSITIONS.map((position) => position.id).filter((fieldId) => !seededFielding[fieldId])
        remainingRows.forEach((row, index) => {
          if (emptyFieldIds[index]) seededFielding[emptyFieldIds[index]] = row.character_id
        })
  
        return Object.entries(seededFielding).map(([fieldId, characterId]) => {
          const lineupRow = lineupByCharacterId[characterId]
          return {
            game_id: selectedGame.id,
            team_id: isSeasonGame ? gameSession.teamIdByPlayerId?.[lineupRow.player_id] || null : lineupRow.player_id,
            player_name: playersById[lineupRow.player_id]?.name || '',
            character: charactersById[characterId]?.name || '',
            position: FIELD_ID_TO_SCOREBOOK_POSITION[fieldId],
            inning_from: 1,
            inning_to: null,
          }
        })
      }
  
      const teamALineupRows = buildRows(teamRosters.teamA, selectedGame.team_a_player_id, savedTeamA)
      const teamBLineupRows = buildRows(teamRosters.teamB, selectedGame.team_b_player_id, savedTeamB)
      const desiredPayload = [...teamALineupRows, ...teamBLineupRows]
  
      if (!desiredPayload.length) return
  
      const currentSignature = gameLineups
        .map((row) => `${row.player_id}:${row.character_id}:${row.batting_order}`)
        .join('|')
      const desiredSignature = desiredPayload
        .map((row) => `${row.player_id}:${row.character_id}:${row.batting_order}`)
        .join('|')
  
      if (currentSignature === desiredSignature && gameFielderRows.length > 0) return
      // Avoid re-running the delete/insert cycle while the realtime echo of our own
      // previous sync is still propagating back (which would otherwise transiently
      // empty `lineups` and re-trigger this effect, causing the lineup to flicker).
      if (lastSyncedLineupSignatureRef.current === desiredSignature) return
  
      const lineupPayload = desiredPayload.map(addSourceFields)
      const fielderPayload = [
        ...buildFielders(teamALineupRows, savedTeamA),
        ...buildFielders(teamBLineupRows, savedTeamB),
      ]
  
      const [deleteLineupsResult, deleteFieldersResult] = await deleteGameLineupProjection({
        tables: scorebookTables,
        gameId: selectedGame.id,
      })
  
      if (deleteLineupsResult.error) {
        pushToast({ title: 'Lineup sync failed', message: deleteLineupsResult.error.message, type: 'error' })
        return
      }
      if (deleteFieldersResult.error) {
        pushToast({ title: 'Fielder sync failed', message: deleteFieldersResult.error.message, type: 'error' })
        return
      }
  
      const { data: insertedLineups, error: lineupError } = await insertGameLineupRows({
        tables: scorebookTables,
        rows: lineupPayload,
      })
      if (lineupError) {
        pushToast({ title: 'Lineup sync failed', message: lineupError.message, type: 'error' })
        return
      }
  
      const { data: insertedFielders, error: fielderError } = await insertGameFielderRows({
        tables: scorebookTables,
        rows: fielderPayload.map(addSourceFields),
      })
      if (fielderError) {
        pushToast({ title: 'Fielder sync failed', message: fielderError.message, type: 'error' })
        return
      }
  
      deferRealtimeHydration()
      setLineups((current) => [...current.filter((row) => String(row.game_id) !== String(selectedGame.id)), ...(insertedLineups || lineupPayload)])
      setGameFielders((current) => [...current.filter((row) => String(row.game_id) !== String(selectedGame.id)), ...(insertedFielders || fielderPayload)])
      lastSyncedLineupSignatureRef.current = desiredSignature
    } finally {
      isSyncingLineupsRef.current = false
    }
  }, [canEditScorebook, selectedGame, isGameComplete, gamePAs.length, gameLineups, gameFielderRows.length, teamRosters, gameSession, addSourceFields, playersById, charactersById, scorebookTables.lineups, scorebookTables.gameFielders, pushToast, isSeasonGame, deferRealtimeHydration])
  
  useEffect(() => {
    lastSyncedLineupSignatureRef.current = null
  }, [selectedGame?.id])
  
  useEffect(() => {
    if (!canEditScorebook) return
    if (!selectedGame) return
    const total = teamRosters.teamA.length + teamRosters.teamB.length
    if (total === 0) return
    syncGameLineupsFromRoster()
  }, [canEditScorebook, selectedGame?.id, teamRosters.teamA.length, teamRosters.teamB.length, gameLineups.length, gamePAs.length, gameFielderRows.length, syncGameLineupsFromRoster])
  
  const discardLineupChanges = useCallback(() => {
    lineupDirtyRef.current = { A: false, B: false }
    setLineupDirty({ A: false, B: false })
    setLineupDrafts({ A: buildLineupDraft('A'), B: buildLineupDraft('B') })
  }, [buildLineupDraft])

  return {
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
  }
}
