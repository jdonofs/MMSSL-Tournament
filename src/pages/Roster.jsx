import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRightLeft, X } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { useTournament } from '../context/TournamentContext'
import SharedCharacterDetailModal from '../components/CharacterDetailModal'
import { buildCharacterTournamentHistory, MIN_PA_THRESHOLD, summarizeBatting, summarizePitching } from '../utils/statsCalculator'
import { analyzeCharacterTalent } from '../utils/characterAnalysis'
import CharacterPortrait from '../components/CharacterPortrait'
import StatIcon from '../components/StatIcon'
import { DraggableRosterItem, FieldingView, Portrait } from '../components/RosterLineupWidgets'
import { getChemistry, chemScore } from '../data/chemistry'
import { buildChemistryHighlightSet } from '../utils/chemistryHighlights'
import { formatCharacterDisplayName, getCharacterChemistryName } from '../utils/mii'
import useTournamentTeamIdentity from '../hooks/useTournamentTeamIdentity'
import { getTeamShortName } from '../utils/teamIdentity'
import { fetchTeamLineup, upsertTeamLineup, TOURNAMENT_TEAM_LINEUPS } from '../utils/teamLineups'

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
function StatBar({ label, value, color = '#EAB308' }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ width: 14, display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
        <StatIcon stat={label} size={14} />
      </span>
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
          <StatBar label="pitching" value={c.pitching} color="#EF4444" />
          <StatBar label="batting" value={c.batting} color="#22C55E" />
          <StatBar label="fielding" value={c.fielding} color="#EAB308" />
          <StatBar label="speed" value={c.speed} color="#3B82F6" />
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

// ─── Main Roster Component ────────────────────────────────────────────────────
// ─── Shared UI helpers ───────────────────────────────────────────────────────
function StatusChip({ value }) {
  const status = String(value || '')
  const tone = status === 'accepted' || status === 'approved'
    ? { bg: 'rgba(34,197,94,0.12)', border: 'rgba(34,197,94,0.35)', color: '#86EFAC' }
    : status === 'pending'
      ? { bg: 'rgba(234,179,8,0.12)', border: 'rgba(234,179,8,0.35)', color: '#FDE68A' }
      : { bg: 'rgba(239,68,68,0.12)', border: 'rgba(239,68,68,0.35)', color: '#FCA5A5' }
  const label = status.charAt(0).toUpperCase() + status.slice(1)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', padding: '6px 10px', borderRadius: 999, background: tone.bg, border: `1px solid ${tone.border}`, color: tone.color, fontSize: 12, fontWeight: 700 }}>
      {label}
    </span>
  )
}

function TeamCountCard({ label, value, muted = false }) {
  return (
    <div style={{ padding: 10, borderRadius: 12, background: muted ? 'rgba(15,23,42,0.45)' : 'rgba(30,41,59,0.7)', border: '1px solid rgba(71,85,105,0.6)', display: 'grid', gap: 4 }}>
      <span className="muted" style={{ fontSize: 11 }}>{label}</span>
      <strong style={{ fontSize: 16 }}>{value}</strong>
    </div>
  )
}

