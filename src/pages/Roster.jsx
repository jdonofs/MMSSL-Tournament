import { useCallback, useEffect, useMemo, useState, useRef } from 'react'
import { ChevronLeft, Music, X } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { useTournament } from '../context/TournamentContext'
import { buildCharacterTournamentHistory, MIN_PA_THRESHOLD } from '../utils/statsCalculator'
import CharacterPortrait from '../components/CharacterPortrait'
import { getChemistry, chemScore } from '../data/chemistry'
import { formatCharacterDisplayName, getCharacterChemistryName } from '../utils/mii'

// ─── Scoring ──────────────────────────────────────────────────────────────────
function baseScore(c) {
  const raw = [c.pitching, c.batting, c.fielding, c.speed]
  const weighted = c.batting * 0.35 + c.pitching * 0.35 + c.speed * 0.20 + c.fielding * 0.10
  const mean = raw.reduce((s, v) => s + v, 0) / 4
  const stdDev = Math.sqrt(raw.reduce((s, v) => s + (v - mean) ** 2, 0) / 4)
  return weighted - stdDev * 0.5
}

function finalScore(c, tournHistory) {
  const base = baseScore(c)
  if (!tournHistory || tournHistory.length === 0) return base
  const valid = tournHistory.filter(t => t.perfScore !== null)
  if (valid.length === 0) return base
  const histAvg = valid.reduce((s, t) => s + t.perfScore, 0) / valid.length
  const histFactor = Math.min(valid.length / 5, 1.0) * 0.3
  return base * (1 - histFactor) + histAvg * histFactor
}

function trendSymbol(history) {
  const valid = (history || []).filter(t => t.perfScore !== null)
  if (valid.length < 2) return null
  const last = valid[valid.length - 1].perfScore
  const prev = valid.slice(0, -1).reduce((s, t) => s + t.perfScore, 0) / (valid.length - 1)
  if (last > prev + 0.4) return '↑'
  if (last < prev - 0.4) return '↓'
  return '→'
}

// ─── Shared sub-components ────────────────────────────────────────────────────
function Portrait({ name, size = 36, style = {}, showMusic = false }) {
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <CharacterPortrait name={name} size={size} draggable={false} style={style} />
      {showMusic && <Music size={size * 0.4} style={{ position: 'absolute', bottom: -4, right: -4, color: '#EAB308', fill: '#EAB308' }} />}
    </div>
  )
}

