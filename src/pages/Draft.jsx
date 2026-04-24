import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronLeft, RotateCcw, SkipForward, Star, X, Zap } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { useTournament } from '../context/TournamentContext'
import PlayerTag from '../components/PlayerTag'
import { buildCharacterTournamentHistory, MIN_PA_THRESHOLD } from '../utils/statsCalculator'
import CharacterPortrait from '../components/CharacterPortrait'
import { getChemistry, chemScore, CHARACTER_VARIANTS } from '../data/chemistry'
import { formatCharacterDisplayName, getCharacterChemistryName, isMiiCharacter, MII_COLOR_OPTIONS } from '../utils/mii'
import { buildTournamentTeamIdentityMap, getCaptainIdentityFromName, isCaptainCharacterName } from '../utils/teamIdentity'

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
function Portrait({ name, size = 36, style = {} }) {
  return <CharacterPortrait name={name} size={size} style={style} />
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

function ChemChip({ name, rosterNames, draftedNames, onClick }) {
  const onRoster = rosterNames.includes(name)
  const drafted = !onRoster && draftedNames.includes(name)
  const ring = onRoster ? '#22C55E' : drafted ? '#475569' : '#334155'
  const portraitName = CHARACTER_VARIANTS[name] || name
  return (
    <button onClick={onClick} type="button" title={name} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, padding: '0 2px' }}>
      <div style={{ padding: 2, borderRadius: '50%', border: `2px solid ${ring}` }}>
        <CharacterPortrait name={portraitName} size={32} style={{ filter: drafted ? 'grayscale(1) opacity(.45)' : 'none' }} />
      </div>
      <span style={{ fontSize: 9, color: '#64748B', width: 42, textAlign: 'center', lineHeight: 1.2 }}>{portraitName}</span>
    </button>
  )
}