// ─── Tournament Trade Builder ─────────────────────────────────────────────────
function TournamentTradeBuilderWorkspace({
  step, onBack, onReset, onAdvance, tradeDraft, setTradeDraft,
  players, playersById, identitiesByPlayerId, myPlayer, viewedPlayerId,
  activeRosterByPlayerId, onSubmit, tradeDeadlinePassed,
}) {
  const teamLabel = useCallback(
    (playerId, fallback = 'Unknown') => getTeamShortName(identitiesByPlayerId[playerId]) || playersById[playerId]?.name || fallback,
    [identitiesByPlayerId, playersById],
  )
  const participantPlayerIds = tradeDraft.participantPlayerIds || []
  const selectedPickIds = useMemo(() => new Set((tradeDraft.assets || []).map(a => a.pickId)), [tradeDraft.assets])
  const [assetPicker, setAssetPicker] = useState(null)

  const getDefaultDestination = useCallback((fromPlayerId) => {
    if (myPlayer?.id && String(fromPlayerId) !== String(myPlayer.id)) return String(myPlayer.id)
    const viewedCandidate = viewedPlayerId && String(viewedPlayerId) !== String(fromPlayerId) ? String(viewedPlayerId) : ''
    if (viewedCandidate) return viewedCandidate
    const fallback = participantPlayerIds.find(pid => String(pid) !== String(fromPlayerId))
    return fallback ? String(fallback) : ''
  }, [myPlayer?.id, participantPlayerIds, viewedPlayerId])

  const upsertAsset = useCallback((pick, toPlayerId) => {
    setTradeDraft(current => {
      const fromPlayerId = String(pick.player_id)
      const next = { pickId: pick.id, character_id: pick.character_id, character_name: pick.character_name, from_player_id: fromPlayerId, to_player_id: toPlayerId ? String(toPlayerId) : '' }
      const existing = current.assets.find(a => Number(a.pickId) === Number(pick.id))
      return {
        ...current,
        participantPlayerIds: current.participantPlayerIds.includes(fromPlayerId) ? current.participantPlayerIds : [...current.participantPlayerIds, fromPlayerId],
        assets: existing ? current.assets.map(a => Number(a.pickId) === Number(pick.id) ? next : a) : [...current.assets, next],
      }
    })
  }, [setTradeDraft])

  const removeAsset = useCallback((pickId) => {
    setTradeDraft(current => ({ ...current, assets: current.assets.filter(a => Number(a.pickId) !== Number(pickId)) }))
  }, [setTradeDraft])

  const playerSummaries = useMemo(() => participantPlayerIds.map(playerId => {
    const outgoing = tradeDraft.assets.filter(a => String(a.from_player_id) === String(playerId)).length
    const incoming = tradeDraft.assets.filter(a => String(a.to_player_id) === String(playerId)).length
    const activeCount = activeRosterByPlayerId[String(playerId)]?.length || 0
    const finalCount = activeCount - outgoing + incoming
    return { playerId: String(playerId), outgoing, incoming, finalCount, valid: finalCount === 9 }
  }), [activeRosterByPlayerId, participantPlayerIds, tradeDraft.assets])

  const unresolvedAssets = tradeDraft.assets.filter(a => !a.to_player_id || String(a.to_player_id) === String(a.from_player_id))
  const invalidPlayers = playerSummaries.filter(p => !p.valid)
  const confirmReady = tradeDraft.assets.length > 0 && unresolvedAssets.length === 0 && invalidPlayers.length === 0

  const stepTitle = step === 'teams' ? 'Choose Players' : step === 'details' ? 'Build Trade Proposal' : 'Confirm Trade'
  const stepSubtitle = step === 'teams' ? 'Select the players involved. Your team stays locked in.'
    : step === 'details' ? 'Select a character, review the owner, and choose where they are being traded.'
    : 'Review every move before sending the trade request.'

  return (
    <section className="panel" style={{ padding: 18 }}>
      <div className="section-head">
        <div><h2>{stepTitle}</h2><span className="muted">{stepSubtitle}</span></div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {step !== 'teams' ? <button className="ghost-button" onClick={onBack} type="button"><ArrowLeft size={16} /><span>Back</span></button> : null}
          <button className="ghost-button" onClick={onReset} type="button"><X size={16} /><span>Reset</span></button>
        </div>
      </div>

      {step === 'teams' ? (
        <div className="page-stack" style={{ gap: 16 }}>
          <div className="summary-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
            {players.map(p => {
              const pid = String(p.id)
              const selected = participantPlayerIds.includes(pid)
              const locked = String(p.id) === String(myPlayer?.id)
              const roster = activeRosterByPlayerId[pid] || []
              return (
                <button key={p.id} type="button" onClick={() => { if (locked || tradeDeadlinePassed) return; setTradeDraft(c => ({ ...c, participantPlayerIds: c.participantPlayerIds.includes(pid) ? c.participantPlayerIds.filter(id => id !== pid) : [...c.participantPlayerIds, pid], assets: c.participantPlayerIds.includes(pid) ? c.assets.filter(a => String(a.from_player_id) !== pid && String(a.to_player_id) !== pid) : c.assets })) }} disabled={tradeDeadlinePassed}
                  style={{ textAlign: 'left', padding: 14, borderRadius: 16, border: `1px solid ${selected ? '#EAB308' : 'rgba(71,85,105,0.75)'}`, background: selected ? 'rgba(234,179,8,0.12)' : 'rgba(15,23,42,0.55)', display: 'grid', gap: 12, color: '#E2E8F0', cursor: tradeDeadlinePassed ? 'default' : 'pointer' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
                    <strong style={{ fontSize: 15 }}>{p.name}</strong>
                    <span style={{ fontSize: 11, fontWeight: 800, color: selected ? '#FDE68A' : '#94A3B8' }}>{locked ? 'Required' : selected ? 'Selected' : 'Add Player'}</span>
                  </div>
                  <span className="muted" style={{ fontSize: 12 }}>{roster.length} active characters</span>
                  <div style={{ display: 'grid', gap: 6 }}>
                    {roster.slice(0, 9).map(entry => (
                      <div key={entry.id} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                        <CharacterPortrait name={entry.character_name} size={28} />
                        <span style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{entry.character_name}</span>
                      </div>
                    ))}
                  </div>
                </button>
              )
            })}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="muted">{participantPlayerIds.length} player{participantPlayerIds.length === 1 ? '' : 's'} selected</span>
            <button className="solid-button" onClick={onAdvance} type="button" disabled={participantPlayerIds.length < 2 || tradeDeadlinePassed}>
              <ArrowRightLeft size={16} /><span>Next: Build Trade</span>
            </button>
          </div>
        </div>
      ) : null}

      {step === 'details' ? (
        <div className="page-stack" style={{ gap: 16 }}>
          <section style={{ display: 'grid', gap: 12 }}>
            <div className="section-head"><div><h3>Players in Deal</h3><span className="muted">{participantPlayerIds.length} participating</span></div></div>
            <div className="summary-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
              {playerSummaries.map(entry => (
                <div key={entry.playerId} style={{ padding: 12, borderRadius: 14, border: `1px solid ${entry.valid ? 'rgba(71,85,105,0.7)' : 'rgba(239,68,68,0.65)'}`, background: entry.valid ? 'rgba(15,23,42,0.6)' : 'rgba(127,29,29,0.2)', display: 'grid', gap: 10 }}>
                  <strong>{teamLabel(entry.playerId)}</strong>
                  <div className="summary-grid" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
                    <TeamCountCard label="Out" value={entry.outgoing} muted />
                    <TeamCountCard label="In" value={entry.incoming} muted />
                    <TeamCountCard label="Final" value={entry.finalCount} muted />
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section style={{ display: 'grid', gap: 12 }}>
            <div className="section-head"><div><h3>Select Characters</h3><span className="muted">Tap a character to assign a destination.</span></div></div>
            <div className="summary-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
              {participantPlayerIds.map(playerId => {
                const roster = activeRosterByPlayerId[String(playerId)] || []
                return (
                  <div key={playerId} style={{ padding: 12, borderRadius: 14, border: '1px solid rgba(71,85,105,0.7)', background: 'rgba(15,23,42,0.55)', display: 'grid', gap: 10 }}>
                    <strong>{teamLabel(playerId)}</strong>
                    <div className="feed-list" style={{ maxHeight: 280, overflowY: 'auto' }}>
                      {roster.map(pick => {
                        const selected = selectedPickIds.has(pick.id)
                        const selectedAsset = tradeDraft.assets.find(a => Number(a.pickId) === Number(pick.id))
                        const destinationName = selectedAsset?.to_player_id ? teamLabel(String(selectedAsset.to_player_id)) : 'Choose destination'
                        return (
                          <button key={pick.id} type="button" onClick={() => setAssetPicker({ pick, destinationPlayerId: selectedAsset?.to_player_id || getDefaultDestination(pick.player_id) })} disabled={tradeDeadlinePassed}
                            style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, padding: 10, borderRadius: 10, border: `1px solid ${selected ? '#EAB308' : 'rgba(71,85,105,0.75)'}`, background: selected ? 'rgba(234,179,8,0.14)' : 'rgba(30,41,59,0.6)', color: '#E2E8F0', cursor: tradeDeadlinePassed ? 'default' : 'pointer' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                              <CharacterPortrait name={pick.character_name} size={34} />
                              <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                                <span style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{pick.character_name}</span>
                                <span className="muted" style={{ fontSize: 11 }}>{selected ? destinationName : 'Tap to assign destination'}</span>
                              </div>
                            </div>
                            <span className="muted" style={{ fontSize: 11 }}>{selected ? 'Edit' : 'Select'}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          </section>

          <section style={{ display: 'grid', gap: 12 }}>
            <div className="section-head"><div><h3>Move Map</h3><span className="muted">{tradeDraft.assets.length} character{tradeDraft.assets.length === 1 ? '' : 's'} selected</span></div></div>
            <div className="feed-list">
              {tradeDraft.assets.map(asset => (
                <div className="feed-row" key={asset.pickId} style={{ alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                    <CharacterPortrait name={asset.character_name} size={36} />
                    <div style={{ display: 'grid', gap: 2 }}>
                      <strong>{asset.character_name}</strong>
                      <span className="muted" style={{ fontSize: 12 }}>{teamLabel(String(asset.from_player_id))} to {teamLabel(String(asset.to_player_id), 'Unassigned')}</span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button className="ghost-button" onClick={() => setAssetPicker({ pick: { id: asset.pickId, player_id: asset.from_player_id, character_id: asset.character_id, character_name: asset.character_name }, destinationPlayerId: asset.to_player_id || '' })} type="button" disabled={tradeDeadlinePassed}>Edit</button>
                    <button className="ghost-button" onClick={() => removeAsset(asset.pickId)} type="button" disabled={tradeDeadlinePassed}><X size={14} /></button>
                  </div>
                </div>
              ))}
              {!tradeDraft.assets.length ? <span className="muted">No characters selected yet.</span> : null}
            </div>
          </section>

          {unresolvedAssets.length || invalidPlayers.length ? (
            <section style={{ display: 'grid', gap: 8 }}>
              {unresolvedAssets.length ? <span className="muted" style={{ color: '#FCA5A5' }}>Every selected character needs a destination before you can continue.</span> : null}
              {invalidPlayers.map(entry => <span key={entry.playerId} className="muted" style={{ color: '#FCA5A5' }}>{teamLabel(entry.playerId, 'A player')} would finish with {entry.finalCount} active characters.</span>)}
            </section>
          ) : null}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="solid-button" onClick={onAdvance} type="button" disabled={tradeDeadlinePassed || !confirmReady}><ArrowRightLeft size={16} /><span>Next: Confirm Trade</span></button>
          </div>
        </div>
      ) : null}

      {step === 'confirm' ? (
        <div className="page-stack" style={{ gap: 16 }}>
          <section style={{ display: 'grid', gap: 12 }}>
            <div className="section-head"><div><h3>Trade Summary</h3><span className="muted">{tradeDraft.assets.length} character{tradeDraft.assets.length === 1 ? '' : 's'} included</span></div></div>
            <div className="feed-list">
              {tradeDraft.assets.map(asset => (
                <div className="feed-row" key={asset.pickId} style={{ alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                    <CharacterPortrait name={asset.character_name} size={36} />
                    <div style={{ display: 'grid', gap: 2 }}>
                      <strong>{asset.character_name}</strong>
                      <span className="muted" style={{ fontSize: 12 }}>{teamLabel(String(asset.from_player_id))} to {teamLabel(String(asset.to_player_id))}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
          <section style={{ display: 'grid', gap: 12 }}>
            <div className="section-head"><div><h3>Final Roster Counts</h3><span className="muted">Each player must finish with 9 active characters.</span></div></div>
            <div className="summary-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
              {playerSummaries.map(entry => (
                <div key={entry.playerId} style={{ padding: 12, borderRadius: 14, border: `1px solid ${entry.valid ? 'rgba(71,85,105,0.7)' : 'rgba(239,68,68,0.65)'}`, background: entry.valid ? 'rgba(15,23,42,0.6)' : 'rgba(127,29,29,0.25)', display: 'grid', gap: 10 }}>
                  <strong>{teamLabel(entry.playerId)}</strong>
                  <div className="summary-grid" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
                    <TeamCountCard label="Out" value={entry.outgoing} muted /><TeamCountCard label="In" value={entry.incoming} muted /><TeamCountCard label="Final" value={entry.finalCount} muted />
                  </div>
                </div>
              ))}
            </div>
          </section>
          {!confirmReady ? <span className="muted" style={{ color: '#FCA5A5' }}>This trade cannot be sent until every character has a valid destination and every player finishes with 9 active characters.</span> : null}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="solid-button" onClick={onSubmit} type="button" disabled={tradeDeadlinePassed || !confirmReady}><ArrowRightLeft size={16} /><span>Send Trade Request</span></button>
          </div>
        </div>
      ) : null}

      {assetPicker ? (
        <div className="modal-backdrop" onClick={() => setAssetPicker(null)}>
          <div className="modal-card" style={{ width: 'min(420px, calc(100vw - 24px))' }} onClick={e => e.stopPropagation()}>
            <div className="section-head">
              <div><h3>{assetPicker.pick.character_name}</h3><span className="muted">Owned by {teamLabel(String(assetPicker.pick.player_id))}</span></div>
              <button className="ghost-button" onClick={() => setAssetPicker(null)} type="button"><X size={14} /></button>
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              <select value={String(assetPicker.destinationPlayerId || '')} onChange={e => setAssetPicker(c => ({ ...c, destinationPlayerId: e.target.value }))}>
                <option value="">Choose destination player</option>
                {participantPlayerIds.filter(pid => String(pid) !== String(assetPicker.pick.player_id)).map(pid => (
                  <option key={pid} value={pid}>{teamLabel(pid)}</option>
                ))}
              </select>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <button className="ghost-button" onClick={() => { removeAsset(assetPicker.pick.id); setAssetPicker(null) }} type="button">Remove From Trade</button>
                <button className="solid-button" onClick={() => { upsertAsset(assetPicker.pick, assetPicker.destinationPlayerId); setAssetPicker(null) }} type="button" disabled={!assetPicker.destinationPlayerId}>Save Selection</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}

export default function Roster() {
  const { player, isCommissioner, isScorekeeper } = useAuth()
  const { currentTournament, allTournaments, selectedTournamentId: ctxTournamentId } = useTournament()
  const { identitiesByPlayerId } = useTournamentTeamIdentity(currentTournament?.id)
  const [players, setPlayers] = useState([])
  const [characters, setCharacters] = useState([])
  const [allDraftPicks, setAllDraftPicks] = useState([])
  const [plateAppearances, setPlateAppearances] = useState([])
  const [pitchingStints, setPitchingStints] = useState([])
  const [games, setGames] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedTeamId, setSelectedTeamId] = useState(null)
  // ctxTournamentId comes from localStorage-backed TournamentContext — available on first render
  // (currentTournament?.id is always null until Supabase responds, so we can't use that)
  const [selectedTournamentId, setSelectedTournamentId] = useState(() => ctxTournamentId || null)
  const [fieldingPositions, setFieldingPositions] = useState({})
  const [lineupOrder, setLineupOrder] = useState([])
  const [activeTab, setActiveTab] = useState('Rosters')
  const [selectedPlayer, setSelectedPlayer] = useState(null)
  const [selectedLineupMoveId, setSelectedLineupMoveId] = useState(null)
  const [cardCharacterId, setCardCharacterId] = useState(null)
  const [freeAgentSort, setFreeAgentSort] = useState({ key: 'name', direction: 'asc' })
  const [tradeProposals, setTradeProposals] = useState([])
  const [tradeProposalPlayers, setTradeProposalPlayers] = useState([])
  const [tradeProposalMoves, setTradeProposalMoves] = useState([])
  const [tradeBuilderStep, setTradeBuilderStep] = useState('teams')
  const [tradeDraft, setTradeDraft] = useState({ participantPlayerIds: [], assets: [] })

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      const [
        { data: pData }, { data: cData }, { data: dData }, { data: paData }, { data: gData },
        { data: pitchData },
        { data: tpData }, { data: tppData }, { data: tpmData },
      ] = await Promise.all([
        supabase.from('players').select('*').order('created_at'),
        supabase.from('characters').select('*').order('name'),
        supabase.from('draft_picks').select('*').order('pick_number'),
        supabase.from('plate_appearances').select('game_id,character_id,result,run_scored,rbi'),
        supabase.from('games').select('id,tournament_id'),
        supabase.from('pitching_stints').select('*'),
        supabase.from('tournament_trade_proposals').select('*'),
        supabase.from('tournament_trade_proposal_players').select('*'),
        supabase.from('tournament_trade_proposal_moves').select('*'),
      ])
      setPlayers(pData || [])
      setCharacters(cData || [])
      setAllDraftPicks(dData || [])
      setPlateAppearances(paData || [])
      setGames(gData || [])
      setPitchingStints(pitchData || [])
      setTradeProposals(tpData || [])
      setTradeProposalPlayers(tppData || [])
      setTradeProposalMoves(tpmData || [])
      setLoading(false)
    }
    load()
    const channel = supabase
      .channel(`roster-live-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'players' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'characters' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'draft_picks' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'plate_appearances' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pitching_stints' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'games' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tournament_trade_proposals' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tournament_trade_proposal_players' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tournament_trade_proposal_moves' }, load)
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
  const charactersByName = useMemo(() => Object.fromEntries(characters.map(c => [c.name, c])), [characters])

  const positionByCharId = useMemo(
    () => Object.fromEntries(Object.entries(fieldingPositions).map(([posId, charId]) => [charId, posId])),
    [fieldingPositions]
  )

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

  const canEditRoster = String(selectedTeamId) === String(player?.id) || isCommissioner || isScorekeeper

  // Tracks the most recently loaded/saved { lineupOrder, fieldingPositions } JSON
  // for the current team, so the autosave effect can skip redundant writes
  // (including writes triggered by our own realtime echo).
  const lastSyncedLineupRef = useRef(null)
  const lineupLoadKeyRef = useRef(null)

  // Load saved lineup order + fielding positions from the database when the
  // team roster changes, falling back to draft-pick order / first-9 fielding.
  useEffect(() => {
    if (teamRoster.length === 0) {
      setFieldingPositions({})
      setLineupOrder([])
      lastSyncedLineupRef.current = null
      lineupLoadKeyRef.current = null
      return
    }

    const defaultFielding = {}
    const positions = ['pitcher', 'catcher', 'firstBase', 'secondBase', 'thirdBase', 'shortStop', 'leftField', 'centerField', 'rightField']
    for (let i = 0; i < Math.min(9, teamRoster.length); i++) {
      defaultFielding[positions[i]] = teamRoster[i].id
    }
    const defaultLineup = teamRoster.map(c => c.id)
    const loadKey = `${selectedTournamentId}-${selectedTeamId}`

    let cancelled = false
    fetchTeamLineup({ ...TOURNAMENT_TEAM_LINEUPS, sourceId: selectedTournamentId, playerId: selectedTeamId }).then((saved) => {
      if (cancelled) return

      let fieldingPositionsResult = defaultFielding
      if (saved && saved.fieldingPositions && Object.keys(saved.fieldingPositions).length) {
        const rosterIds = new Set(teamRoster.map((character) => character.id))
        const savedPositions = Object.fromEntries(
          Object.entries(saved.fieldingPositions).filter(([, value]) => rosterIds.has(value)),
        )
        const placedIds = new Set(Object.values(savedPositions))
        const unplaced = teamRoster.map((character) => character.id).filter((id) => !placedIds.has(id))
        const emptyPositions = positions.filter((position) => !savedPositions[position])
        unplaced.forEach((id, index) => {
          if (emptyPositions[index]) savedPositions[emptyPositions[index]] = id
        })
        fieldingPositionsResult = savedPositions
      }

      let lineupOrderResult = defaultLineup
      if (saved && Array.isArray(saved.lineupOrder) && saved.lineupOrder.length) {
        const rosterIds = new Set(teamRoster.map(c => c.id))
        const ordered = saved.lineupOrder.filter(id => rosterIds.has(id))
        const remaining = teamRoster.map(c => c.id).filter(id => !ordered.includes(id))
        lineupOrderResult = [...ordered, ...remaining]
      }

      lastSyncedLineupRef.current = JSON.stringify({ lineupOrder: lineupOrderResult, fieldingPositions: fieldingPositionsResult })
      lineupLoadKeyRef.current = loadKey
      setFieldingPositions(fieldingPositionsResult)
      setLineupOrder(lineupOrderResult)
    })

    return () => { cancelled = true }
  }, [teamRoster, selectedTournamentId, selectedTeamId])

  // Autosave lineup order + fielding positions to the database (debounced),
  // so every viewer of this team's roster sees edits in real time.
  useEffect(() => {
    if (!selectedTournamentId || !selectedTeamId) return
    if (!canEditRoster) return
    if (lineupLoadKeyRef.current !== `${selectedTournamentId}-${selectedTeamId}`) return
    if (!lineupOrder.length && !Object.keys(fieldingPositions).length) return

    const payload = JSON.stringify({ lineupOrder, fieldingPositions })
    if (payload === lastSyncedLineupRef.current) return

    const timeout = setTimeout(() => {
      lastSyncedLineupRef.current = payload
      upsertTeamLineup({
        ...TOURNAMENT_TEAM_LINEUPS,
        sourceId: selectedTournamentId,
        playerId: selectedTeamId,
        lineupOrder,
        fieldingPositions,
      })
    }, 500)

    return () => clearTimeout(timeout)
  }, [selectedTournamentId, selectedTeamId, lineupOrder, fieldingPositions, canEditRoster])

  // Realtime: pick up lineup/fielding edits made by anyone else (or from
  // another device) for the currently viewed team.
  useEffect(() => {
    if (!selectedTournamentId || !selectedTeamId) return
    const channel = supabase
      .channel(`team-lineup-${selectedTournamentId}-${selectedTeamId}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'team_lineups',
        filter: `tournament_id=eq.${selectedTournamentId}`,
      }, (payload) => {
        const row = payload.new
        if (!row || String(row.player_id) !== String(selectedTeamId)) return
        const lineupOrder = Array.isArray(row.lineup_order) ? row.lineup_order : []
        const fieldingPositions = row.fielding_positions && typeof row.fielding_positions === 'object' ? row.fielding_positions : {}
        lastSyncedLineupRef.current = JSON.stringify({ lineupOrder, fieldingPositions })
        setLineupOrder(lineupOrder)
        setFieldingPositions(fieldingPositions)
      })
      .subscribe()

    // Realtime postgres_changes can silently fail to deliver in some
    // environments (and browsers throttle/suspend websockets on backgrounded
    // tabs), so poll for the saved lineup as a fallback to guarantee it stays
    // in sync even if the live channel above never fires.
    const syncFromDb = () => {
      fetchTeamLineup({ ...TOURNAMENT_TEAM_LINEUPS, sourceId: selectedTournamentId, playerId: selectedTeamId }).then((saved) => {
        if (!saved) return
        const lineupOrder = Array.isArray(saved.lineupOrder) ? saved.lineupOrder : []
        const fieldingPositions = saved.fieldingPositions && typeof saved.fieldingPositions === 'object' ? saved.fieldingPositions : {}
        const payload = JSON.stringify({ lineupOrder, fieldingPositions })
        if (payload === lastSyncedLineupRef.current) return
        lastSyncedLineupRef.current = payload
        setLineupOrder(lineupOrder)
        setFieldingPositions(fieldingPositions)
      })
    }
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') syncFromDb()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    const pollInterval = setInterval(syncFromDb, 5000)

    return () => {
      supabase.removeChannel(channel)
      document.removeEventListener('visibilitychange', handleVisibility)
      clearInterval(pollInterval)
    }
  }, [selectedTournamentId, selectedTeamId])

  const rosterNames = useMemo(() => teamRoster.map(c => c.chemistryName || c.name), [teamRoster])
  const rosterCharacterMetaById = useMemo(() => Object.fromEntries(teamRoster.map(c => [c.id, c])), [teamRoster])
  const activeChemistryCharacterId = selectedPlayer || null
  const chemistryHighlightIds = useMemo(
    () => buildChemistryHighlightSet(activeChemistryCharacterId, teamRoster),
    [activeChemistryCharacterId, teamRoster],
  )
  const selectedCharacterDetail = useMemo(() => {
    if (!cardCharacterId) return null
    return rosterCharacterMetaById[cardCharacterId] || charactersById[cardCharacterId] || null
  }, [cardCharacterId, rosterCharacterMetaById, charactersById])

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

  // All-tournament batting history (includes current tournament) — used by SharedCharacterDetailModal
  const allTournHistories = useMemo(
    () => buildCharacterTournamentHistory(plateAppearances, games, allTournaments || []),
    [plateAppearances, games, allTournaments]
  )

  const pitchingHistoryByCharacter = useMemo(() => {
    const gameByIdMap = Object.fromEntries(games.map(g => [g.id, g]))
    const tournById = Object.fromEntries((allTournaments || []).map(t => [t.id, t]))
    const byCharTournament = {}
    for (const stint of pitchingStints) {
      const game = gameByIdMap[stint.game_id]
      if (!game || !stint.character_id) continue
      const tid = game.tournament_id
      const cid = stint.character_id
      if (!byCharTournament[cid]) byCharTournament[cid] = {}
      if (!byCharTournament[cid][tid]) byCharTournament[cid][tid] = []
      byCharTournament[cid][tid].push(stint)
    }
    const result = {}
    for (const [charId, byT] of Object.entries(byCharTournament)) {
      result[charId] = Object.entries(byT)
        .map(([tid, stints]) => {
          const t = tournById[tid]
          return {
            tournamentId: tid,
            tournamentNumber: t?.tournament_number ?? '?',
            rawStints: stints,
            ...summarizePitching(stints),
          }
        })
        .sort((a, b) => (a.tournamentNumber > b.tournamentNumber ? 1 : -1))
    }
    return result
  }, [pitchingStints, games, allTournaments])

  const handleDragStartRoster = (characterId) => (e) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('characterId', String(characterId))
  }

  const handleDragStartLineup = (characterId) => (e) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('characterId', String(characterId))
    e.dataTransfer.setData('lineupCharacterId', String(characterId))
  }

  const handleLineupNumberClick = useCallback((charId, index) => {
    if (selectedLineupMoveId === null) {
      setSelectedLineupMoveId(charId)
      return
    }
    if (selectedLineupMoveId === charId) {
      setSelectedLineupMoveId(null)
      return
    }
    setLineupOrder((prev) => {
      const newOrder = [...prev]
      const sourceIdx = prev.indexOf(selectedLineupMoveId)
      if (sourceIdx === -1) return prev
      newOrder.splice(sourceIdx, 1)
      newOrder.splice(index, 0, selectedLineupMoveId)
      return newOrder
    })
    setSelectedLineupMoveId(null)
  }, [selectedLineupMoveId, selectedTournamentId, selectedTeamId])

  const handleDropOnLineup = (index) => (e) => {
    e.preventDefault()
    const characterId = parseInt(e.dataTransfer.getData('lineupCharacterId'), 10)
    if (characterId) {
      setLineupOrder(prev => {
        if (!prev.includes(characterId)) return prev
        const newOrder = prev.filter(id => id !== characterId)
        newOrder.splice(index, 0, characterId)
        return newOrder
      })
    }
  }

  const myPlayer = useMemo(() => players.find(p => String(p.id) === String(player?.id)), [players, player?.id])
  const playersById = useMemo(() => Object.fromEntries(players.map(p => [String(p.id), p])), [players])
  const teamLabel = useCallback(
    (playerId, fallback = 'Unknown') => getTeamShortName(identitiesByPlayerId[playerId]) || playersById[playerId]?.name || fallback,
    [identitiesByPlayerId, playersById],
  )

  const tradeDeadlinePassed = currentTournament?.trade_deadline_at
    ? new Date() > new Date(currentTournament.trade_deadline_at)
    : false

  const activeRosterByPlayerId = useMemo(() => {
    const result = {}
    players.forEach(p => {
      result[String(p.id)] = draftPicks
        .filter(pick => String(pick.player_id) === String(p.id) && pick.character_id)
        .map(pick => ({
          id: pick.id,
          player_id: pick.player_id,
          character_id: pick.character_id,
          character_name: charactersById[pick.character_id]?.name || `Character ${pick.character_id}`,
        }))
    })
    return result
  }, [players, draftPicks, charactersById])

  const tournamentTradeProposals = useMemo(
    () => tradeProposals.filter(p => String(p.tournament_id) === String(selectedTournamentId)),
    [tradeProposals, selectedTournamentId],
  )

  const tradeSummaries = useMemo(() => tournamentTradeProposals.map(proposal => ({
    ...proposal,
    participants: tradeProposalPlayers.filter(p => p.proposal_id === proposal.id),
    moves: tradeProposalMoves.filter(m => m.proposal_id === proposal.id),
  })), [tournamentTradeProposals, tradeProposalPlayers, tradeProposalMoves])

  const pendingTrades = tradeSummaries.filter(t => t.status === 'pending')
  const historyTrades = tradeSummaries.filter(t => t.status !== 'pending')

  const pendingTradeCount = pendingTrades.filter(trade =>
    trade.participants.some(p =>
      String(p.player_id) === String(myPlayer?.id) &&
      p.decision_status === 'pending' &&
      String(trade.created_by_player_id) !== String(myPlayer?.id),
    )
  ).length

  const openTradeBuilder = useCallback((seedPick = null) => {
    const baseIds = myPlayer?.id ? [String(myPlayer.id)] : []
    const nextState = { participantPlayerIds: baseIds, assets: [] }
    if (seedPick) {
      const fromId = String(seedPick.player_id)
      const defaultTarget = fromId === String(myPlayer?.id)
        ? (selectedTeamId && String(selectedTeamId) !== fromId ? String(selectedTeamId) : '')
        : String(myPlayer?.id || '')
      nextState.participantPlayerIds = Array.from(new Set([...baseIds, fromId, ...(defaultTarget ? [defaultTarget] : [])]))
      if (defaultTarget && defaultTarget !== fromId) {
        nextState.assets = [{
          pickId: seedPick.id, character_id: seedPick.character_id,
          character_name: seedPick.character_name,
          from_player_id: fromId, to_player_id: defaultTarget,
        }]
      }
    }
    setActiveTab('Trade Center')
    setTradeDraft(nextState)
    setTradeBuilderStep('teams')
  }, [myPlayer?.id, selectedTeamId])

  const closeTradeBuilder = useCallback(() => {
    setTradeDraft({ participantPlayerIds: myPlayer?.id ? [String(myPlayer.id)] : [], assets: [] })
    setTradeBuilderStep('teams')
  }, [myPlayer?.id])

  const submitTradeProposal = async () => {
    if (!selectedTournamentId || !myPlayer?.id) {
      pushToast({ title: 'Trade unavailable', message: 'No tournament or player found.', type: 'error' })
      return
    }
    if (tradeDeadlinePassed) {
      pushToast({ title: 'Trade deadline passed', message: 'Trades are closed for this tournament.', type: 'error' })
      return
    }
    const { data: proposal, error: proposalError } = await supabase
      .from('tournament_trade_proposals')
      .insert({ tournament_id: String(selectedTournamentId), created_by_player_id: String(myPlayer.id), status: 'pending' })
      .select().single()
    if (proposalError) {
      pushToast({ title: 'Trade failed', message: proposalError.message, type: 'error' })
      return
    }
    const [{ error: participantError }, { error: moveError }] = await Promise.all([
      supabase.from('tournament_trade_proposal_players').insert(
        tradeDraft.participantPlayerIds.map(pid => ({
          proposal_id: proposal.id,
          player_id: String(pid),
          decision_status: String(pid) === String(myPlayer.id) ? 'accepted' : 'pending',
        }))
      ),
      supabase.from('tournament_trade_proposal_moves').insert(
        tradeDraft.assets.map(asset => ({
          proposal_id: proposal.id,
          character_id: asset.character_id,
          character_name: asset.character_name,
          from_player_id: String(asset.from_player_id),
          to_player_id: String(asset.to_player_id),
        }))
      ),
    ])
    if (participantError || moveError) {
      pushToast({ title: 'Trade detail failed', message: participantError?.message || moveError?.message, type: 'error' })
      return
    }
    pushToast({ title: 'Trade proposed', message: 'The other players can now review the proposal.', type: 'success' })
    closeTradeBuilder()
  }

  const respondToTrade = async (proposalId, response) => {
    if (!myPlayer?.id) return
    await supabase
      .from('tournament_trade_proposal_players')
      .update({ decision_status: response })
      .eq('proposal_id', proposalId)
      .eq('player_id', String(myPlayer.id))
    if (response === 'rejected') {
      await supabase.from('tournament_trade_proposals')
        .update({ status: 'rejected', resolved_at: new Date().toISOString() })
        .eq('id', proposalId)
      pushToast({ title: 'Trade rejected', message: 'Trade has been declined.', type: 'info' })
      return
    }
    const { data: allParticipants } = await supabase
      .from('tournament_trade_proposal_players').select('*').eq('proposal_id', proposalId)
    const updatedDecisions = (allParticipants || []).map(p =>
      String(p.player_id) === String(myPlayer.id) ? { ...p, decision_status: 'accepted' } : p
    )
    const allAccepted = updatedDecisions.every(p => p.decision_status === 'accepted')
    if (allAccepted) {
      const { data: moves } = await supabase
        .from('tournament_trade_proposal_moves').select('*').eq('proposal_id', proposalId)
      for (const move of (moves || [])) {
        await supabase.from('draft_picks')
          .update({ player_id: move.to_player_id })
          .eq('tournament_id', String(selectedTournamentId))
          .eq('player_id', move.from_player_id)
          .eq('character_id', move.character_id)
      }
      await supabase.from('tournament_trade_proposals')
        .update({ status: 'accepted', resolved_at: new Date().toISOString() })
        .eq('id', proposalId)
      pushToast({ title: 'Trade accepted!', message: 'All parties agreed — rosters updated.', type: 'success' })
    } else {
      pushToast({ title: 'Trade accepted', message: 'Waiting for other players to respond.', type: 'success' })
    }
  }

  const setTradeDeadlineNow = async () => {
    await supabase.from('tournaments')
      .update({ trade_deadline_at: new Date().toISOString() })
      .eq('id', selectedTournamentId)
    pushToast({ title: 'Trade deadline set', message: 'Trades are now locked for this tournament.', type: 'success' })
  }

  const selectedTournament = useMemo(
    () => [currentTournament, ...(allTournaments || [])].filter(Boolean).find(t => String(t.id) === String(selectedTournamentId)),
    [currentTournament, allTournaments, selectedTournamentId]
  )

  const draftedCharacterIds = useMemo(() => new Set(draftPicks.map(p => p.character_id)), [draftPicks])

  const sortedFreeAgents = useMemo(() => {
    const fas = characters.filter(c => !draftedCharacterIds.has(c.id))
    return [...fas].sort((a, b) => {
      const aVal = freeAgentSort.key === 'name' ? a.name : (a[freeAgentSort.key] ?? 0)
      const bVal = freeAgentSort.key === 'name' ? b.name : (b[freeAgentSort.key] ?? 0)
      const cmp = typeof aVal === 'string' ? aVal.localeCompare(bVal) : aVal - bVal
      return freeAgentSort.direction === 'asc' ? cmp : -cmp
    })
  }, [characters, draftedCharacterIds, freeAgentSort])

  const toggleFreeAgentSort = (key) => {
    setFreeAgentSort(prev =>
      prev.key === key
        ? { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: key === 'name' ? 'asc' : 'desc' }
    )
  }

  const TABS = ['Rosters', 'Trade Center', 'Free Agents', 'Transactions']

  return (
    <div className="page-stack">
      <div className="page-head">
        <div>
          <span className="brand-kicker">Tournament Roster</span>
          <h1>{selectedTournament ? `Tournament ${selectedTournament.tournament_number}` : 'Roster'}</h1>
          <p className="muted">View every team's roster and manage fielding positions. Trades live in the Trade Center tab.</p>
        </div>
      </div>

      <div className="tab-row">
        {TABS.map((tab) => (
          <button key={tab} className={`tab-button ${activeTab === tab ? 'tab-button-active' : ''}`} onClick={() => setActiveTab(tab)} type="button">
            {tab}
          </button>
        ))}
      </div>

      {activeTab === 'Rosters' ? (
        <div className="page-stack" style={{ gap: 18 }}>
          <section className="panel" style={{ padding: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <h2 style={{ margin: 0, flexShrink: 0 }}>Viewing:</h2>
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8 }}>
                <select
                  value={String(selectedTeamId || '')}
                  onChange={(e) => setSelectedTeamId(e.target.value)}
                  style={{ background: '#1E293B', border: '1px solid #334155', borderRadius: 999, color: '#E2E8F0', fontWeight: 600, padding: '8px 14px', fontSize: 14, cursor: 'pointer', minWidth: 180 }}
                >
                  {players.map((p) => (
                    <option key={p.id} value={String(p.id)}>
                      {p.name}{String(p.id) === String(player?.id) ? ' — You' : ''}
                    </option>
                  ))}
                </select>
              </div>
              <select
                value={String(selectedTournamentId || '')}
                onChange={(e) => setSelectedTournamentId(e.target.value)}
                style={{ background: '#1E293B', border: '1px solid #334155', borderRadius: 999, color: '#E2E8F0', fontWeight: 600, padding: '8px 14px', fontSize: 14, cursor: 'pointer', minWidth: 160 }}
              >
                {[currentTournament, ...((allTournaments || []).filter((t) => t.id !== currentTournament?.id))].filter(Boolean).map((t) => (
                  <option key={t.id} value={String(t.id)}>Tournament {t.tournament_number}</option>
                ))}
              </select>
              {!canEditRoster && (
                <span style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 999, padding: '4px 12px', textTransform: 'uppercase', letterSpacing: '.04em' }}>
                  View only
                </span>
              )}
            </div>
          </section>

          <div className="roster-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', alignItems: 'start' }}>
            <div style={{ background: '#0F172A', border: '1px solid #1E293B', borderRadius: 14, padding: 16, height: 'fit-content' }}>
              <div style={{ marginBottom: 14 }}>
                <h3 style={{ fontSize: 14, fontWeight: 800, color: '#EFF6FF', letterSpacing: '.04em', textTransform: 'uppercase', margin: 0 }}>Lineup</h3>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {lineupOrder.length === 0 ? (
                  <div style={{ padding: 12, textAlign: 'center', color: '#64748B', fontSize: 12 }}>No active players on this roster yet.</div>
                ) : (
                  lineupOrder.map((charId, index) => {
                    const character = charactersById[charId]
                    if (!character) return null
                    const rosterChar = teamRoster.find((c) => c.id === charId) || character
                    return (
                      <div
                        key={charId}
                        draggable={canEditRoster}
                        onDragStart={canEditRoster ? handleDragStartLineup(charId) : undefined}
                        onDragOver={canEditRoster ? (event) => event.preventDefault() : undefined}
                        onDrop={canEditRoster ? handleDropOnLineup(index) : undefined}
                        style={{ borderRadius: 8, touchAction: 'pan-y' }}
                      >
                        <DraggableRosterItem
                          character={rosterChar}
                          onDragStart={handleDragStartRoster(charId)}
                          rosterNames={rosterNames}
                          onOpenCard={() => setCardCharacterId(charId)}
                          compact
                          lineupNumber={index + 1}
                          positionLabel={positionByCharId[charId] || null}
                          onLineupNumberClick={() => handleLineupNumberClick(charId, index)}
                          lineupNumberSelected={selectedLineupMoveId === charId}
                          lineupNumberAriaLabel={`Lineup spot ${index + 1}`}
                          lineupNumberTitle={canEditRoster ? (selectedLineupMoveId === charId ? 'Selected lineup slot' : 'Tap to move this player or move another player here') : `Lineup spot ${index + 1}`}
                          lineupNumberDisabled={!canEditRoster}
                          showChemistryNote={chemistryHighlightIds.has(charId)}
                            highlighted={selectedLineupMoveId === charId}
                            showTrade={false}
                            disabled={!canEditRoster}
                          />
                      </div>
                    )
                  })
                )}
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
              <FieldingView
                charactersById={charactersById}
                fieldingPositions={fieldingPositions}
                setFieldingPositions={setFieldingPositions}
                selectedPlayer={selectedPlayer}
                setSelectedPlayer={setSelectedPlayer}
                fieldingAssignMode={false}
                selectedForFielding={null}
                onAssignPosition={() => {}}
                editable={canEditRoster}
                chemistryHighlightIds={chemistryHighlightIds}
              />
            </div>
          </div>
        </div>
      ) : null}

      {activeTab === 'Trade Center' ? (
        <div className="page-stack" style={{ gap: 12 }}>
          <div className="inline-actions">
            <StatusChip value={tradeDeadlinePassed ? 'rejected' : 'pending'} />
            <div className="player-pill" style={{ borderColor: pendingTradeCount ? '#EAB308' : '#334155' }}>
              <span>Pending For You</span>
              <strong>{pendingTradeCount}</strong>
            </div>
            <button className="solid-button" onClick={() => openTradeBuilder()} type="button" disabled={!myPlayer || tradeDeadlinePassed}>
              <ArrowRightLeft size={16} /><span>New Trade</span>
            </button>
          </div>

          {/* Pending trades for me */}
          {pendingTrades.filter(t => t.participants.some(p => String(p.player_id) === String(myPlayer?.id) && p.decision_status === 'pending' && String(t.created_by_player_id) !== String(myPlayer?.id))).map(trade => (
            <section key={trade.id} className="panel" style={{ padding: 18, border: '1px solid rgba(234,179,8,0.4)' }}>
              <div className="section-head">
                <div>
                  <h3>Trade Proposal</h3>
                  <span className="muted">From {teamLabel(String(trade.created_by_player_id))}</span>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="ghost-button" onClick={() => respondToTrade(trade.id, 'rejected')} type="button"><X size={14} /><span>Reject</span></button>
                  <button className="solid-button" onClick={() => respondToTrade(trade.id, 'accepted')} type="button"><ArrowRightLeft size={14} /><span>Accept</span></button>
                </div>
              </div>
              <div className="feed-list">
                {trade.moves.map(move => (
                  <div className="feed-row" key={move.id} style={{ alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <CharacterPortrait name={move.character_name} size={32} />
                      <div style={{ display: 'grid', gap: 2 }}>
                        <strong>{move.character_name}</strong>
                        <span className="muted" style={{ fontSize: 12 }}>{teamLabel(String(move.from_player_id))} → {teamLabel(String(move.to_player_id))}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}

          <TournamentTradeBuilderWorkspace
            step={tradeBuilderStep}
            onBack={() => setTradeBuilderStep(s => s === 'confirm' ? 'details' : 'teams')}
            onReset={closeTradeBuilder}
            onAdvance={() => setTradeBuilderStep(s => s === 'teams' ? 'details' : 'confirm')}
            tradeDraft={tradeDraft}
            setTradeDraft={setTradeDraft}
            players={players}
            playersById={playersById}
            identitiesByPlayerId={identitiesByPlayerId}
            myPlayer={myPlayer}
            viewedPlayerId={selectedTeamId}
            activeRosterByPlayerId={activeRosterByPlayerId}
            onSubmit={submitTradeProposal}
            tradeDeadlinePassed={tradeDeadlinePassed}
          />

          {/* All pending trades (mine and others) */}
          {pendingTrades.length > 0 ? (
            <section className="panel" style={{ padding: 18 }}>
              <div className="section-head"><h2>All Pending Trades</h2></div>
              <div className="feed-list">
                {pendingTrades.map(trade => (
                  <div key={trade.id} style={{ padding: 14, borderRadius: 14, background: 'rgba(15,23,42,0.55)', border: '1px solid rgba(51,65,85,0.9)', display: 'grid', gap: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        {trade.participants.map(p => <span key={p.id} style={{ fontSize: 13, fontWeight: 700, color: p.decision_status === 'accepted' ? '#86EFAC' : '#FDE68A' }}>{teamLabel(String(p.player_id))} {p.decision_status === 'accepted' ? '✓' : '…'}</span>)}
                      </div>
                      <StatusChip value="pending" />
                    </div>
                    <span className="muted" style={{ fontSize: 12 }}>{trade.moves.map(m => m.character_name).join(' • ')}</span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      ) : null}

      {activeTab === 'Free Agents' ? (
        <div className="page-stack" style={{ gap: 18 }}>
          <section className="panel" style={{ padding: 18 }}>
            <div className="section-head">
              <div>
                <h2>Free Agents</h2>
                <span className="muted">Characters not drafted in this tournament.</span>
              </div>
              <div style={{ display: 'grid', gap: 4, justifyItems: 'end' }}>
                <span className="muted" style={{ fontSize: 12 }}>Your active roster</span>
                <strong style={{ fontSize: 18 }}>{teamRoster.length}/9</strong>
              </div>
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '32px 1fr 26px 26px 26px 26px 1fr', gap: 4, alignItems: 'center', padding: '4px 6px', color: '#475569', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', borderBottom: '1px solid #1E293B', letterSpacing: '.04em' }}>
                <span />
                <button type="button" onClick={() => toggleFreeAgentSort('name')} style={{ background: 'none', border: 'none', color: 'inherit', padding: 0, textAlign: 'left', font: 'inherit', cursor: 'pointer' }}>
                  Player {freeAgentSort.key === 'name' ? (freeAgentSort.direction === 'asc' ? '^' : 'v') : ''}
                </button>
                <button type="button" onClick={() => toggleFreeAgentSort('pitching')} style={{ background: 'none', border: 'none', color: 'inherit', padding: 0, font: 'inherit', cursor: 'pointer' }}>
                  P {freeAgentSort.key === 'pitching' ? (freeAgentSort.direction === 'asc' ? '^' : 'v') : ''}
                </button>
                <button type="button" onClick={() => toggleFreeAgentSort('batting')} style={{ background: 'none', border: 'none', color: 'inherit', padding: 0, font: 'inherit', cursor: 'pointer' }}>
                  B {freeAgentSort.key === 'batting' ? (freeAgentSort.direction === 'asc' ? '^' : 'v') : ''}
                </button>
                <button type="button" onClick={() => toggleFreeAgentSort('fielding')} style={{ background: 'none', border: 'none', color: 'inherit', padding: 0, font: 'inherit', cursor: 'pointer' }}>
                  F {freeAgentSort.key === 'fielding' ? (freeAgentSort.direction === 'asc' ? '^' : 'v') : ''}
                </button>
                <button type="button" onClick={() => toggleFreeAgentSort('speed')} style={{ background: 'none', border: 'none', color: 'inherit', padding: 0, font: 'inherit', cursor: 'pointer' }}>
                  S {freeAgentSort.key === 'speed' ? (freeAgentSort.direction === 'asc' ? '^' : 'v') : ''}
                </button>
                <span>Status</span>
              </div>
              {sortedFreeAgents.map((c) => (
                <div key={c.id} style={{ display: 'grid', gridTemplateColumns: '32px 1fr 26px 26px 26px 26px 1fr', gap: 4, alignItems: 'center', padding: '7px 6px', borderBottom: '1px solid #0F172A' }}>
                  <button type="button" onClick={() => setCardCharacterId(c.id)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', justifySelf: 'center' }}>
                    <CharacterPortrait name={c.name} size={28} />
                  </button>
                  <button type="button" onClick={() => setCardCharacterId(c.id)} style={{ width: 'fit-content', background: 'none', border: 'none', color: '#E2E8F0', padding: 0, cursor: 'pointer', textAlign: 'left' }}>
                    <strong style={{ fontSize: 15 }}>{c.name}</strong>
                  </button>
                  {[c.pitching, c.batting, c.fielding, c.speed].map((val, i) => (
                    <strong key={i} style={{ fontSize: 15, textAlign: 'center' }}>{val ?? '-'}</strong>
                  ))}
                  <span className="muted" style={{ fontSize: 10 }}>Free agent</span>
                </div>
              ))}
              {!sortedFreeAgents.length ? <span className="muted">No free agents in this tournament.</span> : null}
            </div>
          </section>
        </div>
      ) : null}

      {activeTab === 'Transactions' ? (
        <section className="panel" style={{ padding: 18 }}>
          <div className="section-head"><h2>Transaction History</h2></div>
          <div className="feed-list">
            {[...historyTrades].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0)).map(trade => (
              <div key={trade.id} style={{ padding: 14, borderRadius: 14, background: 'rgba(15,23,42,0.55)', border: '1px solid rgba(51,65,85,0.9)', display: 'grid', gap: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {trade.participants.map(p => <span key={p.id} style={{ fontSize: 13, fontWeight: 700 }}>{teamLabel(String(p.player_id))}</span>)}
                  </div>
                  <StatusChip value={trade.status} />
                </div>
                <span className="muted" style={{ fontSize: 12 }}>{trade.moves.map(m => m.character_name).join(' • ')}</span>
              </div>
            ))}
            {!historyTrades.length ? <span className="muted">No completed trade history.</span> : null}
          </div>
        </section>
      ) : null}

      {cardCharacterId && (
        <>
          <div onClick={() => setCardCharacterId(null)} style={{ position: 'fixed', inset: 0, background: '#00000060', zIndex: 49 }} />
          <SharedCharacterDetailModal
            character={selectedCharacterDetail}
            allCharactersById={charactersByName}
            playersById={players.reduce((acc, p) => ({ ...acc, [p.id]: p }), {})}
            currentOwner={selectedTeamId ? { player_id: selectedTeamId } : null}
            battingHistory={allTournHistories[cardCharacterId] || []}
            pitchingHistory={pitchingHistoryByCharacter[cardCharacterId] || []}
            currentTournamentBatting={(() => {
              const entry = allTournHistories[cardCharacterId]?.find(
                h => String(h.tournamentId) === String(selectedTournamentId)
              )
              if (!entry?.rawPas?.length) return undefined
              const b = summarizeBatting(entry.rawPas)
              b.ops = b.obp + b.slg
              b.rawPas = entry.rawPas
              return b
            })()}
            currentTournamentPitching={
              pitchingHistoryByCharacter[cardCharacterId]?.find(
                h => String(h.tournamentId) === String(selectedTournamentId)
              ) || undefined
            }
            allTimeBatting={(() => {
              const pas = plateAppearances.filter(pa => String(pa.character_id) === String(cardCharacterId))
              if (!pas.length) return undefined
              const b = summarizeBatting(pas)
              b.ops = b.obp + b.slg
              b.rawPas = pas
              return b
            })()}
            allTimePitching={(() => {
              const stints = pitchingStints.filter(s => String(s.character_id) === String(cardCharacterId))
              return stints.length ? summarizePitching(stints) : undefined
            })()}
            rosterNames={rosterNames}
            onClose={() => setCardCharacterId(null)}
          />
        </>
      )}
    </div>
  )
}
