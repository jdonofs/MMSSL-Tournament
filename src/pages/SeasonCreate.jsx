import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronDown, ChevronUp, Shuffle, X } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { useSeason } from '../context/SeasonContext'
import { buildRoundRobinSchedule, formatSeasonLabel, SLUGGERS_PLAYER_ORDER } from '../utils/season'
import { DEFAULT_REGULATION_INNINGS } from '../utils/gameRules'

const C = {
  bg: '#0F172A',
  card: '#1E293B',
  border: '#334155',
  accent: '#EAB308',
  text: '#FFFFFF',
  muted: '#94A3B8',
  green: '#22C55E',
}

const LEAGUE_TYPES = ['draft', 'auction', 'keeper']
const PLAYOFF_FORMATS = ['single_elimination', 'double_elimination']
const STEPS = ['Setup', 'Players', 'Draft Order', 'Review']

function StepIndicator({ current }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 24 }}>
      {STEPS.map((label, index) => {
        const step = index + 1
        const active = step === current
        const done = step < current
        return (
          <div key={label} style={{ display: 'flex', alignItems: 'center', flex: index < STEPS.length - 1 ? 1 : 0 }}>
            <div style={{ display: 'grid', gap: 4, justifyItems: 'center' }}>
              <div
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: active || done ? C.accent : C.bg,
                  border: `1px solid ${active || done ? C.accent : C.border}`,
                  color: active || done ? '#000' : C.muted,
                  fontWeight: 800,
                  fontSize: 12,
                }}
              >
                {done ? '✓' : step}
              </div>
              <span style={{ color: active ? C.accent : C.muted, fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}</span>
            </div>
            {index < STEPS.length - 1 ? <div style={{ flex: 1, height: 2, background: done ? C.accent : C.border, margin: '0 8px 18px' }} /> : null}
          </div>
        )
      })}
    </div>
  )
}

function ReorderList({ items, onMove }) {
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {items.map((player, index) => (
        <div key={player.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 28, height: 28, borderRadius: '50%', background: C.accent, color: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 12 }}>
            {index + 1}
          </div>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 12px' }}>
            <div style={{ width: 12, height: 12, borderRadius: '50%', background: player.color, flexShrink: 0 }} />
            <strong>{player.name}</strong>
          </div>
          <div style={{ display: 'grid', gap: 4 }}>
            <button className="ghost-button" disabled={index === 0} onClick={() => onMove(index, index - 1)} type="button"><ChevronUp size={14} /></button>
            <button className="ghost-button" disabled={index === items.length - 1} onClick={() => onMove(index, index + 1)} type="button"><ChevronDown size={14} /></button>
          </div>
        </div>
      ))}
    </div>
  )
}

