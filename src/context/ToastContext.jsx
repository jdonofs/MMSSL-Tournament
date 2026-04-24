import { createContext, useContext, useMemo, useState } from 'react'
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react'

const ToastContext = createContext(null)

const iconMap = {
  success: CircleCheck,
  error: CircleAlert,
  info: Info
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const pushToast = ({ title, message, type = 'info' }) => {
    const id = crypto.randomUUID()
    setToasts((current) => [...current, { id, title, message, type }])
    setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id))
    }, 3600)
  }

  const removeToast = (id) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }

  const value = useMemo(
    () => ({
      pushToast
    }),
    []
  )

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack">
        {toasts.map((toast) => {
          const Icon = iconMap[toast.type] || Info
          return (
            <div className={`toast toast-${toast.type}`} key={toast.id}>
              <Icon size={18} />
              <div className="toast-copy">
                <strong>{toast.title}</strong>
                <span>{toast.message}</span>
              </div>
              <button className="icon-button" onClick={() => removeToast(toast.id)} type="button">
                <X size={16} />
              </button>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const context = useContext(ToastContext)
  if (!context) {
    throw new Error('useToast must be used inside ToastProvider')
  }

  return context
}
