import { supabase } from '../../../supabaseClient'
import {
  auditGameLifecycle,
  finishGameCompletion,
  finishGameReopen,
  writeGameCompletion,
  writeGameReopen,
} from '../../../utils/gameCompletionLifecycle'

export function writeCompletedGameStatus(options) {
  return writeGameCompletion({ supabase, ...options })
}

export function writeReopenedGameStatus(options) {
  return writeGameReopen({ supabase, ...options })
}

export function finishCompletedGame(options) {
  return finishGameCompletion({ supabase, ...options })
}

export function finishReopenedGame(options) {
  return finishGameReopen({ supabase, ...options })
}

export function auditGameFollowUps(options) {
  return auditGameLifecycle({ supabase, ...options })
}