export default function SeasonCreate() {
  const navigate = useNavigate()
  const { player } = useAuth()
  const { pushToast } = useToast()
  const { refreshSeasons } = useSeason()
  const [step, setStep] = useState(1)
  const [players, setPlayers] = useState([])
  const [loadingPlayers, setLoadingPlayers] = useState(true)
  const [selectedPlayerIds, setSelectedPlayerIds] = useState([])
  const [draftOrder, setDraftOrder] = useState([])
  const [creating, setCreating] = useState(false)
  const [previewGames, setPreviewGames] = useState([])
  const [form, setForm] = useState({
    name: 'Sluggers Season 1',
    league_type: 'draft',
    games_per_matchup: 3,
    innings: DEFAULT_REGULATION_INNINGS,
    keeper_count: 2,
    auction_budget: 100,
    playoff_format: 'double_elimination',
  })

  useEffect(() => {
    if (player && player.is_commissioner === false) {
      navigate('/season', { replace: true })
    }
  }, [player, navigate])

  useEffect(() => {
    async function loadPlayers() {
      const { data } = await supabase.from('players').select('*')
      const ordered = [...(data || [])].sort(
        (a, b) => SLUGGERS_PLAYER_ORDER.indexOf(a.name) - SLUGGERS_PLAYER_ORDER.indexOf(b.name),
      )
      setPlayers(ordered)
      setSelectedPlayerIds(ordered.map((entry) => entry.id))
      setDraftOrder(ordered)
      setLoadingPlayers(false)
    }
    loadPlayers()
  }, [])

  const selectedPlayers = useMemo(
    () => players.filter((entry) => selectedPlayerIds.includes(entry.id)),
    [players, selectedPlayerIds],
  )

  useEffect(() => {
    setDraftOrder((current) => {
      const kept = current.filter((entry) => selectedPlayerIds.includes(entry.id))
      const keepIds = new Set(kept.map((entry) => entry.id))
      const additions = selectedPlayers.filter((entry) => !keepIds.has(entry.id))
      return [...kept, ...additions]
    })
  }, [selectedPlayers, selectedPlayerIds])

  useEffect(() => {
    if (!selectedPlayers.length) {
      setPreviewGames([])
      return
    }
    setPreviewGames(buildRoundRobinSchedule(selectedPlayers.map((entry) => entry.id), Number(form.games_per_matchup || 3)))
  }, [selectedPlayers, form.games_per_matchup])

  const moveDraftOrder = (from, to) => {
    if (to < 0 || to >= draftOrder.length) return
    const next = [...draftOrder]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    setDraftOrder(next)
  }

  const togglePlayer = (playerId) => {
    setSelectedPlayerIds((current) => (
      current.includes(playerId)
        ? current.filter((entry) => entry !== playerId)
        : [...current, playerId]
    ))
  }

  const regenerateSchedule = () => {
    setPreviewGames(buildRoundRobinSchedule(selectedPlayers.map((entry) => entry.id), Number(form.games_per_matchup || 3)))
  }

  const closeModal = () => navigate('/season')

  const handleCreate = async () => {
    if (!player?.is_commissioner) return
    if (selectedPlayers.length < 2) {
      pushToast({ title: 'Select players', message: 'Choose at least two players for the season.', type: 'error' })
      return
    }
    if (draftOrder.length !== selectedPlayers.length) {
      pushToast({ title: 'Draft order mismatch', message: 'Draft order must include every selected player exactly once.', type: 'error' })
      return
    }

    setCreating(true)
    try {
      const { data: season, error: seasonError } = await supabase
        .from('seasons')
        .insert({
          ...form,
          status: 'draft',
        })
        .select()
        .single()
      if (seasonError) throw seasonError

      const orderedTeams = draftOrder.map((entry, index) => ({
        season_id: season.id,
        player_id: entry.id,
        team_name: entry.team_name || `${entry.name}'s Club`,
        team_location: entry.team_location || null,
        team_mascot: entry.team_mascot || null,
        team_logo_key: null,
        logo_url: entry.team_logo_url || null,
        created_at: new Date(Date.now() + index * 1000).toISOString(),
      }))
      const { data: seasonTeams, error: teamsError } = await supabase
        .from('season_teams')
        .insert(orderedTeams)
        .select()
      if (teamsError) throw teamsError

      const playerIdToTeamId = Object.fromEntries((seasonTeams || []).map((entry) => [entry.player_id, entry.id]))
      const schedulePayload = previewGames.map((game) => ({
        season_id: season.id,
        round_number: game.round_number,
        home_team_id: playerIdToTeamId[game.home_team_id],
        away_team_id: playerIdToTeamId[game.away_team_id],
        stadium_picker_team_id: playerIdToTeamId[game.stadium_picker_team_id],
        status: 'scheduled',
      }))
      const { error: scheduleError } = await supabase.from('season_schedule').insert(schedulePayload)
      if (scheduleError) throw scheduleError

      await refreshSeasons(season.id)
      pushToast({ title: 'Season created', message: `${season.name} is ready.`, type: 'success' })
      navigate('/season/draft')
    } catch (error) {
      pushToast({ title: 'Unable to create season', message: error.message, type: 'error' })
    } finally {
      setCreating(false)
    }
  }

  if (!player?.is_commissioner) return null

  return (
    <div className="modal-backdrop" onClick={closeModal}>
      <div
        className="modal-card"
        onClick={(event) => event.stopPropagation()}
        style={{ width: 'min(860px, calc(100vw - 32px))', maxHeight: 'calc(100vh - 40px)', overflow: 'auto', background: C.card, color: C.text }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'start', marginBottom: 20 }}>
          <div>
            <span className="brand-kicker">Season Mode</span>
            <h1 style={{ margin: '6px 0 0' }}>Create Season</h1>
          </div>
          <button className="icon-button" onClick={closeModal} type="button" aria-label="Close season creation">
            <X size={16} />
          </button>
        </div>

        <StepIndicator current={step} />

        {step === 1 ? (
          <div style={{ display: 'grid', gap: 16 }}>
            <h2 style={{ margin: 0, fontSize: 20 }}>League Setup</h2>
            <label style={{ display: 'grid', gap: 6 }}>
              <span className="muted">Season name</span>
              <input value={form.name} onChange={(e) => setForm((current) => ({ ...current, name: e.target.value }))} />
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16 }}>
              <label style={{ display: 'grid', gap: 6 }}>
                <span className="muted">League type</span>
                <select value={form.league_type} onChange={(e) => setForm((current) => ({ ...current, league_type: e.target.value }))}>
                  {LEAGUE_TYPES.map((entry) => <option key={entry} value={entry}>{formatSeasonLabel(entry)}</option>)}
                </select>
              </label>
              <label style={{ display: 'grid', gap: 6 }}>
                <span className="muted">Games per matchup</span>
                <input min="1" max="10" type="number" value={form.games_per_matchup} onChange={(e) => setForm((current) => ({ ...current, games_per_matchup: Number(e.target.value) }))} />
              </label>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16 }}>
              {form.league_type === 'auction' ? (
                <label style={{ display: 'grid', gap: 6 }}>
                  <span className="muted">Auction budget</span>
                  <input min="1" type="number" value={form.auction_budget} onChange={(e) => setForm((current) => ({ ...current, auction_budget: Number(e.target.value) }))} />
                </label>
              ) : <div />}
              {form.league_type === 'keeper' ? (
                <label style={{ display: 'grid', gap: 6 }}>
                  <span className="muted">Keeper count</span>
                  <input min="0" type="number" value={form.keeper_count} onChange={(e) => setForm((current) => ({ ...current, keeper_count: Number(e.target.value) }))} />
                </label>
              ) : <div />}
            </div>
            <label style={{ display: 'grid', gap: 6 }}>
              <span className="muted">Playoff format</span>
              <select value={form.playoff_format} onChange={(e) => setForm((current) => ({ ...current, playoff_format: e.target.value }))}>
                {PLAYOFF_FORMATS.map((entry) => <option key={entry} value={entry}>{formatSeasonLabel(entry)}</option>)}
              </select>
            </label>
          </div>
        ) : null}

        {step === 2 ? (
          <div style={{ display: 'grid', gap: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
              <h2 style={{ margin: 0, fontSize: 20 }}>Season Players</h2>
              <span style={{ color: selectedPlayers.length >= 2 ? C.green : '#EF4444', fontWeight: 700 }}>{selectedPlayers.length} selected</span>
            </div>
            {loadingPlayers ? <span className="muted">Loading players…</span> : (
              <div style={{ display: 'grid', gap: 8 }}>
                {players.map((entry) => {
                  const active = selectedPlayerIds.includes(entry.id)
                  return (
                    <button
                      key={entry.id}
                      onClick={() => togglePlayer(entry.id)}
                      type="button"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        padding: '12px 14px',
                        borderRadius: 10,
                        border: `1px solid ${active ? entry.color : C.border}`,
                        background: active ? `${entry.color}20` : C.bg,
                        color: C.text,
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      <div style={{ width: 12, height: 12, borderRadius: '50%', background: entry.color, flexShrink: 0 }} />
                      <strong style={{ flex: 1 }}>{entry.name}</strong>
                      <span style={{ color: active ? entry.color : C.muted }}>{active ? 'Selected' : 'Add'}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        ) : null}

        {step === 3 ? (
          <div style={{ display: 'grid', gap: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
              <h2 style={{ margin: 0, fontSize: 20 }}>Draft Order</h2>
              <button className="ghost-button" onClick={() => setDraftOrder([...selectedPlayers].sort(() => Math.random() - 0.5))} type="button">
                <Shuffle size={14} /> Randomize
              </button>
            </div>
            <p className="muted" style={{ margin: 0 }}>This order is used for the season snake draft. Round 2 reverses automatically.</p>
            <ReorderList items={draftOrder} onMove={moveDraftOrder} />
          </div>
        ) : null}

        {step === 4 ? (
          <div style={{ display: 'grid', gap: 16 }}>
            <h2 style={{ margin: 0, fontSize: 20 }}>Review</h2>
            <div className="feed-list">
              <div className="feed-row"><span>Name</span><strong>{form.name}</strong></div>
              <div className="feed-row"><span>League Type</span><strong>{formatSeasonLabel(form.league_type)}</strong></div>
              <div className="feed-row"><span>Players</span><strong>{selectedPlayers.map((entry) => entry.name).join(', ')}</strong></div>
              <div className="feed-row"><span>Draft Order</span><strong>{draftOrder.map((entry, index) => `${index + 1}. ${entry.name}`).join(' · ')}</strong></div>
              <div className="feed-row"><span>Games Per Matchup</span><strong>{form.games_per_matchup}</strong></div>
              <div className="feed-row"><span>Playoff Format</span><strong>{formatSeasonLabel(form.playoff_format)}</strong></div>
              <div className="feed-row"><span>Total Games</span><strong>{previewGames.length}</strong></div>
            </div>
          </div>
        ) : null}

        <div className="modal-actions" style={{ marginTop: 28 }}>
          <button className="ghost-button" onClick={step === 1 ? closeModal : () => setStep((current) => current - 1)} type="button">
            {step === 1 ? 'Cancel' : 'Back'}
          </button>
          {step < 4 ? (
            <button
              className="solid-button"
              onClick={() => setStep((current) => current + 1)}
              disabled={(step === 2 && selectedPlayers.length < 2) || (step === 3 && draftOrder.length !== selectedPlayers.length)}
              type="button"
            >
              Next
            </button>
          ) : (
            <button className="solid-button" disabled={creating} onClick={handleCreate} type="button">
              {creating ? 'Creating…' : 'Create Season'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
