import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { useAuth } from '../context/AuthContext'
import { useSeason } from '../context/SeasonContext'
import { useTournament } from '../context/TournamentContext'
import { useToast } from '../context/ToastContext'
import LogoUpload from '../components/LogoUpload'
import EyeDropperButton from '../components/EyeDropperButton'
import { buildRoundRobinSchedule, formatSeasonLabel, normalizeSeasonName, SEASON_PLAYOFF_FORMATS, validateSeasonSettings } from '../utils/season'
import {
  DEFAULT_MERCY_RULE_DIFFERENTIAL,
  DEFAULT_REGULATION_INNINGS,
  deriveOffense,
  normalizeMercyRuleDifferential,
  normalizeRegulationInnings,
} from '../utils/gameRules'
import { calculateOutsForPa, inningsPitchedFromOuts } from '../utils/statsCalculator'

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

function buildSeasonEditForm(season) {
  return {
    name: season?.name || '',
    games_per_matchup: Math.trunc(Number(season?.games_per_matchup || 1)),
    innings: normalizeRegulationInnings(season?.innings, DEFAULT_REGULATION_INNINGS),
    mercy_rule: season?.mercy_rule === true,
    mercy_rule_differential: normalizeMercyRuleDifferential(
      season?.mercy_rule_differential,
      DEFAULT_MERCY_RULE_DIFFERENTIAL,
    ),
    playoff_format: season?.playoff_format || 'double_elimination',
  }
}

