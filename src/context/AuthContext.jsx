import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabaseClient'

const AuthContext = createContext(null)
const STORAGE_KEY = 'sluggers-auth'

function extractPlayer(data) {
  return {
    id: data.id,
    name: data.name,
    color: data.color,
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

export function AuthProvider({ children }) {
  const [authState, setAuthState] = useState(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored
      ? JSON.parse(stored)
      : {
          player: null,
          is_logged_in: false
        }
  })

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(authState))
  }, [authState])

  const loginAsPlayer = async (playerId) => {
    const { data, error } = await supabase
      .from('players')
      .select('*')
      .eq('id', playerId)
      .single()

    if (error) {
      throw new Error(error.message)
    }

    const player = extractPlayer(data)

    setAuthState({
      player,
      is_logged_in: true
    })

    return player
  }

  const refreshPlayer = async () => {
    const currentId = authState.player?.id
    if (!currentId) return
    const { data, error } = await supabase
      .from('players')
      .select('*')
      .eq('id', currentId)
      .single()
    if (error || !data) return
    setAuthState((prev) => ({ ...prev, player: extractPlayer(data) }))
  }

  const logout = () => {
    setAuthState({
      player: null,
      is_logged_in: false
    })
  }

  const value = useMemo(
    () => ({
      ...authState,
      loginAsPlayer,
      refreshPlayer,
      logout
    }),
    [authState]
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
