import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { useAuth } from '../context/AuthContext'
import { useSeason } from '../context/SeasonContext'
import { useTournament } from '../context/TournamentContext'
import { useToast } from '../context/ToastContext'
import LogoUpload from '../components/LogoUpload'
import EyeDropperButton from '../components/EyeDropperButton'

function playerEmailFromName(name) {
  return `${name.toLowerCase().replace(/[^a-z0-9]/g, '.')}@sluggers.local`
}

async function propagateToActiveSeasons(playerId, teamName, teamLocation, teamMascot, teamAbbreviation, primaryColor, secondaryColor, logoChanged, logoUrl) {
  const { data: activeSeasons } = await supabase
    .from('seasons')
    .select('id')
    .neq('status', 'completed')
  if (!activeSeasons?.length) return
  const seasonIds = activeSeasons.map((s) => s.id)
  const updates = {
    team_name: teamName,
    team_location: teamLocation,
    team_mascot: teamMascot,
    team_abbreviation: teamAbbreviation,
    team_primary_color: primaryColor,
    team_secondary_color: secondaryColor,
  }
  if (logoChanged) updates.logo_url = logoUrl
  await supabase.from('season_teams').update(updates).eq('player_id', playerId).in('season_id', seasonIds)
}

function Section({ title, children }) {
  return (
    <section className="panel" style={{ padding: 20, display: 'grid', gap: 16 }}>
      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>{title}</h2>
      {children}
    </section>
  )
}

function Row({ label, description, action }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
      <div>
        <div style={{ fontWeight: 600 }}>{label}</div>
        {description ? <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{description}</div> : null}
      </div>
      <div>{action}</div>
    </div>
  )
}

function ConfirmButton({ label, confirmLabel, onConfirm, danger = false, disabled = false }) {
  const [confirming, setConfirming] = useState(false)
  if (confirming) {
    return (
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="ghost-button" onClick={() => setConfirming(false)} type="button">Cancel</button>
        <button
          onClick={() => { setConfirming(false); onConfirm() }}
          type="button"
          style={{ background: '#ef4444', color: '#fff', border: 'none', borderRadius: 8, padding: '0.5rem 1.25rem', cursor: 'pointer', fontWeight: 600 }}
        >
          {confirmLabel || label}
        </button>
      </div>
    )
  }
  return (
    <button
      className="ghost-button"
      onClick={() => setConfirming(true)}
      type="button"
      disabled={disabled}
      style={danger ? { borderColor: '#ef4444', color: '#ef4444' } : undefined}
    >
      {label}
    </button>
  )
}

