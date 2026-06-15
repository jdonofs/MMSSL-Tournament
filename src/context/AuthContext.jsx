import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../supabaseClient'

const AuthContext = createContext(null)

function extractPlayer(data) {
  return {
    id: data.id,
    name: data.name,
    color: data.color,
    email: data.email || null,
    auth_user_id: data.auth_user_id || null,
    is_commissioner: data.is_commissioner || false,
    scorebook_access: data.scorebook_access || false,
    team_name: data.team_name || null,
    team_location: data.team_location || null,
    team_mascot: data.team_mascot || null,
    team_abbreviation: data.team_abbreviation || null,
    team_primary_color: data.team_primary_color || null,
    team_secondary_color: data.team_secondary_color || null,
    team_logo_url: data.team_logo_url || null,
  }
}

async function fetchLinkedPlayer(userId) {
  const { data, error } = await supabase
    .from('players')
    .select('*')
    .eq('auth_user_id', userId)
    .maybeSingle()

  if (error) {
    throw new Error(error.message)
  }

  return data ? extractPlayer(data) : null
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const sessionRef = useRef(null)
  const [player, setPlayer] = useState(null)
  const [loading, setLoading] = useState(true)

  const resolvePlayerForSession = useCallback(async (nextSession) => {
    const userId = nextSession?.user?.id
    if (!userId) {
      setPlayer(null)
      return null
    }

    const existingPlayer = await fetchLinkedPlayer(userId)
    if (existingPlayer) {
      setPlayer(existingPlayer)
      return existingPlayer
    }

    // Auto-link player record by matching email
    const { data: linkedPlayer, error: linkError } = await supabase.rpc('link_player_to_current_user')
    if (linkError) {
      throw new Error(linkError.message)
    }

    const resolvedPlayer = linkedPlayer ? extractPlayer(linkedPlayer) : null
    setPlayer(resolvedPlayer)
    return resolvedPlayer
  }, [])

  useEffect(() => {
    let active = true

    const initialize = async () => {
      setLoading(true)
      const { data, error } = await supabase.auth.getSession()
      if (!active) return
      if (error) {
        setSession(null)
        setPlayer(null)
        setLoading(false)
        return
      }
      setSession(data.session || null)
      sessionRef.current = data.session || null
      try {
        await resolvePlayerForSession(data.session || null)
      } finally {
        if (active) setLoading(false)
      }
    }

    initialize()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      // TOKEN_REFRESHED fires whenever the tab regains focus/visibility, for
      // the same signed-in user. Re-running setLoading(true) + re-resolving
      // the player on every one of these caused the whole app to flash a
      // loading state (feeling like a forced refresh) every time someone
      // switched tabs. Only treat it as a real session change if the user
      // actually changed.
      if (event === 'TOKEN_REFRESHED' && nextSession?.user?.id === sessionRef.current?.user?.id) {
        setSession(nextSession || null)
        sessionRef.current = nextSession || null
        return
      }

      setSession(nextSession || null)
      sessionRef.current = nextSession || null
      setLoading(true)
      resolvePlayerForSession(nextSession || null)
        .catch(() => {
          if (!active) return
          setPlayer(null)
        })
        .finally(() => {
          if (active) setLoading(false)
        })
    })

    return () => {
      active = false
      subscription.unsubscribe()
    }
  }, [resolvePlayerForSession])

  useEffect(() => {
    if (!player?.id) return undefined

    const channel = supabase
      .channel(`auth-player-${player.id}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: `id=eq.${player.id}` }, async () => {
        const refreshedPlayer = await fetchLinkedPlayer(session?.user?.id)
        setPlayer(refreshedPlayer)
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [player?.id, session?.user?.id])

  const signInWithPassword = useCallback(async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      throw new Error(error.message)
    }
  }, [])

  const changePassword = useCallback(async (newPassword) => {
    const { error } = await supabase.auth.updateUser({ password: newPassword })
    if (error) {
      throw new Error(error.message)
    }
  }, [])

  const refreshPlayer = useCallback(async () => {
    if (!session?.user?.id) return null
    const refreshedPlayer = await fetchLinkedPlayer(session.user.id)
    setPlayer(refreshedPlayer)
    return refreshedPlayer
  }, [session?.user?.id])

  const logout = useCallback(async () => {
    const { error } = await supabase.auth.signOut()
    if (error) {
      throw new Error(error.message)
    }
    setSession(null)
    setPlayer(null)
  }, [])

  const value = useMemo(
    () => ({
      session,
      authUser: session?.user || null,
      player,
      is_logged_in: Boolean(session?.user && player),
      isCommissioner: Boolean(player?.is_commissioner),
      isScorekeeper: Boolean(player && (player.is_commissioner || player.scorebook_access)),
      loading,
      signInWithPassword,
      changePassword,
      refreshPlayer,
      logout,
    }),
    [session, player, loading, signInWithPassword, changePassword, refreshPlayer, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used inside AuthProvider')
  }

  return context
}
