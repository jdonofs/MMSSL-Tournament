import { supabase } from '../../../supabaseClient'
import {
  advanceBracketOnGameComplete,
  reopenBracketAfterGameEdit,
} from '../../../utils/bracketProgression'

export async function advanceTournamentBracket({ tournament, games, completedGame }) {
  return advanceBracketOnGameComplete({
    supabase,
    tournament,
    games,
    completedGame,
  })
}

export async function reopenTournamentBracket({ tournament, games, reopenedGame }) {
  return reopenBracketAfterGameEdit({
    supabase,
    tournament,
    games,
    reopenedGame,
  })
}