function StatBar({ label, value, color = '#EAB308' }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ width: 12, fontSize: 11, color: '#94A3B8', fontWeight: 700 }}>{label}</span>
      <div style={{ flex: 1, height: 6, background: '#0F172A', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${value * 10}%`, background: color, borderRadius: 3 }} />
      </div>
      <span style={{ width: 18, textAlign: 'right', fontSize: 13, fontWeight: 600 }}>{value}</span>
    </div>
  )
}

// ─── Character Card Panel ─────────────────────────────────────────────────────
function CharacterCard({ characterId, charactersById, rosterCharacterMetaById, tournHistories, rosterNames, onClose }) {
  const c = charactersById[characterId]
  if (!c) return null
  const meta = rosterCharacterMetaById?.[characterId]
  const displayName = meta?.displayName || c.name
  const chemistryName = meta?.chemistryName || c.name

  const history = tournHistories[c.id] || []
  const validHistory = history.filter(t => t.perfScore !== null)
  const base = baseScore(c)
  const score = finalScore(c, history)
  const histAvg = validHistory.length ? validHistory.reduce((s, t) => s + t.perfScore, 0) / validHistory.length : null
  const histFactor = Math.min(validHistory.length / 5, 1.0) * 0.3
  const chem = getChemistry(chemistryName)
  const net = chemScore(chemistryName, rosterNames)
  const trend = trendSymbol(history)
  const trendColor = trend === '↑' ? '#22C55E' : trend === '↓' ? '#F87171' : '#94A3B8'

  return (
    <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: Math.min(400, window.innerWidth), background: '#0F172A', borderLeft: '1px solid #1E293B', zIndex: 50, display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
      {/* Sticky header */}
      <div style={{ position: 'sticky', top: 0, background: '#0F172A', borderBottom: '1px solid #1E293B', padding: '10px 14px', zIndex: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 12, fontWeight: 700 }}>{displayName}</div>
        <button onClick={onClose} type="button" style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer', padding: 4 }}>
          <X size={18} />
        </button>
      </div>

      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Portrait + name */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <Portrait name={c.name} size={72} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 20 }}>{displayName}</div>
            {net !== null && <div style={{ fontSize: 12, marginTop: 3, color: net > 0 ? '#22C55E' : net < 0 ? '#F87171' : '#64748B', fontWeight: 700 }}>Chem {net > 0 ? `+${net}` : net}</div>}
            {trend && <div style={{ fontSize: 12, marginTop: 3, color: trendColor, fontWeight: 700 }}>{trend} {validHistory.length}T</div>}
          </div>
        </div>

        {/* Stat bars */}
        <div style={{ background: '#1E293B', borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <StatBar label="P" value={c.pitching} color="#EF4444" />
          <StatBar label="B" value={c.batting} color="#22C55E" />
          <StatBar label="F" value={c.fielding} color="#EAB308" />
          <StatBar label="S" value={c.speed} color="#3B82F6" />
        </div>

        {/* Value score breakdown */}
        <div style={{ background: '#1E293B', borderRadius: 10, padding: '12px 14px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
            <span style={{ fontSize: 11, color: '#94A3B8', fontWeight: 700, textTransform: 'uppercase' }}>Value Score</span>
            <span style={{ fontSize: 24, fontWeight: 800, color: '#EAB308' }}>{score.toFixed(2)}</span>
          </div>
          <div style={{ fontSize: 12, color: '#64748B', marginBottom: 6 }}>Base components</div>
          {[
            { label: 'Batting ×0.35',  val: c.batting * 0.35 },
            { label: 'Pitching ×0.35', val: c.pitching * 0.35 },
            { label: 'Speed ×0.20',    val: c.speed * 0.20 },
            { label: 'Fielding ×0.10', val: c.fielding * 0.10 },
          ].map(({ label, val }) => (
            <div key={label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#94A3B8', marginBottom: 2 }}>
              <span>{label}</span><span style={{ color: '#CBD5E1' }}>+{val.toFixed(2)}</span>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#475569', marginBottom: 2, opacity: 0.3 }}>
            <span>Adjustment</span>
            <span>−{(() => { const raw=[c.pitching,c.batting,c.fielding,c.speed]; const m=raw.reduce((s,v)=>s+v,0)/4; return (Math.sqrt(raw.reduce((s,v)=>s+(v-m)**2,0)/4)*0.5).toFixed(2) })()}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#94A3B8', borderTop: '1px solid #334155', marginTop: 4, paddingTop: 4 }}>
            <span style={{ color: '#CBD5E1' }}>Base score</span><span style={{ color: '#CBD5E1', fontWeight: 600 }}>{base.toFixed(2)}</span>
          </div>
          {histAvg !== null && (
            <>
              <div style={{ fontSize: 12, color: '#64748B', marginTop: 8, marginBottom: 4 }}>Historical adjustment ({validHistory.length} tournament{validHistory.length !== 1 ? 's' : ''}, {(histFactor * 100).toFixed(0)}% weight)</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#94A3B8', marginBottom: 2 }}>
                <span>Hist. avg score</span><span style={{ color: '#CBD5E1' }}>{histAvg.toFixed(2)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#EAB308', borderTop: '1px solid #334155', marginTop: 4, paddingTop: 4, fontWeight: 700 }}>
                <span>Final (blended)</span><span>{score.toFixed(2)}</span>
              </div>
            </>
          )}
        </div>

        {/* Tournament history */}
        {history.length > 0 && (
          <div style={{ background: '#1E293B', borderRadius: 10, padding: '12px 14px' }}>
            <div style={{ fontSize: 11, color: '#94A3B8', fontWeight: 700, textTransform: 'uppercase', marginBottom: 8 }}>Tournament History</div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ color: '#64748B', borderBottom: '1px solid #334155' }}>
                  {['T#', 'PA', 'AVG', 'OPS', 'HR', 'RBI', 'Score'].map(h => (
                    <th key={h} style={{ textAlign: h === 'T#' ? 'left' : 'center', padding: '3px 4px', fontWeight: 700 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {history.map((t, i) => (
                  <tr key={t.tournamentId} style={{ borderBottom: '1px solid #0F172A', color: t.perfScore === null ? '#475569' : '#CBD5E1' }}>
                    <td style={{ padding: '4px 4px', fontWeight: 700 }}>T{t.tournamentNumber}</td>
                    <td style={{ textAlign: 'center', padding: '4px 4px' }}>{t.pa}</td>
                    <td style={{ textAlign: 'center', padding: '4px 4px' }}>{t.avg.toFixed(3)}</td>
                    <td style={{ textAlign: 'center', padding: '4px 4px' }}>{t.ops.toFixed(3)}</td>
                    <td style={{ textAlign: 'center', padding: '4px 4px' }}>{t.hr}</td>
                    <td style={{ textAlign: 'center', padding: '4px 4px' }}>{t.rbi}</td>
                    <td style={{ textAlign: 'center', padding: '4px 4px', fontWeight: 700, color: t.perfScore === null ? '#334155' : '#EAB308' }}>
                      {t.perfScore !== null ? t.perfScore.toFixed(1) : `<${MIN_PA_THRESHOLD}PA`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Chemistry */}
        {(chem.good.length > 0 || chem.bad.length > 0) && (
          <div style={{ background: '#1E293B', borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <span style={{ fontSize: 11, color: '#94A3B8', fontWeight: 700, textTransform: 'uppercase' }}>Chemistry</span>
            {chem.good.length > 0 && (
              <div>
                <div style={{ fontSize: 11, color: '#22C55E', fontWeight: 600, marginBottom: 6 }}>Good</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {chem.good.map(name => <Portrait key={name} name={name} size={32} />)}
                </div>
              </div>
            )}
            {chem.bad.length > 0 && (
              <div>
                <div style={{ fontSize: 11, color: '#F87171', fontWeight: 600, marginBottom: 6 }}>Bad</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {chem.bad.map(name => <Portrait key={name} name={name} size={32} />)}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Draggable Roster Item ────────────────────────────────────────────────────
function DraggableRosterItem({ character, onDragStart, rosterNames, onClick, showMusic = false }) {
  const net = chemScore(character.chemistryName || character.name, rosterNames)
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onClick={onClick}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: '#1E293B', borderRadius: 8, cursor: 'move', border: '1px solid #334155' }}
    >
      <Portrait name={character.name} size={40} showMusic={showMusic} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{character.displayName || character.name}</div>
        {net !== null && <div style={{ fontSize: 10, color: net > 0 ? '#22C55E' : net < 0 ? '#F87171' : '#64748B', fontWeight: 700 }}>{net > 0 ? `+${net}` : net === 0 ? '±0' : net} chem</div>}
      </div>
    </div>
  )
}

// ─── Baseball Field Positions ─────────────────────────────────────────────────
const FIELD_POSITIONS = [
  { id: 'pitcher', label: 'P', x: 50, y: 54 },
  { id: 'catcher', label: 'C', x: 50, y: 76 },
  { id: 'firstBase', label: '1B', x: 64, y: 59 },
  { id: 'secondBase', label: '2B', x: 57, y: 42 },
  { id: 'thirdBase', label: '3B', x: 36, y: 59 },
  { id: 'shortStop', label: 'SS', x: 43, y: 42 },
  { id: 'leftField', label: 'LF', x: 28, y: 24 },
  { id: 'centerField', label: 'CF', x: 50, y: 16 },
  { id: 'rightField', label: 'RF', x: 72, y: 24 },
]

function FieldingView({ roster, charactersById, rosterNames, fieldingPositions, setFieldingPositions, selectedPlayer, setSelectedPlayer, onCharacterClick, tournHistories, fieldingAssignMode, selectedForFielding, onAssignPosition }) {
  const handleDragOver = (e) => {
    e.preventDefault()
  }

  const assignCharToPos = useCallback((posId, characterId) => {
    setFieldingPositions(prev => {
      const next = { ...prev }
      const targetCharId = next[posId]
      if (targetCharId && targetCharId !== characterId) {
        const dragSourcePos = Object.entries(next).find(([_, cId]) => cId === characterId)?.[0]
        if (dragSourcePos) {
          next[dragSourcePos] = targetCharId
          next[posId] = characterId
        } else {
          next[posId] = characterId
        }
      } else {
        next[posId] = characterId
        Object.keys(next).forEach(pos => {
          if (pos !== posId && next[pos] === characterId) delete next[pos]
        })
      }
      return next
    })
  }, [setFieldingPositions])

  const handleDropOnPosition = (posId) => (e) => {
    e.preventDefault()
    const characterId = parseInt(e.dataTransfer.getData('characterId'), 10)
    if (characterId) assignCharToPos(posId, characterId)
  }

  const handleDragStartPosition = (characterId) => (e) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('characterId', String(characterId))
  }

  const handlePositionClick = (posId) => {
    if (fieldingAssignMode && selectedForFielding) {
      assignCharToPos(posId, selectedForFielding)
      onAssignPosition()
      return
    }
    const charId = fieldingPositions[posId]
    if (charId) setSelectedPlayer(charId)
  }

  return (
    <div style={{ background: 'linear-gradient(180deg, #1D4ED8 0%, #0F172A 100%)', borderRadius: 18, padding: 18, marginBottom: 20, border: `2px solid ${fieldingAssignMode ? '#A78BFA' : '#60A5FA'}`, boxShadow: 'inset 0 1px 0 #93C5FD40', transition: 'border-color 0.2s' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <h3 style={{ fontSize: 14, fontWeight: 800, color: '#EFF6FF', letterSpacing: '.04em', textTransform: 'uppercase' }}>Fielding Positions</h3>
        <div style={{ fontSize: 11, fontWeight: 700, color: fieldingAssignMode ? '#A78BFA' : '#DBEAFE', background: '#0F172A55', padding: '4px 8px', borderRadius: 999 }}>
          {fieldingAssignMode
            ? (selectedForFielding ? '📍 Tap position to place' : 'Tap roster player first')
            : 'Drag or tap-select to swap'}
        </div>
      </div>
      <div style={{ position: 'relative', width: '100%', maxWidth: 420, aspectRatio: '1/1.08', background: 'radial-gradient(circle at 50% 18%, #86EFAC 0%, #4ADE80 22%, #2E8B57 52%, #24553A 100%)', borderRadius: 22, border: '4px solid #BFDBFE', margin: '0 auto', overflow: 'hidden', boxShadow: 'inset 0 10px 30px #00000030' }}>
        <div style={{ position: 'absolute', inset: '10% 14% 8%', borderRadius: '50% 50% 22% 22%', background: 'radial-gradient(circle at 50% 35%, #7CFC8A 0%, #4CAF50 45%, #2B6B3F 100%)', opacity: 0.85 }} />
        <div style={{ position: 'absolute', left: '50%', top: '53%', width: '34%', height: '34%', background: '#C8A873', transform: 'translate(-50%, -50%) rotate(45deg)', borderRadius: 16, boxShadow: 'inset 0 0 0 3px #FDE68A80' }} />
        <div style={{ position: 'absolute', left: '50%', top: '53%', width: '23%', height: '23%', border: '3px solid #FFF7ED', transform: 'translate(-50%, -50%) rotate(45deg)', borderRadius: 12, opacity: 0.95 }} />
        <div style={{ position: 'absolute', left: '50%', top: '56%', width: '12%', height: '12%', background: '#D6B38C', transform: 'translate(-50%, -50%) rotate(45deg)', borderRadius: 8 }} />
        <div style={{ position: 'absolute', left: '50%', top: '58%', width: 34, height: 34, background: '#E5E7EB', transform: 'translate(-50%, -50%) rotate(45deg)', borderRadius: 8, boxShadow: '0 0 0 2px #FFFFFF80' }} />
        {[
          { left: '50%', top: '41%' },
          { left: '62%', top: '53%' },
          { left: '50%', top: '65%' },
          { left: '38%', top: '53%' },
        ].map((base, index) => (
          <div key={index} style={{ position: 'absolute', left: base.left, top: base.top, width: 14, height: 14, background: '#FFFFFF', transform: 'translate(-50%, -50%) rotate(45deg)', borderRadius: 3, boxShadow: '0 0 0 2px #E2E8F0' }} />
        ))}
        {FIELD_POSITIONS.map(pos => {
          const charId = fieldingPositions[pos.id]
          const character = charId ? charactersById[charId] : null
          return (
            <div
              key={pos.id}
              onClick={() => handlePositionClick(pos.id)}
              draggable={Boolean(character)}
              onDragStart={character ? handleDragStartPosition(charId) : undefined}
              onDragOver={handleDragOver}
              onDrop={handleDropOnPosition(pos.id)}
              style={{ position: 'absolute', left: `${pos.x}%`, top: `${pos.y}%`, transform: 'translate(-50%, -50%)', width: 76, height: 76, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: character ? 'pointer' : 'move' }}
            >
              {character ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                  <Portrait name={character.name} size={42} showMusic={selectedPlayer === charId} style={{ boxShadow: '0 6px 14px #00000040', background: 'transparent' }} />
                  <div style={{ fontSize: 10, fontWeight: 800, color: '#F8FAFC', textShadow: '0 1px 2px #000', background: '#0F172A99', padding: '2px 5px', borderRadius: 999 }}>{pos.label}</div>
                </div>
              ) : (
                <div style={{ width: 42, height: 42, borderRadius: '50%', background: '#0F172A66', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, color: '#E2E8F0', border: '2px dashed #BFDBFE' }}>{pos.label}</div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Main Roster Component ────────────────────────────────────────────────────
export default function Roster() {
  const { player } = useAuth()
  const { currentTournament, allTournaments, selectedTournamentId: ctxTournamentId } = useTournament()
  const [players, setPlayers] = useState([])
  const [characters, setCharacters] = useState([])
  const [allDraftPicks, setAllDraftPicks] = useState([])
  const [plateAppearances, setPlateAppearances] = useState([])
  const [games, setGames] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedTeamId, setSelectedTeamId] = useState(null)
  // ctxTournamentId comes from localStorage-backed TournamentContext — available on first render
  // (currentTournament?.id is always null until Supabase responds, so we can't use that)
  const [selectedTournamentId, setSelectedTournamentId] = useState(() => ctxTournamentId || null)
  const [fieldingPositions, setFieldingPositions] = useState({})
  const [lineupOrder, setLineupOrder] = useState([])
  const [selectedPlayer, setSelectedPlayer] = useState(null)
  const [cardCharacterId, setCardCharacterId] = useState(null)
  const [fieldingAssignMode, setFieldingAssignMode] = useState(false)
  const [selectedForFielding, setSelectedForFielding] = useState(null)

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      const [{ data: pData }, { data: cData }, { data: dData }, { data: paData }, { data: gData }] = await Promise.all([
        supabase.from('players').select('*').order('created_at'),
        supabase.from('characters').select('*').order('name'),
        supabase.from('draft_picks').select('*').order('pick_number'),
        supabase.from('plate_appearances').select('game_id,character_id,result,run_scored,rbi'),
        supabase.from('games').select('id,tournament_id'),
      ])
      setPlayers(pData || [])
      setCharacters(cData || [])
      setAllDraftPicks(dData || [])
      setPlateAppearances(paData || [])
      setGames(gData || [])
      setLoading(false)
    }
    load()
    const channel = supabase
      .channel(`roster-live-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'players' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'characters' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'draft_picks' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'plate_appearances' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'games' }, load)
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [])

  // Once players load, resolve the correct default team.
  // Matches by UUID first, then falls back to player name (handles stale localStorage UUIDs).
  // Skips if the user has already made a valid manual selection.
  useEffect(() => {
    if (players.length === 0) return
    if (selectedTeamId && players.some(p => String(p.id) === String(selectedTeamId))) return
    const mine = players.find(p => String(p.id) === String(player?.id))
      ?? players.find(p => p.name === player?.name)
    if (mine) setSelectedTeamId(String(mine.id))
  }, [players, player?.id, player?.name, selectedTeamId])

  // Fallback: set tournament if it wasn't available from localStorage on first render
  useEffect(() => {
    if (ctxTournamentId && selectedTournamentId === null) {
      setSelectedTournamentId(ctxTournamentId)
    }
  }, [ctxTournamentId, selectedTournamentId])

  const charactersById = useMemo(() => Object.fromEntries(characters.map(c => [c.id, c])), [characters])

  const draftPicks = useMemo(() => {
    if (!selectedTournamentId) return []
    // Look up the full tournament object for tournament_number-based legacy records
    const allTourneys = [currentTournament, ...(allTournaments || [])].filter(Boolean)
    const selectedTourney = allTourneys.find(t => String(t.id) === String(selectedTournamentId))

    // Always match by UUID string first — this works as soon as allDraftPicks loads,
    // without waiting for the tournament list to load from Supabase.
    // Also match by tournament_number for older draft_picks records.
    return allDraftPicks.filter(p =>
      String(p.tournament_id) === String(selectedTournamentId) ||
      (selectedTourney && p.tournament_id === selectedTourney.tournament_number)
    )
  }, [allDraftPicks, selectedTournamentId, currentTournament, allTournaments])

  const teamRoster = useMemo(() => {
    if (!selectedTeamId) return []
    return draftPicks
      .filter(p => String(p.player_id) === String(selectedTeamId) && p.character_id)
      .map(p => {
        const character = charactersById[p.character_id]
        if (!character) return null
        return {
          ...character,
          miiColor: p.mii_color,
          displayName: formatCharacterDisplayName(character.name, p.mii_color),
          chemistryName: getCharacterChemistryName(character.name, p.mii_color),
        }
      })
      .filter(Boolean)
  }, [draftPicks, selectedTeamId, charactersById])

  // Auto-populate fielding positions and lineup when team roster changes
  useEffect(() => {
    if (teamRoster.length === 0) {
      setFieldingPositions({})
      setLineupOrder([])
      return
    }

    const newFielding = {}
    const positions = ['pitcher', 'catcher', 'firstBase', 'secondBase', 'thirdBase', 'shortStop', 'leftField', 'centerField', 'rightField']
    for (let i = 0; i < Math.min(9, teamRoster.length); i++) {
      newFielding[positions[i]] = teamRoster[i].id
    }
    setFieldingPositions(newFielding)

    // Load saved lineup order from localStorage, falling back to draft pick order
    const savedKey = `roster-lineup-${selectedTournamentId}-${selectedTeamId}`
    try {
      const saved = JSON.parse(localStorage.getItem(savedKey) || 'null')
      if (saved && Array.isArray(saved)) {
        const rosterIds = new Set(teamRoster.map(c => c.id))
        const ordered = saved.filter(id => rosterIds.has(id))
        const remaining = teamRoster.map(c => c.id).filter(id => !ordered.includes(id))
        setLineupOrder([...ordered, ...remaining])
        return
      }
    } catch {}
    setLineupOrder(teamRoster.map(c => c.id))
  }, [teamRoster, selectedTournamentId, selectedTeamId])

  const rosterNames = useMemo(() => teamRoster.map(c => c.chemistryName || c.name), [teamRoster])
  const rosterCharacterMetaById = useMemo(() => Object.fromEntries(teamRoster.map(c => [c.id, c])), [teamRoster])

  const historicalGames = useMemo(() => {
    if (!selectedTournamentId) return []
    return games.filter(g => g.tournament_id !== selectedTournamentId)
  }, [games, selectedTournamentId])

  const historicalPAs = useMemo(() => {
    const hGameIds = new Set(historicalGames.map(g => g.id))
    return plateAppearances.filter(pa => hGameIds.has(pa.game_id))
  }, [plateAppearances, historicalGames])

  const tournHistories = useMemo(
    () => buildCharacterTournamentHistory(historicalPAs, historicalGames, allTournaments || []),
    [historicalPAs, historicalGames, allTournaments]
  )

  const handleDragStartRoster = (characterId) => (e) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('characterId', String(characterId))
  }

  const handleDragStartLineup = (characterId) => (e) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('lineupCharacterId', String(characterId))
  }

  const handleDropOnLineup = (index) => (e) => {
    e.preventDefault()
    const characterId = parseInt(e.dataTransfer.getData('lineupCharacterId'), 10)
    if (characterId) {
      setLineupOrder(prev => {
        if (!prev.includes(characterId)) return prev
        const newOrder = prev.filter(id => id !== characterId)
        newOrder.splice(index, 0, characterId)
        if (selectedTournamentId && selectedTeamId) {
          localStorage.setItem(`roster-lineup-${selectedTournamentId}-${selectedTeamId}`, JSON.stringify(newOrder))
        }
        return newOrder
      })
    }
  }

  const handleDragOverLineup = (e) => {
    e.preventDefault()
    e.currentTarget.style.background = '#1E293B'
  }

  const handleDragLeaveLineup = (e) => {
    e.currentTarget.style.background = 'transparent'
  }

  const moveInLineup = useCallback((index, dir) => {
    const targetIdx = index + dir
    setLineupOrder(prev => {
      if (targetIdx < 0 || targetIdx >= prev.length) return prev
      const next = [...prev];
      [next[index], next[targetIdx]] = [next[targetIdx], next[index]]
      if (selectedTournamentId && selectedTeamId) {
        localStorage.setItem(`roster-lineup-${selectedTournamentId}-${selectedTeamId}`, JSON.stringify(next))
      }
      return next
    })
  }, [selectedTournamentId, selectedTeamId])

  const exitFieldingAssignMode = useCallback(() => {
    setFieldingAssignMode(false)
    setSelectedForFielding(null)
  }, [])

  return (
    <div style={{ padding: '0 16px 80px' }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 800, marginBottom: 16 }}>Roster</h1>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <label style={{ fontSize: 11, color: '#94A3B8', fontWeight: 700, marginBottom: 4, textTransform: 'uppercase' }}>Team</label>
            <select value={String(selectedTeamId || '')} onChange={e => setSelectedTeamId(e.target.value)} style={{ background: '#1E293B', border: '1px solid #334155', borderRadius: 8, color: '#E2E8F0', padding: '8px 10px', fontSize: 13, fontWeight: 600 }}>
              {players.map(p => (
                <option key={p.id} value={String(p.id)}>{p.name}</option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <label style={{ fontSize: 11, color: '#94A3B8', fontWeight: 700, marginBottom: 4, textTransform: 'uppercase' }}>Tournament</label>
            <select value={String(selectedTournamentId || '')} onChange={e => setSelectedTournamentId(e.target.value)} style={{ background: '#1E293B', border: '1px solid #334155', borderRadius: 8, color: '#E2E8F0', padding: '8px 10px', fontSize: 13, fontWeight: 600 }}>
              {[currentTournament, ...((allTournaments || []).filter(t => t.id !== currentTournament?.id))].filter(Boolean).map(t => (
                <option key={t.id} value={String(t.id)}>Tournament {t.tournament_number}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Lineup */}
      <div style={{ background: 'linear-gradient(180deg, #2563EB 0%, #0F172A 100%)', borderRadius: 18, padding: 16, marginBottom: 24, border: '2px solid #60A5FA', boxShadow: 'inset 0 1px 0 #93C5FD40' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h3 style={{ fontSize: 14, fontWeight: 800, color: '#EFF6FF', letterSpacing: '.04em', textTransform: 'uppercase' }}>Batting Order</h3>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#DBEAFE', background: '#0F172A55', padding: '4px 8px', borderRadius: 999 }}>Drag or use ← →</div>
        </div>
        <div style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 4 }}>
          {lineupOrder.length === 0 ? (
            <div style={{ padding: 16, textAlign: 'center', color: '#64748B', fontSize: 12, width: '100%' }}>No lineup available for this roster</div>
          ) : (
            lineupOrder.map((charId, i) => {
              const character = charactersById[charId]
              if (!character) return null
              return (
                <div
                  key={charId}
                  draggable
                  onDragStart={handleDragStartLineup(charId)}
                  onDragOver={handleDragOverLineup}
                  onDragLeave={handleDragLeaveLineup}
                  onDrop={handleDropOnLineup(i)}
                  style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '8px 6px 4px', minWidth: 58, background: selectedPlayer === charId ? '#FACC1533' : '#0F172A55', borderRadius: 14, border: `2px solid ${selectedPlayer === charId ? '#FACC15' : '#93C5FD55'}`, cursor: 'grab', fontSize: 12, flex: '0 0 auto', boxShadow: 'inset 0 1px 0 #FFFFFF20' }}
                >
                  <div style={{ width: 22, height: 22, borderRadius: '50%', background: selectedPlayer === charId ? '#FACC15' : '#DBEAFE', color: '#0F172A', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 900 }}>{i + 1}</div>
                  <Portrait name={character.name} size={32} showMusic={selectedPlayer === charId} onClick={() => setSelectedPlayer(selectedPlayer === charId ? null : charId)} style={{ cursor: 'pointer', boxShadow: '0 4px 10px #00000040', background: 'transparent' }} />
                  <div style={{ maxWidth: 52, textAlign: 'center' }}>
                    <div style={{ fontWeight: 700, fontSize: 9, lineHeight: 1.1, color: '#EFF6FF', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{(character.displayName || character.name).split(' ')[0]}</div>
                  </div>
                  {/* Touch-friendly reorder buttons */}
                  <div style={{ display: 'flex', gap: 2, marginTop: 2 }}>
                    <button
                      type="button"
                      disabled={i === 0}
                      onClick={e => { e.stopPropagation(); moveInLineup(i, -1) }}
                      style={{ background: 'none', border: 'none', color: i === 0 ? '#1E3A5F' : '#93C5FD', fontSize: 14, cursor: i === 0 ? 'default' : 'pointer', padding: '4px 6px', lineHeight: 1, minWidth: 24, minHeight: 28 }}
                    >‹</button>
                    <button
                      type="button"
                      disabled={i === lineupOrder.length - 1}
                      onClick={e => { e.stopPropagation(); moveInLineup(i, 1) }}
                      style={{ background: 'none', border: 'none', color: i === lineupOrder.length - 1 ? '#1E3A5F' : '#93C5FD', fontSize: 14, cursor: i === lineupOrder.length - 1 ? 'default' : 'pointer', padding: '4px 6px', lineHeight: 1, minWidth: 24, minHeight: 28 }}
                    >›</button>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="roster-grid">
        {/* Left: Roster List */}
        <div style={{ background: '#0F172A', borderRadius: 10, padding: 16, height: 'fit-content', maxHeight: '80vh', overflowY: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: '#CBD5E1', margin: 0 }}>Roster</h3>
            <button
              type="button"
              onClick={() => {
                if (fieldingAssignMode) { exitFieldingAssignMode() }
                else { setFieldingAssignMode(true); setSelectedForFielding(null) }
              }}
              style={{ fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 999, border: `1px solid ${fieldingAssignMode ? '#A78BFA' : '#334155'}`, background: fieldingAssignMode ? '#A78BFA22' : 'none', color: fieldingAssignMode ? '#A78BFA' : '#94A3B8', cursor: 'pointer' }}
            >
              {fieldingAssignMode ? '✕ Cancel' : '📍 Assign'}
            </button>
          </div>
          {fieldingAssignMode && (
            <div style={{ fontSize: 11, color: '#A78BFA', background: '#A78BFA18', borderRadius: 8, padding: '6px 10px', marginBottom: 10, fontWeight: 600 }}>
              Tap a player, then tap a field position to assign them.
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {teamRoster.length === 0 ? (
              <div style={{ padding: 12, textAlign: 'center', color: '#64748B', fontSize: 12 }}>No players drafted yet</div>
            ) : (
              teamRoster.map(character => {
                const isSelectedForField = selectedForFielding === character.id
                return (
                  <div
                    key={character.id}
                    onClick={() => {
                      if (fieldingAssignMode) {
                        setSelectedForFielding(prev => prev === character.id ? null : character.id)
                      } else {
                        setCardCharacterId(character.id)
                      }
                    }}
                    style={{ outline: isSelectedForField ? '2px solid #A78BFA' : 'none', borderRadius: 8 }}
                  >
                    <DraggableRosterItem
                      character={character}
                      onDragStart={handleDragStartRoster(character.id)}
                      rosterNames={rosterNames}
                      showMusic={selectedPlayer === character.id}
                      onClick={() => {
                        if (!fieldingAssignMode) setSelectedPlayer(selectedPlayer === character.id ? null : character.id)
                      }}
                    />
                  </div>
                )
              })
            )}
          </div>
        </div>

        {/* Right: Fielding */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <FieldingView
            roster={teamRoster}
            charactersById={charactersById}
            rosterNames={rosterNames}
            fieldingPositions={fieldingPositions}
            setFieldingPositions={setFieldingPositions}
            selectedPlayer={selectedPlayer}
            setSelectedPlayer={setSelectedPlayer}
            onCharacterClick={setCardCharacterId}
            tournHistories={tournHistories}
            fieldingAssignMode={fieldingAssignMode}
            selectedForFielding={selectedForFielding}
            onAssignPosition={exitFieldingAssignMode}
          />
        </div>
      </div>

      {/* Character Card */}
      {cardCharacterId && (
        <>
          <div onClick={() => setCardCharacterId(null)} style={{ position: 'fixed', inset: 0, background: '#00000060', zIndex: 49 }} />
          <CharacterCard
            characterId={cardCharacterId}
            charactersById={charactersById}
            rosterCharacterMetaById={rosterCharacterMetaById}
            tournHistories={tournHistories}
            rosterNames={rosterNames}
            onClose={() => setCardCharacterId(null)}
          />
        </>
      )}
    </div>
  )
}
