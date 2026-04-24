import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { AuthProvider } from './context/AuthContext'
import { ToastProvider } from './context/ToastContext'
import { TournamentProvider } from './context/TournamentContext'
import './styles/global.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <TournamentProvider>
          <AuthProvider>
            <App />
          </AuthProvider>
        </TournamentProvider>
      </ToastProvider>
    </BrowserRouter>
  </React.StrictMode>
)
