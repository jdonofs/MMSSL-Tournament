import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronDown, ChevronUp, RotateCcw, Shuffle } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { useTournament } from '../context/TournamentContext'
import { buildDoubleElimBracket, generateSingleElimBracket, getRoundRobinSchedule } from '../utils/bracketTemplates'

// ─── Style constants ─────────────────────────────────────────────────────────
const C = {
  bg: '#0F172A',
  card: '#1E293B',
  border: '#334155',
  accent: '#EAB308',
  green: '#22C55E',
  text: '#FFFFFF',
  muted: '#94A3B8',
}

const STEPS = ['Settings', 'Players', 'Seeding', 'Draft Order', 'Review']

function StepIndicator({ current }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 28 }}>
      {STEPS.map((label, i) => {
        const num = i + 1
        const done = num < current
        const active = num === current
        return (
          <div key={label} style={{ display: 'flex', alignItems: 'center', flex: i < STEPS.length - 1 ? 1 : 0 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
              <div style={{
                width: 32, height: 32, borderRadius: '50%', display: 'flex',
                alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 13,
                background: done || active ? C.accent : C.card,
                color: done || active ? '#000' : C.muted,
                border: `2px solid ${done || active ? C.accent : C.border}`,
                flexShrink: 0,
              }}>
                {done ? '✓' : num}
              </div>
              <span style={{ fontSize: 10, color: active ? C.accent : C.muted, whiteSpace: 'nowrap', fontWeight: active ? 700 : 400 }}>
                {label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div style={{ flex: 1, height: 2, background: done ? C.accent : C.border, margin: '0 4px', marginBottom: 18 }} />
            )}
          </div>
        )
      })}
    </div>
  )
}

