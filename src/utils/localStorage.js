function getLocalStorage() {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage
  } catch {
    return null
  }
}

export function readLocalStorageItem(key, fallback = '') {
  const storage = getLocalStorage()
  if (!storage) return fallback
  const value = storage.getItem(key)
  return value ?? fallback
}

export function writeLocalStorageItem(key, value) {
  const storage = getLocalStorage()
  if (!storage) return false
  storage.setItem(key, value)
  return true
}

export function removeLocalStorageItem(key) {
  const storage = getLocalStorage()
  if (!storage) return false
  storage.removeItem(key)
  return true
}
