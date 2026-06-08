import { useEffect, useRef, useState } from 'react'
import { supabase } from '../supabaseClient'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import LogoUpload from '../components/LogoUpload'
import TeamLogo from '../components/TeamLogo'
import EyeDropperButton from '../components/EyeDropperButton'

async function propagateToActiveSeasons(playerId, teamName, teamLocation, teamMascot, teamAbbreviation, primaryColor, secondaryColor, logoUrl) {
  const { data: activeSeasons } = await supabase
    .from('seasons')
    .select('id')
    .neq('status', 'completed')

  if (!activeSeasons?.length) return

  const seasonIds = activeSeasons.map((s) => s.id)
  const updates = {}
  if (teamName !== undefined) updates.team_name = teamName
  if (teamLocation !== undefined) updates.team_location = teamLocation
  if (teamMascot !== undefined) updates.team_mascot = teamMascot
  if (teamAbbreviation !== undefined) updates.team_abbreviation = teamAbbreviation
  if (primaryColor !== undefined) updates.team_primary_color = primaryColor
  if (secondaryColor !== undefined) updates.team_secondary_color = secondaryColor
  if (logoUrl !== undefined) updates.logo_url = logoUrl

  if (Object.keys(updates).length) {
    await supabase
      .from('season_teams')
      .update(updates)
      .eq('player_id', playerId)
      .in('season_id', seasonIds)
  }
}