function PlayerTeamRow({ player: p, onSave, onError }) {
  const [playerEmail, setPlayerEmail] = useState(p.email || '')
  const [teamLocation, setTeamLocation] = useState(p.team_location || '')
  const [teamMascot, setTeamMascot] = useState(p.team_mascot || '')
  const [teamAbbreviation, setTeamAbbreviation] = useState(p.team_abbreviation || '')
  const [primaryColor, setPrimaryColor] = useState(p.team_primary_color || p.color || '#38BDF8')
  const [secondaryColor, setSecondaryColor] = useState(p.team_secondary_color || '#0F172A')
  const [logoUrl, setLogoUrl] = useState(p.team_logo_url || null)
  const [saving, setSaving] = useState(false)

  const originalLocation = p.team_location || ''
  const originalEmail = p.email || ''
  const originalMascot = p.team_mascot || ''
  const originalAbbreviation = p.team_abbreviation || ''
  const originalPrimaryColor = p.team_primary_color || p.color || '#38BDF8'
  const originalSecondaryColor = p.team_secondary_color || '#0F172A'
  const originalLogo = p.team_logo_url || null

  const teamName = [teamLocation, teamMascot].filter(Boolean).join(' ')
  const isDirty = teamLocation !== originalLocation
    || playerEmail !== originalEmail
    || teamMascot !== originalMascot
    || teamAbbreviation !== originalAbbreviation
    || primaryColor !== originalPrimaryColor
    || secondaryColor !== originalSecondaryColor
    || logoUrl !== originalLogo

  useEffect(() => {
    setPlayerEmail(p.email || '')
    setTeamLocation(p.team_location || '')
    setTeamMascot(p.team_mascot || '')
    setTeamAbbreviation(p.team_abbreviation || '')
    setPrimaryColor(p.team_primary_color || p.color || '#38BDF8')
    setSecondaryColor(p.team_secondary_color || '#0F172A')
    setLogoUrl(p.team_logo_url || null)
  }, [p])

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

  const handleSave = async () => {
    setSaving(true)
    const logoChanged = logoUrl !== originalLogo
    const fullTeamName = teamName || null
    const playerUpdate = {
      email: playerEmail.trim().toLowerCase() || null,
      team_name: fullTeamName,
      team_location: teamLocation || null,
      team_mascot: teamMascot || null,
      team_abbreviation: teamAbbreviation || null,
      team_primary_color: primaryColor || null,
      team_secondary_color: secondaryColor || null,
    }
    if (logoChanged) playerUpdate.team_logo_url = logoUrl || null

    const { error } = await supabase.from('players').update(playerUpdate).eq('id', p.id)
    if (error) {
      onError(error.message)
      setSaving(false)
      return
    }
    await propagateToActiveSeasons(p.id, fullTeamName, teamLocation || null, teamMascot || null, teamAbbreviation || null, primaryColor || null, secondaryColor || null, logoChanged, logoUrl || null)
    onSave(p.id, playerEmail.trim().toLowerCase() || null, fullTeamName, teamLocation || null, teamMascot || null, teamAbbreviation || null, primaryColor || null, secondaryColor || null, logoUrl)
    setSaving(false)
  }

  return (
    <div style={{
      padding: '12px 14px',
      background: 'rgba(15,23,42,0.55)',
      borderRadius: 10,
      border: '1px solid #1E293B',
      display: 'grid',
      gap: 10,
    }}>
      <span style={{ fontWeight: 700, color: p.color || '#E2E8F0' }}>{p.name}</span>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <LogoUpload
          logoUrl={logoUrl}
          teamName={teamName || p.name}
          storagePath={`players/${p.id}/team-logo`}
          onUpload={(url) => setLogoUrl(url)}
          onError={onError}
          height={36}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
        <input
          type="text"
          value={playerEmail}
          onChange={(e) => setPlayerEmail(e.target.value)}
          placeholder="Login email (e.g. jason@sluggers.local)"
          style={inputStyle}
        />
        <input
          type="text"
          value={teamLocation}
          onChange={(e) => setTeamLocation(e.target.value)}
          maxLength={40}
          style={inputStyle}
        />
        <input
          type="text"
          value={teamMascot}
          onChange={(e) => setTeamMascot(e.target.value)}
          maxLength={40}
          style={inputStyle}
        />
        <input
          type="text"
          value={teamAbbreviation}
          onChange={(e) => setTeamAbbreviation(e.target.value.toUpperCase().slice(0, 5))}
          maxLength={5}
          style={{ ...inputStyle, textTransform: 'uppercase', letterSpacing: 1 }}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="color"
            value={primaryColor}
            onChange={(e) => setPrimaryColor(e.target.value)}
            style={{ width: 36, height: 28, padding: 0, border: '1px solid #334155', borderRadius: 6, background: 'transparent', cursor: 'pointer' }}
          />
          <EyeDropperButton onPick={setPrimaryColor} title="Pick primary color from screen" />
          <span className="muted" style={{ fontSize: 12 }}>Primary</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="color"
            value={secondaryColor}
            onChange={(e) => setSecondaryColor(e.target.value)}
            style={{ width: 36, height: 28, padding: 0, border: '1px solid #334155', borderRadius: 6, background: 'transparent', cursor: 'pointer' }}
          />
          <EyeDropperButton onPick={setSecondaryColor} title="Pick secondary color from screen" />
          <span className="muted" style={{ fontSize: 12 }}>Secondary</span>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={handleSave}
          disabled={!isDirty || saving}
          style={{
            background: isDirty && !saving ? '#EAB308' : 'rgba(234,179,8,0.2)',
            color: isDirty && !saving ? '#0F172A' : '#94A3B8',
            border: 'none',
            borderRadius: 8, padding: '6px 16px', cursor: isDirty && !saving ? 'pointer' : 'default',
            fontWeight: 700, fontSize: 13,
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

export default function Admin() {
  const navigate = useNavigate()
  const { player } = useAuth()
  const { pushToast } = useToast()
  const { currentSeason, viewedSeason, refreshSeasons } = useSeason()
  const { viewedTournament, currentTournament, refreshTournaments } = useTournament()
  const [players, setPlayers] = useState([])
  const [togglingId, setTogglingId] = useState(null)
  const [newPlayerName, setNewPlayerName] = useState('')
  const [newPlayerColor, setNewPlayerColor] = useState('#38BDF8')
  const [creatingPlayer, setCreatingPlayer] = useState(false)
  const [awardContext, setAwardContext] = useState('season')
  const [awardTargetId, setAwardTargetId] = useState('all')
  const [awardAmount, setAwardAmount] = useState('')
  const [awardNote, setAwardNote] = useState('')
  const [awardingBalance, setAwardingBalance] = useState(false)

  const isCommissioner = player?.is_commissioner === true

  useEffect(() => {
    if (!isCommissioner) return
    const loadPlayers = async () => {
      const { data } = await supabase.from('players').select('*').order('name')
      setPlayers(data || [])
    }

    loadPlayers()

    const channel = supabase
      .channel(`admin-players-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'players' }, loadPlayers)
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [isCommissioner])

  const activeSeason = viewedSeason || currentSeason
  const activeTournament = viewedTournament || currentTournament

  if (!isCommissioner) {
    return (
      <div className="page-stack">
        <div className="page-head"><h1>Not authorized.</h1></div>
      </div>
    )
  }

  const handleDeleteSeason = async () => {
    if (!activeSeason) return
    const { error } = await supabase.from('seasons').delete().eq('id', activeSeason.id)
    if (error) { pushToast({ title: 'Error', message: error.message, type: 'error' }); return }
    pushToast({ title: 'Season deleted', message: `${activeSeason.name} has been deleted.`, type: 'success' })
    await refreshSeasons()
    navigate('/season')
  }

  const handleDeleteTournament = async () => {
    if (!activeTournament) return
    const { error } = await supabase.from('tournaments').delete().eq('id', activeTournament.id)
    if (error) { pushToast({ title: 'Error', message: error.message, type: 'error' }); return }
    pushToast({ title: 'Tournament deleted', message: `Tournament ${activeTournament.tournament_number} has been deleted.`, type: 'success' })
    await refreshTournaments()
    navigate('/')
  }

  const handleLockTrades = async () => {
    if (!activeTournament) return
    const { error } = await supabase.from('tournaments').update({ trade_deadline_at: new Date().toISOString() }).eq('id', activeTournament.id)
    if (error) { pushToast({ title: 'Error', message: error.message, type: 'error' }); return }
    pushToast({ title: 'Trade deadline set', message: 'Trades are now locked for this tournament.', type: 'success' })
    await refreshTournaments()
  }

  const handleResolveWaivers = async () => {
    if (!activeSeason) return
    const [{ data: waivers }, { data: roster }] = await Promise.all([
      supabase.from('season_waivers').select('*').eq('season_id', activeSeason.id).eq('status', 'pending'),
      supabase.from('season_roster').select('*').eq('season_id', activeSeason.id).eq('is_active', true),
    ])
    if (!waivers?.length) { pushToast({ title: 'No pending waivers', type: 'success' }); return }

    const grouped = waivers.reduce((acc, entry) => {
      acc[entry.claiming_character] = acc[entry.claiming_character] || []
      acc[entry.claiming_character].push(entry)
      return acc
    }, {})

    for (const claims of Object.values(grouped)) {
      const sorted = [...claims].sort((a, b) => Number(a.priority_order) - Number(b.priority_order) || new Date(a.created_at) - new Date(b.created_at))
      const winner = sorted[0]
      const losers = sorted.slice(1)
      const dropRow = roster?.find((r) => r.team_id === winner.claiming_team_id && r.character_name === winner.dropping_character)
      if (dropRow) await supabase.from('season_roster').update({ is_active: false }).eq('id', dropRow.id)
      await supabase.from('season_roster').insert({ season_id: activeSeason.id, team_id: winner.claiming_team_id, character_name: winner.claiming_character, acquired_via: 'waiver', is_active: true })
      await supabase.from('season_waivers').update({ status: 'approved', resolved_at: new Date().toISOString() }).eq('id', winner.id)
      if (losers.length) await supabase.from('season_waivers').update({ status: 'denied', resolved_at: new Date().toISOString() }).in('id', losers.map((e) => e.id))
    }
    pushToast({ title: 'Waivers resolved', type: 'success' })
  }

  const handleToggleScorebookAccess = async (target) => {
    setTogglingId(target.id)
    const newValue = !target.scorebook_access
    const { error } = await supabase.from('players').update({ scorebook_access: newValue }).eq('id', target.id)
    if (error) {
      pushToast({ title: 'Error', message: error.message, type: 'error' })
    } else {
      setPlayers((prev) => prev.map((p) => p.id === target.id ? { ...p, scorebook_access: newValue } : p))
    }
    setTogglingId(null)
  }

  const handlePlayerTeamSave = (playerId, email, teamName, teamLocation, teamMascot, teamAbbreviation, primaryColor, secondaryColor, logoUrl) => {
    setPlayers((prev) => prev.map((p) => p.id === playerId
      ? { ...p, email, team_name: teamName, team_location: teamLocation, team_mascot: teamMascot, team_abbreviation: teamAbbreviation, team_primary_color: primaryColor, team_secondary_color: secondaryColor, team_logo_url: logoUrl }
      : p))
    pushToast({ title: 'Team updated', type: 'success' })
  }

  const handleCreatePlayer = async () => {
    const trimmedName = newPlayerName.trim()
    if (!trimmedName || creatingPlayer) return
    setCreatingPlayer(true)
    const email = playerEmailFromName(trimmedName)
    const { error } = await supabase.from('players').insert({
      name: trimmedName,
      color: newPlayerColor,
      email,
      is_commissioner: false,
      scorebook_access: false,
    })
    if (error) {
      pushToast({ title: 'Error creating player', message: error.message, type: 'error' })
    } else {
      pushToast({
        title: `${trimmedName} added`,
        message: `Login email: ${email} · Default password: ${trimmedName.toLowerCase()}. Create a Supabase Auth account with these credentials.`,
        type: 'success',
      })
      setNewPlayerName('')
      setNewPlayerColor('#38BDF8')
    }
    setCreatingPlayer(false)
  }

  const handleAwardBalance = async () => {
    const amount = Number(awardAmount)
    const contextEntry = awardContext === 'season' ? activeSeason : activeTournament
    if (!contextEntry || !amount) return
    setAwardingBalance(true)
    const { error } = await supabase.from('balance_awards').insert({
      [awardContext === 'season' ? 'season_id' : 'tournament_id']: contextEntry.id,
      player_id: awardTargetId === 'all' ? null : awardTargetId,
      amount,
      note: awardNote || null,
      awarded_by: player?.id || null,
    })
    setAwardingBalance(false)
    if (error) {
      pushToast({ title: 'Error', message: error.message, type: 'error' })
      return
    }
    pushToast({
      title: 'Balance awarded',
      message: `$${amount} awarded to ${awardTargetId === 'all' ? 'all players' : players.find((p) => p.id === awardTargetId)?.name || 'player'}.`,
      type: 'success',
    })
    setAwardAmount('')
    setAwardNote('')
  }

  const tradeLocked = activeTournament?.trade_deadline_at
    ? new Date() > new Date(activeTournament.trade_deadline_at)
    : false

  const nonCommissioners = players.filter((p) => !p.is_commissioner)

  return (
    <div className="page-stack">
      <div className="page-head">
        <span className="brand-kicker">Commissioner</span>
        <h1>Admin</h1>
      </div>

      <div style={{ display: 'grid', gap: 16 }}>

        <Section title="Team Editor">
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            Set each player's login email and team details. The login email must match the Supabase Auth account. Changes apply to all current and future seasons and tournaments — completed ones keep their recorded identity.
          </p>
          <div style={{ display: 'grid', gap: 8 }}>
            {players.map((p) => (
              <PlayerTeamRow
                key={p.id}
                player={p}
                onSave={handlePlayerTeamSave}
                onError={(msg) => pushToast({ title: 'Error', message: msg, type: 'error' })}
              />
            ))}
          </div>
        </Section>

        <Section title="Add Player">
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            Create a new player account. After adding, go to Supabase Dashboard → Authentication → Users and create an account with the generated email and the player's name as the default password. Email confirmation should be disabled in your Supabase auth settings.
          </p>
          <div style={{ display: 'grid', gap: 10 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, alignItems: 'end' }}>
              <div style={{ display: 'grid', gap: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 700, color: '#94A3B8' }}>Player Name</label>
                <input
                  type="text"
                  value={newPlayerName}
                  onChange={(e) => setNewPlayerName(e.target.value)}
                  placeholder="e.g. Jason"
                  style={{ background: '#1E293B', border: '1px solid #334155', borderRadius: 8, padding: '8px 12px', color: '#E2E8F0', fontSize: 14, fontWeight: 600, width: '100%', boxSizing: 'border-box' }}
                />
              </div>
              <div style={{ display: 'grid', gap: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 700, color: '#94A3B8' }}>Color</label>
                <input
                  type="color"
                  value={newPlayerColor}
                  onChange={(e) => setNewPlayerColor(e.target.value)}
                  style={{ width: 40, height: 36, padding: 0, border: '1px solid #334155', borderRadius: 6, background: 'transparent', cursor: 'pointer' }}
                />
              </div>
            </div>
            {newPlayerName.trim() && (
              <div style={{ padding: '8px 12px', background: 'rgba(15,23,42,0.55)', borderRadius: 8, border: '1px solid #1E293B', fontSize: 12 }}>
                <span className="muted">Login email: </span>
                <span style={{ fontFamily: 'monospace' }}>{playerEmailFromName(newPlayerName.trim())}</span>
                <span className="muted"> · Default password: </span>
                <span style={{ fontFamily: 'monospace' }}>{newPlayerName.trim().toLowerCase()}</span>
              </div>
            )}
            <div>
              <button
                type="button"
                onClick={handleCreatePlayer}
                disabled={!newPlayerName.trim() || creatingPlayer}
                style={{
                  background: newPlayerName.trim() && !creatingPlayer ? '#EAB308' : 'rgba(234,179,8,0.2)',
                  color: newPlayerName.trim() && !creatingPlayer ? '#0F172A' : '#94A3B8',
                  border: 'none',
                  borderRadius: 8,
                  padding: '8px 20px',
                  cursor: newPlayerName.trim() && !creatingPlayer ? 'pointer' : 'default',
                  fontWeight: 700,
                  fontSize: 13,
                }}
              >
                {creatingPlayer ? 'Adding…' : 'Add Player'}
              </button>
            </div>
          </div>
        </Section>

        <Section title="Scorebook Access">
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>Grant players the ability to edit the scorebook. Commissioners always have full access.</p>
          <div style={{ display: 'grid', gap: 8 }}>
            {nonCommissioners.map((p) => (
              <div key={p.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: 'rgba(15,23,42,0.55)', borderRadius: 10, border: '1px solid #1E293B' }}>
                <span style={{ fontWeight: 600, color: p.color || '#E2E8F0' }}>{p.name}</span>
                <button
                  onClick={() => handleToggleScorebookAccess(p)}
                  disabled={togglingId === p.id}
                  type="button"
                  style={{
                    background: p.scorebook_access ? 'rgba(34,197,94,0.15)' : 'transparent',
                    color: p.scorebook_access ? '#22C55E' : '#64748B',
                    border: `1px solid ${p.scorebook_access ? '#22C55E' : '#334155'}`,
                    borderRadius: 20,
                    padding: '4px 14px',
                    cursor: 'pointer',
                    fontSize: 12,
                    fontWeight: 700,
                  }}
                >
                  {p.scorebook_access ? 'Editor ✓' : 'Viewer'}
                </button>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Award Balance">
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            Give players extra betting balance for the active season or tournament. Applies to a single player or everyone at once.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, alignItems: 'end' }}>
            <div style={{ display: 'grid', gap: 6 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: '#94A3B8' }}>Context</label>
              <select
                value={awardContext}
                onChange={(e) => setAwardContext(e.target.value)}
                style={{ background: '#1E293B', border: '1px solid #334155', borderRadius: 8, padding: '8px 12px', color: '#E2E8F0', fontSize: 14, fontWeight: 600 }}
              >
                <option value="season" disabled={!activeSeason}>{activeSeason ? `Season: ${activeSeason.name}` : 'No active season'}</option>
                <option value="tournament" disabled={!activeTournament}>{activeTournament ? `Tournament ${activeTournament.tournament_number}` : 'No active tournament'}</option>
              </select>
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: '#94A3B8' }}>Player</label>
              <select
                value={awardTargetId}
                onChange={(e) => setAwardTargetId(e.target.value)}
                style={{ background: '#1E293B', border: '1px solid #334155', borderRadius: 8, padding: '8px 12px', color: '#E2E8F0', fontSize: 14, fontWeight: 600 }}
              >
                <option value="all">All players</option>
                {players.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: '#94A3B8' }}>Amount ($)</label>
              <input
                type="number"
                value={awardAmount}
                onChange={(e) => setAwardAmount(e.target.value)}
                placeholder="e.g. 25 or -10"
                style={{ background: '#1E293B', border: '1px solid #334155', borderRadius: 8, padding: '8px 12px', color: '#E2E8F0', fontSize: 14, fontWeight: 600, width: '100%', boxSizing: 'border-box' }}
              />
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: '#94A3B8' }}>Note</label>
              <input
                type="text"
                value={awardNote}
                onChange={(e) => setAwardNote(e.target.value)}
                placeholder="Optional reason"
                style={{ background: '#1E293B', border: '1px solid #334155', borderRadius: 8, padding: '8px 12px', color: '#E2E8F0', fontSize: 14, fontWeight: 600, width: '100%', boxSizing: 'border-box' }}
              />
            </div>
            <button
              type="button"
              onClick={handleAwardBalance}
              disabled={!awardAmount || awardingBalance || (awardContext === 'season' ? !activeSeason : !activeTournament)}
              style={{
                background: awardAmount && !awardingBalance ? '#EAB308' : 'rgba(234,179,8,0.2)',
                color: awardAmount && !awardingBalance ? '#0F172A' : '#94A3B8',
                border: 'none',
                borderRadius: 8,
                padding: '8px 20px',
                cursor: awardAmount && !awardingBalance ? 'pointer' : 'default',
                fontWeight: 700,
                fontSize: 13,
              }}
            >
              {awardingBalance ? 'Awarding…' : 'Award'}
            </button>
          </div>
        </Section>

        <Section title="Season">
          <Row
            label="New Season"
            description="Create a new season with a fresh schedule and rosters."
            action={<button className="ghost-button" onClick={() => navigate('/season/create')} type="button">Create</button>}
          />
          <Row
            label="Resolve Waivers"
            description={activeSeason ? `Process all pending waiver claims for ${activeSeason.name}.` : 'No active season.'}
            action={
              <ConfirmButton
                label="Resolve"
                confirmLabel="Resolve Waivers"
                onConfirm={handleResolveWaivers}
                disabled={!activeSeason}
              />
            }
          />
          <Row
            label="Delete Season"
            description={activeSeason ? `Permanently delete ${activeSeason.name} and all related data.` : 'No active season.'}
            action={
              <ConfirmButton
                label="Delete"
                confirmLabel="Yes, delete season"
                onConfirm={handleDeleteSeason}
                danger
                disabled={!activeSeason}
              />
            }
          />
        </Section>

        <Section title="Tournament">
          <Row
            label="New Tournament"
            description="Create a new tournament bracket."
            action={<button className="ghost-button" onClick={() => navigate('/tournament/create')} type="button">Create</button>}
          />
          <Row
            label="Lock Trades"
            description={
              tradeLocked
                ? 'Trade deadline is already set for this tournament.'
                : activeTournament
                  ? `Lock all trades for Tournament ${activeTournament.tournament_number}.`
                  : 'No active tournament.'
            }
            action={
              <ConfirmButton
                label={tradeLocked ? 'Locked' : 'Lock Trades'}
                confirmLabel="Lock Trades"
                onConfirm={handleLockTrades}
                disabled={!activeTournament || tradeLocked}
              />
            }
          />
          <Row
            label="Delete Tournament"
            description={activeTournament ? `Permanently delete Tournament ${activeTournament.tournament_number} and all its data.` : 'No active tournament.'}
            action={
              <ConfirmButton
                label="Delete"
                confirmLabel="Yes, delete tournament"
                onConfirm={handleDeleteTournament}
                danger
                disabled={!activeTournament}
              />
            }
          />
        </Section>

      </div>
    </div>
  )
}
