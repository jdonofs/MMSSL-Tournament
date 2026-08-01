import { useEffect, useRef, useState } from 'react'
import { supabase } from '../supabaseClient'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import GameCard from '../components/GameCard'
import YouTubePlayer from '../components/YouTubePlayer'
import useCompletedGames from '../hooks/useCompletedGames'
import { TABLES } from '../utils/gameSourceTables'
import { extractYouTubeId, formatSecondsAsClock, parseRawClockInput, formatSecondsAsRawInput } from '../utils/video'
import { formatPaResultLabel } from '../utils/notation'

// A backgrounded tab on this page can get silently killed and reloaded by the
// browser (no beforeunload/pagehide fires, so there's no chance to warn the
// user) — see the memory/reload investigation this page came out of. Captured
// timestamps and an in-progress video URL live only in local React state until
// their own Save button is clicked, so without this they'd vanish with no
// warning. Persist them as-you-go and restore on mount instead.
const DRAFT_STORAGE_KEY = 'sluggers-video-timestamps-draft'

function readStoredDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function writeStoredDraft(value) {
  try {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(value))
  } catch {
    // best-effort only
  }
}

export default function VideoTimestamps() {
  const { isScorekeeper } = useAuth()
  const { pushToast } = useToast()
  const playerRef = useRef(null)
  const pendingRestoreRef = useRef(readStoredDraft())
  const skipNextSourceResetRef = useRef(true)

  const [source, setSource] = useState(() => pendingRestoreRef.current?.source || 'tournament')
  const [playersById, setPlayersById] = useState({})
  const [teamsById, setTeamsById] = useState({})
  const [charactersById, setCharactersById] = useState({})
  const [stadiumNamesById, setStadiumNamesById] = useState({})
  const [selectedGameId, setSelectedGameId] = useState(() => pendingRestoreRef.current?.selectedGameId || '')
  const [selectedPaId, setSelectedPaId] = useState(() => pendingRestoreRef.current?.selectedPaId ?? null)
  const [videoUrlDraft, setVideoUrlDraft] = useState('')
  const [savingVideoUrl, setSavingVideoUrl] = useState(false)
  const [pas, setPas] = useState([])
  const [loadingPas, setLoadingPas] = useState(false)
  const [savingPaId, setSavingPaId] = useState(null)
  const [drafts, setDrafts] = useState(() => pendingRestoreRef.current?.drafts || {})

  const [games, setGames] = useCompletedGames(source, { enabled: isScorekeeper })
  const tables = TABLES[source]
  const selectedGame = games.find((g) => String(g.id) === String(selectedGameId)) || null
  const videoId = extractYouTubeId(videoUrlDraft)

  useEffect(() => {
    if (!isScorekeeper) {
      setPlayersById({})
      setTeamsById({})
      setCharactersById({})
      setStadiumNamesById({})
      return undefined
    }

    let cancelled = false

    Promise.all([
      supabase.from('players').select('*'),
      supabase.from('season_teams').select('*'),
      supabase.from('characters').select('id, name'),
      supabase.from('stadiums').select('id, name'),
    ]).then(([playersResult, teamsResult, charactersResult, stadiumsResult]) => {
      if (cancelled) return
      setPlayersById(Object.fromEntries((playersResult.data || []).map((p) => [p.id, p])))
      setTeamsById(Object.fromEntries((teamsResult.data || []).map((t) => [t.id, t])))
      setCharactersById(Object.fromEntries((charactersResult.data || []).map((c) => [c.id, c])))
      setStadiumNamesById(Object.fromEntries((stadiumsResult.data || []).map((s) => [s.id, s.name])))
    })

    return () => { cancelled = true }
  }, [isScorekeeper])

  useEffect(() => {
    if (skipNextSourceResetRef.current) {
      skipNextSourceResetRef.current = false
      return
    }
    setSelectedGameId('')
    setPas([])
    setSelectedPaId(null)
  }, [source])

  useEffect(() => {
    setVideoUrlDraft(selectedGame?.video_url || '')
  }, [selectedGame])

  // Reapplies restored drafts/video-url once the matching game's data has
  // loaded, overriding the defaults the effects above just set.
  useEffect(() => {
    const restore = pendingRestoreRef.current
    if (!restore || !selectedGame || loadingPas) return
    if (String(restore.selectedGameId) !== String(selectedGameId)) return
    if (restore.videoUrlDraft !== undefined) setVideoUrlDraft(restore.videoUrlDraft)
    if (restore.drafts) setDrafts(restore.drafts)
    pendingRestoreRef.current = null
  }, [selectedGame, loadingPas, selectedGameId])

  useEffect(() => {
    writeStoredDraft({ source, selectedGameId, selectedPaId, videoUrlDraft, drafts })
  }, [source, selectedGameId, selectedPaId, videoUrlDraft, drafts])

  useEffect(() => {
    if (!isScorekeeper || !selectedGameId) {
      setPas([])
      setLoadingPas(false)
      return
    }
    let cancelled = false
    setLoadingPas(true)
    setSelectedPaId(null)
    supabase
      .from(tables.pa)
      .select('*')
      .eq('game_id', selectedGameId)
      .order('inning', { ascending: true })
      .order('pa_number', { ascending: true })
      .then(({ data }) => {
        if (cancelled) return
        setPas(data || [])
        setDrafts({})
        setLoadingPas(false)
      })
    return () => { cancelled = true }
  }, [isScorekeeper, selectedGameId, tables.pa])

  if (!isScorekeeper) {
    return (
      <div className="page-shell">
        <section className="panel"><p className="muted" style={{ margin: 0 }}>Scorekeeper access required.</p></section>
      </div>
    )
  }

  async function saveVideoUrl() {
    if (!selectedGameId) return
    setSavingVideoUrl(true)
    const { error } = await supabase.from(tables.games).update({ video_url: videoUrlDraft || null }).eq('id', selectedGameId)
    setSavingVideoUrl(false)
    if (error) {
      pushToast({ title: 'Save failed', message: error.message, type: 'error' })
      return
    }
    const savedUrl = videoUrlDraft || null
    setGames((current) => current.map((g) => (String(g.id) === String(selectedGameId) ? { ...g, video_url: savedUrl } : g)))
    pushToast({ title: 'Video URL saved', type: 'success' })
  }

  async function savePaTimestamps(pa) {
    const draft = drafts[pa.id] || {}
    const payload = {
      video_timestamp_start_sec: draft.start !== undefined ? draft.start : pa.video_timestamp_start_sec,
      video_timestamp_end_sec: draft.end !== undefined ? draft.end : pa.video_timestamp_end_sec,
    }
    setSavingPaId(pa.id)
    const { error } = await supabase.from(tables.pa).update(payload).eq('id', pa.id)
    setSavingPaId(null)
    if (error) {
      pushToast({ title: 'Save failed', message: error.message, type: 'error' })
      return
    }
    setPas((current) => current.map((p) => (p.id === pa.id ? { ...p, ...payload } : p)))
    pushToast({ title: 'Timestamps saved', type: 'success' })
  }

  function captureTime(pa, field) {
    const current = playerRef.current?.getCurrentTime?.()
    if (current == null) {
      pushToast({ title: 'Video not ready', type: 'error' })
      return
    }
    const seconds = Math.round(current * 100) / 100
    setDrafts((cur) => ({ ...cur, [pa.id]: { ...cur[pa.id], [field]: seconds, [`${field}Text`]: formatSecondsAsRawInput(seconds) } }))
  }

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <section className="panel" style={{ padding: 20, display: 'grid', gap: 16 }}>
        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>Video Timestamps</h1>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          Link a YouTube video to a game, then mark where each at-bat starts and ends in that video.
        </p>

        <label style={{ display: 'grid', gap: 4, fontSize: 12, maxWidth: 200 }}>
          <span className="muted" style={{ textTransform: 'uppercase', fontWeight: 700, fontSize: 10 }}>Source</span>
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="tournament">Tournament</option>
            <option value="season">Season</option>
          </select>
        </label>

        {games.length === 0 ? (
          <div className="muted" style={{ fontSize: 13 }}>No completed games yet.</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
            {games.map((game) => (
              <GameCard
                key={game.id}
                game={game}
                source={source}
                playersById={playersById}
                teamsById={teamsById}
                stadiumNamesById={stadiumNamesById}
                selected={String(game.id) === String(selectedGameId)}
                onSelect={() => setSelectedGameId(game.id)}
              />
            ))}
          </div>
        )}

        {selectedGame ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="text"
              placeholder="https://www.youtube.com/watch?v=..."
              value={videoUrlDraft}
              onChange={(e) => setVideoUrlDraft(e.target.value)}
              style={{ flex: 1, minWidth: 260, padding: '8px 10px' }}
            />
            <button type="button" className="primary-button" onClick={saveVideoUrl} disabled={savingVideoUrl}>
              {savingVideoUrl ? 'Saving…' : 'Save video URL'}
            </button>
          </div>
        ) : null}
      </section>

      {selectedGame ? (
        <>
          <section className="panel" style={{ padding: 20 }}>
            <YouTubePlayer ref={playerRef} videoId={videoId} />
            {!videoId ? <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>Enter and save a valid YouTube URL above to load the player.</div> : null}
          </section>

          <section className="panel" style={{ padding: 20, display: 'grid', gap: 10 }}>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 800 }}>Play by play</h2>
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>Select a plate appearance to set its video timestamps.</p>
            {loadingPas ? <div className="muted">Loading…</div> : null}
            {!loadingPas && pas.length === 0 ? <div className="muted" style={{ fontSize: 13 }}>No at-bats recorded for this game.</div> : null}
            {pas.map((pa) => {
              const isSelected = selectedPaId === pa.id
              const draft = drafts[pa.id] || {}
              const start = draft.start !== undefined ? draft.start : pa.video_timestamp_start_sec
              const end = draft.end !== undefined ? draft.end : pa.video_timestamp_end_sec
              const batterName = charactersById[pa.character_id]?.name || 'Unknown batter'

              if (!isSelected) {
                return (
                  <button
                    key={pa.id}
                    type="button"
                    onClick={() => setSelectedPaId(pa.id)}
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border, rgba(148,163,184,0.2))', background: 'transparent', textAlign: 'left', cursor: 'pointer' }}
                  >
                    <div style={{ fontSize: 13 }}>
                      <strong>{batterName}</strong>
                      <span className="muted"> · Inning {pa.inning} · {formatPaResultLabel(pa)}</span>
                    </div>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {start != null || end != null ? `${formatSecondsAsClock(start)} – ${formatSecondsAsClock(end)}` : 'Not set'}
                    </span>
                  </button>
                )
              }

              return (
                <div key={pa.id} style={{ display: 'grid', gap: 10, padding: '10px', borderRadius: 8, border: '2px solid #EAB308', background: 'rgba(234,179,8,0.06)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontSize: 13 }}>
                      <strong>{batterName}</strong>
                      <span className="muted"> · Inning {pa.inning} · {formatPaResultLabel(pa)}</span>
                    </div>
                    <button type="button" className="ghost-button" onClick={() => setSelectedPaId(null)}>Close</button>
                  </div>
                  <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <input
                        type="text"
                        inputMode="numeric"
                        placeholder="e.g. 1054"
                        value={draft.startText !== undefined ? draft.startText : formatSecondsAsRawInput(start)}
                        onChange={(e) => setDrafts((cur) => ({ ...cur, [pa.id]: { ...cur[pa.id], startText: e.target.value, start: parseRawClockInput(e.target.value) } }))}
                        style={{ width: 90 }}
                      />
                      <button type="button" className="ghost-button" onClick={() => captureTime(pa, 'start')} title="Capture current player time">{formatSecondsAsClock(start)}</button>
                    </div>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <input
                        type="text"
                        inputMode="numeric"
                        placeholder="e.g. 1054"
                        value={draft.endText !== undefined ? draft.endText : formatSecondsAsRawInput(end)}
                        onChange={(e) => setDrafts((cur) => ({ ...cur, [pa.id]: { ...cur[pa.id], endText: e.target.value, end: parseRawClockInput(e.target.value) } }))}
                        style={{ width: 90 }}
                      />
                      <button type="button" className="ghost-button" onClick={() => captureTime(pa, 'end')} title="Capture current player time">{formatSecondsAsClock(end)}</button>
                    </div>
                    <button type="button" className="primary-button" disabled={savingPaId === pa.id} onClick={() => savePaTimestamps(pa)}>
                      {savingPaId === pa.id ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </div>
              )
            })}
          </section>
        </>
      ) : null}
    </div>
  )
}
