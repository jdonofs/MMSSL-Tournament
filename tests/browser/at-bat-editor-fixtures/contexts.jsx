const player = {
  id: 'scorekeeper',
  name: 'Fixture Scorekeeper',
  auth_user_id: 'fixture-user',
  is_commissioner: true,
  scorebook_access: true,
}

export function useAuth() {
  return { isScorekeeper: true, player }
}

export function useToast() {
  return {
    pushToast(toast) {
      globalThis.__EDITOR_TOASTS__ = globalThis.__EDITOR_TOASTS__ || []
      globalThis.__EDITOR_TOASTS__.push(toast)
    },
  }
}
