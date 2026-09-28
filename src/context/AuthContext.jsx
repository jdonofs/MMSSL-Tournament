import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../supabaseClient'
import useRealtimeEnabled from '../hooks/useRealtimeEnabled'

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
  const realtimeEnabled = useRealtimeEnabled()
  const [session, setSession] = useState(null)
  const sessionRef = useRef(null)
  const [player, setPlayer] = useState(null)
  const [loading, setLoading] = useState(true)
  const mountedRef = useRef(false)
  const authLifecycleRef = useRef(0)
  const playerRequestRef = useRef(0)

  const isPlayerRequestCurrent = useCallback((request) => Boolean(
    mountedRef.current
    && request.lifecycle === authLifecycleRef.current
    && request.id === playerRequestRef.current
    && request.userId === sessionRef.current?.user?.id
  ), [])

  const beginPlayerRequest = useCallback((userId) => {
    if (!mountedRef.current || !userId || userId !== sessionRef.current?.user?.id) return null

    return {
      id: ++playerRequestRef.current,
      lifecycle: authLifecycleRef.current,
      userId,
    }
  }, [])

  const resolvePlayerForSession = useCallback(async (nextSession, request) => {
    const userId = nextSession?.user?.id
    if (!userId || !request || !isPlayerRequestCurrent(request)) return null

    const existingPlayer = await fetchLinkedPlayer(userId)
    if (!isPlayerRequestCurrent(request)) return null
    if (existingPlayer) {
      setPlayer(existingPlayer)
      return existingPlayer
    }

    // Auto-link player record by matching email
    const { data: linkedPlayer, error: linkError } = await supabase.rpc('link_player_to_current_user')
    if (linkError) {
      throw new Error(linkError.message)
    }
    if (!isPlayerRequestCurrent(request)) return null

    const resolvedPlayer = linkedPlayer ? extractPlayer(linkedPlayer) : null
    setPlayer(resolvedPlayer)
    return resolvedPlayer
  }, [isPlayerRequestCurrent])

  useEffect(() => {
    mountedRef.current = true

    const resolveSession = (nextSession, lifecycle) => {
      const userId = nextSession?.user?.id
      if (!userId) {
        if (mountedRef.current && lifecycle === authLifecycleRef.current) setLoading(false)
        return
      }

      const request = beginPlayerRequest(userId)
      resolvePlayerForSession(nextSession, request)
        .catch(() => {
          if (request && isPlayerRequestCurrent(request)) setPlayer(null)
        })
        .finally(() => {
          if (mountedRef.current && lifecycle === authLifecycleRef.current) setLoading(false)
        })
    }

    const replaceSession = (nextSession) => {
      const lifecycle = ++authLifecycleRef.current
      playerRequestRef.current += 1
      sessionRef.current = nextSession
      setSession(nextSession)
      setPlayer(null)
      setLoading(Boolean(nextSession?.user?.id))
      resolveSession(nextSession, lifecycle)
    }

    const initialize = async () => {
      const lifecycle = ++authLifecycleRef.current
      playerRequestRef.current += 1
      setLoading(true)
      try {
        const { data, error } = await supabase.auth.getSession()
        if (!mountedRef.current || lifecycle !== authLifecycleRef.current) return
        if (error) {
          sessionRef.current = null
          setSession(null)
          setPlayer(null)
          setLoading(false)
          return
        }

        const nextSession = data.session || null
        sessionRef.current = nextSession
        setSession(nextSession)
        setPlayer(null)
        resolveSession(nextSession, lifecycle)
      } catch {
        if (!mountedRef.current || lifecycle !== authLifecycleRef.current) return
        sessionRef.current = null
        setSession(null)
        setPlayer(null)
        setLoading(false)
      }
    }

    void initialize()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      // Supabase can emit SIGNED_IN when an existing session is re-established
      // (including on tab refocus), then broadcasts it to every same-origin tab.
      // TOKEN_REFRESHED is likewise session maintenance. Neither event should
      // blank and remount the app when the signed-in user has not changed.
      const isSameUserSession = Boolean(
        nextSession?.user?.id
        && nextSession.user.id === sessionRef.current?.user?.id,
      )
      if (isSameUserSession && (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED')) {
        setSession(nextSession || null)
        sessionRef.current = nextSession || null
        return
      }

      replaceSession(nextSession || null)
    })

    return () => {
      mountedRef.current = false
      authLifecycleRef.current += 1
      playerRequestRef.current += 1
      subscription.unsubscribe()
    }
  }, [beginPlayerRequest, isPlayerRequestCurrent, resolvePlayerForSession])

  const currentPlayer = player?.auth_user_id === session?.user?.id ? player : null

  useEffect(() => {
    // Skipped on pages that don't need live updates (see useRealtimeEnabled) — an open realtime
    // WebSocket connection disqualifies a page from the browser's back/forward cache, so a page
    // with no use for this channel shouldn't pay that cost.
    if (!realtimeEnabled || !currentPlayer?.id) return undefined

    let active = true
    const userId = session.user.id

    const channel = supabase
      .channel(`auth-player-${currentPlayer.id}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: `id=eq.${currentPlayer.id}` }, async () => {
        const request = beginPlayerRequest(userId)
        if (!request) return
        try {
          const refreshedPlayer = await fetchLinkedPlayer(userId)
          if (active && isPlayerRequestCurrent(request)) setPlayer(refreshedPlayer)
        } catch {
          // Keep the last valid player when a realtime refresh fails.
        }
      })
      .subscribe()

    return () => {
      active = false
      supabase.removeChannel(channel)
    }
  }, [beginPlayerRequest, currentPlayer?.id, isPlayerRequestCurrent, realtimeEnabled, session?.user?.id])

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
    const userId = session?.user?.id
    const request = beginPlayerRequest(userId)
    if (!request) return null

    try {
      const refreshedPlayer = await fetchLinkedPlayer(userId)
      if (!isPlayerRequestCurrent(request)) return null
      setPlayer(refreshedPlayer)
      return refreshedPlayer
    } catch {
      return null
    }
  }, [beginPlayerRequest, isPlayerRequestCurrent, session?.user?.id])

  const logout = useCallback(async () => {
    const userId = sessionRef.current?.user?.id
    const lifecycle = authLifecycleRef.current
    playerRequestRef.current += 1
    const { error } = await supabase.auth.signOut()
    if (error) {
      throw new Error(error.message)
    }

    if (!mountedRef.current
      || lifecycle !== authLifecycleRef.current
      || userId !== sessionRef.current?.user?.id) return

    authLifecycleRef.current += 1
    playerRequestRef.current += 1
    sessionRef.current = null
    setSession(null)
    setPlayer(null)
    setLoading(false)
  }, [])

  const value = useMemo(
    () => ({
      session,
      authUser: session?.user || null,
      player: currentPlayer,
      is_logged_in: Boolean(session?.user && currentPlayer),
      isCommissioner: Boolean(currentPlayer?.is_commissioner),
      isScorekeeper: Boolean(currentPlayer && (currentPlayer.is_commissioner || currentPlayer.scorebook_access)),
      loading,
      signInWithPassword,
      changePassword,
      refreshPlayer,
      logout,
    }),
    [session, currentPlayer, loading, signInWithPassword, changePassword, refreshPlayer, logout],
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
