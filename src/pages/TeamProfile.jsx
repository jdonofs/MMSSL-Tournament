import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import LogoUpload from '../components/LogoUpload'
import EyeDropperButton from '../components/EyeDropperButton'
import InlineField from '../components/InlineField'
import { savePlayerTeamIdentity } from '../utils/playerTeamIdentity'

const inputStyle = {
  background: '#1E293B',
  border: '1px solid #334155',
  borderRadius: 8,
  padding: '8px 12px',
  color: '#E2E8F0',
  fontSize: 14,
  fontWeight: 600,
  width: '100%',
  boxSizing: 'border-box',
}

export default function TeamProfile() {
  const { player, refreshPlayer, changePassword } = useAuth()
  const { pushToast } = useToast()
  const [teamLocation, setTeamLocation] = useState(player?.team_location || '')
  const [teamMascot, setTeamMascot] = useState(player?.team_mascot || '')
  const [teamAbbreviation, setTeamAbbreviation] = useState(player?.team_abbreviation || '')
  const [primaryColor, setPrimaryColor] = useState(player?.team_primary_color || player?.color || '#38BDF8')
  const [secondaryColor, setSecondaryColor] = useState(player?.team_secondary_color || '#0F172A')
  const [logoUrl, setLogoUrl] = useState(player?.team_logo_url || null)
  const [saving, setSaving] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [changingPassword, setChangingPassword] = useState(false)

  // Pull the latest team fields from the database — the cached auth player can be stale
  useEffect(() => {
    refreshPlayer()
  }, [refreshPlayer])

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
  }, [
    player?.id,
    player?.team_location,
    player?.team_mascot,
    player?.team_abbreviation,
    player?.team_primary_color,
    player?.team_secondary_color,
    player?.team_logo_url,
    player?.color,
  ])

  const isDirty = teamLocation !== initialRef.current.teamLocation
    || teamMascot !== initialRef.current.teamMascot
    || teamAbbreviation !== initialRef.current.teamAbbreviation
    || primaryColor !== initialRef.current.primaryColor
    || secondaryColor !== initialRef.current.secondaryColor
    || logoUrl !== initialRef.current.logoUrl

  const handleLogoUpload = (url) => {
    setLogoUrl(url)
  }

  const handleChangePassword = async () => {
    if (!newPassword || newPassword !== confirmPassword || changingPassword) return
    if (newPassword.length < 4) {
      pushToast({ title: 'Password too short', message: 'Password must be at least 4 characters.', type: 'error' })
      return
    }
    setChangingPassword(true)
    try {
      await changePassword(newPassword)
      setNewPassword('')
      setConfirmPassword('')
      pushToast({ title: 'Password updated', message: 'Your new password is active.', type: 'success' })
    } catch (error) {
      pushToast({ title: 'Error', message: error.message, type: 'error' })
    } finally {
      setChangingPassword(false)
    }
  }

  const handleSave = async () => {
    if (!player?.id) return
    setSaving(true)

    let data = null
    try {
      data = await savePlayerTeamIdentity({
        teamLocation,
        teamMascot,
        teamAbbreviation,
        primaryColor,
        secondaryColor,
        logoUrl,
      })
    } catch (error) {
      pushToast({ title: 'Error', message: error.message, type: 'error' })
      setSaving(false)
      return
    }

    await refreshPlayer()

    initialRef.current = {
      teamLocation: data?.team_location || teamLocation,
      teamMascot: data?.team_mascot || teamMascot,
      teamAbbreviation: data?.team_abbreviation || teamAbbreviation,
      primaryColor: data?.team_primary_color || primaryColor,
      secondaryColor: data?.team_secondary_color || secondaryColor,
      logoUrl: data?.team_logo_url ?? logoUrl,
    }
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
        <section className="panel" style={{ padding: 20, display: 'grid', gap: 8 }}>
          <div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Signed in as</div>
            <div style={{ fontWeight: 700, color: player?.color || '#E2E8F0' }}>{player?.name}</div>
          </div>
        </section>

        <section className="panel" style={{ padding: 24, display: 'grid', gap: 20 }}>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <LogoUpload
                logoUrl={logoUrl}
                teamName={[teamLocation, teamMascot].filter(Boolean).join(' ') || player?.name}
                storagePath={`players/${player?.id}/team-logo`}
                onUpload={handleLogoUpload}
                onError={(msg) => pushToast({ title: 'Upload failed', message: msg, type: 'error' })}
                height={48}
              />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  id="team-primary-color-input"
                  type="color"
                  value={primaryColor}
                  onChange={(e) => setPrimaryColor(e.target.value)}
                  style={{ width: 30, height: 24, padding: 0, border: '1px solid #334155', borderRadius: 6, background: 'transparent', cursor: 'pointer' }}
                />
                <EyeDropperButton onPick={setPrimaryColor} title="Pick primary color from screen" />
                <label htmlFor="team-primary-color-input" className="muted" style={{ fontSize: 12 }}>Primary</label>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  id="team-secondary-color-input"
                  type="color"
                  value={secondaryColor}
                  onChange={(e) => setSecondaryColor(e.target.value)}
                  style={{ width: 30, height: 24, padding: 0, border: '1px solid #334155', borderRadius: 6, background: 'transparent', cursor: 'pointer' }}
                />
                <EyeDropperButton onPick={setSecondaryColor} title="Pick secondary color from screen" />
                <label htmlFor="team-secondary-color-input" className="muted" style={{ fontSize: 12 }}>Secondary</label>
              </div>
            </div>
          </div>
          <p className="muted" style={{ fontSize: 12, margin: 0 }}>PNG, JPG, GIF or WebP · max 5 MB</p>

          <div style={{ display: 'grid', gap: 8 }}>
            <InlineField
              label="Location:"
              value={teamLocation}
              onChange={setTeamLocation}
              placeholder="Location"
              maxLength={40}
              inputStyle={inputStyle}
            />
            <InlineField
              label="Team Name:"
              value={teamMascot}
              onChange={setTeamMascot}
              placeholder="Team Name"
              maxLength={40}
              inputStyle={inputStyle}
            />
            <InlineField
              label="Abbrev:"
              value={teamAbbreviation}
              onChange={setTeamAbbreviation}
              placeholder="ABB"
              maxLength={5}
              transform={(v) => v.toUpperCase().slice(0, 5)}
              textStyle={{ textTransform: 'uppercase', letterSpacing: 1 }}
              inputStyle={{ ...inputStyle, textTransform: 'uppercase', letterSpacing: 1, maxWidth: 100 }}
            />
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

        <section className="panel" style={{ padding: 24, display: 'grid', gap: 16 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 4 }}>Change Password</div>
            <div className="muted" style={{ fontSize: 12 }}>Your default password is your name. Change it here to something more secure.</div>
          </div>
          <div style={{ display: 'grid', gap: 10 }}>
            <div style={{ display: 'grid', gap: 6 }}>
              <label htmlFor="new-password-input" style={{ fontSize: 13, fontWeight: 700, color: '#94A3B8' }}>New Password</label>
              <input
                id="new-password-input"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="At least 4 characters"
                style={{ background: '#1E293B', border: '1px solid #334155', borderRadius: 8, padding: '10px 14px', color: '#E2E8F0', fontSize: 15, width: '100%', boxSizing: 'border-box' }}
              />
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              <label htmlFor="confirm-password-input" style={{ fontSize: 13, fontWeight: 700, color: '#94A3B8' }}>Confirm Password</label>
              <input
                id="confirm-password-input"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Repeat new password"
                style={{ background: '#1E293B', border: '1px solid #334155', borderRadius: 8, padding: '10px 14px', color: '#E2E8F0', fontSize: 15, width: '100%', boxSizing: 'border-box' }}
              />
            </div>
            {confirmPassword && newPassword !== confirmPassword && (
              <div style={{ color: '#F87171', fontSize: 13 }}>Passwords do not match.</div>
            )}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={handleChangePassword}
              disabled={!newPassword || newPassword !== confirmPassword || changingPassword}
              style={{
                background: newPassword && newPassword === confirmPassword && !changingPassword ? '#EAB308' : 'rgba(234,179,8,0.2)',
                color: newPassword && newPassword === confirmPassword && !changingPassword ? '#0F172A' : '#94A3B8',
                border: 'none',
                borderRadius: 8,
                padding: '0.5rem 1.5rem',
                cursor: newPassword && newPassword === confirmPassword && !changingPassword ? 'pointer' : 'default',
                fontWeight: 700,
                fontSize: 14,
                transition: 'background 0.15s',
              }}
            >
              {changingPassword ? 'Saving…' : 'Update Password'}
            </button>
          </div>
        </section>

      </div>
    </div>
  )
}
