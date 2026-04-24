import { Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export default function ProtectedRoute({ children }) {
  const { is_logged_in } = useAuth()

  if (!is_logged_in) {
    return <Navigate to="/login" replace />
  }

  return children
}
