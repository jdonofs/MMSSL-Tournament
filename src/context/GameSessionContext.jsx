import { createContext, useContext } from 'react'

const GameSessionContext = createContext(null)

export function GameSessionProvider({ children, value }) {
  return <GameSessionContext.Provider value={value}>{children}</GameSessionContext.Provider>
}

export function useGameSession() {
  const context = useContext(GameSessionContext)
  if (!context) {
    throw new Error('useGameSession must be used inside a GameSessionProvider')
  }
  return context
}
