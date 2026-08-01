import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Maximize2, Minimize2, Pause, Play, RotateCcw } from 'lucide-react'
import { buildYouTubeEmbedUrl, formatSecondsAsClock } from '../utils/video'

let iframeApiPromise = null

// Loads the YouTube IFrame API script once and resolves when window.YT is
// ready to construct players. Shared across every YouTubePlayer instance.
function loadYouTubeIframeApi() {
  if (iframeApiPromise) return iframeApiPromise

  iframeApiPromise = new Promise((resolve) => {
    if (window.YT && window.YT.Player) {
      resolve(window.YT)
      return
    }

    const previousCallback = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previousCallback === 'function') previousCallback()
      resolve(window.YT)
    }

    if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
      const script = document.createElement('script')
      script.src = 'https://www.youtube.com/iframe_api'
      document.head.appendChild(script)
    }
  })

  return iframeApiPromise
}

// Thin wrapper around the YouTube IFrame API, exposing imperative playback
// controls via ref so callers (AtBatPage, VideoTimestamps) can seek/capture
// the current time without re-rendering the embed.
//
// When both startSec and endSec are given, this renders its own play/pause,
// restart, and scrubber UI scoped to that clip window instead of YouTube's
// native controls — so the at-bat clip reads and scrubs as if it were a
// standalone video the length of the at-bat, not a scrub point in a full game
// broadcast. Callers that need to scrub the full video (VideoTimestamps, to
// find timestamps in the first place) simply don't pass endSec and get the
// native controls as before.
const YouTubePlayer = forwardRef(function YouTubePlayer({ videoId, startSec, endSec, style }, ref) {
  const rootRef = useRef(null)
  const containerRef = useRef(null)
  const playerRef = useRef(null)
  const endSecRef = useRef(endSec)
  const startSecRef = useRef(startSec)
  const pollRef = useRef(null)
  const primingRef = useRef(false)
  const primingTimeoutRef = useRef(null)
  const [isReady, setIsReady] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isAtClipEnd, setIsAtClipEnd] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [progressSec, setProgressSec] = useState(startSec ?? 0)
  // While the user is dragging the scrubber, the thumb follows this local
  // value instead of actual playback progress. The whole point of scrubbing
  // here is watching frames go by to find an exact contact/landing/fielded
  // moment, so the video does need to actually seek during the drag, not
  // just on release — lastDragSeekRef below throttles those seeks instead
  // of skipping them, since firing one on every pixel of mouse movement is
  // what made it stutter.
  const [scrubValue, setScrubValue] = useState(null)
  const lastDragSeekRef = useRef(0)

  const hasClip = startSec != null && endSec != null && endSec > startSec

  useEffect(() => {
    endSecRef.current = endSec
  }, [endSec])

  useEffect(() => {
    startSecRef.current = startSec
  }, [startSec])

  useEffect(() => {
    function handleFullscreenChange() {
      setIsFullscreen(document.fullscreenElement === rootRef.current)
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])

  useEffect(() => {
    let cancelled = false
    setIsReady(false)
    setIsPlaying(false)
    setIsAtClipEnd(false)
    setProgressSec(startSec ?? 0)

    if (!videoId || !containerRef.current) return undefined

    loadYouTubeIframeApi().then((YT) => {
      if (cancelled || !containerRef.current) return

      playerRef.current = new YT.Player(containerRef.current, {
        videoId,
        playerVars: {
          start: startSec != null ? Math.max(0, Math.floor(startSec)) : undefined,
          modestbranding: 1,
          rel: 0,
          iv_load_policy: 3,
          cc_load_policy: 0,
          fs: 1,
          controls: hasClip ? 0 : 1,
          disablekb: hasClip ? 1 : 0,
        },
        events: {
          onReady: () => {
            if (cancelled) return
            setIsReady(true)
            // cc_load_policy=0 only sets the default — many browsers still
            // override it with the viewer's saved YouTube caption
            // preference. Tearing out the captions module entirely is the
            // only reliable way to force them off.
            playerRef.current?.unloadModule?.('captions')
            if (hasClip) {
              // Silently play-then-pause right away so the clip is already
              // buffered by the time the user actually presses play — a
              // cold play always has to buffer first, and that buffering
              // shows YouTube's own loading UI through once our cover comes
              // down. Doing it now, while the cover is already up for other
              // reasons, means the real click starts instantly.
              primingRef.current = true
              playerRef.current.playVideo()
              primingTimeoutRef.current = setTimeout(() => {
                primingRef.current = false
              }, 4000)
            }
          },
          // Poll while playing so playback can be stopped right at the
          // at-bat's recorded end timestamp — the IFrame API has no native
          // "stop at time" option, only start-time playerVars. Also drives
          // the custom scrubber's progress while a clip is active.
          onStateChange: (event) => {
            if (primingRef.current) {
              if (event.data === YT.PlayerState.PLAYING) {
                playerRef.current.pauseVideo()
              } else if (event.data === YT.PlayerState.PAUSED) {
                clearTimeout(primingTimeoutRef.current)
                primingRef.current = false
              }
              return
            }
            clearInterval(pollRef.current)
            const playing = event.data === YT.PlayerState.PLAYING
            if (playing) playerRef.current?.unloadModule?.('captions')
            setIsPlaying(playing)
            if (!playing) return
            setIsAtClipEnd(false)
            // 40ms (~25fps) instead of the old 200ms — getCurrentTime is
            // cheap, and the slower rate made the scrubber thumb visibly
            // hop forward in steps during playback instead of gliding.
            pollRef.current = setInterval(() => {
              const current = playerRef.current?.getCurrentTime?.()
              if (current == null) return
              setProgressSec(current)
              const end = endSecRef.current
              if (end != null && current >= end) {
                playerRef.current.pauseVideo()
                setIsAtClipEnd(true)
                clearInterval(pollRef.current)
              }
            }, 40)
          },
        },
      })
    })

    return () => {
      cancelled = true
      clearInterval(pollRef.current)
      clearTimeout(primingTimeoutRef.current)
      primingRef.current = false
      if (playerRef.current?.destroy) {
        playerRef.current.destroy()
        playerRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId])

  useImperativeHandle(ref, () => ({
    seekTo(sec) {
      playerRef.current?.seekTo?.(sec, true)
    },
    play() {
      playerRef.current?.playVideo?.()
    },
    pause() {
      playerRef.current?.pauseVideo?.()
    },
    getCurrentTime() {
      return playerRef.current?.getCurrentTime?.() ?? null
    },
    isReady() {
      return isReady
    },
  }))

  function restartClip() {
    const start = startSecRef.current ?? 0
    playerRef.current?.seekTo?.(start, true)
    setProgressSec(start)
    setIsAtClipEnd(false)
    playerRef.current?.playVideo?.()
  }

  // The end-of-clip pause is just a regular pauseVideo() at endSec, not a
  // true "ended" player state — resuming with a plain playVideo() would keep
  // playing forward into the rest of the full broadcast. Route play presses
  // through here so pressing play after the clip finishes restarts it instead.
  function handlePlayClick() {
    if (!playerRef.current) return
    if (isAtClipEnd) {
      restartClip()
      return
    }
    if (isPlaying) playerRef.current.pauseVideo?.()
    else playerRef.current.playVideo?.()
  }

  function seekWithinClip(sec) {
    const start = startSecRef.current ?? 0
    playerRef.current?.seekTo?.(start + sec, true)
    setProgressSec(start + sec)
    setIsAtClipEnd(false)
  }

  // Called on every drag tick — updates the thumb immediately, and seeks the
  // actual video too (throttled) so frames visibly advance while dragging,
  // which is the reason to scrub in the first place.
  const DRAG_SEEK_THROTTLE_MS = 120
  function scrubTo(sec) {
    setScrubValue(sec)
    const now = performance.now()
    if (now - lastDragSeekRef.current < DRAG_SEEK_THROTTLE_MS) return
    lastDragSeekRef.current = now
    const start = startSecRef.current ?? 0
    playerRef.current?.seekTo?.(start + sec, true)
  }

  // Fires on release (mouseup/touchend/keyup) — guarantees the final
  // position lands exactly where released, bypassing the throttle above.
  function commitScrub() {
    if (scrubValue == null) return
    seekWithinClip(scrubValue)
    setScrubValue(null)
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen()
    } else {
      rootRef.current?.requestFullscreen?.()
    }
  }

  if (!videoId) {
    return (
      <div
        className="video-player-placeholder"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--panel-muted, #1a1a1a)', color: 'var(--text-muted, #888)', aspectRatio: '16 / 9', borderRadius: 8, ...style }}
      >
        No video linked
      </div>
    )
  }

  const clipDuration = hasClip ? endSec - startSec : 0
  const clipElapsed = hasClip ? Math.min(Math.max(progressSec - startSec, 0), clipDuration) : 0
  const displayedElapsed = scrubValue ?? clipElapsed

  return (
    <div
      ref={rootRef}
      style={
        isFullscreen
          ? { display: 'flex', flexDirection: 'column', gap: 8, height: '100%', background: '#000', padding: 8 }
          : { display: 'grid', gap: 8, ...style }
      }
    >
      <div style={isFullscreen ? { position: 'relative', width: '100%', flex: 1, minHeight: 0 } : { position: 'relative', width: '100%', aspectRatio: '16 / 9' }}>
        <div ref={containerRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
        {hasClip ? (
          // Transparent click-catcher: sits above the iframe in every state
          // so mouse movement never reaches YouTube's own document (which is
          // what triggers its hover-revealed title bar even with
          // controls=0), and so a click anywhere on the video toggles
          // play/pause through our own handler instead of YouTube's.
          <div
            onClick={isReady ? handlePlayClick : undefined}
            style={{ position: 'absolute', inset: 0, cursor: isReady ? 'pointer' : 'default', background: 'transparent' }}
          />
        ) : null}
      </div>
      {hasClip ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '8px 10px',
            borderRadius: 8,
            background: 'var(--panel-muted, rgba(15,23,42,0.6))',
            border: '1px solid var(--border, rgba(148,163,184,0.2))',
          }}
        >
          <button
            type="button"
            onClick={handlePlayClick}
            disabled={!isReady}
            title={isAtClipEnd ? 'Restart' : isPlaying ? 'Pause' : 'Play'}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 6, border: 'none', background: 'var(--accent, #EAB308)', color: '#1a1a1a', cursor: 'pointer', flexShrink: 0 }}
          >
            {isAtClipEnd ? <RotateCcw size={14} /> : isPlaying ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
          </button>
          <input
            type="range"
            min={0}
            max={clipDuration}
            step={0.01}
            value={displayedElapsed}
            disabled={!isReady}
            onChange={(e) => scrubTo(Number(e.target.value))}
            onMouseUp={commitScrub}
            onTouchEnd={commitScrub}
            onKeyUp={commitScrub}
            style={{ flex: 1, accentColor: 'var(--accent, #EAB308)' }}
          />
          <span className="muted" style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
            {formatSecondsAsClock(displayedElapsed)} / {formatSecondsAsClock(clipDuration)}
          </span>
          <button
            type="button"
            onClick={toggleFullscreen}
            title={isFullscreen ? 'Exit full screen' : 'Full screen'}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 6, border: '1px solid var(--border, rgba(148,163,184,0.3))', background: 'transparent', color: 'var(--text, #E2E8F0)', cursor: 'pointer', flexShrink: 0 }}
          >
            {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </div>
      ) : null}
    </div>
  )
})

export default YouTubePlayer

// Non-JS-API fallback embed for contexts that only need a fixed seek point
// with no imperative control (kept here so both call sites can pick either).
export function buildStaticEmbedUrl(videoId, startSec) {
  return buildYouTubeEmbedUrl(videoId, { startSec })
}