export default function TeamProfile() {
  const { player, refreshPlayer } = useAuth()
  const { pushToast } = useToast()
  const [teamLocation, setTeamLocation] = useState(player?.team_location || '')
  const [teamMascot, setTeamMascot] = useState(player?.team_mascot || '')
  const [teamAbbreviation, setTeamAbbreviation] = useState(player?.team_abbreviation || '')
  const [primaryColor, setPrimaryColor] = useState(player?.team_primary_color || player?.color || '#38BDF8')
  const [secondaryColor, setSecondaryColor] = useState(player?.team_secondary_color || '#0F172A')
  const [logoUrl, setLogoUrl] = useState(player?.team_logo_url || null)
  const [saving, setSaving] = useState(false)

  // Pull the latest team fields from the database — the cached auth player can be stale
  useEffect(() => {
    refreshPlayer()
  }, [])

  const initialRef = useRef({
    teamLocation: player?.team_location || '',
    teamMascot: player?.team_mascot || '',
    teamAbbreviation: player?.team_abbreviation || '',
    primaryColor: player?.team_primary_color || player?.color || '#38BDF8',
    secondaryColor: player?.team_secondary_color || '#0F172A',
    logoUrl: player?.team_logo_url || null,
  })

  // Keep fields in sync if auth player changes externally
  useEffect(() => {
    setTeamLocation(player?.team_location || '')
    setTeamMascot(player?.team_mascot || '')
    setTeamAbbreviation(player?.team_abbreviation || '')
    setPrimaryColor(player?.team_primary_color || player?.color || '#38BDF8')
    setSecondaryColor(player?.team_secondary_color || '#0F172A')
    setLogoUrl(player?.team_logo_url || null)
    initialRef.current = {
      teamLocation: player?.team_location || '',
      teamMascot: player?.team_mascot || '',
      teamAbbreviation: player?.team_abbreviation || '',
      primaryColor: player?.team_primary_color || player?.color || '#38BDF8',
      secondaryColor: player?.team_secondary_color || '#0F172A',
      logoUrl: player?.team_logo_url || null,
    }
  }, [player?.id])

  const isDirty = teamLocation !== initialRef.current.teamLocation
    || teamMascot !== initialRef.current.teamMascot
    || teamAbbreviation !== initialRef.current.teamAbbreviation
    || primaryColor !== initialRef.current.primaryColor
    || secondaryColor !== initialRef.current.secondaryColor
    || logoUrl !== initialRef.current.logoUrl

  const handleLogoUpload = (url) => {
    setLogoUrl(url)
  }

  const handleSave = async () => {
    if (!player?.id) return
    setSaving(true)

    const fullTeamName = [teamLocation, teamMascot].filter(Boolean).join(' ') || null
    const playerUpdate = {
      team_name: fullTeamName,
      team_location: teamLocation || null,
      team_mascot: teamMascot || null,
      team_abbreviation: teamAbbreviation || null,
      team_primary_color: primaryColor || null,
      team_secondary_color: secondaryColor || null,
    }
    if (logoUrl !== initialRef.current.logoUrl) playerUpdate.team_logo_url = logoUrl || null

    const { error } = await supabase
      .from('players')
      .update(playerUpdate)
      .eq('id', player.id)

    if (error) {
      pushToast({ title: 'Error', message: error.message, type: 'error' })
      setSaving(false)
      return
    }

    const logoChanged = logoUrl !== initialRef.current.logoUrl
    await propagateToActiveSeasons(
      player.id,
      fullTeamName,
      teamLocation || null,
      teamMascot || null,
      teamAbbreviation || null,
      primaryColor || null,
      secondaryColor || null,
      logoChanged ? logoUrl || null : undefined,
    )
    await refreshPlayer()

    initialRef.current = { teamLocation, teamMascot, teamAbbreviation, primaryColor, secondaryColor, logoUrl }
    pushToast({ title: 'Team updated', message: 'Your team identity has been saved.', type: 'success' })
    setSaving(false)
  }

  return (
    <div className="page-stack">
      <div className="page-head">
        <span className="brand-kicker">My Profile</span>
        <h1>My Team</h1>
      </div>

      <div style={{ display: 'grid', gap: 16, maxWidth: 480 }}>

        <section className="panel" style={{ padding: 24, display: 'grid', gap: 20 }}>

          <div style={{ display: 'grid', gap: 6 }}>
            <label style={{ fontSize: 13, fontWeight: 700, color: '#94A3B8' }}>Team Logo</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <TeamLogo logoUrl={logoUrl} height={56} placeholder />
              <LogoUpload
                logoUrl={logoUrl}
                teamName={[teamLocation, teamMascot].filter(Boolean).join(' ') || player?.name}
                storagePath={`players/${player?.id}/team-logo`}
                onUpload={handleLogoUpload}
                onError={(msg) => pushToast({ title: 'Upload failed', message: msg, type: 'error' })}
                height={56}
              />
            </div>
            <p className="muted" style={{ fontSize: 12, margin: 0 }}>PNG, JPG, GIF or WebP · max 5 MB</p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={{ display: 'grid', gap: 6 }}>
              <label htmlFor="team-location-input" style={{ fontSize: 13, fontWeight: 700, color: '#94A3B8' }}>Location</label>
              <input
                id="team-location-input"
                type="text"
                value={teamLocation}
                onChange={(e) => setTeamLocation(e.target.value)}
                maxLength={40}
                style={{
                  background: '#1E293B',
                  border: '1px solid #334155',
                  borderRadius: 8,
                  padding: '10px 14px',
                  color: '#E2E8F0',
                  fontSize: 15,
                  fontWeight: 600,
                  width: '100%',
                  boxSizing: 'border-box',
                }}
              />
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              <label htmlFor="team-mascot-input" style={{ fontSize: 13, fontWeight: 700, color: '#94A3B8' }}>Team Name</label>
              <input
                id="team-mascot-input"
                type="text"
                value={teamMascot}
                onChange={(e) => setTeamMascot(e.target.value)}
                maxLength={40}
                style={{
                  background: '#1E293B',
                  border: '1px solid #334155',
                  borderRadius: 8,
                  padding: '10px 14px',
                  color: '#E2E8F0',
                  fontSize: 15,
                  fontWeight: 600,
                  width: '100%',
                  boxSizing: 'border-box',
                }}
              />
            </div>
          </div>
          <div style={{ display: 'grid', gap: 6, maxWidth: 160 }}>
            <label htmlFor="team-abbreviation-input" style={{ fontSize: 13, fontWeight: 700, color: '#94A3B8' }}>Abbreviation</label>
            <input
              id="team-abbreviation-input"
              type="text"
              value={teamAbbreviation}
              onChange={(e) => setTeamAbbreviation(e.target.value.toUpperCase().slice(0, 5))}
              maxLength={5}
              style={{
                background: '#1E293B',
                border: '1px solid #334155',
                borderRadius: 8,
                padding: '10px 14px',
                color: '#E2E8F0',
                fontSize: 15,
                fontWeight: 600,
                width: '100%',
                boxSizing: 'border-box',
                textTransform: 'uppercase',
                letterSpacing: 1,
              }}
            />
          </div>
          <div style={{ display: 'grid', gap: 6, maxWidth: 280 }}>
            <label style={{ fontSize: 13, fontWeight: 700, color: '#94A3B8' }}>Team Colors</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  id="team-primary-color-input"
                  type="color"
                  value={primaryColor}
                  onChange={(e) => setPrimaryColor(e.target.value)}
                  style={{ width: 40, height: 32, padding: 0, border: '1px solid #334155', borderRadius: 6, background: 'transparent', cursor: 'pointer' }}
                />
                <EyeDropperButton onPick={setPrimaryColor} title="Pick primary color from screen" />
                <label htmlFor="team-primary-color-input" className="muted" style={{ fontSize: 12 }}>Primary</label>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  id="team-secondary-color-input"
                  type="color"
                  value={secondaryColor}
                  onChange={(e) => setSecondaryColor(e.target.value)}
                  style={{ width: 40, height: 32, padding: 0, border: '1px solid #334155', borderRadius: 6, background: 'transparent', cursor: 'pointer' }}
                />
                <EyeDropperButton onPick={setSecondaryColor} title="Pick secondary color from screen" />
                <label htmlFor="team-secondary-color-input" className="muted" style={{ fontSize: 12 }}>Secondary</label>
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, paddingTop: 4 }}>
            <button
              className="ghost-button"
              type="button"
              disabled={!isDirty || saving}
              onClick={() => {
                setTeamLocation(initialRef.current.teamLocation)
                setTeamMascot(initialRef.current.teamMascot)
                setTeamAbbreviation(initialRef.current.teamAbbreviation)
                setPrimaryColor(initialRef.current.primaryColor)
                setSecondaryColor(initialRef.current.secondaryColor)
                setLogoUrl(initialRef.current.logoUrl)
              }}
            >
              Discard
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !isDirty}
              style={{
                background: isDirty && !saving ? '#EAB308' : 'rgba(234,179,8,0.2)',
                color: isDirty && !saving ? '#0F172A' : '#94A3B8',
                border: 'none',
                borderRadius: 8,
                padding: '0.5rem 1.5rem',
                cursor: isDirty && !saving ? 'pointer' : 'default',
                fontWeight: 700,
                fontSize: 14,
                transition: 'background 0.15s',
              }}
            >
              {saving ? 'Saving…' : 'Save Team'}
            </button>
          </div>
        </section>

        <p className="muted" style={{ fontSize: 12, margin: 0 }}>
          Changes apply to all current and future seasons and tournaments.
          Completed seasons keep their recorded team name and logo.
        </p>

      </div>
    </div>
  )
}
