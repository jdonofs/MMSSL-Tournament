// Parses a YouTube URL (watch, share, or embed form) into its 11-char video
// id, or returns null if the string isn't a recognizable YouTube URL.
export function extractYouTubeId(url) {
  if (!url || typeof url !== 'string') return null

  const trimmed = url.trim()
  if (!trimmed) return null

  const patterns = [
    /(?:youtube\.com\/watch\?(?:.*&)?v=)([\w-]{11})/,
    /(?:youtube\.com\/embed\/)([\w-]{11})/,
    /(?:youtube\.com\/shorts\/)([\w-]{11})/,
    /(?:youtu\.be\/)([\w-]{11})/,
  ]

  for (const pattern of patterns) {
    const match = trimmed.match(pattern)
    if (match) return match[1]
  }

  // Bare 11-char id pasted directly.
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed

  return null
}

export function buildYouTubeEmbedUrl(videoId, { startSec, autoplay = false } = {}) {
  if (!videoId) return null

  const params = new URLSearchParams({ enablejsapi: '1', modestbranding: '1', rel: '0', iv_load_policy: '3', cc_load_policy: '0' })
  if (startSec != null && Number.isFinite(startSec)) {
    params.set('start', String(Math.max(0, Math.floor(startSec))))
  }
  if (autoplay) params.set('autoplay', '1')

  return `https://www.youtube.com/embed/${videoId}?${params.toString()}`
}

export function formatSecondsAsClock(totalSeconds) {
  if (totalSeconds == null || !Number.isFinite(totalSeconds)) return '--:--'

  const seconds = Math.max(0, Math.floor(totalSeconds))
  const minutes = Math.floor(seconds / 60)
  const remaining = seconds % 60
  return `${minutes}:${String(remaining).padStart(2, '0')}`
}

// Lets a scorekeeper type a video timestamp as one raw number the way it
// reads on the player's clock (10:54 -> "1054") instead of computing total
// seconds by hand. The last two digits are seconds, everything before that
// is minutes.
export function parseRawClockInput(raw) {
  if (raw === '' || raw == null) return null
  const str = String(raw).trim()
  if (!/^\d+(\.\d+)?$/.test(str)) return null

  const [intPart, fracPart] = str.split('.')
  const secsPart = intPart.slice(-2).padStart(2, '0')
  const minsPart = intPart.slice(0, -2) || '0'
  const seconds = Number(minsPart) * 60 + Number(secsPart)
  return fracPart ? Number(`${seconds}.${fracPart}`) : seconds
}

// Inverse of parseRawClockInput, for displaying a stored seconds value back
// in the same raw MMSS form the input expects.
export function formatSecondsAsRawInput(totalSeconds) {
  if (totalSeconds == null || !Number.isFinite(totalSeconds)) return ''

  const whole = Math.floor(totalSeconds)
  const minutes = Math.floor(whole / 60)
  const remaining = whole % 60
  const base = `${minutes}${String(remaining).padStart(2, '0')}`

  const frac = totalSeconds - whole
  if (frac > 0.001) return `${base}${frac.toFixed(2).slice(1)}`
  return base
}
