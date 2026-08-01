import { supabase } from '../supabaseClient'

export async function savePlayerTeamIdentity({
  playerId = null,
  teamLocation = null,
  teamMascot = null,
  teamAbbreviation = null,
  primaryColor = null,
  secondaryColor = null,
  logoUrl = null,
} = {}) {
  const { data, error } = await supabase.rpc('save_player_team_identity', {
    p_player_id: playerId,
    team_location_in: teamLocation || null,
    team_mascot_in: teamMascot || null,
    team_abbreviation_in: teamAbbreviation || null,
    primary_color_in: primaryColor || null,
    secondary_color_in: secondaryColor || null,
    logo_url_in: logoUrl || null,
  })

  if (error) throw error
  return Array.isArray(data) ? (data[0] || null) : (data || null)
}