function ReorderList({ items, onMove, renderItem }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {items.map((item, idx) => (
        <div key={item.id} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <div style={{
            width: 28, height: 28, borderRadius: '50%', background: C.accent, color: '#000',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 800, fontSize: 13, flexShrink: 0,
          }}>
            {idx + 1}
          </div>
          <div style={{ flex: 1 }}>{renderItem(item, idx)}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <button
              onClick={() => onMove(idx, idx - 1)}
              disabled={idx === 0}
              style={{
                background: C.card, border: `1px solid ${C.border}`, borderRadius: 4,
                color: idx === 0 ? C.border : C.muted, cursor: idx === 0 ? 'not-allowed' : 'pointer',
                padding: '2px 6px', lineHeight: 1,
              }}
            >
              <ChevronUp size={14} />
            </button>
            <button
              onClick={() => onMove(idx, idx + 1)}
              disabled={idx === items.length - 1}
              style={{
                background: C.card, border: `1px solid ${C.border}`, borderRadius: 4,
                color: idx === items.length - 1 ? C.border : C.muted,
                cursor: idx === items.length - 1 ? 'not-allowed' : 'pointer',
                padding: '2px 6px', lineHeight: 1,
              }}
            >
              <ChevronDown size={14} />
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

function PlayerChip({ player, style: extraStyle = {} }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, background: C.bg,
      borderRadius: 10, padding: '10px 14px', border: `1px solid ${C.border}`,
      ...extraStyle,
    }}>
      <div style={{ width: 12, height: 12, borderRadius: '50%', background: player.color, flexShrink: 0 }} />
      <span style={{ fontWeight: 600, fontSize: 14 }}>{player.name}</span>
    </div>
  )
}

const FORMAT_OPTIONS = [
  {
    value: 'double',
    label: 'Double Elimination',
    desc: 'Each player must lose twice to be eliminated. Produces a winners bracket, a losers bracket, and a championship game.',
  },
  {
    value: 'single',
    label: 'Single Elimination',
    desc: 'One loss and you\'re out. Fast and dramatic. Seeds protect the top players in round 1.',
  },
  {
    value: 'round_robin',
    label: 'Round Robin',
    desc: 'Everyone plays everyone. Best overall record wins. No bracket — just standings and a full schedule.',
  },
]

export default function TournamentCreate() {
  const navigate = useNavigate()
  const { player } = useAuth()
  const { pushToast } = useToast()
  const { allTournaments, activeTournament, refreshTournaments } = useTournament()

  const [step, setStep] = useState(1)
  const [allPlayers, setAllPlayers] = useState([])
  const [submitting, setSubmitting] = useState(false)

  // Form state
  const nextNumber = (allTournaments.length
    ? Math.max(...allTournaments.map(t => t.tournament_number || 0)) + 1
    : 1)
  const [tournamentNumber, setTournamentNumber] = useState(nextNumber)
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [innings, setInnings] = useState(3)
  const [mercyRule, setMercyRule] = useState(true)
  const [bracketFormat, setBracketFormat] = useState('double')
  const [selectedPlayerIds, setSelectedPlayerIds] = useState([])
  const [seeding, setSeeding] = useState([]) // array of player objects
  const [draftOrder, setDraftOrder] = useState([]) // array of player objects
  const seedingInitialized = useRef(false)

  // Redirect non-commissioners
  useEffect(() => {
    if (player && player.is_commissioner === false) {
      navigate('/')
    }
  }, [player, navigate])

  useEffect(() => {
    supabase.from('players').select('*').order('name').then(({ data }) => {
      const list = data || []
      setAllPlayers(list)
      setSelectedPlayerIds(list.map(p => p.id))
    })
  }, [])

  // Set default seeding from the most recent previous tournament's results
  useEffect(() => {
    if (allPlayers.length === 0 || allTournaments.length === 0) return
    if (seedingInitialized.current) return
    seedingInitialized.current = true

    const prevTournament = [...allTournaments].sort((a, b) => b.tournament_number - a.tournament_number)[0]
    if (!prevTournament?.champion_player_id) return

    supabase.from('games').select('*').eq('tournament_id', prevTournament.id).then(({ data: prevGames }) => {
      const stats = {}
      allPlayers.forEach(p => { stats[p.id] = { wins: 0, losses: 0 } })
      ;(prevGames || []).filter(g => g.status === 'complete').forEach(game => {
        if (!game.winner_player_id) return
        const loserId = game.team_a_player_id === game.winner_player_id
          ? game.team_b_player_id : game.team_a_player_id
        if (stats[game.winner_player_id]) stats[game.winner_player_id].wins++
        if (stats[loserId]) stats[loserId].losses++
      })
      const champId = prevTournament.champion_player_id
      setSeeding(prev => [...prev].sort((a, b) => {
        if (a.id === champId) return -1
        if (b.id === champId) return 1
        const aS = stats[a.id] || { wins: 0, losses: 0 }
        const bS = stats[b.id] || { wins: 0, losses: 0 }
        if (bS.wins !== aS.wins) return bS.wins - aS.wins
        return aS.losses - bS.losses
      }))
    })
  }, [allPlayers, allTournaments])

  // Sync seeding/draftOrder when player selection changes
  const selectedPlayers = allPlayers.filter(p => selectedPlayerIds.includes(p.id))
  useEffect(() => {
    setSeeding(prev => {
      const prevIds = prev.map(p => p.id)
      const keep = prev.filter(p => selectedPlayerIds.includes(p.id))
      const added = selectedPlayers.filter(p => !prevIds.includes(p.id))
      return [...keep, ...added]
    })
    setDraftOrder(prev => {
      const prevIds = prev.map(p => p.id)
      const keep = prev.filter(p => selectedPlayerIds.includes(p.id))
      const added = selectedPlayers.filter(p => !prevIds.includes(p.id))
      return [...keep, ...added]
    })
  }, [selectedPlayerIds.join(',')])

  const moveItem = (arr, setArr) => (from, to) => {
    if (to < 0 || to >= arr.length) return
    const next = [...arr]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    setArr(next)
  }

  const shuffle = (arr) => [...arr].sort(() => Math.random() - 0.5)

  const handleCreate = async () => {
    if (selectedPlayers.length < 4 || selectedPlayers.length > 8) {
      pushToast({ title: 'Invalid player count', message: 'Select 4–8 players.', type: 'error' })
      return
    }
    setSubmitting(true)
    try {
      // Archive the current active tournament if one exists
      if (activeTournament && !activeTournament.archived) {
        await supabase.from('tournaments').update({ archived: true }).eq('id', activeTournament.id)
      }

      const { data: newTournament, error } = await supabase.from('tournaments').insert({
        tournament_number: tournamentNumber,
        date,
        player_count: selectedPlayers.length,
        innings,
        mercy_rule: mercyRule,
        bracket_format: bracketFormat,
        player_ids: selectedPlayers.map(p => p.id),
        seeding: seeding.map(p => p.id),
        draft_order: draftOrder.map(p => p.id),
        status: 'drafting',
        archived: false,
      }).select().single()

      if (error) {
        pushToast({ title: 'Creation failed', message: error.message, type: 'error' })
        return
      }

      // Auto-generate bracket games immediately
      const seedingIds = seeding.map(p => p.id)
      let bracketGames = []
      if (bracketFormat === 'round_robin') {
        bracketGames = getRoundRobinSchedule(seedingIds).map((m, i) => ({
          tournament_id: newTournament.id, game_code: `G${i + 1}`, stage: m.stage,
          team_a_player_id: m.teamA, team_b_player_id: m.teamB, team_a_runs: 0, team_b_runs: 0, status: 'pending',
        }))
      } else if (bracketFormat === 'single') {
        bracketGames = generateSingleElimBracket(seedingIds).map((g, i) => ({
          tournament_id: newTournament.id, game_code: `G${i + 1}`, stage: g.stage,
          team_a_player_id: g.teamA, team_b_player_id: g.teamB, team_a_runs: 0, team_b_runs: 0, status: 'pending',
        }))
      } else {
        bracketGames = buildDoubleElimBracket(seedingIds).map((g, i) => ({
          tournament_id: newTournament.id, game_code: `G${i + 1}`, stage: g.stage,
          team_a_player_id: g.teamA, team_b_player_id: g.teamB, team_a_runs: 0, team_b_runs: 0, status: 'pending',
        }))
      }
      if (bracketGames.length > 0) {
        await supabase.from('games').insert(bracketGames)
      }

      await refreshTournaments(newTournament.id)
      pushToast({ title: `Tournament ${tournamentNumber} created!`, message: 'Redirecting to draft…', type: 'success' })
      navigate('/draft')
    } catch (err) {
      pushToast({ title: 'Unexpected error', message: err.message, type: 'error' })
    } finally {
      setSubmitting(false)
    }
  }

  // ─── Step renderers ───────────────────────────────────────────────────────

  const renderStep1 = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>Basic Settings</h2>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ color: C.muted, fontSize: 12, fontWeight: 700, textTransform: 'uppercase' }}>Tournament #</span>
          <input
            type="number" min={1} value={tournamentNumber}
            onChange={e => setTournamentNumber(Number(e.target.value))}
            style={{ background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 12px', fontSize: 16 }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ color: C.muted, fontSize: 12, fontWeight: 700, textTransform: 'uppercase' }}>Date</span>
          <input
            type="date" value={date}
            onChange={e => setDate(e.target.value)}
            style={{ background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 12px', fontSize: 16 }}
          />
        </label>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ color: C.muted, fontSize: 12, fontWeight: 700, textTransform: 'uppercase' }}>Innings per Game</span>
          <input
            type="number" min={1} max={9} value={innings}
            onChange={e => setInnings(Math.max(1, Math.min(9, Number(e.target.value))))}
            style={{ background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 12px', fontSize: 16 }}
          />
        </label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ color: C.muted, fontSize: 12, fontWeight: 700, textTransform: 'uppercase' }}>Mercy Rule</span>
          <button
            onClick={() => setMercyRule(v => !v)}
            style={{
              background: mercyRule ? `${C.green}22` : C.bg, color: mercyRule ? C.green : C.muted,
              border: `2px solid ${mercyRule ? C.green : C.border}`, borderRadius: 8,
              padding: '10px 12px', fontWeight: 700, cursor: 'pointer', fontSize: 14, textAlign: 'left',
            }}
          >
            {mercyRule ? '✓ Mercy Rule ON' : '✗ Mercy Rule OFF'}
          </button>
        </div>
      </div>


      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span style={{ color: C.muted, fontSize: 12, fontWeight: 700, textTransform: 'uppercase' }}>Bracket Format</span>
        {FORMAT_OPTIONS.map(opt => (
          <button
            key={opt.value}
            onClick={() => setBracketFormat(opt.value)}
            style={{
              background: bracketFormat === opt.value ? `${C.accent}18` : C.bg,
              border: `2px solid ${bracketFormat === opt.value ? C.accent : C.border}`,
              borderRadius: 10, padding: '14px 16px', textAlign: 'left', cursor: 'pointer',
              color: C.text,
            }}
          >
            <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 4 }}>{opt.label}</div>
            <div style={{ color: C.muted, fontSize: 12, lineHeight: 1.5 }}>{opt.desc}</div>
          </button>
        ))}
      </div>
    </div>
  )

  const renderStep2 = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>Player Selection</h2>
        <span style={{
          fontSize: 13, fontWeight: 700,
          color: selectedPlayers.length >= 4 && selectedPlayers.length <= 8 ? C.green : '#EF4444',
        }}>
          {selectedPlayers.length} selected {selectedPlayers.length < 4 ? '(need 4+)' : selectedPlayers.length > 8 ? '(max 8)' : '✓'}
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {allPlayers.map(p => {
          const selected = selectedPlayerIds.includes(p.id)
          return (
            <button
              key={p.id}
              onClick={() => setSelectedPlayerIds(prev =>
                selected ? prev.filter(id => id !== p.id) : [...prev, p.id],
              )}
              style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px',
                background: selected ? `${p.color}18` : C.bg,
                border: `2px solid ${selected ? p.color : C.border}`,
                borderRadius: 10, cursor: 'pointer', textAlign: 'left', color: C.text,
              }}
            >
              <div style={{ width: 14, height: 14, borderRadius: '50%', background: p.color, flexShrink: 0 }} />
              <span style={{ fontWeight: 700, flex: 1 }}>{p.name}</span>
              <span style={{ fontSize: 18, color: selected ? p.color : C.border }}>{selected ? '✓' : '○'}</span>
            </button>
          )
        })}
      </div>
    </div>
  )

  const renderStep3 = () => {
    const prevTournament = [...allTournaments].sort((a, b) => b.tournament_number - a.tournament_number)[0]
    const hasPrevResults = prevTournament?.champion_player_id

    const resetToPrevResults = () => {
      if (!hasPrevResults) return
      supabase.from('games').select('*').eq('tournament_id', prevTournament.id).then(({ data: prevGames }) => {
        const stats = {}
        allPlayers.forEach(p => { stats[p.id] = { wins: 0, losses: 0 } })
        ;(prevGames || []).filter(g => g.status === 'complete').forEach(game => {
          if (!game.winner_player_id) return
          const loserId = game.team_a_player_id === game.winner_player_id
            ? game.team_b_player_id : game.team_a_player_id
          if (stats[game.winner_player_id]) stats[game.winner_player_id].wins++
          if (stats[loserId]) stats[loserId].losses++
        })
        const champId = prevTournament.champion_player_id
        setSeeding(prev => [...prev].sort((a, b) => {
          if (a.id === champId) return -1
          if (b.id === champId) return 1
          const aS = stats[a.id] || { wins: 0, losses: 0 }
          const bS = stats[b.id] || { wins: 0, losses: 0 }
          if (bS.wins !== aS.wins) return bS.wins - aS.wins
          return aS.losses - bS.losses
        }))
      })
    }

    return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>Seeding</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          {hasPrevResults && (
            <button
              onClick={resetToPrevResults}
              style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 12px', color: C.muted, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}
            >
              <RotateCcw size={14} /> Reset
            </button>
          )}
          <button
            onClick={() => setSeeding(shuffle(seeding))}
            style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 12px', color: C.text, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}
          >
            <Shuffle size={14} /> Randomize
          </button>
        </div>
      </div>
      {hasPrevResults && (
        <p style={{ margin: 0, color: C.muted, fontSize: 13 }}>
          Default seeding is based on Tournament {prevTournament.tournament_number} results. Seed 1 gets the best bracket position.
        </p>
      )}
      {!hasPrevResults && (
        <p style={{ margin: 0, color: C.muted, fontSize: 13 }}>
          Seed 1 gets the best bracket position. Drag or use arrows to reorder.
        </p>
      )}
      <ReorderList
        items={seeding}
        onMove={moveItem(seeding, setSeeding)}
        renderItem={(p, idx) => (
          <PlayerChip player={p} style={{ background: idx === 0 ? `${C.accent}18` : C.bg }} />
        )}
      />
    </div>
    )
  }

  const renderStep4 = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>Draft Order</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => setDraftOrder([...seeding])}
            style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: '7px 10px', color: C.muted, cursor: 'pointer', fontSize: 12 }}
          >
            Mirror Seeding
          </button>
          <button
            onClick={() => setDraftOrder([...seeding].reverse())}
            style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: '7px 10px', color: C.muted, cursor: 'pointer', fontSize: 12 }}
          >
            Reverse Seeding
          </button>
          <button
            onClick={() => setDraftOrder(shuffle(draftOrder))}
            style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: '7px 10px', color: C.muted, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5, fontSize: 12 }}
          >
            <Shuffle size={13} /> Randomize
          </button>
        </div>
      </div>
      <p style={{ margin: 0, color: C.muted, fontSize: 13 }}>
        Pick 1 goes first in Round 1. Snake draft reverses each round automatically.
      </p>
      <ReorderList
        items={draftOrder}
        onMove={moveItem(draftOrder, setDraftOrder)}
        renderItem={(p) => <PlayerChip player={p} />}
      />
    </div>
  )

  const renderStep5 = () => {
    const prevTournament = activeTournament && !activeTournament.archived ? activeTournament : null
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>Review & Create</h2>

        {prevTournament && (
          <div style={{ background: `#EAB30818`, border: `1px solid #EAB30844`, borderRadius: 10, padding: '12px 16px' }}>
            <div style={{ color: C.accent, fontWeight: 700, fontSize: 13, marginBottom: 4 }}>⚠ Previous tournament will be archived</div>
            <div style={{ color: C.muted, fontSize: 12 }}>
              Tournament {prevTournament.tournament_number} will be archived when you create this one. You can still view it from the tournament selector.
            </div>
          </div>
        )}

        <div style={{ background: C.bg, borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {[
            ['Tournament #', tournamentNumber],
            ['Date', date],
            ['Innings', innings],
            ['Mercy Rule', mercyRule ? 'On — 10 run lead' : 'Off'],
            ['Format', FORMAT_OPTIONS.find(f => f.value === bracketFormat)?.label],
            ['Players', selectedPlayers.map(p => p.name).join(', ')],
            ['Seeding', seeding.map((p, i) => `${i + 1}. ${p.name}`).join(' · ')],
            ['Draft Order', draftOrder.map((p, i) => `${i + 1}. ${p.name}`).join(' · ')],
          ].map(([label, val]) => (
            <div key={label} style={{ display: 'flex', gap: 12, fontSize: 14 }}>
              <span style={{ color: C.muted, minWidth: 120, flexShrink: 0 }}>{label}</span>
              <span style={{ fontWeight: 600, wordBreak: 'break-word' }}>{val}</span>
            </div>
          ))}
        </div>

        <button
          onClick={handleCreate}
          disabled={submitting || selectedPlayers.length < 4 || selectedPlayers.length > 8}
          style={{
            background: submitting ? C.border : C.accent, color: '#000', border: 'none',
            borderRadius: 12, padding: '16px 0', fontWeight: 800, fontSize: 18,
            cursor: submitting ? 'not-allowed' : 'pointer', width: '100%',
          }}
        >
          {submitting ? 'Creating…' : `Create Tournament ${tournamentNumber}`}
        </button>
      </div>
    )
  }

  const stepContent = [renderStep1, renderStep2, renderStep3, renderStep4, renderStep5]

  const canAdvance = step < 5 && (step !== 2 || (selectedPlayers.length >= 4 && selectedPlayers.length <= 8))

  return (
    <div style={{ maxWidth: 600, margin: '0 auto', color: C.text }}>
      <div className="page-head">
        <div>
          <span className="brand-kicker">Commissioner</span>
          <h1>New Tournament</h1>
        </div>
      </div>

      <div className="panel" style={{ background: C.card, borderRadius: 14, padding: 24 }}>
        <StepIndicator current={step} />
        {stepContent[step - 1]()}

        <div style={{ display: 'flex', gap: 10, marginTop: 28, justifyContent: 'space-between' }}>
          <button
            onClick={() => setStep(s => s - 1)}
            disabled={step === 1}
            style={{
              background: 'none', border: `1px solid ${C.border}`, borderRadius: 10,
              padding: '12px 20px', color: step === 1 ? C.border : C.muted,
              cursor: step === 1 ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: 14,
            }}
          >
            ← Back
          </button>
          {step < 5 && (
            <button
              onClick={() => setStep(s => s + 1)}
              disabled={!canAdvance}
              style={{
                background: canAdvance ? C.accent : C.border, color: '#000', border: 'none',
                borderRadius: 10, padding: '12px 28px', fontWeight: 800, fontSize: 15,
                cursor: canAdvance ? 'pointer' : 'not-allowed',
              }}
            >
              Next →
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