function EditSeasonModal({
  season,
  allSeasons,
  schedule,
  seasonTeams,
  onClose,
  onSaved,
  pushToast,
}) {
  const [form, setForm] = useState(() => buildSeasonEditForm(season))
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setForm(buildSeasonEditForm(season))
  }, [season])

  if (!season) return null

  const regularSeasonGames = (schedule || []).filter((game) => !game.stage)
  const regularSeasonStarted = regularSeasonGames.some((game) => game.status !== 'scheduled')
  const playoffFormatLocked = season.status === 'playoffs' || (schedule || []).some((game) => Boolean(game.stage))

  const handleSave = async () => {
    const validationError = validateSeasonSettings(form, allSeasons, season.id)
    if (validationError) {
      pushToast({ title: 'Fix season settings', message: validationError, type: 'error' })
      return
    }

    const nextGamesPerMatchup = Math.trunc(Number(form.games_per_matchup))
    const currentGamesPerMatchup = Number(season.games_per_matchup || 0)
    if (regularSeasonStarted && nextGamesPerMatchup < currentGamesPerMatchup) {
      pushToast({
        title: 'Games per matchup locked',
        message: 'Games per matchup can only be increased once the regular season has started, not decreased.',
        type: 'error',
      })
      return
    }

    const payload = {
      name: normalizeSeasonName(form.name),
      games_per_matchup: nextGamesPerMatchup,
      innings: normalizeRegulationInnings(form.innings, DEFAULT_REGULATION_INNINGS),
      mercy_rule: Boolean(form.mercy_rule),
      mercy_rule_differential: normalizeMercyRuleDifferential(
        form.mercy_rule_differential,
        DEFAULT_MERCY_RULE_DIFFERENTIAL,
      ),
      playoff_format: playoffFormatLocked ? season.playoff_format : form.playoff_format,
    }

    setSaving(true)
    try {
      const { error: seasonError } = await supabase
        .from('seasons')
        .update(payload)
        .eq('id', season.id)
      if (seasonError) throw seasonError

      if (!regularSeasonStarted && nextGamesPerMatchup !== currentGamesPerMatchup) {
        const playerIdToTeamId = Object.fromEntries((seasonTeams || []).map((entry) => [entry.player_id, entry.id]))
        const nextSchedule = buildRoundRobinSchedule(
          (seasonTeams || []).map((entry) => entry.player_id),
          nextGamesPerMatchup,
        ).map((game) => ({
          season_id: season.id,
          round_number: game.round_number,
          home_team_id: playerIdToTeamId[game.home_team_id],
          away_team_id: playerIdToTeamId[game.away_team_id],
          stadium_picker_team_id: playerIdToTeamId[game.stadium_picker_team_id],
          innings: payload.innings,
          mercy_rule: payload.mercy_rule,
          mercy_rule_differential: payload.mercy_rule_differential,
          status: 'scheduled',
        }))

        const existingRegularSeasonIds = regularSeasonGames.map((game) => game.id)
        if (existingRegularSeasonIds.length) {
          const { error: deleteError } = await supabase
            .from('season_schedule')
            .delete()
            .in('id', existingRegularSeasonIds)
          if (deleteError) throw deleteError
        }

        if (nextSchedule.length) {
          const { error: insertError } = await supabase.from('season_schedule').insert(nextSchedule)
          if (insertError) throw insertError
        }
      } else if (regularSeasonStarted && nextGamesPerMatchup > currentGamesPerMatchup) {
        const playerIdToTeamId = Object.fromEntries((seasonTeams || []).map((entry) => [entry.player_id, entry.id]))
        const addedCycles = nextGamesPerMatchup - currentGamesPerMatchup
        const maxRoundNumber = regularSeasonGames.reduce((max, game) => Math.max(max, Number(game.round_number || 0)), 0)
        const additionalSchedule = buildRoundRobinSchedule(
          (seasonTeams || []).map((entry) => entry.player_id),
          addedCycles,
        ).map((game) => ({
          season_id: season.id,
          round_number: maxRoundNumber + game.round_number,
          home_team_id: playerIdToTeamId[game.home_team_id],
          away_team_id: playerIdToTeamId[game.away_team_id],
          stadium_picker_team_id: playerIdToTeamId[game.stadium_picker_team_id],
          innings: payload.innings,
          mercy_rule: payload.mercy_rule,
          mercy_rule_differential: payload.mercy_rule_differential,
          status: 'scheduled',
        }))

        if (additionalSchedule.length) {
          const { error: insertError } = await supabase.from('season_schedule').insert(additionalSchedule)
          if (insertError) throw insertError
        }

        const { error: scheduledGamesError } = await supabase
          .from('season_schedule')
          .update({
            innings: payload.innings,
            mercy_rule: payload.mercy_rule,
            mercy_rule_differential: payload.mercy_rule_differential,
          })
          .eq('season_id', season.id)
          .eq('status', 'scheduled')
        if (scheduledGamesError) throw scheduledGamesError
      } else {
        const { error: scheduledGamesError } = await supabase
          .from('season_schedule')
          .update({
            innings: payload.innings,
            mercy_rule: payload.mercy_rule,
            mercy_rule_differential: payload.mercy_rule_differential,
          })
          .eq('season_id', season.id)
          .eq('status', 'scheduled')
        if (scheduledGamesError) throw scheduledGamesError
      }

      await onSaved(payload.name)
    } catch (error) {
      pushToast({ title: 'Unable to update season', message: error.message, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(event) => event.stopPropagation()} style={{ width: 'min(720px, calc(100vw - 32px))', display: 'grid', gap: 16 }}>
        <div className="section-head">
          <div>
            <span className="brand-kicker">Commissioner</span>
            <h2 style={{ margin: '6px 0 0' }}>Edit Season</h2>
          </div>
          <span className="player-pill">{formatSeasonLabel(season.status || 'draft')}</span>
        </div>

        <label style={{ display: 'grid', gap: 6 }}>
          <span className="muted">Season name</span>
          <input value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} />
        </label>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
          <label style={{ display: 'grid', gap: 6 }}>
            <span className="muted">Games per matchup</span>
            <input
              min={regularSeasonStarted ? Number(season.games_per_matchup || 1) : 1}
              max="10"
              type="number"
              value={form.games_per_matchup}
              onChange={(event) => setForm((current) => ({ ...current, games_per_matchup: Number(event.target.value) }))}
            />
            {regularSeasonStarted ? (
              <span className="muted" style={{ fontSize: 12 }}>
                The regular season has started — you can add more games per matchup, but not remove any.
              </span>
            ) : null}
          </label>
          <label style={{ display: 'grid', gap: 6 }}>
            <span className="muted">Regulation innings</span>
            <input
              min="1"
              max="12"
              type="number"
              value={form.innings}
              onChange={(event) => setForm((current) => ({ ...current, innings: Number(event.target.value) }))}
            />
          </label>
        </div>

        <div style={{ display: 'grid', gap: 12, padding: 14, borderRadius: 12, border: '1px solid #334155', background: 'rgba(15,23,42,0.55)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <div>
              <strong>Mercy rule</strong>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Future scheduled games will use the updated threshold.</div>
            </div>
            <button
              className="ghost-button"
              onClick={() => setForm((current) => ({ ...current, mercy_rule: !current.mercy_rule }))}
              type="button"
              style={{
                borderColor: form.mercy_rule ? '#22C55E' : '#334155',
                color: form.mercy_rule ? '#22C55E' : '#94A3B8',
                background: form.mercy_rule ? 'rgba(34,197,94,0.12)' : 'transparent',
              }}
            >
              {form.mercy_rule ? 'Enabled' : 'Disabled'}
            </button>
          </div>
          <label style={{ display: 'grid', gap: 6 }}>
            <span className="muted">Mercy differential</span>
            <input
              min="1"
              max="30"
              type="number"
              value={form.mercy_rule_differential}
              onChange={(event) => setForm((current) => ({ ...current, mercy_rule_differential: Number(event.target.value) }))}
              disabled={!form.mercy_rule}
            />
          </label>
        </div>

        <label style={{ display: 'grid', gap: 6 }}>
          <span className="muted">Playoff format</span>
          <select
            value={playoffFormatLocked ? season.playoff_format : form.playoff_format}
            onChange={(event) => setForm((current) => ({ ...current, playoff_format: event.target.value }))}
            disabled={playoffFormatLocked}
          >
            {SEASON_PLAYOFF_FORMATS.map((entry) => <option key={entry} value={entry}>{formatSeasonLabel(entry)}</option>)}
          </select>
        </label>

        {regularSeasonStarted ? (
          <div className="muted" style={{ fontSize: 12 }}>
            Games per matchup is locked once the regular season starts. Name, innings, mercy settings, and the playoff format can still be updated here.
          </div>
        ) : null}

        {playoffFormatLocked ? (
          <div className="muted" style={{ fontSize: 12 }}>
            Playoff format is locked after playoffs begin or once playoff games exist.
          </div>
        ) : null}

        <div className="modal-actions">
          <button className="ghost-button" onClick={onClose} type="button">Cancel</button>
          <button className="solid-button" disabled={saving} onClick={handleSave} type="button">
            {saving ? 'Saving...' : 'Save Season'}
          </button>
        </div>
      </div>
    </div>
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
  const { allSeasons, currentSeason, viewedSeason, refreshSeasons, schedule, seasonTeams } = useSeason()
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
  const [editingSeason, setEditingSeason] = useState(false)

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
  const [backingUp, setBackingUp] = useState(false)
  const [recomputingPitching, setRecomputingPitching] = useState(false)

  const handleBackup = async () => {
    setBackingUp(true)
    try {
      const results = await Promise.all([
        supabase.from('seasons').select('*').order('created_at'),
        supabase.from('players').select('*').order('name'),
        supabase.from('characters').select('*').order('name'),
        supabase.from('draft_picks').select('*').order('created_at'),
        supabase.from('season_teams').select('*').order('created_at'),
        supabase.from('season_schedule').select('*').order('created_at'),
        supabase.from('season_roster').select('*').order('created_at'),
        supabase.from('season_lineups').select('*').order('created_at'),
        supabase.from('season_plate_appearances').select('*').order('created_at'),
        supabase.from('season_pitching_stints').select('*').order('created_at'),
        supabase.from('season_pitches').select('*').order('created_at'),
        supabase.from('season_game_fielders').select('*').order('created_at'),
        supabase.from('season_runs_scored').select('*').order('created_at'),
        supabase.from('season_inning_scores').select('*').order('created_at'),
        supabase.from('games').select('*').order('created_at'),
        supabase.from('plate_appearances').select('*').order('created_at'),
        supabase.from('pitching_stints').select('*').order('created_at'),
        supabase.from('pitches').select('*').order('created_at'),
        supabase.from('runs_scored').select('*').order('created_at'),
        supabase.from('inning_scores').select('*').order('created_at'),
        supabase.from('game_fielders').select('*').order('created_at'),
      ])

      const [
        { data: seasonsData },
        { data: playersData },
        { data: charactersData },
        { data: draftPicksData },
        { data: seasonTeamsData },
        { data: seasonScheduleData },
        { data: seasonRosterData },
        { data: seasonLineupsData },
        { data: seasonPAsData },
        { data: seasonPitchingData },
        { data: seasonPitchesData },
        { data: seasonFieldersData },
        { data: seasonRunsData },
        { data: seasonInningsData },
        { data: gamesData },
        { data: tournamentPAsData },
        { data: tournamentPitchingData },
        { data: tournamentPitchesData },
        { data: tournamentRunsData },
        { data: tournamentInningsData },
        { data: tournamentFieldersData },
      ] = results

      const backup = {
        exportedAt: new Date().toISOString(),
        version: 1,
        seasons: seasonsData || [],
        players: playersData || [],
        characters: charactersData || [],
        draftPicks: draftPicksData || [],
        season: {
          teams: seasonTeamsData || [],
          schedule: seasonScheduleData || [],
          roster: seasonRosterData || [],
          lineups: seasonLineupsData || [],
          plateAppearances: seasonPAsData || [],
          pitchingStints: seasonPitchingData || [],
          pitches: seasonPitchesData || [],
          gameFielders: seasonFieldersData || [],
          runsScored: seasonRunsData || [],
          inningScores: seasonInningsData || [],
        },
        tournament: {
          games: gamesData || [],
          plateAppearances: tournamentPAsData || [],
          pitchingStints: tournamentPitchingData || [],
          pitches: tournamentPitchesData || [],
          runsScored: tournamentRunsData || [],
          inningScores: tournamentInningsData || [],
          gameFielders: tournamentFieldersData || [],
        },
      }

      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `sluggers-backup-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
      pushToast({ title: 'Backup downloaded', message: 'All stats saved to your device.', type: 'success' })
    } catch (error) {
      pushToast({ title: 'Backup failed', message: error.message, type: 'error' })
    } finally {
      setBackingUp(false)
    }
  }

  const handleRecomputePitchingStats = async () => {
    setRecomputingPitching(true)
    try {
      const [
        { data: gamesData },
        { data: tournamentPAsData },
        { data: tournamentStintsData },
        { data: tournamentRunsData },
        { data: seasonTeamsData },
        { data: seasonGamesData },
        { data: seasonPAsData },
        { data: seasonStintsData },
        { data: seasonRunsData },
      ] = await Promise.all([
        supabase.from('games').select('id,team_a_player_id,team_b_player_id,home_away_swapped').order('created_at'),
        supabase.from('plate_appearances').select('id,game_id,player_id,result,rbi,run_scored,is_earned_run,created_at').order('created_at'),
        supabase.from('pitching_stints').select('id,game_id,player_id,character_id,created_at').order('created_at'),
        supabase.from('runs_scored').select('id,game_id,pa_id,charged_to_pitcher_id,is_earned_run').order('created_at'),
        supabase.from('season_teams').select('id,player_id').order('created_at'),
        supabase.from('season_schedule').select('id,away_team_id,home_team_id,home_away_swapped').order('created_at'),
        supabase.from('season_plate_appearances').select('id,game_id,player_id,result,rbi,run_scored,is_earned_run,created_at').order('created_at'),
        supabase.from('season_pitching_stints').select('id,game_id,player_id,character_id,created_at').order('created_at'),
        supabase.from('season_runs_scored').select('id,game_id,pa_id,charged_to_pitcher_id,is_earned_run').order('created_at'),
      ])

      const playerIdByTeamId = Object.fromEntries((seasonTeamsData || []).map((t) => [String(t.id), t.player_id]))
      const HIT_RESULTS = new Set(['1B', '2B', '3B', 'HR', 'IPHR'])
      const isHR = (r) => r === 'HR' || r === 'IPHR'

      const computeStatsForGame = (game, gamePAs, gameStints, gameRuns) => {
        const stints = [...gameStints].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
        const pas = [...gamePAs].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
        const nextStatsByStintId = Object.fromEntries(
          stints.map((stint) => [stint.id, {
            innings_pitched: 0, hits_allowed: 0, runs_allowed: 0,
            earned_runs: 0, walks: 0, strikeouts: 0, hr_allowed: 0, _outs: 0,
          }])
        )
        let outsBeforePa = 0
        pas.forEach((pa) => {
          const defense = deriveOffense(game, outsBeforePa)
          const eligibleStints = stints.filter(
            (s) => String(s.player_id) === String(defense.pitchingPlayerId) &&
              new Date(s.created_at).getTime() <= new Date(pa.created_at).getTime()
          )
          const activeStint = eligibleStints[eligibleStints.length - 1]
          if (activeStint) {
            const next = nextStatsByStintId[activeStint.id]
            const outs = calculateOutsForPa(pa.result)
            const paRuns = gameRuns.filter((run) => String(run.pa_id) === String(pa.id))
            next._outs += outs
            if (HIT_RESULTS.has(pa.result)) next.hits_allowed += 1
            if (isHR(pa.result)) next.hr_allowed += 1
            if (pa.result === 'BB') next.walks += 1
            if (pa.result === 'K') next.strikeouts += 1
            if (paRuns.length > 0) {
              paRuns.forEach((run) => {
                let target = next
                if (Number(run.charged_to_pitcher_id) !== Number(activeStint.character_id)) {
                  const chargedStints = stints.filter(
                    (s) => Number(s.character_id) === Number(run.charged_to_pitcher_id) &&
                      new Date(s.created_at).getTime() <= new Date(pa.created_at).getTime()
                  )
                  const chargedStint = chargedStints[chargedStints.length - 1]
                  if (chargedStint) target = nextStatsByStintId[chargedStint.id]
                }
                target.runs_allowed += 1
                if (run.is_earned_run !== false) target.earned_runs += 1
              })
            } else {
              const fallback = Number(pa.rbi || 0) + (pa.run_scored ? 1 : 0)
              if (fallback > 0) {
                next.runs_allowed += fallback
                if (pa.is_earned_run !== false) next.earned_runs += fallback
              }
            }
          }
          outsBeforePa += calculateOutsForPa(pa.result)
        })
        Object.values(nextStatsByStintId).forEach((entry) => {
          entry.innings_pitched = inningsPitchedFromOuts(entry._outs)
          delete entry._outs
        })
        return nextStatsByStintId
      }

      const groupById = (rows, key) => rows.reduce((acc, row) => {
        const k = String(row[key])
        if (!acc[k]) acc[k] = []
        acc[k].push(row)
        return acc
      }, {})

      const tournamentPAsByGame = groupById(tournamentPAsData || [], 'game_id')
      const tournamentStintsByGame = groupById(tournamentStintsData || [], 'game_id')
      const tournamentRunsByGame = groupById(tournamentRunsData || [], 'game_id')
      const seasonPAsByGame = groupById(seasonPAsData || [], 'game_id')
      const seasonStintsByGame = groupById(seasonStintsData || [], 'game_id')
      const seasonRunsByGame = groupById(seasonRunsData || [], 'game_id')

      const updates = []
      for (const game of (gamesData || [])) {
        const stints = tournamentStintsByGame[String(game.id)] || []
        if (!stints.length) continue
        const stats = computeStatsForGame(
          game,
          tournamentPAsByGame[String(game.id)] || [],
          stints,
          tournamentRunsByGame[String(game.id)] || [],
        )
        for (const [stintId, stintStats] of Object.entries(stats)) {
          updates.push(supabase.from('pitching_stints').update(stintStats).eq('id', stintId))
        }
      }
      for (const game of (seasonGamesData || [])) {
        const normalizedGame = {
          id: game.id,
          team_a_player_id: playerIdByTeamId[String(game.away_team_id)],
          team_b_player_id: playerIdByTeamId[String(game.home_team_id)],
          home_away_swapped: game.home_away_swapped || false,
        }
        const stints = seasonStintsByGame[String(game.id)] || []
        if (!stints.length) continue
        const stats = computeStatsForGame(
          normalizedGame,
          seasonPAsByGame[String(game.id)] || [],
          stints,
          seasonRunsByGame[String(game.id)] || [],
        )
        for (const [stintId, stintStats] of Object.entries(stats)) {
          updates.push(supabase.from('season_pitching_stints').update(stintStats).eq('id', stintId))
        }
      }

      await Promise.all(updates)
      pushToast({ title: 'Pitching stats recomputed', message: `Updated ${updates.length} pitching stints across all games.`, type: 'success' })
    } catch (error) {
      pushToast({ title: 'Recompute failed', message: error.message, type: 'error' })
    } finally {
      setRecomputingPitching(false)
    }
  }

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
  }

  const handleSeasonSaved = async (seasonName) => {
    await refreshSeasons(activeSeason?.id)
    setEditingSeason(false)
    pushToast({ title: 'Season updated', message: `${seasonName} saved.`, type: 'success' })
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
            action={<button className="ghost-button" onClick={() => navigate('/season/create')} type="button">Create</button>}
          />
          <Row
            label="Edit Season"
            action={<button className="ghost-button" onClick={() => setEditingSeason(true)} disabled={!activeSeason} type="button">Edit</button>}
          />
          <Row
            label="Resolve Waivers"
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

        <Section title="Data">
          <Row
            label="Download Backup"
            description="Export all stats and seasons as a JSON file."
            action={
              <button
                type="button"
                className="ghost-button"
                onClick={handleBackup}
                disabled={backingUp}
              >
                {backingUp ? 'Exporting…' : 'Download'}
              </button>
            }
          />
          <Row
            label="Recompute Pitching Stats"
            description="Recalculate R and ER for all pitching stints across every game. Fixes inherited-runner runs that were not attributed to any pitcher."
            action={
              <ConfirmButton
                label="Recompute"
                confirmLabel="Yes, recompute all"
                onConfirm={handleRecomputePitchingStats}
                disabled={recomputingPitching}
              />
            }
          />
        </Section>

      </div>

      <EditSeasonModal
        season={editingSeason ? activeSeason : null}
        allSeasons={allSeasons}
        schedule={schedule}
        seasonTeams={seasonTeams}
        onClose={() => setEditingSeason(false)}
        onSaved={handleSeasonSaved}
        pushToast={pushToast}
      />
    </div>
  )
}
