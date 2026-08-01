import { useLocation } from 'react-router-dom'

// Pages listed here are intentionally excluded from the app's always-on realtime channels
// (Auth/Season/Tournament/Navbar's pending-trades subscription). Those channels normally need
// to stay open on every page for live cross-app updates, but an open realtime WebSocket
// connection disqualifies a page from the browser's back/forward cache (bfcache) — so a page
// that has no need for live updates pays that cost for nothing, becoming unable to use bfcache
// (and thus showing a full reload instead of an instant restore) with no benefit in exchange.
const REALTIME_PAUSED_PATH_PREFIXES = ['/admin/video-timestamps']

export default function useRealtimeEnabled() {
  const location = useLocation()
  return !REALTIME_PAUSED_PATH_PREFIXES.some((prefix) => location.pathname.startsWith(prefix))
}
