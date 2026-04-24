import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabaseClient'

const AuthContext = createContext(null)
const STORAGE_KEY = 'sluggers-auth'

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

    const player = {
      id: data.id,
      name: data.name,
      color: data.color,
      is_commissioner: data.is_commissioner || false,
      scorebook_access: data.scorebook_access || false,
    }

    setAuthState({
      player,
      is_logged_in: true
    })

    return player
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
