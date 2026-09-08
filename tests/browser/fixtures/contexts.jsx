// Context stand-ins for the betting UI fixture. Each real context module is
// redirected to this file by the fixture Vite plugin, so BettingTab and the
// components it renders get a fixed, deterministic session instead of a live
// Supabase-backed one.
const fixture = () => globalThis.__BETTING_FIXTURE__ || {}

export function useAuth() {
  const { player, isScorekeeper = true } = fixture()
  return { player: player || null, isScorekeeper, is_logged_in: Boolean(player) }
}

export function AuthProvider({ children }) { return children }

export function useTournament() {
  const { tournament = null, tournaments = null } = fixture()
  // BettingTab labels a ticket's competition from this list.
  return { currentTournament: tournament, tournaments: tournaments || (tournament ? [tournament] : []) }
}

export function TournamentProvider({ children }) { return children }

export function useSeason() {
  const { season = null, seasonTeams = [], allSeasons = null } = fixture()
  return {
    currentSeason: season,
    seasons: [],
    allSeasons: allSeasons || (season ? [season] : []),
    seasonTeams,
  }
}

export function SeasonProvider({ children }) { return children }

export function useToast() {
  return {
    pushToast(toast) {
      globalThis.__BETTING_TOASTS__ = globalThis.__BETTING_TOASTS__ || []
      globalThis.__BETTING_TOASTS__.push(toast)
    },
    dismissToast() {},
    toasts: [],
  }
}

export function ToastProvider({ children }) { return children }