// ─── Player card panel ────────────────────────────────────────────────────────
function PlayerCard({ stack, charactersById, tournHistories, rosterNames, draftedNames, picksByCharacter, playersById, teamIdentitiesByPlayerId, isYourTurn, isDrafting, onDraft, onClose, onNavigate, watchlist, onToggleWatchlist }) {
  const charId = stack[stack.length - 1]
  const c = charactersById[charId]
  if (!c) return null

  const pick = picksByCharacter[c.id]
  const isDrafted = Boolean(pick)
  const history = tournHistories[c.id] || []
  const validHistory = history.filter(t => t.perfScore !== null)
  const base = baseScore(c)
  const score = finalScore(c, history)
  const histAvg = validHistory.length ? validHistory.reduce((s, t) => s + t.perfScore, 0) / validHistory.length : null
  const histFactor = Math.min(validHistory.length / 5, 1.0) * 0.3
  const displayName = formatCharacterDisplayName(c.name, pick?.mii_color)
  const chemistryName = getCharacterChemistryName(c.name, pick?.mii_color)
  const chem = getChemistry(chemistryName)
  const net = chemScore(chemistryName, rosterNames)
  const breadcrumb = stack.map(id => charactersById[id]).filter(Boolean)

  const handleChipClick = (name) => {
    const target = Object.values(charactersById).find(ch => ch.name === name)
    if (target) onNavigate(target.id)
  }

  const trend = trendSymbol(history)
  const trendColor = trend === '↑' ? '#22C55E' : trend === '↓' ? '#F87171' : '#94A3B8'

  return (
    <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: Math.min(400, window.innerWidth), background: '#0F172A', borderLeft: '1px solid #1E293B', zIndex: 50, display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
      {/* Sticky header */}
      <div style={{ position: 'sticky', top: 0, background: '#0F172A', borderBottom: '1px solid #1E293B', padding: '10px 14px', zIndex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {stack.length > 1 && (
            <button onClick={() => onNavigate(null, true)} type="button" style={{ background: 'none', border: 'none', color: '#94A3B8', cursor: 'pointer', padding: 4, flexShrink: 0 }}>
              <ChevronLeft size={18} />
            </button>
          )}
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 3, overflow: 'hidden', fontSize: 12 }}>
            {(breadcrumb.length > 4 ? [null, ...breadcrumb.slice(-3)] : breadcrumb).map((bc, i, arr) => (
              <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 3, minWidth: 0 }}>
                {i > 0 && <span style={{ color: '#334155' }}>›</span>}
                {bc === null
                  ? <span style={{ color: '#475569' }}>…</span>
                  : <button
                      onClick={() => {
                        const idx = stack.findIndex(id => id === bc.id)
                        onNavigate(bc.id, false, idx)
                      }}
                      type="button"
                      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: i === arr.length - 1 ? '#E2E8F0' : '#64748B', fontWeight: i === arr.length - 1 ? 700 : 400, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 80 }}
                    >{bc.name}</button>}
              </span>
            ))}
          </div>
          <button onClick={onClose} type="button" style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer', padding: 4, flexShrink: 0 }}>
            <X size={18} />
          </button>
        </div>
      </div>

      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Portrait + name */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <Portrait name={c.name} size={72} style={{ border: `3px solid ${isDrafted ? '#334155' : '#EAB308'}`, filter: isDrafted ? 'grayscale(.8) opacity(.6)' : 'none' }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 20 }}>{displayName}</div>
            <div style={{ fontSize: 12, marginTop: 3 }}>
              {isDrafted
                ? <span style={{ color: '#64748B', display: 'inline-flex', alignItems: 'center', gap: 6 }}>Drafted · <PlayerTag height={24} identitiesByPlayerId={teamIdentitiesByPlayerId} playerId={pick.player_id} playersById={playersById} /></span>
                : <span style={{ color: '#22C55E', fontWeight: 600 }}>Available</span>}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 4, fontSize: 12 }}>
              {net !== null && <span style={{ color: net > 0 ? '#22C55E' : net < 0 ? '#F87171' : '#64748B', fontWeight: 700 }}>Chem {net > 0 ? `+${net}` : net}</span>}
              {trend && <span style={{ color: trendColor, fontWeight: 700 }}>{trend} {validHistory.length}T</span>}
            </div>
          </div>
          <button onClick={() => onToggleWatchlist(c.id)} type="button" style={{ background: 'none', border: 'none', cursor: 'pointer', color: watchlist.has(c.id) ? '#EAB308' : '#334155', flexShrink: 0 }}>
            <Star size={20} fill={watchlist.has(c.id) ? '#EAB308' : 'none'} />
          </button>
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
                  {chem.good.map(name => <ChemChip key={name} name={name} rosterNames={rosterNames} draftedNames={draftedNames} onClick={() => handleChipClick(name)} />)}
                </div>
              </div>
            )}
            {chem.bad.length > 0 && (
              <div>
                <div style={{ fontSize: 11, color: '#F87171', fontWeight: 600, marginBottom: 6 }}>Bad</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {chem.bad.map(name => <ChemChip key={name} name={name} rosterNames={rosterNames} draftedNames={draftedNames} onClick={() => handleChipClick(name)} />)}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Draft button */}
        {!isDrafted && (
          <button className="solid-button" disabled={!isYourTurn || !isDrafting} onClick={() => onDraft(c)} type="button">
            {isYourTurn && isDrafting ? `Draft ${displayName}` : !isDrafting ? 'Draft locked' : 'Not your pick'}
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Watchlist drawer ─────────────────────────────────────────────────────────
function WatchlistDrawer({ watchlist, charactersById, tournHistories, picksByCharacter, onOpen, onRemove }) {
  const [open, setOpen] = useState(false)
  const items = [...watchlist].map(id => charactersById[id]).filter(Boolean)

  return (
    <>
      <button onClick={() => setOpen(v => !v)} type="button" style={{ position: 'fixed', bottom: 20, left: 16, background: '#1E293B', border: '1px solid #334155', borderRadius: 24, padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 6, color: '#EAB308', fontWeight: 600, fontSize: 13, cursor: 'pointer', zIndex: 40, boxShadow: '0 4px 12px #00000060' }}>
        <Star size={15} fill="#EAB308" />
        Watchlist{items.length > 0 ? ` (${items.length})` : ''}
      </button>
      {open && (
        <div style={{ position: 'fixed', bottom: 62, left: 16, width: 248, background: '#1E293B', border: '1px solid #334155', borderRadius: 12, overflow: 'hidden', zIndex: 41, boxShadow: '0 8px 24px #00000080' }}>
          <div style={{ padding: '10px 12px', borderBottom: '1px solid #334155', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 700, fontSize: 13 }}>Watchlist</span>
            <button onClick={() => setOpen(false)} type="button" style={{ background: 'none', border: 'none', color: '#64748B', cursor: 'pointer' }}><X size={14} /></button>
          </div>
          {items.length === 0 && <div style={{ padding: 12, color: '#64748B', fontSize: 13 }}>No starred players yet.</div>}
          {items.map(c => {
            const isDrafted = Boolean(picksByCharacter[c.id])
            const score = finalScore(c, tournHistories[c.id])
            return (
              <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid #0F172A', opacity: isDrafted ? 0.4 : 1 }}>
                <Portrait name={c.name} size={28} />
                <button onClick={() => { onOpen(c.id); setOpen(false) }} type="button" style={{ flex: 1, background: 'none', border: 'none', color: isDrafted ? '#64748B' : '#E2E8F0', textAlign: 'left', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>{c.name}</button>
                <span style={{ fontSize: 11, color: '#EAB308', fontWeight: 700 }}>{score.toFixed(1)}</span>
                <button onClick={() => onRemove(c.id)} type="button" style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer' }}><X size={12} /></button>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────
function snakeOrder(players, round) {
  return round % 2 === 1 ? players : [...players].reverse()
}

export default function Draft() {
  const { player } = useAuth()
  const { pushToast } = useToast()
  const { currentTournament, allTournaments } = useTournament()

  const [players, setPlayers] = useState([])
  const [characters, setCharacters] = useState([])
  const [allDraftPicks, setAllDraftPicks] = useState([])
  const [plateAppearances, setPlateAppearances] = useState([])
  const [games, setGames] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState('value')
  const [sortDesc, setSortDesc] = useState(true)
  const [cardStack, setCardStack] = useState([])
  const [forcePickMenu, setForcePickMenu] = useState(null)
  const [pendingMiiPick, setPendingMiiPick] = useState(null)
  const [isAutoDrafting, setIsAutoDrafting] = useState(false)
  const [draftError, setDraftError] = useState('')
  const [watchlist, setWatchlist] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('draft-watchlist') || '[]')) } catch { return new Set() }
  })

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
  }, [])

  useEffect(() => {
    if (!currentTournament?.id) return
    const ch = supabase
      .channel(`draft-${currentTournament.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'draft_picks', filter: `tournament_id=eq.${currentTournament.id}` }, async () => {
        const { data } = await supabase.from('draft_picks').select('*').eq('tournament_id', currentTournament.id).order('pick_number')
        setAllDraftPicks(cur => [...cur.filter(p => p.tournament_id !== currentTournament.id), ...(data || [])])
      })
      .subscribe()
    return () => supabase.removeChannel(ch)
  }, [currentTournament?.id])

  useEffect(() => {
    localStorage.setItem('draft-watchlist', JSON.stringify([...watchlist]))
  }, [watchlist])

  const draftPicks = useMemo(
    () => allDraftPicks.filter(p => p.tournament_id === currentTournament?.id),
    [allDraftPicks, currentTournament?.id]
  )
  const picksByCharacter = useMemo(
    () => Object.fromEntries(draftPicks.map(p => [p.character_id, p])),
    [draftPicks]
  )
  const playersById = useMemo(() => Object.fromEntries(players.map(p => [p.id, p])), [players])
  const charactersById = useMemo(() => Object.fromEntries(characters.map(c => [c.id, c])), [characters])
  const teamIdentitiesByPlayerId = useMemo(
    () => buildTournamentTeamIdentityMap(draftPicks, charactersById),
    [draftPicks, charactersById],
  )

  // Historical performance per character per tournament (exclude current tournament)
  const historicalGames = useMemo(
    () => games.filter(g => g.tournament_id !== currentTournament?.id),
    [games, currentTournament?.id]
  )
  const historicalPAs = useMemo(() => {
    const hGameIds = new Set(historicalGames.map(g => g.id))
    return plateAppearances.filter(pa => hGameIds.has(pa.game_id))
  }, [plateAppearances, historicalGames])

  const tournHistories = useMemo(
    () => buildCharacterTournamentHistory(historicalPAs, historicalGames, allTournaments || []),
    [historicalPAs, historicalGames, allTournaments]
  )

  // Draft order
  const currentPickNumber = draftPicks.length + 1
  const round = Math.ceil(currentPickNumber / Math.max(players.length, 1))
  const orderThisRound = useMemo(() => snakeOrder(players, round), [players, round])
  const pickInRound = (currentPickNumber - 1) % Math.max(players.length, 1)
  const currentDrafter = orderThisRound[pickInRound]
  const isYourTurn = currentDrafter?.id === player?.id
  const isDrafting = currentTournament?.status === 'drafting'
  const totalPicks = players.length > 0 ? players.length * 9 : 54
  const picksRemaining = Math.max(0, totalPicks - draftPicks.length)
  const playersWithCaptainPick = useMemo(
    () => new Set(
      draftPicks
        .filter((pick) => Number(pick.pick_number || 0) <= players.length)
        .filter((pick) => pick.character_id)
        .map((pick) => pick.player_id),
    ),
    [draftPicks, players.length],
  )
  const isCaptainRoundLocked = players.length > 0 && playersWithCaptainPick.size < players.length

  const myRosterNames = useMemo(() => {
    if (!player?.id) return []
    return draftPicks
      .filter(p => p.player_id === player.id && p.character_id)
      .map(p => {
        const character = charactersById[p.character_id]
        return character ? getCharacterChemistryName(character.name, p.mii_color) : null
      })
      .filter(Boolean)
  }, [draftPicks, player?.id, charactersById])

  const allDraftedNames = useMemo(
    () => draftPicks.filter(p => p.character_id).map(p => charactersById[p.character_id]?.name).filter(Boolean),
    [draftPicks, charactersById]
  )

  const sortedCharacters = useMemo(() => {
    let list = characters.filter(c => c.name.toLowerCase().includes(search.toLowerCase()))
    if (isCaptainRoundLocked) {
      list = list.filter(c => isCaptainCharacterName(c.name))
    }
    const sorted = [...list].sort((a, b) => {
      let compareVal = 0
      if (sortKey === 'value') compareVal = finalScore(b, tournHistories[b.id]) - finalScore(a, tournHistories[a.id])
      else if (sortKey === 'history') {
        const ha = (tournHistories[a.id] || []).filter(t => t.perfScore !== null)
        const hb = (tournHistories[b.id] || []).filter(t => t.perfScore !== null)
        const sa = ha.length ? ha.reduce((s, t) => s + t.perfScore, 0) / ha.length : 0
        const sb = hb.length ? hb.reduce((s, t) => s + t.perfScore, 0) / hb.length : 0
        compareVal = sb - sa
      }
      else if (sortKey === 'chemistry') {
        const sa = chemScore(a.name, myRosterNames) ?? -999
        const sb = chemScore(b.name, myRosterNames) ?? -999
        compareVal = sb - sa
      }
      else if (sortKey === 'tournaments') {
        const ha = (tournHistories[a.id] || []).length
        const hb = (tournHistories[b.id] || []).length
        compareVal = hb - ha
      }
      else if (sortKey === 'trend') {
        const ta = trendSymbol(tournHistories[a.id])
        const tb = trendSymbol(tournHistories[b.id])
        const tval = { '↑': 3, '→': 1, '↓': -1 }
        compareVal = (tval[tb] || 0) - (tval[ta] || 0)
      }
      else compareVal = b[sortKey] - a[sortKey]
      
      return sortDesc ? compareVal : -compareVal
    })
    return sorted
  }, [characters, isCaptainRoundLocked, search, sortKey, sortDesc, tournHistories, myRosterNames])

  const toggleWatchlist = useCallback((id) => {
    setWatchlist(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }, [])

  const openCard = useCallback((id) => setCardStack([id]), [])
  const navigateCard = useCallback((id, goBack = false, stackIndex = null) => {
    if (goBack) setCardStack(prev => prev.slice(0, -1))
    else if (stackIndex !== null) setCardStack(prev => prev.slice(0, stackIndex + 1))
    else setCardStack(prev => [...prev, id])
  }, [])
  const closeCard = useCallback(() => setCardStack([]), [])

  const handleHeaderClick = useCallback((key) => {
    if (sortKey === key) {
      setSortDesc(prev => !prev)
    } else {
      setSortKey(key)
      setSortDesc(true)
    }
  }, [sortKey])

  const validateCaptainPick = useCallback((targetPlayerId, character) => {
    const playerHasPick = draftPicks.some((pick) => pick.player_id === targetPlayerId && pick.character_id)
    if (!playerHasPick) {
      if (!isCaptainCharacterName(character?.name)) {
        return 'Your first pick must be a captain.'
      }
    }
    return ''
  }, [draftPicks])

  const insertDraftPick = useCallback(async ({ targetPlayerId, characterId, miiColor = null }) => {
    const character = charactersById[characterId]
    const firstPickForPlayer = !draftPicks.some((pick) => pick.player_id === targetPlayerId && pick.character_id)
    const captainIdentity = getCaptainIdentityFromName(character?.name)
    const payload = {
      tournament_id: currentTournament.id,
      pick_number: currentPickNumber,
      round,
      pick_in_round: pickInRound + 1,
      player_id: targetPlayerId,
      character_id: characterId,
    }
    if (miiColor) payload.mii_color = miiColor
    if (firstPickForPlayer && captainIdentity) {
      payload.is_captain = true
      payload.captain_character_name = character.name === 'Bowser Jr' ? 'Bowser Jr.' : character.name
      payload.team_logo_key = captainIdentity.logoKey
    }

    const { error } = await supabase.from('draft_picks').insert(payload)
    if (error && miiColor && error.message?.includes('mii_color')) {
      return {
        error: {
          ...error,
          message: 'The database is missing the new mii_color column. Apply the latest Supabase migration, then try the Mii pick again.',
        },
      }
    }
    return { error }
  }, [charactersById, currentTournament?.id, currentPickNumber, draftPicks, round, pickInRound])

  const submitDraftPick = useCallback(async (character, miiColor = null) => {
    if (!character || !currentTournament || !currentDrafter) return
    if (!isYourTurn) { pushToast({ title: 'Not your pick', message: 'Wait for your turn.', type: 'error' }); return }
    const captainError = validateCaptainPick(currentDrafter.id, character)
    if (captainError) {
      setDraftError(captainError)
      pushToast({ title: 'Captain required', message: captainError, type: 'error' })
      return
    }
    const { error } = await insertDraftPick({ targetPlayerId: currentDrafter.id, characterId: character.id, miiColor })
    if (error) { pushToast({ title: 'Draft pick failed', message: error.message, type: 'error' }); return }
    setDraftError('')
    pushToast({ title: 'Pick submitted', message: `${currentDrafter.name} drafted ${formatCharacterDisplayName(character.name, miiColor)}.`, type: 'success' })
    setPendingMiiPick(null)
    closeCard()
  }, [currentTournament, currentDrafter, isYourTurn, closeCard, pushToast, insertDraftPick, validateCaptainPick])

  const forceAdvance = useCallback(async () => {
    if (!currentTournament || !currentDrafter) return
    const { error } = await supabase.from('draft_picks').insert({ tournament_id: currentTournament.id, pick_number: currentPickNumber, round, pick_in_round: pickInRound + 1, player_id: currentDrafter.id, character_id: null })
    if (error) { pushToast({ title: 'Failed', message: error.message, type: 'error' }); return }
    const { data } = await supabase.from('draft_picks').select('*').eq('tournament_id', currentTournament.id).order('pick_number')
    setAllDraftPicks(cur => [...cur.filter(p => p.tournament_id !== currentTournament.id), ...(data || [])])
    pushToast({ title: 'Pick skipped', type: 'info' })
  }, [currentTournament, currentDrafter, currentPickNumber, round, pickInRound, pushToast])

  const undoLastPick = useCallback(async () => {
    if (!draftPicks.length) return
    const { error } = await supabase.from('draft_picks').delete().eq('id', draftPicks[draftPicks.length - 1].id)
    if (error) { pushToast({ title: 'Undo failed', message: error.message, type: 'error' }); return }
    const { data } = await supabase.from('draft_picks').select('*').eq('tournament_id', currentTournament.id).order('pick_number')
    setAllDraftPicks(cur => [...cur.filter(p => p.tournament_id !== currentTournament.id), ...(data || [])])
    pushToast({ title: 'Pick undone', type: 'success' })
  }, [draftPicks, currentTournament?.id, pushToast])

  const forcePickCharacter = useCallback(async (character, targetPlayerId, miiColor = null) => {
    if (!character || !currentTournament) return
    const captainError = validateCaptainPick(targetPlayerId, character)
    if (captainError) { pushToast({ title: 'Captain required', message: captainError, type: 'error' }); return }
    const { error } = await insertDraftPick({ targetPlayerId, characterId: character.id, miiColor })
    if (error) { pushToast({ title: 'Force pick failed', message: error.message, type: 'error' }); return }
    const { data } = await supabase.from('draft_picks').select('*').eq('tournament_id', currentTournament.id).order('pick_number')
    setAllDraftPicks(cur => [...cur.filter(p => p.tournament_id !== currentTournament.id), ...(data || [])])
    setDraftError('')
    pushToast({ title: 'Pick forced', message: `${playersById[targetPlayerId]?.name} drafted ${formatCharacterDisplayName(character.name, miiColor)}.`, type: 'success' })
    setForcePickMenu(null)
    setPendingMiiPick(null)
  }, [currentTournament, playersById, pushToast, insertDraftPick, validateCaptainPick])

  const beginDraftPick = useCallback((character) => {
    if (!character) return
    if (isMiiCharacter(character)) {
      setPendingMiiPick({ character, targetPlayerId: null })
      return
    }
    submitDraftPick(character)
  }, [submitDraftPick])

  const beginForcePick = useCallback((character, targetPlayerId) => {
    if (!character || !targetPlayerId) return
    if (isMiiCharacter(character)) {
      setPendingMiiPick({ character, targetPlayerId })
      setForcePickMenu(null)
      return
    }
    forcePickCharacter(character, targetPlayerId)
  }, [forcePickCharacter])

  const confirmPendingMiiPick = useCallback((miiColor) => {
    if (!pendingMiiPick?.character) return
    if (pendingMiiPick.targetPlayerId) {
      forcePickCharacter(pendingMiiPick.character, pendingMiiPick.targetPlayerId, miiColor)
      return
    }
    submitDraftPick(pendingMiiPick.character, miiColor)
  }, [pendingMiiPick, forcePickCharacter, submitDraftPick])

  const autoDraftAll = useCallback(async () => {
    if (!currentTournament || !isDrafting || players.length === 0 || characters.length === 0) return
    setIsAutoDrafting(true)

    const draftedIds = new Set(draftPicks.map(p => p.character_id).filter(Boolean))
    let pickNumber = draftPicks.length + 1
    const inserts = []
    const remaining = totalPicks - draftPicks.length

    for (let i = 0; i < remaining; i++) {
      const rnd = Math.ceil(pickNumber / players.length)
      const orderThisRnd = snakeOrder(players, rnd)
      const pickIdx = (pickNumber - 1) % players.length
      const drafter = orderThisRnd[pickIdx]

      const drafterHasPick = inserts.some((entry) => entry.player_id === drafter.id && entry.character_id) ||
        draftPicks.some((pick) => pick.player_id === drafter.id && pick.character_id)
      const available = characters
        .filter(c => !draftedIds.has(c.id))
        .filter(c => (drafterHasPick ? true : isCaptainCharacterName(c.name)))
      if (available.length === 0) break

      const best = available.reduce((b, c) =>
        finalScore(c, tournHistories[c.id]) > finalScore(b, tournHistories[b.id]) ? c : b
      , available[0])

      const miiColor = isMiiCharacter(best) ? MII_COLOR_OPTIONS[0] : null
      const captainIdentity = getCaptainIdentityFromName(best.name)
      inserts.push({
        tournament_id: currentTournament.id,
        pick_number: pickNumber,
        round: rnd,
        pick_in_round: pickIdx + 1,
        player_id: drafter.id,
        character_id: best.id,
        ...(!drafterHasPick && captainIdentity ? {
          is_captain: true,
          captain_character_name: best.name === 'Bowser Jr' ? 'Bowser Jr.' : best.name,
          team_logo_key: captainIdentity.logoKey,
        } : {}),
        ...(miiColor ? { mii_color: miiColor } : {}),
      })
      draftedIds.add(best.id)
      pickNumber++
    }

    if (inserts.length > 0) {
      const { error } = await supabase.from('draft_picks').insert(inserts)
      if (error) {
        pushToast({ title: 'Auto draft failed', message: error.message, type: 'error' })
      } else {
        const { data } = await supabase.from('draft_picks').select('*').eq('tournament_id', currentTournament.id).order('pick_number')
        setAllDraftPicks(cur => [...cur.filter(p => p.tournament_id !== currentTournament.id), ...(data || [])])
        pushToast({ title: 'Auto draft complete', message: `${inserts.length} picks made.`, type: 'success' })
      }
    }

    setIsAutoDrafting(false)
  }, [currentTournament, isDrafting, players, draftPicks, characters, totalPicks, tournHistories, pushToast])

  return (
    <div style={{ position: 'relative' }}>
      {/* Sticky bar */}
      <div style={{ position: 'sticky', top: 60, zIndex: 19, background: '#0F172A', borderBottom: '1px solid #1E293B', padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
        {[
          { label: 'Pick',      val: loading ? '—' : currentPickNumber },
          { label: 'Round',     val: loading ? '—' : round },
          { label: 'Remaining', val: loading ? '—' : picksRemaining },
        ].map(({ label, val }) => (
          <div key={label} style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.1 }}>
            <span style={{ fontSize: 10, color: '#64748B', textTransform: 'uppercase', fontWeight: 700 }}>{label}</span>
            <span style={{ fontSize: 18, fontWeight: 800 }}>{val}</span>
          </div>
        ))}
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.1, flex: 1 }}>
          <span style={{ fontSize: 10, color: '#64748B', textTransform: 'uppercase', fontWeight: 700 }}>On the clock</span>
          <span style={{ fontSize: 18, fontWeight: 800, color: currentDrafter?.color || '#E2E8F0' }}>
            {loading ? '—' : isYourTurn ? 'You' : <PlayerTag height={24} identitiesByPlayerId={teamIdentitiesByPlayerId} player={currentDrafter} />}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {player?.is_commissioner && (
            <>
              <button className="ghost-button" disabled={!isDrafting || isCaptainRoundLocked} onClick={forceAdvance} type="button" style={{ fontSize: 12, padding: '6px 10px' }}><SkipForward size={14} /> Skip</button>
              <button className="ghost-button" disabled={!isDrafting} onClick={undoLastPick} type="button" style={{ fontSize: 12, padding: '6px 10px' }}><RotateCcw size={14} /> Undo</button>
              <button className="ghost-button" disabled={!isDrafting || isAutoDrafting || picksRemaining === 0} onClick={autoDraftAll} type="button" style={{ fontSize: 12, padding: '6px 10px', color: '#A78BFA', borderColor: '#A78BFA' }}><Zap size={14} /> {isAutoDrafting ? 'Drafting…' : 'Auto Draft'}</button>
            </>
          )}
        </div>
      </div>

      {isCaptainRoundLocked ? (
        <div style={{ margin: '10px 16px 0', background: '#EAB30818', border: '1px solid #EAB30855', borderRadius: 12, padding: '10px 14px', color: '#FDE68A', fontWeight: 700 }}>
          Round 1 — Select your captain.
        </div>
      ) : null}

      {draftError ? (
        <div style={{ margin: '10px 16px 0', background: '#7F1D1D55', border: '1px solid #EF444488', borderRadius: 12, padding: '10px 14px', color: '#FECACA', fontWeight: 700 }}>
          {draftError}
        </div>
      ) : null}

      <div style={{ padding: '0 16px 80px' }}>
        {/* Toolbar */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '12px 0 6px' }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…" style={{ background: '#1E293B', border: '1px solid #334155', borderRadius: 8, color: '#E2E8F0', padding: '7px 12px', fontSize: 14, width: 150 }} />
        </div>

        {/* Column headers */}
        <div style={{ display: 'grid', gridTemplateColumns: '32px 1fr 26px 26px 26px 26px 46px 28px 36px 22px 36px 36px', gap: 4, padding: '4px 6px', color: '#475569', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', borderBottom: '1px solid #1E293B', letterSpacing: '.04em' }}>
          <span />
          <span>Name</span>
          <button onClick={() => handleHeaderClick('pitching')} type="button" style={{ textAlign: 'center', background: 'none', border: 'none', color: sortKey === 'pitching' ? '#EAB308' : '#475569', cursor: 'pointer', padding: 0, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3 }}>P {sortKey === 'pitching' && (sortDesc ? '↓' : '↑')}</button>
          <button onClick={() => handleHeaderClick('batting')} type="button" style={{ textAlign: 'center', background: 'none', border: 'none', color: sortKey === 'batting' ? '#EAB308' : '#475569', cursor: 'pointer', padding: 0, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3 }}>B {sortKey === 'batting' && (sortDesc ? '↓' : '↑')}</button>
          <button onClick={() => handleHeaderClick('fielding')} type="button" style={{ textAlign: 'center', background: 'none', border: 'none', color: sortKey === 'fielding' ? '#EAB308' : '#475569', cursor: 'pointer', padding: 0, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3 }}>F {sortKey === 'fielding' && (sortDesc ? '↓' : '↑')}</button>
          <button onClick={() => handleHeaderClick('speed')} type="button" style={{ textAlign: 'center', background: 'none', border: 'none', color: sortKey === 'speed' ? '#EAB308' : '#475569', cursor: 'pointer', padding: 0, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3 }}>S {sortKey === 'speed' && (sortDesc ? '↓' : '↑')}</button>
          <button onClick={() => handleHeaderClick('value')} type="button" style={{ textAlign: 'center', background: 'none', border: 'none', color: sortKey === 'value' ? '#EAB308' : '#475569', cursor: 'pointer', padding: 0, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3 }}>Score {sortKey === 'value' && (sortDesc ? '↓' : '↑')}</button>
          <button onClick={() => handleHeaderClick('tournaments')} type="button" style={{ textAlign: 'center', background: 'none', border: 'none', color: sortKey === 'tournaments' ? '#EAB308' : '#475569', cursor: 'pointer', padding: 0, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3 }}>T {sortKey === 'tournaments' && (sortDesc ? '↓' : '↑')}</button>
          <button onClick={() => handleHeaderClick('history')} type="button" style={{ textAlign: 'center', background: 'none', border: 'none', color: sortKey === 'history' ? '#EAB308' : '#475569', cursor: 'pointer', padding: 0, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3 }}>Hist {sortKey === 'history' && (sortDesc ? '↓' : '↑')}</button>
          <button onClick={() => handleHeaderClick('trend')} type="button" style={{ textAlign: 'center', background: 'none', border: 'none', color: sortKey === 'trend' ? '#EAB308' : '#475569', cursor: 'pointer', padding: 0, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3 }}>↑ {sortKey === 'trend' && (sortDesc ? '↓' : '↑')}</button>
          <span />
          <span />
        </div>

        {/* Rows */}
        {sortedCharacters.map(c => {
          const pick = picksByCharacter[c.id]
          const isDrafted = Boolean(pick)
          const history = tournHistories[c.id] || []
          const validH = history.filter(t => t.perfScore !== null)
          const histAvg = validH.length ? validH.reduce((s, t) => s + t.perfScore, 0) / validH.length : null
          const trend = trendSymbol(history)
          const trendColor = trend === '↑' ? '#22C55E' : trend === '↓' ? '#F87171' : '#64748B'
          const score = finalScore(c, history)
          const chemistryName = getCharacterChemistryName(c.name, pick?.mii_color)
          const displayName = formatCharacterDisplayName(c.name, pick?.mii_color)
          const net = chemScore(chemistryName, myRosterNames)
          const starred = watchlist.has(c.id)

          return (
            <div
              key={c.id}
              onClick={() => openCard(c.id)}
              onMouseEnter={e => e.currentTarget.style.background = '#1E293B'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              style={{ display: 'grid', gridTemplateColumns: '32px 1fr 26px 26px 26px 26px 46px 28px 36px 22px 36px 36px', gap: 4, alignItems: 'center', padding: '7px 6px', borderBottom: '1px solid #0F172A', cursor: 'pointer', opacity: isDrafted ? 0.35 : 1, filter: isDrafted ? 'saturate(0.15)' : 'none' }}
            >
              <Portrait name={c.name} size={28} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName}</div>
                {net !== null && <div style={{ fontSize: 10, color: net > 0 ? '#22C55E' : net < 0 ? '#F87171' : '#64748B', fontWeight: 700 }}>{net > 0 ? `+${net}` : net === 0 ? '±0' : net} chem</div>}
              </div>
              <span style={{ textAlign: 'center', fontSize: 13 }}>{c.pitching}</span>
              <span style={{ textAlign: 'center', fontSize: 13 }}>{c.batting}</span>
              <span style={{ textAlign: 'center', fontSize: 13, color: '#94A3B8' }}>{c.fielding}</span>
              <span style={{ textAlign: 'center', fontSize: 13, color: '#A78BFA' }}>{c.speed}</span>
              <span style={{ textAlign: 'center', fontSize: 13, fontWeight: 700, color: '#EAB308' }}>{score.toFixed(1)}</span>
              <span style={{ textAlign: 'center', fontSize: 12, color: '#64748B' }}>{history.length > 0 ? history.length : '—'}</span>
              <span style={{ textAlign: 'center', fontSize: 12, color: histAvg !== null ? '#CBD5E1' : '#334155' }}>{histAvg !== null ? histAvg.toFixed(1) : '—'}</span>
              <span style={{ textAlign: 'center', fontSize: 14, color: trendColor }}>{trend || '—'}</span>
              <button onClick={e => { e.stopPropagation(); toggleWatchlist(c.id) }} type="button" style={{ background: 'none', border: 'none', cursor: 'pointer', color: starred ? '#EAB308' : '#334155', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Star size={15} fill={starred ? '#EAB308' : 'none'} />
              </button>
              {!isDrafted
                ? (
                  player?.is_commissioner ? (
                    <div style={{ position: 'relative' }}>
                      <button onClick={e => { e.stopPropagation(); setForcePickMenu(forcePickMenu === c.id ? null : c.id) }} type="button" style={{ padding: '4px 6px', borderRadius: 6, fontSize: 11, fontWeight: 700, border: '1px solid #EAB308', background: forcePickMenu === c.id ? '#EAB30820' : 'transparent', color: '#EAB308', cursor: 'pointer' }}>
                        Force
                      </button>
                      {forcePickMenu === c.id && (
                        <div onClick={e => e.stopPropagation()} style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, background: '#1E293B', border: '1px solid #334155', borderRadius: 6, zIndex: 50, maxHeight: 200, overflowY: 'auto', minWidth: 120 }}>
                          {players.map(p => (
                            <button key={p.id} onClick={() => beginForcePick(c, p.id)} type="button" style={{ width: '100%', padding: '8px 12px', textAlign: 'left', background: 'none', border: 'none', color: '#E2E8F0', cursor: 'pointer', fontSize: 12, borderBottom: '1px solid #0F172A', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              <PlayerTag height={24} identitiesByPlayerId={teamIdentitiesByPlayerId} player={p} />
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <button onClick={e => { e.stopPropagation(); beginDraftPick(c) }} type="button" disabled={!isYourTurn || !isDrafting} style={{ padding: '4px 6px', borderRadius: 6, fontSize: 11, fontWeight: 700, border: 'none', background: isYourTurn && isDrafting ? '#EAB308' : '#1E293B', color: isYourTurn && isDrafting ? '#000' : '#334155', cursor: isYourTurn && isDrafting ? 'pointer' : 'default' }}>
                      Draft
                    </button>
                  )
                )
                : <span style={{ fontSize: 10, color: '#334155', textAlign: 'center' }}>—</span>}
            </div>
          )
        })}
      </div>

      {/* Card panel */}
      {cardStack.length > 0 && (
        <>
          <div onClick={closeCard} style={{ position: 'fixed', inset: 0, background: '#00000060', zIndex: 49 }} />
          <PlayerCard
            stack={cardStack}
            charactersById={charactersById}
            tournHistories={tournHistories}
            rosterNames={myRosterNames}
            draftedNames={allDraftedNames}
            picksByCharacter={picksByCharacter}
            playersById={playersById}
            teamIdentitiesByPlayerId={teamIdentitiesByPlayerId}
            isYourTurn={isYourTurn}
            isDrafting={isDrafting}
            onDraft={beginDraftPick}
            onClose={closeCard}
            onNavigate={navigateCard}
            watchlist={watchlist}
            onToggleWatchlist={toggleWatchlist}
          />
        </>
      )}

      {pendingMiiPick && (
        <>
          <div onClick={() => setPendingMiiPick(null)} style={{ position: 'fixed', inset: 0, background: '#00000070', zIndex: 59 }} />
          <div style={{ position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: 'min(92vw, 420px)', background: '#0F172A', border: '1px solid #334155', borderRadius: 14, padding: 18, zIndex: 60, boxShadow: '0 18px 50px #00000080' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 800, color: '#E2E8F0' }}>Choose Mii Color</div>
                <div style={{ fontSize: 12, color: '#64748B', marginTop: 4 }}>This pick will be stored with a specific Mii color so we can apply chemistry correctly.</div>
              </div>
              <button onClick={() => setPendingMiiPick(null)} type="button" style={{ background: 'none', border: 'none', color: '#64748B', cursor: 'pointer', padding: 4 }}><X size={18} /></button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
              {MII_COLOR_OPTIONS.map(color => (
                <button key={color} onClick={() => confirmPendingMiiPick(color)} type="button" style={{ background: '#1E293B', border: '1px solid #334155', borderRadius: 10, color: '#E2E8F0', padding: '10px 12px', cursor: 'pointer', fontWeight: 700 }}>
                  {color}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      <WatchlistDrawer
        watchlist={watchlist}
        charactersById={charactersById}
        tournHistories={tournHistories}
        picksByCharacter={picksByCharacter}
        onOpen={openCard}
        onRemove={toggleWatchlist}
      />
    </div>
  )
}
