import { Suspense, useEffect, useState } from 'react'
import { C } from './theme'

const LOCAL_SITE = ['localhost', '127.0.0.1'].includes(window.location.hostname)
const GAME_CONTROL_URL = LOCAL_SITE
  ? `${window.location.origin}/game-control`
  : 'http://127.0.0.1:4318'

function StartGameControl({ gameId, table }) {
  const launchKey = `sluggers-game-started:${table}:${gameId}`
  const [launched, setLaunched] = useState(() => {
    try { return window.sessionStorage.getItem(launchKey) === '1' } catch { return false }
  })
  const [status, setStatus] = useState(null)
  const [message, setMessage] = useState('')
  const [starting, setStarting] = useState(false)
  const [armed, setArmed] = useState(LOCAL_SITE || launched)

  const rememberLaunch = (value) => {
    setLaunched(value)
    try {
      if (value) window.sessionStorage.setItem(launchKey, '1')
      else window.sessionStorage.removeItem(launchKey)
    } catch { /* Browsers can disable session storage. */ }
  }

  useEffect(() => {
    if (!armed) return undefined
    let active = true
    const refresh = async () => {
      try {
        const response = await fetch(`${GAME_CONTROL_URL}/status`, { cache: 'no-store' })
        if (!response.ok) throw new Error(`Local launcher returned ${response.status}`)
        const next = await response.json()
        if (next.service !== 'sluggers-game-control') throw new Error('Another service is using the game launcher port')
        if (active) setStatus(next)
      } catch {
        if (active) setStatus(null)
      }
    }
    refresh()
    const timer = setInterval(refresh, 1500)
    return () => { active = false; clearInterval(timer) }
  }, [armed])

  useEffect(() => {
    if (LOCAL_SITE || !armed || (status && String(status.gameId) === String(gameId) && status.table === table)) return undefined
    const timer = setTimeout(() => {
      setMessage('No local helper connected. Allow the browser prompts, or register the Sluggers Game link using the one-time setup below.')
      rememberLaunch(false)
    }, 8000)
    return () => clearTimeout(timer)
  }, [armed, status, gameId, table])

  useEffect(() => {
    if (!status || String(status.gameId) !== String(gameId) || status.table !== table) return
    if (status.phase === 'failed') rememberLaunch(false)
    else if (['starting', 'selecting_teams', 'game_live', 'finished'].includes(status.phase)) rememberLaunch(true)
  }, [status, gameId, table])

  const busy = status && ['starting', 'selecting_teams', 'game_live', 'stopping'].includes(status.phase)
  const start = async () => {
    setStarting(true)
    setMessage('Starting the local game launcher…')
    try {
      const response = await fetch(`${GAME_CONTROL_URL}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId, table }),
      })
      const next = await response.json()
      if (!response.ok) throw new Error(next.error || `Local launcher returned ${response.status}`)
      setStatus(next)
      rememberLaunch(true)
      setMessage('Game setup started. The lineup and tracker are being prepared.')
    } catch (error) {
      rememberLaunch(false)
      setMessage(error instanceof TypeError
        ? 'The local game helper is offline. Start it once on the Dolphin computer.'
        : error.message)
    } finally {
      setStarting(false)
    }
  }

  const activeHere = busy && String(status.gameId) === String(gameId) && status.table === table
  // Once the match is live the tracker below is the whole story; the launch
  // controls and setup log are only noise until the game is reset.
  if (activeHere && status.phase === 'game_live') return null
  const showInstructions = !launched && !activeHere
  const latestLine = activeHere ? status.lines?.at(-1) : null
  const gameLink = `sluggers-game://start?game=${gameId}&table=${table}`
  return (
    <section style={{ padding: '12px 14px', marginBottom: 12, border: `1px solid ${C.border}`, borderRadius: 10, background: C.card }} aria-label="Start this game">
      {showInstructions && (
        <>
          <div style={{ fontWeight: 700, marginBottom: 5 }}>Start this game</div>
          <ol style={{ color: C.muted, fontSize: 13, margin: '0 0 8px', paddingLeft: 20 }}>
            <li>In Dolphin, enable cheats and the MSS Autoteam and Input Suppression Gecko codes for Mario Super Sluggers.</li>
            <li>Open the game and stop at the main menu with Exhibition Mode highlighted.</li>
            <li>On that computer, click the button below to inject both lineups and start the game.</li>
          </ol>
        </>
      )}
      {LOCAL_SITE ? (
        <button type="button" className="solid-button" onClick={start} disabled={starting || busy}>
          {activeHere ? status.phase === 'stopping' ? 'Stopping tracker…' : 'Game starting…' : 'Inject lineups and start game'}
        </button>
      ) : busy ? (
        <button type="button" className="solid-button" disabled>{status.phase === 'stopping' ? 'Stopping tracker…' : 'Game starting…'}</button>
      ) : (
        <a href={gameLink} className="solid-button" style={{ display: 'inline-block', textDecoration: 'none' }}
          onClick={() => {
            rememberLaunch(true)
            setArmed(true)
            setMessage('Allow the browser to open Sluggers Game and to access the local helper if asked. Setup progress will appear here.')
          }}>
          Inject lineups and start game
        </a>
      )}
      {(message || latestLine) && (
        <p role="status" style={{ color: C.muted, fontSize: 12, margin: '7px 0 0' }}>
          {latestLine || message}
        </p>
      )}
      {busy && !activeHere && (
        <p style={{ color: C.muted, fontSize: 12, margin: '7px 0 0' }}>
          The local launcher is already running game {status.gameId}.
        </p>
      )}
      {status?.phase === 'failed' && String(status.gameId) === String(gameId) && (
        <p role="alert" style={{ color: '#f87171', fontSize: 12, margin: '7px 0 0' }}>
          Game setup failed: {status.lines?.at(-1) || `exit ${status.exitCode}`}
        </p>
      )}
      {status?.lines?.length > 0 && String(status.gameId) === String(gameId) && (
        <details style={{ color: C.muted, fontSize: 12, marginTop: 8 }}>
          <summary>Setup log</summary>
          <pre style={{ maxHeight: 240, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {status.lines.join('\n')}
          </pre>
        </details>
      )}
      {!LOCAL_SITE && !status && showInstructions && (
        <details style={{ color: C.muted, fontSize: 12, marginTop: 8 }}>
          <summary>First time using this button?</summary>
          <p>On the Dolphin computer, register the Sluggers Game link once by running
            <code> scripts/install_game_protocol.ps1</code> from the project folder. The browser may ask you to open Sluggers Game.</p>
        </details>
      )}
      {showInstructions && (
        <details style={{ color: C.muted, fontSize: 12, marginTop: 9 }}>
          <summary style={{ cursor: 'pointer' }}>Need to add the Gecko codes?</summary>
          <div style={{ margin: '7px 0' }}>In the game’s Dolphin Properties → Gecko Codes, add and enable these two codes, then restart the game:</div>
          <div style={{ marginBottom: 7 }}>MSS Autoteam</div>
          <pre style={{ margin: '0 0 9px', padding: 9, borderRadius: 6, background: C.bg, overflowX: 'auto' }}>{'040802b4 60000000\n040802b8 60000000\n0406aed8 48000b80'}</pre>
          <div style={{ marginBottom: 7 }}>Input Suppression</div>
          <pre style={{ margin: 0, padding: 9, borderRadius: 6, background: C.bg, overflowX: 'auto' }}>{'20002F00 00000001\n045FD3F0 60000000\nE0000000 80008000\n20002F00 00000000\n045FD3F0 901F0000\nE0000000 80008000'}</pre>
        </details>
      )}
    </section>
  )
}

export function AtBatEditorScorebookView({
  toolbar,
  tabs,
  selectedGame,
  isSeasonGame,
  editorRef,
  onDirtyChange,
  EditorComponent,
}) {
  return (
    <div style={{ color: C.text, paddingBottom: 40, margin: '-1.25rem -1.25rem 0' }}>
      {toolbar}
      {tabs}
      <div style={{ padding: '8px 10px 32px' }}>
        {!selectedGame ? (
          <div style={{ color: C.muted, textAlign: 'center', padding: 24 }}>Select a game to edit its at-bats.</div>
        ) : (
          <Suspense fallback={<div style={{ color: C.muted, textAlign: 'center', padding: 24 }}>Loading editor…</div>}>
            <EditorComponent
              ref={editorRef}
              source={isSeasonGame ? 'season' : 'tournament'}
              gameId={selectedGame.id}
              embedded
              onDirtyChange={onDirtyChange}
            />
          </Suspense>
        )}
      </div>
    </div>
  )
}

export function TrackerScorebookView({
  toolbar,
  tabs,
  selectedGame,
  isSeasonGame,
  TrackerComponent,
}) {
  return (
    <div style={{ color: C.text, paddingBottom: 40, margin: '-1.25rem -1.25rem 0' }}>
      {toolbar}
      {tabs}
      <div style={{ padding: '8px 10px 32px' }}>
        {!selectedGame ? (
          <div style={{ color: C.muted, textAlign: 'center', padding: 24 }}>Select a game to watch its tracker feed.</div>
        ) : (
          <Suspense fallback={<div style={{ color: C.muted, textAlign: 'center', padding: 24 }}>Loading tracker feed…</div>}>
            <>
              {!['complete', 'completed'].includes(selectedGame.status) && (
                <StartGameControl
                  key={`${isSeasonGame ? 'season_schedule' : 'games'}:${selectedGame.id}`}
                  gameId={selectedGame.id}
                  table={isSeasonGame ? 'season_schedule' : 'games'}
                />
              )}
              <TrackerComponent embedded expectedGameId={selectedGame.id} expectedGameStatus={selectedGame.status} />
            </>
          </Suspense>
        )}
      </div>
    </div>
  )
}
