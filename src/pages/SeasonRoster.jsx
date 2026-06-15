import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRightLeft, Clock3, Plus, Users2, X } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { useAuth } from '../context/AuthContext'
import { useSeason } from '../context/SeasonContext'
import { useToast } from '../context/ToastContext'
import SharedCharacterDetailModal from '../components/CharacterDetailModal'
import PlayerTag from '../components/PlayerTag'
import TeamLogo from '../components/TeamLogo'
import CharacterPortrait from '../components/CharacterPortrait'
import StatIcon from '../components/StatIcon'
import { DraggableRosterItem, FieldingView, FIELD_POSITIONS } from '../components/RosterLineupWidgets'
import { getChemistry, chemScore } from '../data/chemistry'
import { analyzeCharacterTalent } from '../utils/characterAnalysis'
import { buildChemistryHighlightSet } from '../utils/chemistryHighlights'
import { formatSeasonLabel } from '../utils/season'
import { buildSeasonTeamIdentity, getTeamShortName } from '../utils/teamIdentity'
import { summarizeBatting, summarizePitching } from '../utils/statsCalculator'
import { fetchTeamLineup, swapLineupSlot, upsertTeamLineup, SEASON_TEAM_LINEUPS } from '../utils/teamLineups'

const TABS = ['Rosters', 'Trade Center', 'Free Agents', 'Transactions']
const WAIVER_DURATION_MS = 7 * 24 * 60 * 60 * 1000
const SUPPORTS_WAIVER_CLAIMS_SCHEMA = false

function sortNewestFirst(rows = []) {
  return [...rows].sort((a, b) => new Date(b.created_at || b.proposed_at || 0) - new Date(a.created_at || a.proposed_at || 0))
}

function StatusChip({ value }) {
  const status = String(value || '')
  const tone = status === 'accepted' || status === 'approved'
    ? { bg: 'rgba(34,197,94,0.12)', border: 'rgba(34,197,94,0.35)', color: '#86EFAC' }
    : status === 'pending'
      ? { bg: 'rgba(234,179,8,0.12)', border: 'rgba(234,179,8,0.35)', color: '#FDE68A' }
      : { bg: 'rgba(239,68,68,0.12)', border: 'rgba(239,68,68,0.35)', color: '#FCA5A5' }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', padding: '6px 10px', borderRadius: 999, background: tone.bg, border: `1px solid ${tone.border}`, color: tone.color, fontSize: 12, fontWeight: 700 }}>
      {formatSeasonLabel(status)}
    </span>
  )
}

function formatShortDate(value) {
  if (!value) return 'No expiry'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return 'No expiry'
  return parsed.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function buildWaiverExpiryDate() {
  return new Date(Date.now() + WAIVER_DURATION_MS).toISOString()
}

function sortWaiverClaims(claims = []) {
  return [...claims].sort((a, b) => Number(a.priority_order) - Number(b.priority_order) || new Date(a.created_at || 0) - new Date(b.created_at || 0))
}

function getWaiverClockTeamId(waiver, reverseStandings = []) {
  const deniedTeamIds = new Set((waiver?.denied_team_ids || []).map((entry) => String(entry)))
  return reverseStandings
    .map((entry) => String(entry.id))
    .find((teamId) => teamId !== String(waiver?.source_team_id || '') && !deniedTeamIds.has(teamId)) || ''
}

function buildLegacyTradeSummary(trades, tradePlayers) {
  return (trades || []).map((trade) => ({
    id: `legacy-${trade.id}`,
    source: 'legacy',
    status: trade.status,
    created_at: trade.created_at,
    resolved_at: trade.resolved_at,
    created_by_team_id: trade.proposing_team_id,
    trade_id: trade.id,
    participants: [
      { team_id: trade.proposing_team_id, decision_status: 'accepted' },
      {
        team_id: trade.receiving_team_id,
        decision_status: trade.status === 'pending' ? 'pending' : trade.status === 'accepted' ? 'accepted' : trade.status,
      },
    ],
    moves: (tradePlayers || [])
      .filter((entry) => entry.trade_id === trade.id)
      .map((entry) => ({
        id: `legacy-move-${entry.id}`,
        roster_id: null,
        character_name: entry.character_name,
        from_team_id: entry.from_team_id,
        to_team_id: entry.to_team_id,
      })),
  }))
}

function buildModernTradeSummary(proposals, proposalTeams, proposalMoves) {
  return (proposals || []).map((proposal) => ({
    id: `modern-${proposal.id}`,
    source: 'modern',
    status: proposal.status,
    created_at: proposal.created_at,
    resolved_at: proposal.resolved_at,
    created_by_team_id: proposal.created_by_team_id,
    created_by_player_id: proposal.created_by_player_id,
    proposal_id: proposal.id,
    participants: (proposalTeams || []).filter((entry) => entry.proposal_id === proposal.id),
    moves: (proposalMoves || []).filter((entry) => entry.proposal_id === proposal.id),
  }))
}

function isMissingSupabaseTable(error, tableNames) {
  const names = Array.isArray(tableNames) ? tableNames : [tableNames]
  const message = String(error?.message || '')
  return names.some((tableName) => (
    message.includes(`Could not find the table 'public.${tableName}' in the schema cache`)
    || message.includes(`relation "public.${tableName}" does not exist`)
    || message.includes(`table "public.${tableName}" does not exist`)
  ))
}

function isMissingSupabaseFunction(error, functionName) {
  const message = String(error?.message || '')
  return (
    error?.code === 'PGRST202'
    || message.includes(`Could not find the function public.${functionName}`)
    || message.includes(`function public.${functionName}`)
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

function RosterPlayerRow({ entry, actionLabel, onAction, onInfo, disabled = false }) {
  return (
    <div className="feed-row" style={{ alignItems: 'center' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <button type="button" onClick={onInfo} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
          <CharacterPortrait name={entry.character_name} size={38} />
        </button>
        <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
          <strong style={{ fontSize: 14 }}>{entry.character_name}</strong>
          <span className="muted" style={{ fontSize: 12 }}>Acquired via {formatSeasonLabel(entry.acquired_via || 'draft')}</span>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {onInfo ? <button className="ghost-button" onClick={onInfo} type="button">Info</button> : null}
        {onAction ? (
          <button className="ghost-button" onClick={() => onAction(entry)} type="button" disabled={disabled}>
            <ArrowRightLeft size={15} />
            <span>{actionLabel}</span>
          </button>
        ) : null}
      </div>
    </div>
  )
}

function TradeBuilderWorkspace({
  step,
  onBack,
  onReset,
  onAdvance,
  tradeDraft,
  setTradeDraft,
  seasonTeams,
  teamsById,
  playersById,
  identitiesByPlayerId,
  activeRosterByTeamId,
  myTeam,
  viewedTeamId,
  onSubmit,
  tradeDeadlinePassed,
}) {
  const participantTeamIds = tradeDraft.participantTeamIds || []
  const selectedRosterIds = useMemo(() => new Set((tradeDraft.assets || []).map((entry) => entry.rosterId)), [tradeDraft.assets])
  const [assetPicker, setAssetPicker] = useState(null)

  const getDefaultDestination = useCallback((fromTeamId) => {
    if (myTeam?.id && Number(fromTeamId) !== Number(myTeam.id)) return String(myTeam.id)
    const viewedCandidate = viewedTeamId && Number(viewedTeamId) !== Number(fromTeamId) ? String(viewedTeamId) : ''
    if (viewedCandidate) return viewedCandidate
    const fallback = participantTeamIds.find((teamId) => String(teamId) !== String(fromTeamId))
    return fallback ? String(fallback) : ''
  }, [myTeam?.id, participantTeamIds, viewedTeamId])

  const upsertAsset = useCallback((rosterEntry, destinationTeamId) => {
    setTradeDraft((current) => {
      const fromTeamId = String(rosterEntry.team_id)
      const nextAsset = {
        rosterId: rosterEntry.id,
        character_name: rosterEntry.character_name,
        from_team_id: fromTeamId,
        to_team_id: destinationTeamId ? String(destinationTeamId) : '',
      }
      const existing = current.assets.find((entry) => Number(entry.rosterId) === Number(rosterEntry.id))
      return {
        ...current,
        participantTeamIds: current.participantTeamIds.includes(fromTeamId)
          ? current.participantTeamIds
          : [...current.participantTeamIds, fromTeamId],
        assets: existing
          ? current.assets.map((entry) => entry.rosterId === rosterEntry.id ? nextAsset : entry)
          : [...current.assets, nextAsset],
      }
    })
  }, [setTradeDraft])

  const removeAsset = useCallback((rosterId) => {
    setTradeDraft((current) => ({
      ...current,
      assets: current.assets.filter((entry) => Number(entry.rosterId) !== Number(rosterId)),
    }))
  }, [setTradeDraft])

  const teamSummaries = useMemo(() => participantTeamIds.map((teamId) => {
    const outgoing = tradeDraft.assets.filter((entry) => String(entry.from_team_id) === String(teamId)).length
    const incoming = tradeDraft.assets.filter((entry) => String(entry.to_team_id) === String(teamId)).length
    const activeCount = activeRosterByTeamId[String(teamId)]?.length || 0
    const finalCount = activeCount - outgoing + incoming
    return {
      teamId: String(teamId),
      outgoing,
      incoming,
      finalCount,
      valid: finalCount === 9,
    }
  }), [activeRosterByTeamId, participantTeamIds, tradeDraft.assets])

  const unresolvedAssets = tradeDraft.assets.filter((entry) => !entry.to_team_id || String(entry.to_team_id) === String(entry.from_team_id))
  const invalidTeams = teamSummaries.filter((entry) => !entry.valid)
  const confirmReady = tradeDraft.assets.length > 0 && unresolvedAssets.length === 0 && invalidTeams.length === 0

  const stepTitle = step === 'teams'
    ? 'Choose Teams'
    : step === 'details'
      ? 'Build Trade Proposal'
      : 'Confirm Trade'
  const stepSubtitle = step === 'teams'
    ? ''
    : step === 'details'
      ? 'Select a character, review the owner, and choose where that player is being traded.'
      : 'Review every move before sending the trade request.'

  return (
    <section className="panel" style={{ padding: 18 }}>
      <div className="section-head">
        <div>
          <h2>{stepTitle}</h2>
          {stepSubtitle ? <span className="muted">{stepSubtitle}</span> : null}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {step !== 'teams' ? (
            <button className="ghost-button" onClick={onBack} type="button" disabled={tradeDeadlinePassed}>
              <ArrowLeft size={16} />
              <span>Back</span>
            </button>
          ) : null}
          <button className="ghost-button" onClick={onReset} type="button">
            <X size={16} />
            <span>Reset</span>
          </button>
        </div>
      </div>

      {step === 'teams' ? (
        <div className="page-stack" style={{ gap: 16 }}>
          <div className="summary-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
            {seasonTeams.map((team) => {
              const teamId = String(team.id)
              const selected = participantTeamIds.includes(teamId)
              const locked = String(team.id) === String(myTeam?.id)
              const playerRecord = playersById[team.player_id]
              const roster = activeRosterByTeamId[teamId] || []
              return (
                <button
                  key={team.id}
                  type="button"
                  onClick={() => {
                    if (locked || tradeDeadlinePassed) return
                    setTradeDraft((current) => ({
                      ...current,
                      participantTeamIds: current.participantTeamIds.includes(teamId)
                        ? current.participantTeamIds.filter((entry) => String(entry) !== teamId)
                        : [...current.participantTeamIds, teamId],
                      assets: current.participantTeamIds.includes(teamId)
                        ? current.assets.filter((entry) => String(entry.from_team_id) !== teamId && String(entry.to_team_id) !== teamId)
                        : current.assets,
                    }))
                  }}
                  disabled={tradeDeadlinePassed}
                  style={{
                    textAlign: 'left',
                    padding: 14,
                    borderRadius: 16,
                    border: `1px solid ${selected ? '#EAB308' : 'rgba(71,85,105,0.75)'}`,
                    background: selected ? 'rgba(234,179,8,0.12)' : 'rgba(15,23,42,0.55)',
                    display: 'grid',
                    gap: 12,
                    color: '#E2E8F0',
                    cursor: tradeDeadlinePassed ? 'default' : 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
                    <PlayerTag height={28} identitiesByPlayerId={identitiesByPlayerId} playerId={team.player_id} playersById={playersById} />
                    <span style={{ fontSize: 11, fontWeight: 800, color: selected ? '#FDE68A' : '#94A3B8' }}>
                      {locked ? 'Required' : selected ? 'Selected' : 'Add Team'}
                    </span>
                  </div>
                  <div style={{ display: 'grid', gap: 4 }}>
                    <strong>{getTeamShortName(team) || playerRecord?.name || 'Season Team'}</strong>
                    <span className="muted" style={{ fontSize: 12 }}>{roster.length} active players</span>
                  </div>
                  <div style={{ display: 'grid', gap: 6 }}>
                    {roster.slice(0, 9).map((entry) => (
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
            <span className="muted">
              {participantTeamIds.length} team{participantTeamIds.length === 1 ? '' : 's'} selected
            </span>
            <button className="solid-button" onClick={onAdvance} type="button" disabled={participantTeamIds.length < 2 || tradeDeadlinePassed}>
              <ArrowRightLeft size={16} />
              <span>Next: Build Trade</span>
            </button>
          </div>
        </div>
      ) : null}

      {step === 'details' ? (
        <div className="page-stack" style={{ gap: 16 }}>
          <section style={{ display: 'grid', gap: 12 }}>
            <div className="section-head">
              <div>
                <h3>Teams in Deal</h3>
                <span className="muted">{participantTeamIds.length} participating team{participantTeamIds.length === 1 ? '' : 's'}</span>
              </div>
            </div>

            <div className="summary-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
              {teamSummaries.map((entry) => {
                const team = teamsById[entry.teamId]
                const playerRecord = playersById[team?.player_id]
                return (
                  <div key={entry.teamId} style={{ padding: 12, borderRadius: 14, border: `1px solid ${entry.valid ? 'rgba(71,85,105,0.7)' : 'rgba(239,68,68,0.65)'}`, background: entry.valid ? 'rgba(15,23,42,0.6)' : 'rgba(127,29,29,0.2)', display: 'grid', gap: 10 }}>
                    <PlayerTag height={28} identitiesByPlayerId={identitiesByPlayerId} playerId={team?.player_id} playersById={playersById} />
                    <div className="summary-grid" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
                      <TeamCountCard label="Out" value={entry.outgoing} muted />
                      <TeamCountCard label="In" value={entry.incoming} muted />
                      <TeamCountCard label="Final" value={entry.finalCount} muted />
                    </div>
                    <span className="muted" style={{ fontSize: 12 }}>{getTeamShortName(team) || playerRecord?.name || 'Season Team'}</span>
                  </div>
                )
              })}
            </div>
          </section>

          <section style={{ display: 'grid', gap: 12 }}>
            <div className="section-head">
              <div>
                <h3>Select Players</h3>
                <span className="muted">Tap a player to open the trade popup and choose the destination team.</span>
              </div>
            </div>
            <div className="summary-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
              {participantTeamIds.map((teamId) => {
                const team = teamsById[teamId]
                const roster = activeRosterByTeamId[String(teamId)] || []
                return (
                  <div key={teamId} style={{ padding: 12, borderRadius: 14, border: '1px solid rgba(71,85,105,0.7)', background: 'rgba(15,23,42,0.55)', display: 'grid', gap: 10 }}>
                    <PlayerTag height={28} identitiesByPlayerId={identitiesByPlayerId} playerId={team?.player_id} playersById={playersById} />
                    <div className="feed-list" style={{ maxHeight: 280, overflowY: 'auto' }}>
                      {roster.map((entry) => {
                        const selected = selectedRosterIds.has(entry.id)
                        const selectedAsset = tradeDraft.assets.find((asset) => Number(asset.rosterId) === Number(entry.id))
                        const destinationName = selectedAsset?.to_team_id
                          ? playersById[teamsById[String(selectedAsset.to_team_id)]?.player_id]?.name || teamsById[String(selectedAsset.to_team_id)]?.team_name || 'Season Team'
                          : 'Choose destination'
                        return (
                          <button
                            key={entry.id}
                            type="button"
                            onClick={() => {
                              const destinationTeamId = selectedAsset?.to_team_id || getDefaultDestination(entry.team_id)
                              if (participantTeamIds.length === 2) {
                                if (selected) {
                                  removeAsset(entry.id)
                                } else {
                                  upsertAsset(entry, destinationTeamId)
                                }
                                return
                              }
                              setAssetPicker({ rosterEntry: entry, destinationTeamId })
                            }}
                            disabled={tradeDeadlinePassed}
                            style={{
                              display: 'flex',
                              alignItems: 'flex-start',
                              justifyContent: 'space-between',
                              gap: 8,
                              padding: 10,
                              borderRadius: 10,
                              border: `1px solid ${selected ? '#EAB308' : 'rgba(71,85,105,0.75)'}`,
                              background: selected ? 'rgba(234,179,8,0.14)' : 'rgba(30,41,59,0.6)',
                              color: '#E2E8F0',
                              cursor: tradeDeadlinePassed ? 'default' : 'pointer',
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                              <CharacterPortrait name={entry.character_name} size={34} />
                              <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                                <span style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{entry.character_name}</span>
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
            <div className="section-head">
              <div>
                <h3>Move Map</h3>
                <span className="muted">{tradeDraft.assets.length} player{tradeDraft.assets.length === 1 ? '' : 's'} selected</span>
              </div>
            </div>
            <div className="feed-list">
              {tradeDraft.assets.map((asset) => (
                <div className="feed-row" key={asset.rosterId} style={{ alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                    <CharacterPortrait name={asset.character_name} size={36} />
                    <div style={{ display: 'grid', gap: 2 }}>
                      <strong>{asset.character_name}</strong>
                      <span className="muted" style={{ fontSize: 12 }}>
                        {playersById[teamsById[String(asset.from_team_id)]?.player_id]?.name || teamsById[String(asset.from_team_id)]?.team_name || 'Team'}
                        {' '}to{' '}
                        {playersById[teamsById[String(asset.to_team_id)]?.player_id]?.name || teamsById[String(asset.to_team_id)]?.team_name || 'Unassigned'}
                      </span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button
                      className="ghost-button"
                      onClick={() => setAssetPicker({
                        rosterEntry: { id: asset.rosterId, team_id: asset.from_team_id, character_name: asset.character_name },
                        destinationTeamId: asset.to_team_id || '',
                      })}
                      type="button"
                      disabled={tradeDeadlinePassed}
                    >
                      Edit
                    </button>
                    <button className="ghost-button" onClick={() => removeAsset(asset.rosterId)} type="button" disabled={tradeDeadlinePassed}>
                      <X size={14} />
                    </button>
                  </div>
                </div>
              ))}
              {!tradeDraft.assets.length ? <span className="muted">No players selected yet.</span> : null}
            </div>
          </section>

          {unresolvedAssets.length || invalidTeams.length ? (
            <section style={{ display: 'grid', gap: 8 }}>
              {unresolvedAssets.length ? <span className="muted" style={{ color: '#FCA5A5' }}>Every selected player needs a destination before you can continue.</span> : null}
              {invalidTeams.map((entry) => (
                <span key={entry.teamId} className="muted" style={{ color: '#FCA5A5' }}>
                  {playersById[teamsById[entry.teamId]?.player_id]?.name || teamsById[entry.teamId]?.team_name || 'A team'} would finish with {entry.finalCount} active players.
                </span>
              ))}
            </section>
          ) : null}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
            <button className="solid-button" onClick={onAdvance} type="button" disabled={tradeDeadlinePassed || !confirmReady}>
              <ArrowRightLeft size={16} />
              <span>Next: Confirm Trade</span>
            </button>
          </div>
        </div>
      ) : null}

      {step === 'confirm' ? (
        <div className="page-stack" style={{ gap: 16 }}>
          <section style={{ display: 'grid', gap: 12 }}>
            <div className="section-head">
              <div>
                <h3>Trade Summary</h3>
                <span className="muted">{tradeDraft.assets.length} player{tradeDraft.assets.length === 1 ? '' : 's'} included</span>
              </div>
            </div>
            <div className="feed-list">
              {tradeDraft.assets.map((asset) => (
                <div className="feed-row" key={asset.rosterId} style={{ alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                    <CharacterPortrait name={asset.character_name} size={36} />
                    <div style={{ display: 'grid', gap: 2 }}>
                      <strong>{asset.character_name}</strong>
                      <span className="muted" style={{ fontSize: 12 }}>
                        {playersById[teamsById[String(asset.from_team_id)]?.player_id]?.name || teamsById[String(asset.from_team_id)]?.team_name || 'Team'}
                        {' '}to{' '}
                        {playersById[teamsById[String(asset.to_team_id)]?.player_id]?.name || teamsById[String(asset.to_team_id)]?.team_name || 'Team'}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section style={{ display: 'grid', gap: 12 }}>
            <div className="section-head">
              <div>
                <h3>Final Team Counts</h3>
                <span className="muted">Each team must finish with 9 active players for the request to be sent.</span>
              </div>
            </div>
            <div className="summary-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
              {teamSummaries.map((entry) => (
                <div key={entry.teamId} style={{ padding: 12, borderRadius: 14, border: `1px solid ${entry.valid ? 'rgba(71,85,105,0.7)' : 'rgba(239,68,68,0.65)'}`, background: entry.valid ? 'rgba(15,23,42,0.6)' : 'rgba(127,29,29,0.25)', display: 'grid', gap: 10 }}>
                  <PlayerTag height={28} identitiesByPlayerId={identitiesByPlayerId} playerId={teamsById[entry.teamId]?.player_id} playersById={playersById} />
                  <div className="summary-grid" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
                    <TeamCountCard label="Out" value={entry.outgoing} muted />
                    <TeamCountCard label="In" value={entry.incoming} muted />
                    <TeamCountCard label="Final" value={entry.finalCount} muted />
                  </div>
                </div>
              ))}
            </div>
          </section>

          {!confirmReady ? (
            <span className="muted" style={{ color: '#FCA5A5' }}>
              This trade cannot be sent until every selected player has a valid destination and every team finishes with 9 active players.
            </span>
          ) : null}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
            <button className="solid-button" onClick={onSubmit} type="button" disabled={tradeDeadlinePassed || !confirmReady}>
              <ArrowRightLeft size={16} />
              <span>Send Trade Request</span>
            </button>
          </div>
        </div>
      ) : null}

      {assetPicker ? (
        <div className="modal-backdrop" onClick={() => setAssetPicker(null)}>
          <div className="modal-card" style={{ width: 'min(420px, calc(100vw - 24px))' }} onClick={(event) => event.stopPropagation()}>
            <div className="section-head">
              <div>
                <h3>{assetPicker.rosterEntry.character_name}</h3>
                <span className="muted">
                  Owned by {playersById[teamsById[String(assetPicker.rosterEntry.team_id)]?.player_id]?.name || teamsById[String(assetPicker.rosterEntry.team_id)]?.team_name || 'Unknown owner'}
                </span>
              </div>
              <button className="ghost-button" onClick={() => setAssetPicker(null)} type="button">
                <X size={14} />
              </button>
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              <select
                value={String(assetPicker.destinationTeamId || '')}
                onChange={(event) => setAssetPicker((current) => ({ ...current, destinationTeamId: event.target.value }))}
              >
                <option value="">Choose destination team</option>
                {participantTeamIds
                  .filter((teamId) => String(teamId) !== String(assetPicker.rosterEntry.team_id))
                  .map((teamId) => (
                    <option key={teamId} value={teamId}>
                      {playersById[teamsById[String(teamId)]?.player_id]?.name || teamsById[String(teamId)]?.team_name || 'Season Team'}
                    </option>
                  ))}
              </select>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <button
                  className="ghost-button"
                  onClick={() => {
                    removeAsset(assetPicker.rosterEntry.id)
                    setAssetPicker(null)
                  }}
                  type="button"
                >
                  Remove From Trade
                </button>
                <button
                  className="solid-button"
                  onClick={() => {
                    upsertAsset(assetPicker.rosterEntry, assetPicker.destinationTeamId)
                    setAssetPicker(null)
                  }}
                  type="button"
                  disabled={!assetPicker.destinationTeamId}
                >
                  Save Selection
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}

export default function SeasonRoster() {
  const { player, is_logged_in, isScorekeeper } = useAuth()
  const { currentSeason, seasonTeams, standings, tradeDeadlinePassed, seasonPlayersById } = useSeason()
  const { pushToast } = useToast()
  const [players, setPlayers] = useState([])
  const [characters, setCharacters] = useState([])
  const [roster, setRoster] = useState([])
  const [waivers, setWaivers] = useState([])
  const [waiverClaims, setWaiverClaims] = useState([])
  const [legacyTrades, setLegacyTrades] = useState([])
  const [legacyTradePlayers, setLegacyTradePlayers] = useState([])
  const [tradeProposals, setTradeProposals] = useState([])
  const [tradeProposalTeams, setTradeProposalTeams] = useState([])
  const [tradeProposalMoves, setTradeProposalMoves] = useState([])
  const [supportsModernTradeSchema, setSupportsModernTradeSchema] = useState(true)
  const [activeTab, setActiveTab] = useState(TABS[0])
  const [viewedTeamId, setViewedTeamId] = useState('')
  const [tradeBuilderStep, setTradeBuilderStep] = useState('teams')
  const [tradeDraft, setTradeDraft] = useState({ participantTeamIds: [], assets: [] })
  const [pendingTradesOpen, setPendingTradesOpen] = useState(false)
  const [freeAgentSort, setFreeAgentSort] = useState({ key: 'name', direction: 'asc' })
  const [pickupModal, setPickupModal] = useState(null)
  const [pickupDropCharacter, setPickupDropCharacter] = useState('')
  const [fieldingPositions, setFieldingPositions] = useState({})
  const [lineupOrder, setLineupOrder] = useState([])
  const [selectedPlayer, setSelectedPlayer] = useState(null)
  const [cardCharacterId, setCardCharacterId] = useState(null)
  const [cardCharacterStats, setCardCharacterStats] = useState(null)
  const [selectedLineupMoveId, setSelectedLineupMoveId] = useState(null)
  const processingWaiversRef = useRef(false)
  const lastSyncedLineupRef = useRef(null)
  const lineupLoadKeyRef = useRef(null)

  const loadRosterData = useCallback(async () => {
    if (!currentSeason?.id) return
    const [
      playersResponse,
      charactersResponse,
      rosterResponse,
      waiversResponse,
      legacyTradesResponse,
      legacyTradePlayersResponse,
      modernTradesResponse,
      modernTradeTeamsResponse,
      modernTradeMovesResponse,
    ] = await Promise.all([
      supabase.from('players').select('*'),
      supabase.from('characters').select('*').order('name'),
      supabase.from('season_roster').select('*').eq('season_id', currentSeason.id).order('created_at'),
      supabase.from('season_waivers').select('*').eq('season_id', currentSeason.id).order('created_at', { ascending: false }),
      supabase.from('season_trades').select('*').eq('season_id', currentSeason.id).order('created_at', { ascending: false }),
      supabase.from('season_trade_players').select('*').order('id'),
      supabase.from('season_trade_proposals').select('*').eq('season_id', currentSeason.id).order('created_at', { ascending: false }),
      supabase.from('season_trade_proposal_teams').select('*').eq('season_id', currentSeason.id).order('created_at'),
      supabase.from('season_trade_proposal_moves').select('*').eq('season_id', currentSeason.id).order('created_at'),
    ])

    const modernTradeSchemaMissing = [
      modernTradesResponse.error,
      modernTradeTeamsResponse.error,
      modernTradeMovesResponse.error,
    ].some((error) => isMissingSupabaseTable(error, [
      'season_trade_proposals',
      'season_trade_proposal_teams',
      'season_trade_proposal_moves',
    ]))

    setSupportsModernTradeSchema(!modernTradeSchemaMissing)
    setPlayers(playersResponse.data || [])
    setCharacters(charactersResponse.data || [])
    setRoster(rosterResponse.data || [])
    setWaivers(waiversResponse.data || [])
    setWaiverClaims([])
    setLegacyTrades(legacyTradesResponse.data || [])
    setLegacyTradePlayers(legacyTradePlayersResponse.data || [])
    setTradeProposals(modernTradeSchemaMissing ? [] : (modernTradesResponse.data || []))
    setTradeProposalTeams(modernTradeSchemaMissing ? [] : (modernTradeTeamsResponse.data || []))
    setTradeProposalMoves(modernTradeSchemaMissing ? [] : (modernTradeMovesResponse.data || []))
  }, [currentSeason?.id])

  useEffect(() => {
    loadRosterData().catch(() => {})
  }, [loadRosterData])

  // Fetch full batting + pitching history across all seasons and tournaments for the opened character card
  useEffect(() => {
    if (!cardCharacterId) {
      setCardCharacterStats(null)
      return
    }
    const load = async () => {
      const [
        { data: seasonPas },
        { data: tournPas },
        { data: seasonStints },
        { data: tournStints },
        { data: tournGames },
        { data: tournaments },
        { data: seasons },
      ] = await Promise.all([
        supabase.from('season_plate_appearances').select('game_id,character_id,result,run_scored,rbi,season_id').eq('character_id', cardCharacterId),
        supabase.from('plate_appearances').select('game_id,character_id,result,run_scored,rbi').eq('character_id', cardCharacterId),
        supabase.from('season_pitching_stints').select('*').eq('character_id', cardCharacterId),
        supabase.from('pitching_stints').select('*').eq('character_id', cardCharacterId),
        supabase.from('games').select('id,tournament_id'),
        supabase.from('tournaments').select('id,tournament_number').order('tournament_number'),
        supabase.from('seasons').select('id,name,status,created_at').order('created_at'),
      ])

      const allSeasonPas = seasonPas || []
      const allTournPas = tournPas || []
      const allSeasonStints = seasonStints || []
      const allTournStints = tournStints || []
      const tournGameById = Object.fromEntries((tournGames || []).map(g => [g.id, g]))
      const tournById = Object.fromEntries((tournaments || []).map(t => [t.id, t]))
      const seasonById = Object.fromEntries((seasons || []).map(s => [s.id, s]))

      // Build per-season batting history
      const seasonPasBySeason = {}
      for (const pa of allSeasonPas) {
        const sid = pa.season_id
        if (!sid) continue
        if (!seasonPasBySeason[sid]) seasonPasBySeason[sid] = []
        seasonPasBySeason[sid].push(pa)
      }
      const seasonBattingHistory = Object.entries(seasonPasBySeason).map(([sid, pas]) => {
        const s = seasonById[sid]
        const b = summarizeBatting(pas)
        b.ops = b.obp + b.slg
        return { sourceId: `season-${sid}`, sourceLabel: s?.name || 'Season', sourceType: 'season', sortGroup: 1, sortValue: new Date(s?.created_at || 0).getTime(), rawPas: pas, ...b }
      }).sort((a, b) => a.sortValue - b.sortValue)

      // Build per-tournament batting history
      const tournPasByTournament = {}
      for (const pa of allTournPas) {
        const game = tournGameById[pa.game_id]
        if (!game) continue
        const tid = game.tournament_id
        if (!tournPasByTournament[tid]) tournPasByTournament[tid] = []
        tournPasByTournament[tid].push(pa)
      }
      const tournBattingHistory = Object.entries(tournPasByTournament).map(([tid, pas]) => {
        const t = tournById[tid]
        const b = summarizeBatting(pas)
        b.ops = b.obp + b.slg
        return { sourceId: `tournament-${tid}`, sourceLabel: `Tournament ${t?.tournament_number ?? '?'}`, sourceType: 'tournament', sortGroup: 0, sortValue: Number(t?.tournament_number || 0), rawPas: pas, ...b }
      }).sort((a, b) => a.sortValue - b.sortValue)

      // Build per-season pitching history
      const seasonStintsBySeason = {}
      for (const stint of allSeasonStints) {
        const sid = stint.season_id
        if (!sid) continue
        if (!seasonStintsBySeason[sid]) seasonStintsBySeason[sid] = []
        seasonStintsBySeason[sid].push(stint)
      }
      const seasonPitchingHistory = Object.entries(seasonStintsBySeason).map(([sid, stints]) => {
        const s = seasonById[sid]
        return { sourceId: `season-${sid}`, sourceLabel: s?.name || 'Season', sourceType: 'season', sortGroup: 1, sortValue: new Date(s?.created_at || 0).getTime(), rawStints: stints, ...summarizePitching(stints) }
      }).sort((a, b) => a.sortValue - b.sortValue)

      // Build per-tournament pitching history
      const tournStintsByTournament = {}
      for (const stint of allTournStints) {
        const game = tournGameById[stint.game_id]
        if (!game) continue
        const tid = game.tournament_id
        if (!tournStintsByTournament[tid]) tournStintsByTournament[tid] = []
        tournStintsByTournament[tid].push(stint)
      }
      const tournPitchingHistory = Object.entries(tournStintsByTournament).map(([tid, stints]) => {
        const t = tournById[tid]
        return { sourceId: `tournament-${tid}`, sourceLabel: `Tournament ${t?.tournament_number ?? '?'}`, sourceType: 'tournament', sortGroup: 0, sortValue: Number(t?.tournament_number || 0), rawStints: stints, ...summarizePitching(stints) }
      }).sort((a, b) => a.sortValue - b.sortValue)

      // Combine: tournaments first, then seasons (within each group, sorted by number/date)
      const battingHistory = [...tournBattingHistory, ...seasonBattingHistory]
      const pitchingHistory = [...tournPitchingHistory, ...seasonPitchingHistory]

      // Current season stats
      const currentSeasonPas = allSeasonPas.filter(pa => String(pa.season_id) === String(currentSeason?.id))
      const currentSeasonBatting = summarizeBatting(currentSeasonPas)
      currentSeasonBatting.ops = currentSeasonBatting.obp + currentSeasonBatting.slg
      currentSeasonBatting.rawPas = currentSeasonPas

      const currentSeasonStints = allSeasonStints.filter(s => String(s.season_id) === String(currentSeason?.id))
      const currentSeasonPitching = { ...summarizePitching(currentSeasonStints), rawStints: currentSeasonStints }

      // All-time stats
      const allPas = [...allTournPas, ...allSeasonPas]
      const allTimeBatting = summarizeBatting(allPas)
      allTimeBatting.ops = allTimeBatting.obp + allTimeBatting.slg
      allTimeBatting.rawPas = allPas

      const allStints = [...allTournStints, ...allSeasonStints]
      const allTimePitching = { ...summarizePitching(allStints), rawStints: allStints }

      setCardCharacterStats({ battingHistory, pitchingHistory, currentSeasonBatting, currentSeasonPitching, allTimeBatting, allTimePitching })
    }
    load()
  }, [cardCharacterId, currentSeason?.id])

  useEffect(() => {
    if (!currentSeason?.id) return undefined
    let channel = supabase
      .channel(`season-roster-${currentSeason.id}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_roster', filter: `season_id=eq.${currentSeason.id}` }, loadRosterData)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_waivers', filter: `season_id=eq.${currentSeason.id}` }, loadRosterData)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_trades', filter: `season_id=eq.${currentSeason.id}` }, loadRosterData)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_trade_players' }, loadRosterData)
    if (supportsModernTradeSchema) {
      channel = channel
        .on('postgres_changes', { event: '*', schema: 'public', table: 'season_trade_proposals', filter: `season_id=eq.${currentSeason.id}` }, loadRosterData)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'season_trade_proposal_teams', filter: `season_id=eq.${currentSeason.id}` }, loadRosterData)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'season_trade_proposal_moves', filter: `season_id=eq.${currentSeason.id}` }, loadRosterData)
    }
    channel = channel.subscribe()
    return () => supabase.removeChannel(channel)
  }, [currentSeason?.id, loadRosterData, supportsModernTradeSchema])

  const playersById = useMemo(() => Object.fromEntries(players.map((entry) => [entry.id, entry])), [players])
  const charactersById = useMemo(() => Object.fromEntries(characters.map((entry) => [entry.id, entry])), [characters])
  const charactersByName = useMemo(() => Object.fromEntries(characters.map((entry) => [entry.name, entry])), [characters])
  const teamsById = useMemo(() => Object.fromEntries(seasonTeams.map((entry) => [String(entry.id), entry])), [seasonTeams])
  const identitiesByPlayerId = useMemo(
    () => Object.fromEntries(seasonTeams.map((team) => [team.player_id, buildSeasonTeamIdentity(team)])),
    [seasonTeams],
  )
  const myTeam = useMemo(
    () => seasonTeams.find((entry) => String(entry.player_id) === String(player?.id)) || null,
    [seasonTeams, player?.id],
  )
  useEffect(() => {
    if (!myTeam?.id) return
    setTradeDraft((current) => (
      current.participantTeamIds.includes(String(myTeam.id))
        ? current
        : { ...current, participantTeamIds: [String(myTeam.id), ...current.participantTeamIds] }
    ))
  }, [myTeam?.id])

  const activeRoster = useMemo(() => roster.filter((entry) => entry.is_active !== false), [roster])
  const activeRosterByTeamId = useMemo(
    () => activeRoster.reduce((acc, entry) => {
      const key = String(entry.team_id)
      acc[key] = acc[key] || []
      acc[key].push(entry)
      return acc
    }, {}),
    [activeRoster],
  )
  const captainNameByTeamId = useMemo(
    () => roster.reduce((acc, entry) => {
      if (entry.acquired_via !== 'draft') return acc
      const key = String(entry.team_id)
      if (acc[key]) return acc
      acc[key] = entry.character_name
      return acc
    }, {}),
    [roster],
  )
  const characterOwnersByName = useMemo(
    () => Object.fromEntries(activeRoster.map((entry) => [entry.character_name, entry.team_id])),
    [activeRoster],
  )
  const viewedTeam = useMemo(() => teamsById[String(viewedTeamId)] || null, [teamsById, viewedTeamId])
  const viewedRoster = useMemo(() => activeRosterByTeamId[String(viewedTeamId)] || [], [activeRosterByTeamId, viewedTeamId])
  const viewedRosterCharacters = useMemo(
    () => viewedRoster.map((entry) => {
      const character = charactersByName[entry.character_name]
      if (!character) return null
      return {
        ...character,
        rosterId: entry.id,
        seasonRosterEntry: entry,
        displayName: character.name,
        chemistryName: character.name,
      }
    }).filter(Boolean),
    [charactersByName, viewedRoster],
  )
  const viewedRosterCharactersById = useMemo(
    () => Object.fromEntries(viewedRosterCharacters.map((entry) => [entry.id, entry])),
    [viewedRosterCharacters],
  )
  const viewedRosterCharactersByName = useMemo(
    () => Object.fromEntries(viewedRosterCharacters.map((entry) => [entry.name, entry])),
    [viewedRosterCharacters],
  )
  const rosterNames = useMemo(() => viewedRosterCharacters.map((entry) => entry.chemistryName || entry.name), [viewedRosterCharacters])
  const viewedPlayerId = viewedTeam?.player_id || null
  const isViewingOwnTeam = String(viewedTeam?.id || '') === String(myTeam?.id || '')
  const isCommissioner = Boolean(player?.is_commissioner)
  const canEditRoster = isViewingOwnTeam || isCommissioner || isScorekeeper
  // The Rosters tab always shows the currently-selected team (viewedTeam)
  const lineupTeam = viewedTeam || myTeam || null
  const lineupRoster = activeRosterByTeamId[String(lineupTeam?.id)] || []
  const lineupCharacters = useMemo(
    () => lineupRoster.map((entry) => {
      const character = charactersByName[entry.character_name]
      if (!character) return null
      return {
        ...character,
        rosterId: entry.id,
        seasonRosterEntry: entry,
        displayName: character.name,
        chemistryName: character.name,
      }
    }).filter(Boolean),
    [charactersByName, lineupRoster],
  )
  const lineupCharactersById = useMemo(
    () => Object.fromEntries(lineupCharacters.map((entry) => [entry.id, entry])),
    [lineupCharacters],
  )
  const positionByCharId = useMemo(
    () => Object.fromEntries(Object.entries(fieldingPositions).map(([posId, charId]) => [charId, posId])),
    [fieldingPositions],
  )
  const lineupChemistryCharacterId = selectedLineupMoveId || null
  const lineupChemistryHighlightIds = useMemo(
    () => buildChemistryHighlightSet(lineupChemistryCharacterId, lineupCharacters),
    [lineupChemistryCharacterId, lineupCharacters],
  )
  const fieldingChemistryCharacterId = selectedPlayer || null
  const fieldingChemistryHighlightIds = useMemo(
    () => buildChemistryHighlightSet(fieldingChemistryCharacterId, lineupCharacters),
    [fieldingChemistryCharacterId, lineupCharacters],
  )
  const activeCharacterNames = useMemo(() => new Set(activeRoster.map((entry) => entry.character_name)), [activeRoster])
  const reverseStandings = useMemo(() => [...standings].reverse(), [standings])
  const waiverClaimsByWaiverId = useMemo(
    () => waiverClaims.reduce((acc, entry) => {
      const key = String(entry.waiver_id)
      acc[key] = acc[key] || []
      acc[key].push(entry)
      return acc
    }, {}),
    [waiverClaims],
  )
  const activeWaiverEntries = useMemo(
    () => waivers.filter((entry) => entry.status === 'active'),
    [waivers],
  )
  const activeWaiverCharacterNames = useMemo(
    () => new Set(activeWaiverEntries.map((entry) => entry.claiming_character)),
    [activeWaiverEntries],
  )
  const freeAgentCharacters = useMemo(
    () => characters.filter((entry) => !activeCharacterNames.has(entry.name) && !activeWaiverCharacterNames.has(entry.name)),
    [characters, activeCharacterNames, activeWaiverCharacterNames],
  )
  const availablePlayerRows = useMemo(() => {
    const freeAgentRows = freeAgentCharacters.map((character) => ({
      id: `free-agent-${character.id}`,
      type: 'free_agent',
      character,
      analysis: analyzeCharacterTalent(character),
    }))

    const waiverRows = activeWaiverEntries
      .map((waiver) => {
        const character = charactersByName[waiver.claiming_character]
        if (!character) return null
        const claims = sortWaiverClaims((waiverClaimsByWaiverId[String(waiver.id)] || []).filter((entry) => entry.status === 'pending'))
        const claimTeamIds = new Set(claims.map((entry) => String(entry.claiming_team_id)))
        const clockTeamId = getWaiverClockTeamId(waiver, reverseStandings)
        return {
          id: `waiver-${waiver.id}`,
          type: 'waiver',
          waiver,
          character,
          analysis: analyzeCharacterTalent(character),
          claims,
          claimCount: claims.length,
          claimTeamIds,
          clockTeamId,
          myClaim: claims.find((entry) => String(entry.claiming_team_id) === String(myTeam?.id || '')) || null,
          canDeny: Boolean(myTeam?.id) && String(clockTeamId) === String(myTeam.id),
          canClaim: Boolean(myTeam?.id) && !claimTeamIds.has(String(myTeam.id)),
        }
      })
      .filter(Boolean)

    return [...waiverRows, ...freeAgentRows].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'waiver' ? -1 : 1
      return a.character.name.localeCompare(b.character.name)
    })
  }, [activeWaiverEntries, charactersByName, freeAgentCharacters, myTeam?.id, reverseStandings, waiverClaimsByWaiverId])
  const sortedAvailablePlayerRows = useMemo(() => {
    const getStatValue = (row, key) => {
      if (key === 'name') return row.character.name
      const raw = key === 'pitching'
        ? row.analysis?.displayRatings?.pitching
        : key === 'batting'
          ? row.analysis?.displayRatings?.batting
          : key === 'fielding'
            ? row.analysis?.displayRatings?.fielding
            : key === 'speed'
              ? row.analysis?.displayRatings?.speed
              : row.analysis?.displayRatings?.overall
      return Number(raw ?? -1)
    }

    return [...availablePlayerRows].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'waiver' ? -1 : 1
      const aValue = getStatValue(a, freeAgentSort.key)
      const bValue = getStatValue(b, freeAgentSort.key)
      if (typeof aValue === 'string' && typeof bValue === 'string') {
        const result = aValue.localeCompare(bValue)
        return freeAgentSort.direction === 'asc' ? result : -result
      }
      if (aValue !== bValue) {
        return freeAgentSort.direction === 'asc' ? aValue - bValue : bValue - aValue
      }
      return a.character.name.localeCompare(b.character.name)
    })
  }, [availablePlayerRows, freeAgentSort])
  const combinedTrades = useMemo(
    () => sortNewestFirst([
      ...buildModernTradeSummary(tradeProposals, tradeProposalTeams, tradeProposalMoves),
      ...buildLegacyTradeSummary(legacyTrades, legacyTradePlayers),
    ]),
    [legacyTradePlayers, legacyTrades, tradeProposalMoves, tradeProposalTeams, tradeProposals],
  )

  useEffect(() => {
    if (!seasonTeams.length) {
      setViewedTeamId('')
      return
    }
    if (myTeam?.id && !viewedTeamId) {
      setViewedTeamId(String(myTeam.id))
      return
    }
    const stillExists = seasonTeams.some((entry) => String(entry.id) === String(viewedTeamId))
    if (!stillExists) {
      setViewedTeamId(String(myTeam?.id || seasonTeams[0]?.id || ''))
    }
  }, [myTeam?.id, seasonTeams, viewedTeamId])

  // Load saved lineup order + fielding positions from the database when the
  // viewed team's roster changes, falling back to roster order / first-9 fielding.
  useEffect(() => {
    if (!viewedRosterCharacters.length || !currentSeason?.id || !viewedPlayerId) {
      setFieldingPositions({})
      setLineupOrder([])
      setSelectedPlayer(null)
      setCardCharacterId(null)
      setSelectedLineupMoveId(null)
      lastSyncedLineupRef.current = null
      lineupLoadKeyRef.current = null
      return
    }

    const defaultLineup = viewedRosterCharacters.map((entry) => entry.id)
    const allowedIds = new Set(defaultLineup)
    const loadKey = `${currentSeason.id}-${viewedPlayerId}`

    let cancelled = false
    fetchTeamLineup({ ...SEASON_TEAM_LINEUPS, sourceId: currentSeason.id, playerId: viewedPlayerId }).then((saved) => {
      if (cancelled) return

      let lineupOrderResult = defaultLineup
      if (saved && Array.isArray(saved.lineupOrder) && saved.lineupOrder.length) {
        const ordered = saved.lineupOrder.filter((id) => allowedIds.has(id))
        const remaining = defaultLineup.filter((id) => !ordered.includes(id))
        lineupOrderResult = [...ordered, ...remaining]
      }

      // Load saved positions, strip out removed characters, then auto-fill any new ones
      let savedPositions = {}
      if (saved && saved.fieldingPositions && Object.keys(saved.fieldingPositions).length) {
        savedPositions = Object.fromEntries(
          Object.entries(saved.fieldingPositions).filter(([, value]) => allowedIds.has(value)),
        )
      }
      const placedIds = new Set(Object.values(savedPositions))
      const unplaced = defaultLineup.filter((id) => !placedIds.has(id))
      const emptyPositions = FIELD_POSITIONS.filter((pos) => !savedPositions[pos.id])
      unplaced.forEach((id, i) => {
        if (emptyPositions[i]) savedPositions[emptyPositions[i].id] = id
      })

      lastSyncedLineupRef.current = JSON.stringify({ lineupOrder: lineupOrderResult, fieldingPositions: savedPositions })
      lineupLoadKeyRef.current = loadKey
      setLineupOrder(lineupOrderResult)
      setFieldingPositions(savedPositions)
    })

    return () => { cancelled = true }
  }, [currentSeason?.id, viewedPlayerId, viewedRosterCharacters])

  // Autosave lineup order + fielding positions to the database (debounced),
  // so every viewer of this team's roster sees edits in real time.
  useEffect(() => {
    if (!currentSeason?.id || !viewedPlayerId) return
    if (!canEditRoster) return
    if (lineupLoadKeyRef.current !== `${currentSeason.id}-${viewedPlayerId}`) return
    if (!lineupOrder.length && !Object.keys(fieldingPositions).length) return

    const payload = JSON.stringify({ lineupOrder, fieldingPositions })
    if (payload === lastSyncedLineupRef.current) return

    const timeout = setTimeout(() => {
      lastSyncedLineupRef.current = payload
      upsertTeamLineup({
        ...SEASON_TEAM_LINEUPS,
        sourceId: currentSeason.id,
        playerId: viewedPlayerId,
        lineupOrder,
        fieldingPositions,
      })
    }, 500)

    return () => clearTimeout(timeout)
  }, [currentSeason?.id, viewedPlayerId, lineupOrder, fieldingPositions, canEditRoster])

  // Realtime: pick up lineup/fielding edits made by anyone else (or from
  // another device) for the currently viewed team.
  useEffect(() => {
    if (!currentSeason?.id || !viewedPlayerId) return
    const channel = supabase
      .channel(`season-team-lineup-${currentSeason.id}-${viewedPlayerId}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'season_team_lineups',
        filter: `season_id=eq.${currentSeason.id}`,
      }, (payload) => {
        const row = payload.new
        if (!row || String(row.player_id) !== String(viewedPlayerId)) return
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
      fetchTeamLineup({ ...SEASON_TEAM_LINEUPS, sourceId: currentSeason.id, playerId: viewedPlayerId }).then((saved) => {
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
  }, [currentSeason?.id, viewedPlayerId])

  const handleDragStartRoster = (characterId) => (event) => {
    if (!canEditRoster) return
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('characterId', String(characterId))
  }

  const handleDragStartLineup = (characterId) => (event) => {
    if (!canEditRoster) return
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('lineupCharacterId', String(characterId))
  }

  const handleDropOnLineup = (index) => (event) => {
    if (!canEditRoster) return
    event.preventDefault()
    const characterId = parseInt(event.dataTransfer.getData('lineupCharacterId'), 10)
    if (!characterId) return
    setLineupOrder((current) => swapLineupSlot(current, characterId, index))
  }

  const moveInLineup = useCallback((index, direction) => {
    if (!canEditRoster) return
    const targetIndex = index + direction
    setLineupOrder((current) => {
      if (targetIndex < 0 || targetIndex >= current.length) return current
      const next = [...current]
      ;[next[index], next[targetIndex]] = [next[targetIndex], next[index]]
      return next
    })
  }, [canEditRoster])

  const handleLineupNumberClick = useCallback((characterId, targetIndex) => {
    if (!canEditRoster) return
    setSelectedLineupMoveId((current) => {
      if (!current) return characterId
      if (current === characterId) return null
      setLineupOrder((lineup) => swapLineupSlot(lineup, current, targetIndex))
      return null
    })
  }, [canEditRoster])

  const closeTradeBuilder = useCallback(() => {
    setTradeDraft({ participantTeamIds: myTeam?.id ? [String(myTeam.id)] : [], assets: [] })
    setTradeBuilderStep('teams')
  }, [myTeam?.id])

  const toggleFreeAgentSort = useCallback((key) => {
    setFreeAgentSort((current) => (
      current.key === key
        ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: key === 'name' ? 'asc' : 'desc' }
    ))
  }, [])

  const closePickupModal = useCallback(() => {
    setPickupModal(null)
    setPickupDropCharacter('')
  }, [])

  const createDroppedPlayerWaiver = useCallback(async (characterName, sourceTeamId) => {
    const { error } = await supabase.from('season_waivers').insert({
      season_id: currentSeason.id,
      claiming_character: characterName,
      source_team_id: sourceTeamId,
      status: 'active',
      denied_team_ids: [],
      expires_at: buildWaiverExpiryDate(),
    })
    if (error) throw error
  }, [currentSeason?.id])

  const processWaivers = useCallback(async (waiverRows = waivers, claimRows = waiverClaims) => {
    if (!currentSeason?.id || processingWaiversRef.current) return

    processingWaiversRef.current = true
    let mutated = false
    const now = new Date()
    const nowIso = now.toISOString()

    try {
      for (const waiver of waiverRows.filter((entry) => entry.status === 'active')) {
        const pendingClaims = sortWaiverClaims((claimRows || []).filter((entry) => entry.waiver_id === waiver.id && entry.status === 'pending'))
        const clockTeamId = getWaiverClockTeamId(waiver, reverseStandings)
        const awardClaim = pendingClaims.find((entry) => String(entry.claiming_team_id) === String(clockTeamId))
        const isExpired = waiver.expires_at ? new Date(waiver.expires_at) <= now : false

        const finalizeAward = async (winningClaim, winningStatus = 'approved') => {
          const winnerRoster = activeRosterByTeamId[String(winningClaim.claiming_team_id)] || []
          const dropRow = winnerRoster.find((entry) => entry.character_name === winningClaim.dropping_character)

          if (!dropRow) {
            await supabase.from('season_waiver_claims').update({ status: 'denied', resolved_at: nowIso }).eq('id', winningClaim.id)
            mutated = true
            return
          }

          const { error: deactivateError } = await supabase.from('season_roster').update({ is_active: false }).eq('id', dropRow.id)
          if (deactivateError) throw deactivateError

          const { error: addError } = await supabase.from('season_roster').insert({
            season_id: currentSeason.id,
            team_id: winningClaim.claiming_team_id,
            character_name: waiver.claiming_character,
            acquired_via: 'waiver',
            is_active: true,
          })
          if (addError) throw addError

          const otherClaimIds = pendingClaims.filter((entry) => entry.id !== winningClaim.id).map((entry) => entry.id)
          if (otherClaimIds.length) {
            const { error: rejectError } = await supabase.from('season_waiver_claims').update({ status: 'denied', resolved_at: nowIso }).in('id', otherClaimIds)
            if (rejectError) throw rejectError
          }

          const { error: approveError } = await supabase.from('season_waiver_claims').update({ status: winningStatus, resolved_at: nowIso }).eq('id', winningClaim.id)
          if (approveError) throw approveError

          const { error: waiverError } = await supabase.from('season_waivers').update({
            status: 'claimed',
            awarded_to_team_id: winningClaim.claiming_team_id,
            resolved_at: nowIso,
          }).eq('id', waiver.id)
          if (waiverError) throw waiverError

          try {
            await createDroppedPlayerWaiver(winningClaim.dropping_character, winningClaim.claiming_team_id)
          } catch (error) {
            throw error
          }

          mutated = true
        }

        if (isExpired) {
          if (pendingClaims.length) {
            await finalizeAward(pendingClaims[0], 'expired_award')
          } else {
            const { error } = await supabase.from('season_waivers').update({ status: 'free_agent', resolved_at: nowIso }).eq('id', waiver.id)
            if (error) throw error
            mutated = true
          }
          continue
        }

        if (awardClaim) {
          await finalizeAward(awardClaim)
          continue
        }

        if (!clockTeamId && !pendingClaims.length) {
          const { error } = await supabase.from('season_waivers').update({ status: 'free_agent', resolved_at: nowIso }).eq('id', waiver.id)
          if (error) throw error
          mutated = true
        }
      }
    } finally {
      processingWaiversRef.current = false
    }

    if (mutated) {
      loadRosterData().catch(() => {})
    }
  }, [activeRosterByTeamId, createDroppedPlayerWaiver, currentSeason?.id, loadRosterData, reverseStandings, waiverClaims, waivers])

  const submitLegacyTradeProposal = useCallback(async (participantTeamIds) => {
    const normalizedParticipantTeamIds = Array.from(new Set((participantTeamIds || []).map(String).filter(Boolean)))

    if (!normalizedParticipantTeamIds.includes(String(myTeam?.id || '')) || normalizedParticipantTeamIds.length !== 2) {
      pushToast({
        title: 'Trade schema unavailable',
        message: normalizedParticipantTeamIds.length > 2
          ? 'This database only supports two-team trades. Apply the multi-team trade migration to use larger deals.'
          : 'This database only supports direct trades between two teams.',
        type: 'error',
      })
      return false
    }

    const counterpartTeamId = normalizedParticipantTeamIds.find((teamId) => String(teamId) !== String(myTeam.id))
    if (!counterpartTeamId) {
      pushToast({ title: 'Trade needs two teams', message: 'Add one other team to the deal.', type: 'error' })
      return false
    }

    const { data: trade, error: tradeError } = await supabase.from('season_trades').insert({
      season_id: currentSeason.id,
      proposing_team_id: myTeam.id,
      receiving_team_id: Number(counterpartTeamId),
      status: 'pending',
    }).select().single()

    if (tradeError) {
      pushToast({ title: 'Trade failed', message: tradeError.message, type: 'error' })
      return false
    }

    const movePayload = tradeDraft.assets.map((entry) => ({
      trade_id: trade.id,
      character_name: entry.character_name,
      from_team_id: Number(entry.from_team_id),
      to_team_id: Number(entry.to_team_id),
    }))

    const { error: moveError } = await supabase.from('season_trade_players').insert(movePayload)
    if (moveError) {
      await supabase.from('season_trades').delete().eq('id', trade.id)
      pushToast({ title: 'Trade detail failed', message: moveError.message, type: 'error' })
      return false
    }

    pushToast({ title: 'Trade proposed', message: 'The other team can now review the proposal.', type: 'success' })
    closeTradeBuilder()
    loadRosterData().catch(() => {})
    return true
  }, [closeTradeBuilder, currentSeason?.id, loadRosterData, myTeam?.id, pushToast, tradeDraft.assets])

  const submitTradeProposal = async () => {
    if (!currentSeason?.id || !myTeam?.id) {
      pushToast({ title: 'Trade unavailable', message: 'Join a season team first.', type: 'error' })
      return
    }
    if (tradeDeadlinePassed) {
      pushToast({ title: 'Trade deadline passed', message: 'Trades are closed for this season.', type: 'error' })
      return
    }
    if (tradeDraft.assets.length === 0) {
      pushToast({ title: 'No players selected', message: 'Add players to the proposal first.', type: 'error' })
      return
    }

    const unresolvedAssets = tradeDraft.assets.filter((entry) => !entry.to_team_id || String(entry.to_team_id) === String(entry.from_team_id))
    if (unresolvedAssets.length) {
      pushToast({ title: 'Missing destinations', message: 'Every selected player needs a valid destination team.', type: 'error' })
      return
    }

    const participantTeamIds = Array.from(new Set([
      ...tradeDraft.participantTeamIds.map(String),
      ...tradeDraft.assets.map((entry) => String(entry.from_team_id)),
      ...tradeDraft.assets.map((entry) => String(entry.to_team_id)),
    ]))

    if (participantTeamIds.length < 2) {
      pushToast({ title: 'Trade needs two teams', message: 'Add at least one other team to the deal.', type: 'error' })
      return
    }

    const invalidTeam = participantTeamIds.find((teamId) => {
      const outgoing = tradeDraft.assets.filter((entry) => String(entry.from_team_id) === String(teamId)).length
      const incoming = tradeDraft.assets.filter((entry) => String(entry.to_team_id) === String(teamId)).length
      const activeCount = activeRosterByTeamId[String(teamId)]?.length || 0
      return activeCount - outgoing + incoming !== 9
    })

    if (invalidTeam) {
      const team = teamsById[String(invalidTeam)]
      pushToast({
        title: 'Roster count mismatch',
        message: `${getTeamShortName(team) || playersById[team?.player_id]?.name || 'A team'} would not finish with 9 active players.`,
        type: 'error',
      })
      return
    }

    if (!supportsModernTradeSchema) {
      await submitLegacyTradeProposal(participantTeamIds)
      return
    }

    const movePayload = tradeDraft.assets.map((entry) => ({
      roster_id: entry.rosterId,
      from_team_id: Number(entry.from_team_id),
      to_team_id: Number(entry.to_team_id),
    }))

    const { error: rpcError } = await supabase.rpc('create_season_trade_proposal', {
      p_season_id: currentSeason.id,
      p_created_by_team_id: myTeam.id,
      p_participant_team_ids: participantTeamIds.map((teamId) => Number(teamId)),
      p_moves: movePayload,
    })

    if (!rpcError) {
      pushToast({ title: 'Trade proposed', message: 'The other teams can now review the proposal.', type: 'success' })
      closeTradeBuilder()
      loadRosterData().catch(() => {})
      return
    }

    if (!isMissingSupabaseFunction(rpcError, 'create_season_trade_proposal')) {
      if (isMissingSupabaseTable(rpcError, 'season_trade_proposals')) {
        setSupportsModernTradeSchema(false)
        await submitLegacyTradeProposal(participantTeamIds)
        return
      }
      pushToast({ title: 'Trade failed', message: rpcError.message, type: 'error' })
      return
    }

    const { data: proposal, error: proposalError } = await supabase.from('season_trade_proposals').insert({
      season_id: currentSeason.id,
      created_by_player_id: player?.id,
      created_by_team_id: myTeam.id,
      status: 'pending',
    }).select().single()

    if (proposalError) {
      if (isMissingSupabaseTable(proposalError, 'season_trade_proposals')) {
        setSupportsModernTradeSchema(false)
        await submitLegacyTradeProposal(participantTeamIds)
        return
      }
      pushToast({ title: 'Trade failed', message: proposalError.message, type: 'error' })
      return
    }

    const participantPayload = participantTeamIds.map((teamId) => ({
      season_id: currentSeason.id,
      proposal_id: proposal.id,
      team_id: Number(teamId),
      decision_status: String(teamId) === String(myTeam.id) ? 'accepted' : 'pending',
      decided_at: String(teamId) === String(myTeam.id) ? new Date().toISOString() : null,
    }))

    const legacyMovePayload = tradeDraft.assets.map((entry) => ({
      season_id: currentSeason.id,
      proposal_id: proposal.id,
      roster_id: entry.rosterId,
      character_name: entry.character_name,
      from_team_id: Number(entry.from_team_id),
      to_team_id: Number(entry.to_team_id),
    }))

    const [{ error: participantError }, { error: moveError }] = await Promise.all([
      supabase.from('season_trade_proposal_teams').insert(participantPayload),
      supabase.from('season_trade_proposal_moves').insert(legacyMovePayload),
    ])

    if (participantError || moveError) {
      if (
        isMissingSupabaseTable(participantError, 'season_trade_proposal_teams')
        || isMissingSupabaseTable(moveError, 'season_trade_proposal_moves')
      ) {
        setSupportsModernTradeSchema(false)
        await supabase.from('season_trade_proposals').delete().eq('id', proposal.id)
        await submitLegacyTradeProposal(participantTeamIds)
        return
      }
      pushToast({ title: 'Trade detail failed', message: participantError?.message || moveError?.message, type: 'error' })
      return
    }

    pushToast({ title: 'Trade proposed', message: 'The other teams can now review the proposal.', type: 'success' })
    closeTradeBuilder()
    loadRosterData().catch(() => {})
  }

  const resolveLegacyTrade = async (trade, status) => {
    if (!trade) return
    if (status === 'accepted') {
      const scopedPlayers = legacyTradePlayers.filter((entry) => entry.trade_id === trade.trade_id)
      await Promise.all(scopedPlayers.map((entry) => (
        supabase
          .from('season_roster')
          .update({ team_id: entry.to_team_id, acquired_via: 'trade' })
          .eq('season_id', currentSeason.id)
          .eq('team_id', entry.from_team_id)
          .eq('character_name', entry.character_name)
          .eq('is_active', true)
      )))
    }
    const { error } = await supabase.from('season_trades').update({ status, resolved_at: new Date().toISOString() }).eq('id', trade.trade_id)
    if (error) {
      pushToast({ title: 'Trade update failed', message: error.message, type: 'error' })
      return
    }
    pushToast({ title: `Trade ${status}`, type: 'success' })
    window.dispatchEvent(new Event('season-trades-updated'))
    loadRosterData().catch(() => {})
  }

  const resolveModernTrade = async (trade, status) => {
    if (!trade || !myTeam?.id) return
    const now = new Date().toISOString()

    if (status === 'rejected' || status === 'cancelled') {
      const participantRows = trade.participants.filter((entry) => String(entry.team_id) === String(myTeam.id))
      if (participantRows.length) {
        await supabase.from('season_trade_proposal_teams').update({ decision_status: status, decided_at: now }).eq('proposal_id', trade.proposal_id).eq('team_id', myTeam.id)
      }
      const { error } = await supabase.from('season_trade_proposals').update({ status, resolved_at: now }).eq('id', trade.proposal_id)
      if (error) {
        pushToast({ title: 'Trade update failed', message: error.message, type: 'error' })
        return
      }
      pushToast({ title: `Trade ${status}`, type: 'success' })
      window.dispatchEvent(new Event('season-trades-updated'))
      loadRosterData().catch(() => {})
      return
    }

    const { error: decisionError } = await supabase
      .from('season_trade_proposal_teams')
      .update({ decision_status: 'accepted', decided_at: now })
      .eq('proposal_id', trade.proposal_id)
      .eq('team_id', myTeam.id)

    if (decisionError) {
      pushToast({ title: 'Trade update failed', message: decisionError.message, type: 'error' })
      return
    }

    const nextParticipants = trade.participants.map((entry) => (
      String(entry.team_id) === String(myTeam.id)
        ? { ...entry, decision_status: 'accepted', decided_at: now }
        : entry
    ))
    const allAccepted = nextParticipants.every((entry) => entry.decision_status === 'accepted')

    if (!allAccepted) {
      pushToast({ title: 'Trade approved', message: 'Waiting on the remaining teams.', type: 'success' })
      window.dispatchEvent(new Event('season-trades-updated'))
      loadRosterData().catch(() => {})
      return
    }

    await Promise.all(trade.moves.map((move) => (
      supabase
        .from('season_roster')
        .update({ team_id: move.to_team_id, acquired_via: 'trade' })
        .eq('id', move.roster_id)
    )))

    const { error } = await supabase.from('season_trade_proposals').update({ status: 'accepted', resolved_at: now }).eq('id', trade.proposal_id)
    if (error) {
      pushToast({ title: 'Trade finalize failed', message: error.message, type: 'error' })
      return
    }
    pushToast({ title: 'Trade completed', message: 'All teams accepted and the rosters were updated.', type: 'success' })
    window.dispatchEvent(new Event('season-trades-updated'))
    loadRosterData().catch(() => {})
  }

  const resolveTrade = (trade, status) => {
    if (trade.source === 'legacy') {
      return resolveLegacyTrade(trade, status)
    }
    return resolveModernTrade(trade, status)
  }

  const submitPickup = async () => {
    if (!pickupModal || !myTeam?.id || !pickupDropCharacter) {
      pushToast({ title: 'Pickup incomplete', message: 'Choose a player to drop first.', type: 'error' })
      return
    }

    const myRoster = activeRosterByTeamId[String(myTeam.id)] || []
    if (myRoster.length !== 9) {
      pushToast({ title: 'Roster must stay at 9', message: 'Your team must have exactly 9 active players before making a pickup.', type: 'error' })
      return
    }

    const dropRow = myRoster.find((entry) => entry.character_name === pickupDropCharacter)
    if (!dropRow) {
      pushToast({ title: 'Drop target missing', message: 'That player is no longer on your active roster.', type: 'error' })
      return
    }

    const myCaptainName = captainNameByTeamId[String(myTeam.id)]
    if (myCaptainName && dropRow.character_name === myCaptainName) {
      pushToast({ title: 'Cannot drop captain', message: 'Your team captain cannot be dropped to free agency or waivers.', type: 'error' })
      return
    }

    if (pickupModal.type === 'free_agent') {
      const { error: addError } = await supabase.from('season_roster').insert({
        season_id: currentSeason.id,
        team_id: myTeam.id,
        character_name: pickupModal.characterName,
        acquired_via: 'free_agent',
        is_active: true,
      })
      if (addError) {
        pushToast({ title: 'Pickup failed', message: addError.message, type: 'error' })
        return
      }

      const { error: deactivateError } = await supabase.from('season_roster').update({ is_active: false }).eq('id', dropRow.id)
      if (deactivateError) {
        pushToast({ title: 'Drop failed', message: deactivateError.message, type: 'error' })
        return
      }

      try {
        await createDroppedPlayerWaiver(dropRow.character_name, myTeam.id)
      } catch (error) {
        pushToast({ title: 'Waiver creation failed', message: error.message, type: 'error' })
        return
      }

      pushToast({ title: 'Free agent added', message: `${pickupModal.characterName} joined your roster and ${dropRow.character_name} is now on waivers.`, type: 'success' })
      closePickupModal()
      loadRosterData().catch(() => {})
      return
    }

    if (!SUPPORTS_WAIVER_CLAIMS_SCHEMA) {
      pushToast({
        title: 'Waiver claims unavailable',
        message: 'This database does not have the waiver claims table yet, so roster-page claims are disabled for now.',
        type: 'error',
      })
      return
    }

    const priority = reverseStandings.findIndex((entry) => String(entry.id) === String(myTeam.id)) + 1 || reverseStandings.length
    const { error } = await supabase.from('season_waiver_claims').upsert({
      waiver_id: pickupModal.waiverId,
      season_id: currentSeason.id,
      claiming_team_id: myTeam.id,
      dropping_character: pickupDropCharacter,
      priority_order: priority,
      status: 'pending',
      resolved_at: null,
    }, { onConflict: 'waiver_id,claiming_team_id' })

    if (error) {
      pushToast({ title: 'Waiver claim failed', message: error.message, type: 'error' })
      return
    }

    pushToast({ title: 'Waiver claim submitted', message: 'Your claim is in place if the priority line reaches you.', type: 'success' })
    closePickupModal()
    const nextClaims = waiverClaims
      .filter((entry) => !(entry.waiver_id === pickupModal.waiverId && String(entry.claiming_team_id) === String(myTeam.id)))
      .concat([{
        waiver_id: pickupModal.waiverId,
        season_id: currentSeason.id,
        claiming_team_id: myTeam.id,
        dropping_character: pickupDropCharacter,
        priority_order: priority,
        status: 'pending',
        created_at: new Date().toISOString(),
      }])
    await processWaivers(waivers, nextClaims)
    loadRosterData().catch(() => {})
  }

  const denyWaiver = async (waiver) => {
    if (!myTeam?.id) return
    const currentClockTeamId = getWaiverClockTeamId(waiver, reverseStandings)
    if (String(currentClockTeamId) !== String(myTeam.id)) {
      pushToast({ title: 'Cannot deny yet', message: 'Only the current priority team can deny this waiver.', type: 'error' })
      return
    }

    const deniedTeamIds = Array.from(new Set([...(waiver.denied_team_ids || []).map(Number), Number(myTeam.id)]))
    const { error } = await supabase.from('season_waivers').update({ denied_team_ids: deniedTeamIds }).eq('id', waiver.id)
    if (error) {
      pushToast({ title: 'Waiver update failed', message: error.message, type: 'error' })
      return
    }

    pushToast({ title: 'Waiver denied', message: `${waiver.claiming_character} moved to the next waiver priority.`, type: 'success' })
    const nextWaivers = waivers.map((entry) => entry.id === waiver.id ? { ...entry, denied_team_ids: deniedTeamIds } : entry)
    await processWaivers(nextWaivers, waiverClaims)
    loadRosterData().catch(() => {})
  }

  useEffect(() => {
    if (!currentSeason?.id || (!waivers.length && !waiverClaims.length)) return
    processWaivers().catch(() => {})
  }, [currentSeason?.id, processWaivers, waiverClaims.length, waivers.length])

  useEffect(() => {
    if (!activeWaiverEntries.length) return undefined
    const intervalId = window.setInterval(() => {
      processWaivers().catch(() => {})
    }, 60000)
    return () => window.clearInterval(intervalId)
  }, [activeWaiverEntries.length, processWaivers])

  const pendingTrades = combinedTrades.filter((entry) => entry.status === 'pending')
  const historyTrades = combinedTrades.filter((entry) => entry.status !== 'pending')
  const historyWaivers = waivers.filter((entry) => entry.status !== 'active')
  const freeAgentMoves = useMemo(() => {
    const drops = waivers.filter((entry) => entry.source_team_id)
    return roster
      .filter((entry) => entry.acquired_via === 'free_agent')
      .map((entry) => {
        const matchedDrop = drops
          .filter((waiver) => String(waiver.source_team_id) === String(entry.team_id))
          .reduce((closest, waiver) => {
            const diff = Math.abs(new Date(waiver.created_at) - new Date(entry.created_at))
            if (!closest || diff < closest.diff) return { waiver, diff }
            return closest
          }, null)?.waiver || null
        return {
          id: entry.id,
          team_id: entry.team_id,
          created_at: entry.created_at,
          addedCharacter: entry.character_name,
          droppedCharacter: matchedDrop?.claiming_character || null,
        }
      })
  }, [roster, waivers])
  const modalCharacter = charactersById[cardCharacterId] || lineupCharactersById[cardCharacterId] || null
  const modalCharacterOwnerTeamId = modalCharacter ? characterOwnersByName[modalCharacter.name] : null

  if (!currentSeason) {
    return <div className="page-stack"><div className="page-head"><h1>No season selected.</h1></div></div>
  }

  return (
    <div className="page-stack">
      <div className="tab-row">
        {TABS.filter((tab) => is_logged_in || tab !== 'Trade Center').map((tab) => (
          <button key={tab} className={`tab-button ${activeTab === tab ? 'tab-button-active' : ''}`} onClick={() => setActiveTab(tab)} type="button">
            {tab}
          </button>
        ))}
      </div>

      {activeTab === 'Rosters' ? (
        <div className="page-stack" style={{ gap: 18 }}>
            {/* Team selector */}
            <section className="panel" style={{ padding: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <h2 style={{ margin: 0, flexShrink: 0 }}>Viewing:</h2>
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8 }}>
                  {lineupTeam && (
                    <TeamLogo
                      logoKey={lineupTeam.team_logo_key}
                      logoUrl={lineupTeam.logo_url || null}
                      teamName={lineupTeam.team_name}
                      height={36}
                    />
                  )}
                  <select
                    value={viewedTeamId}
                    onChange={(e) => setViewedTeamId(e.target.value)}
                    style={{
                      background: '#1E293B', border: '1px solid #334155', borderRadius: 999,
                      color: '#E2E8F0', fontWeight: 600, padding: '8px 14px', fontSize: 14, cursor: 'pointer',
                      minWidth: 180,
                    }}
                  >
                    {seasonTeams.map((team) => {
                      const playerName = seasonPlayersById[team.player_id]?.name || team.team_name || 'Unknown'
                      const shortName = getTeamShortName(team)
                      const label = shortName ? `${shortName} (${playerName})` : playerName
                      return (
                        <option key={team.id} value={String(team.id)}>
                          {label}
                          {String(team.id) === String(myTeam?.id) ? ' — You' : ''}
                        </option>
                      )
                    })}
                  </select>
                </div>
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
                  {lineupCharacters.length === 0 ? (
                    <div style={{ padding: 12, textAlign: 'center', color: '#64748B', fontSize: 12 }}>No active players on this roster yet.</div>
                  ) : (
                    lineupOrder.map((charId, index) => {
                      const character = lineupCharactersById[charId]
                      if (!character) return null
                      return (
                      <div
                        key={`roster-character-${character.rosterId}`}
                        draggable={canEditRoster}
                        onDragStart={canEditRoster ? handleDragStartLineup(charId) : undefined}
                        onDragOver={canEditRoster ? (event) => event.preventDefault() : undefined}
                        onDrop={canEditRoster ? handleDropOnLineup(index) : undefined}
                        style={{ borderRadius: 8, touchAction: 'pan-y' }}
                      >
                        <DraggableRosterItem
                          character={character}
                          onDragStart={handleDragStartRoster(character.id)}
                          rosterNames={rosterNames}
                          onOpenCard={() => setCardCharacterId(character.id)}
                          compact
                          lineupNumber={index + 1}
                          positionLabel={positionByCharId[charId] || null}
                          onLineupNumberClick={() => handleLineupNumberClick(charId, index)}
                          lineupNumberSelected={selectedLineupMoveId === charId}
                          lineupNumberAriaLabel={`Lineup spot ${index + 1}`}
                          lineupNumberTitle={canEditRoster ? (selectedLineupMoveId === charId ? 'Selected lineup slot' : 'Tap to swap this player with another lineup slot') : `Lineup spot ${index + 1}`}
                          lineupNumberDisabled={!canEditRoster}
                          showChemistryNote={lineupChemistryHighlightIds.has(character.id)}
                          highlighted={selectedLineupMoveId === character.id}
                          showTrade={false}
                          disabled={!isViewingOwnTeam || !myTeam || tradeDeadlinePassed}
                        />
                      </div>
                    )})
                  )}
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                <FieldingView
                  charactersById={lineupCharactersById}
                  fieldingPositions={fieldingPositions}
                  setFieldingPositions={setFieldingPositions}
                  selectedPlayer={selectedPlayer}
                  setSelectedPlayer={setSelectedPlayer}
                  fieldingAssignMode={false}
                  selectedForFielding={null}
                  onAssignPosition={() => {}}
                  editable={canEditRoster}
                  chemistryHighlightIds={fieldingChemistryHighlightIds}
                />

              </div>
            </div>
        </div>
      ) : null}

      {activeTab === 'Trade Center' && is_logged_in ? (
        <div className="page-stack" style={{ gap: 12 }}>
          <div className="inline-actions">
            <button
              className="ghost-button"
              onClick={() => setPendingTradesOpen(true)}
              type="button"
              style={pendingTrades.length ? { borderColor: '#EAB308', color: '#FDE68A' } : undefined}
            >
              <span>Pending Trades</span>
              <strong>{pendingTrades.length}</strong>
            </button>
          </div>
          <TradeBuilderWorkspace
          step={tradeBuilderStep}
          onBack={() => setTradeBuilderStep((current) => current === 'confirm' ? 'details' : 'teams')}
          onReset={closeTradeBuilder}
          onAdvance={() => setTradeBuilderStep((current) => current === 'teams' ? 'details' : 'confirm')}
          tradeDraft={tradeDraft}
          setTradeDraft={setTradeDraft}
          seasonTeams={seasonTeams}
          teamsById={teamsById}
          playersById={playersById}
          identitiesByPlayerId={identitiesByPlayerId}
          activeRosterByTeamId={activeRosterByTeamId}
          myTeam={myTeam}
          viewedTeamId={viewedTeamId}
          onSubmit={submitTradeProposal}
          tradeDeadlinePassed={tradeDeadlinePassed}
          />

          {false ? (
          <section className="panel" style={{ padding: 18 }}>
            <div className="section-head">
              <div>
                <h2>Pending Trades</h2>
                <span className="muted">{pendingTrades.length} open proposal{pendingTrades.length === 1 ? '' : 's'}</span>
              </div>
            </div>
            <div className="feed-list">
              {pendingTrades.map((trade) => {
                const myParticipant = trade.participants.find((entry) => String(entry.team_id) === String(myTeam?.id || ''))
                const canRespond = myParticipant?.decision_status === 'pending'
                const canCancel = !canRespond && String(trade.created_by_team_id) === String(myTeam?.id || '')
                return (
                  <div key={trade.id} style={{ padding: 14, borderRadius: 14, background: 'rgba(15,23,42,0.55)', border: '1px solid rgba(51,65,85,0.9)', display: 'grid', gap: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        {trade.participants.map((participant) => (
                          <PlayerTag key={`${trade.id}-${participant.team_id}`} height={26} identitiesByPlayerId={identitiesByPlayerId} playerId={teamsById[String(participant.team_id)]?.player_id} playersById={playersById} />
                        ))}
                      </div>
                      <StatusChip value={myParticipant?.decision_status || trade.status} />
                    </div>
                    <span className="muted" style={{ fontSize: 13 }}>{trade.moves.map((move) => move.character_name).join(' • ')}</span>
                    {canRespond || canCancel ? (
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        {canRespond ? <button className="solid-button" onClick={() => resolveTrade(trade, 'accepted')} type="button">Accept</button> : null}
                        {canRespond ? <button className="ghost-button" onClick={() => resolveTrade(trade, 'rejected')} type="button">Reject</button> : null}
                        {canCancel ? <button className="ghost-button" onClick={() => resolveTrade(trade, 'cancelled')} type="button">Cancel</button> : null}
                      </div>
                    ) : null}
                  </div>
                )
              })}
              {!pendingTrades.length ? <span className="muted">No pending trades.</span> : null}
            </div>
          </section>
          ) : null}
        </div>
      ) : null}

      {activeTab === 'Free Agents' ? (
        <div className="page-stack" style={{ gap: 18 }}>
          <section className="panel season-free-agents-panel" style={{ padding: 18 }}>
            <div className="section-head">
              <div>
                <h2>Free Agents</h2>
              </div>
            </div>
            <div className="season-free-agents-list" style={{ display: 'grid', gap: 8 }}>
              <div className="season-free-agents-row season-free-agents-header">
                <span />
                <button type="button" onClick={() => toggleFreeAgentSort('name')} style={{ background: 'none', border: 'none', color: 'inherit', padding: 0, textAlign: 'left', font: 'inherit', cursor: 'pointer' }}>
                  Player {freeAgentSort.key === 'name' ? (freeAgentSort.direction === 'asc' ? '^' : 'v') : ''}
                </button>
                <button type="button" onClick={() => toggleFreeAgentSort('batting')} style={{ textAlign: 'center', background: 'none', border: 'none', color: freeAgentSort.key === 'batting' ? '#EAB308' : 'inherit', padding: 0, font: 'inherit', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2 }}>
                  <StatIcon stat="batting" size={13} /> OVR {freeAgentSort.key === 'batting' ? (freeAgentSort.direction === 'asc' ? '^' : 'v') : ''}
                </button>
                <button type="button" onClick={() => toggleFreeAgentSort('pitching')} style={{ textAlign: 'center', background: 'none', border: 'none', color: freeAgentSort.key === 'pitching' ? '#EAB308' : 'inherit', padding: 0, font: 'inherit', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2 }}>
                  <StatIcon stat="pitching" size={13} /> OVR {freeAgentSort.key === 'pitching' ? (freeAgentSort.direction === 'asc' ? '^' : 'v') : ''}
                </button>
                <button type="button" onClick={() => toggleFreeAgentSort('fielding')} style={{ textAlign: 'center', background: 'none', border: 'none', color: freeAgentSort.key === 'fielding' ? '#EAB308' : 'inherit', padding: 0, font: 'inherit', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2 }}>
                  <StatIcon stat="fielding" size={13} /> OVR {freeAgentSort.key === 'fielding' ? (freeAgentSort.direction === 'asc' ? '^' : 'v') : ''}
                </button>
                <button type="button" onClick={() => toggleFreeAgentSort('speed')} style={{ textAlign: 'center', background: 'none', border: 'none', color: freeAgentSort.key === 'speed' ? '#EAB308' : 'inherit', padding: 0, font: 'inherit', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2 }}>
                  <StatIcon stat="speed" size={13} /> OVR {freeAgentSort.key === 'speed' ? (freeAgentSort.direction === 'asc' ? '^' : 'v') : ''}
                </button>
                <button type="button" onClick={() => toggleFreeAgentSort('overall')} style={{ textAlign: 'center', background: 'none', border: 'none', color: freeAgentSort.key === 'overall' ? '#EAB308' : 'inherit', padding: 0, font: 'inherit', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2 }}>
                  OVR {freeAgentSort.key === 'overall' ? (freeAgentSort.direction === 'asc' ? '^' : 'v') : ''}
                </button>
                <span style={{ textAlign: 'center' }}>Action</span>
              </div>
              {sortedAvailablePlayerRows.map((row) => {
                const isWaiver = row.type === 'waiver'
                const ownerTeam = isWaiver ? teamsById[String(row.waiver.source_team_id)] : null
                const clockTeam = isWaiver ? teamsById[String(row.clockTeamId)] : null
                return (
                  <div key={row.id} className="season-free-agents-row season-free-agents-item">
                    <button type="button" onClick={() => setCardCharacterId(row.character.id)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', justifySelf: 'center' }}>
                      <CharacterPortrait name={row.character.name} size={28} />
                    </button>
                    <div style={{ display: 'contents' }}>
                      <div style={{ display: 'grid', gap: 4 }}>
                        <button type="button" onClick={() => setCardCharacterId(row.character.id)} style={{ width: 'fit-content', background: 'none', border: 'none', color: '#E2E8F0', padding: 0, cursor: 'pointer', textAlign: 'left' }}>
                          <strong style={{ fontSize: 15 }}>{row.character.name}</strong>
                        </button>
                        {isWaiver ? (
                          <span className="muted" style={{ fontSize: 11 }}>
                            {ownerTeam?.team_name || seasonPlayersById[ownerTeam?.player_id]?.name || 'Unknown team'} dropped them.
                          </span>
                        ) : null}
                        {isWaiver ? (
                          <span className="muted" style={{ fontSize: 11 }}>
                            {clockTeam ? `Current waiver clock: ${clockTeam.team_name}` : 'Waiting for expiry or a new claim'} • Expires {formatShortDate(row.waiver.expires_at)}
                          </span>
                        ) : null}
                      </div>
                      <div style={{ display: 'contents' }}>
                        {[
                          { label: 'B', value: row.analysis?.displayRatings?.batting ?? '-', color: '#EAB308' },
                          { label: 'P', value: row.analysis?.displayRatings?.pitching ?? '-', color: '#EF4444' },
                          { label: 'F', value: row.analysis?.displayRatings?.fielding ?? '-', color: '#3B82F6' },
                          { label: 'S', value: row.analysis?.displayRatings?.speed ?? '-', color: '#A78BFA' },
                          { label: 'OVR', value: row.analysis?.displayRatings?.overall ?? '-', color: '#64748B' },
                        ].map((stat) => (
                          <div key={`${row.id}-${stat.label}`} style={{ display: 'contents' }}>
                            <span style={{ display: 'none' }}>{stat.label}</span>
                            <strong style={{ fontSize: 15, textAlign: 'center', color: stat.color }}>{stat.value}</strong>
                          </div>
                        ))}
                      </div>
                      {isWaiver ? (
                        <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                          {row.claimCount ? <span className="muted" style={{ fontSize: 12 }}>{row.claimCount} claim{row.claimCount === 1 ? '' : 's'} filed</span> : <span className="muted" style={{ fontSize: 12 }}>No claims filed yet</span>}
                          {row.myClaim ? <span className="muted" style={{ fontSize: 12 }}>Your drop: {row.myClaim.dropping_character}</span> : null}
                          {!SUPPORTS_WAIVER_CLAIMS_SCHEMA ? <span className="muted" style={{ fontSize: 12 }}>Claim queue unavailable on this database schema.</span> : null}
                        </div>
                      ) : (
                        <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                          <span className="muted" style={{ fontSize: 10 }}>Free agent</span>
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'grid', gap: 6, justifyItems: 'center' }}>
                      {!is_logged_in ? null : isWaiver ? (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              if (!SUPPORTS_WAIVER_CLAIMS_SCHEMA) return
                              setPickupModal({ type: 'waiver', waiverId: row.waiver.id, characterName: row.character.name })
                              setPickupDropCharacter(row.myClaim?.dropping_character || '')
                            }}
                            disabled={!SUPPORTS_WAIVER_CLAIMS_SCHEMA || !myTeam || (!row.canClaim && !row.myClaim)}
                            style={{ minWidth: 56, minHeight: 36, borderRadius: 10, border: '1px solid rgba(234,179,8,0.45)', background: 'rgba(234,179,8,0.14)', color: '#FDE68A', fontWeight: 800, display: 'grid', placeItems: 'center', cursor: !SUPPORTS_WAIVER_CLAIMS_SCHEMA || !myTeam || (!row.canClaim && !row.myClaim) ? 'not-allowed' : 'pointer' }}
                          >
                            <span style={{ fontSize: 18, lineHeight: 1 }}>W</span>
                          </button>
                          {row.canDeny ? (
                            <button className="ghost-button" onClick={() => denyWaiver(row.waiver)} type="button" style={{ minHeight: 28, padding: '4px 8px', fontSize: 11 }}>
                              <X size={12} />
                              <span>Deny</span>
                            </button>
                          ) : null}
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setPickupModal({ type: 'free_agent', characterName: row.character.name })
                            setPickupDropCharacter('')
                          }}
                          disabled={!myTeam}
                          style={{ width: 36, height: 36, borderRadius: 10, border: '1px solid rgba(34,197,94,0.42)', background: 'rgba(34,197,94,0.14)', color: '#86EFAC', display: 'grid', placeItems: 'center', cursor: myTeam ? 'pointer' : 'not-allowed' }}
                          aria-label={`Add ${row.character.name}`}
                          title={`Add ${row.character.name}`}
                        >
                          <Plus size={16} />
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
              {!sortedAvailablePlayerRows.length ? <span className="muted">No free agents or active waiver players right now.</span> : null}
            </div>
          </section>
        </div>
      ) : null}

      {activeTab === 'Transactions' ? (
        <section className="panel" style={{ padding: 18 }}>
          <div className="section-head"><h2>Transaction History</h2></div>
          <div className="feed-list">
            {[
              ...historyTrades.map((t) => ({ ...t, _type: 'trade', _date: t.created_at })),
              ...historyWaivers.map((w) => ({ ...w, _type: 'waiver', _date: w.created_at })),
              ...freeAgentMoves.map((m) => ({ ...m, _type: 'free_agent', _date: m.created_at })),
            ]
              .sort((a, b) => new Date(b._date || 0) - new Date(a._date || 0))
              .map((item) => {
                if (item._type === 'trade') {
                  return (
                    <div key={`trade-${item.id}`} style={{ padding: 14, borderRadius: 14, background: 'rgba(15,23,42,0.55)', border: '1px solid rgba(51,65,85,0.9)', display: 'grid', gap: 10 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          {item.participants.map((participant) => (
                            <PlayerTag key={`${item.id}-${participant.team_id}`} height={24} identitiesByPlayerId={identitiesByPlayerId} playerId={teamsById[String(participant.team_id)]?.player_id} playersById={playersById} responsiveAbbreviation />
                          ))}
                        </div>
                        <StatusChip value={item.status} />
                      </div>
                      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                        {item.moves.map((move) => (
                          <div key={`${item.id}-${move.character_name}-${move.to_team_id}`} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <CharacterPortrait name={move.character_name} size={26} />
                            <span className="muted" style={{ fontSize: 12 }}>{move.character_name}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                }
                if (item._type === 'free_agent') {
                  const team = teamsById[String(item.team_id)]
                  return (
                    <div key={`free-agent-${item.id}`} style={{ padding: 14, borderRadius: 14, background: 'rgba(15,23,42,0.55)', border: '1px solid rgba(51,65,85,0.9)', display: 'grid', gap: 10 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
                        <PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} playerId={team?.player_id} playersById={playersById} responsiveAbbreviation />
                        <span className="muted" style={{ fontSize: 12 }}>{formatShortDate(item.created_at)}</span>
                      </div>
                      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
                        {item.droppedCharacter ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <div style={{ position: 'relative' }}>
                              <CharacterPortrait name={item.droppedCharacter} size={32} />
                              <span style={{ position: 'absolute', bottom: -2, right: -2, width: 16, height: 16, borderRadius: '50%', background: '#EF4444', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '2px solid #0F172A' }}>
                                <X size={10} />
                              </span>
                            </div>
                            <span style={{ fontSize: 13, fontWeight: 600 }}>{item.droppedCharacter}</span>
                          </div>
                        ) : null}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <div style={{ position: 'relative' }}>
                            <CharacterPortrait name={item.addedCharacter} size={32} />
                            <span style={{ position: 'absolute', bottom: -2, right: -2, width: 16, height: 16, borderRadius: '50%', background: '#22C55E', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '2px solid #0F172A' }}>
                              <Plus size={10} />
                            </span>
                          </div>
                          <span style={{ fontSize: 13, fontWeight: 600 }}>{item.addedCharacter}</span>
                        </div>
                      </div>
                    </div>
                  )
                }
                return (
                  <div className="feed-row" key={`waiver-${item.id}`}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                      <CharacterPortrait name={item.claiming_character} size={32} />
                      <div style={{ display: 'grid', gap: 4 }}>
                        <strong>{item.claiming_character}</strong>
                        <span className="muted">
                          {formatSeasonLabel(item.status)}
                          {item.expires_at ? ` • expired ${formatShortDate(item.expires_at)}` : ''}
                        </span>
                      </div>
                    </div>
                    {item.awarded_to_team_id
                      ? <PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} playerId={teamsById[String(item.awarded_to_team_id)]?.player_id} playersById={playersById} responsiveAbbreviation />
                      : <span className="muted" style={{ fontSize: 12 }}>Free agent pool</span>}
                  </div>
                )
              })}
            {!historyTrades.length && !historyWaivers.length && !freeAgentMoves.length ? <span className="muted">No transaction history yet.</span> : null}
          </div>
        </section>
      ) : null}

      {pendingTradesOpen ? (
        <div className="modal-backdrop" onClick={() => setPendingTradesOpen(false)}>
          <div className="modal-card" style={{ width: 'min(720px, calc(100vw - 24px))', maxHeight: 'calc(100vh - 48px)', overflowY: 'auto' }} onClick={(event) => event.stopPropagation()}>
            <div className="section-head">
              <div>
                <h2>Pending Trades</h2>
                <span className="muted">{pendingTrades.length} open proposal{pendingTrades.length === 1 ? '' : 's'}</span>
              </div>
              <button className="ghost-button" onClick={() => setPendingTradesOpen(false)} type="button">
                <X size={14} />
              </button>
            </div>
            <div className="feed-list">
              {pendingTrades.map((trade) => {
                const myParticipant = trade.participants.find((entry) => String(entry.team_id) === String(myTeam?.id || ''))
                const canRespond = myParticipant?.decision_status === 'pending'
                const canCancel = !canRespond && String(trade.created_by_team_id) === String(myTeam?.id || '')
                return (
                  <div key={trade.id} style={{ padding: 14, borderRadius: 14, background: 'rgba(15,23,42,0.55)', border: '1px solid rgba(51,65,85,0.9)', display: 'grid', gap: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        {trade.participants.map((participant) => (
                          <PlayerTag key={`${trade.id}-${participant.team_id}`} height={26} identitiesByPlayerId={identitiesByPlayerId} playerId={teamsById[String(participant.team_id)]?.player_id} playersById={playersById} />
                        ))}
                      </div>
                      <StatusChip value={myParticipant?.decision_status || trade.status} />
                    </div>
                    <span className="muted" style={{ fontSize: 13 }}>{trade.moves.map((move) => move.character_name).join(' • ')}</span>
                    {canRespond || canCancel ? (
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        {canRespond ? <button className="solid-button" onClick={() => resolveTrade(trade, 'accepted')} type="button">Accept</button> : null}
                        {canRespond ? <button className="ghost-button" onClick={() => resolveTrade(trade, 'rejected')} type="button">Reject</button> : null}
                        {canCancel ? <button className="ghost-button" onClick={() => resolveTrade(trade, 'cancelled')} type="button">Cancel</button> : null}
                      </div>
                    ) : null}
                  </div>
                )
              })}
              {!pendingTrades.length ? <span className="muted">No pending trades.</span> : null}
            </div>
          </div>
        </div>
      ) : null}

      {pickupModal ? (
        <div className="modal-backdrop" onClick={closePickupModal}>
          <div className="modal-card" style={{ maxWidth: 460 }} onClick={(event) => event.stopPropagation()}>
            <div className="section-head">
              <div>
                <h2>{pickupModal.type === 'waiver' ? `Claim ${pickupModal.characterName}` : `Add ${pickupModal.characterName}`}</h2>
                <span className="muted">
                  {pickupModal.type === 'waiver'
                    ? 'Choose the player you would drop only if your waiver claim is awarded.'
                    : 'Choose the player you are dropping. The dropped player will go to waivers for one week.'}
                </span>
              </div>
              <button onClick={closePickupModal} type="button" style={{ background: 'none', border: 'none', color: '#94A3B8', cursor: 'pointer' }}>
                <X size={18} />
              </button>
            </div>
            <div style={{ display: 'grid', gap: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 12, borderRadius: 12, background: 'rgba(15,23,42,0.72)', border: '1px solid rgba(51,65,85,0.85)' }}>
                <CharacterPortrait name={pickupModal.characterName} size={44} />
                <div style={{ display: 'grid', gap: 2 }}>
                  <strong>{pickupModal.characterName}</strong>
                  {pickupModal.type === 'waiver' ? (
                    <span className="muted" style={{ fontSize: 12 }}>Waiver award if the priority line reaches your team.</span>
                  ) : null}
                </div>
              </div>
              <select value={pickupDropCharacter} onChange={(event) => setPickupDropCharacter(event.target.value)}>
                <option value="">Drop character</option>
                {(activeRosterByTeamId[String(myTeam?.id)] || [])
                  .filter((entry) => entry.character_name !== captainNameByTeamId[String(myTeam?.id)])
                  .map((entry) => <option key={entry.id} value={entry.character_name}>{entry.character_name}</option>)}
              </select>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button className="ghost-button" onClick={closePickupModal} type="button">Cancel</button>
                <button className="solid-button" onClick={submitPickup} type="button">
                  {pickupModal.type === 'waiver' ? <Clock3 size={16} /> : <Plus size={16} />}
                  <span>{pickupModal.type === 'waiver' ? 'Submit Claim' : 'Confirm Pickup'}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {cardCharacterId ? (
        <>
          <div onClick={() => setCardCharacterId(null)} style={{ position: 'fixed', inset: 0, background: '#00000060', zIndex: 49 }} />
          <SharedCharacterDetailModal
            character={modalCharacter}
            allCharactersById={Object.fromEntries(characters.map((entry) => [entry.name, entry]))}
            playersById={playersById}
            identitiesByPlayerId={identitiesByPlayerId}
            currentOwner={modalCharacterOwnerTeamId ? { player_id: teamsById[String(modalCharacterOwnerTeamId)]?.player_id } : null}
            battingHistory={cardCharacterStats?.battingHistory || []}
            pitchingHistory={cardCharacterStats?.pitchingHistory || []}
            currentTournamentBatting={cardCharacterStats?.currentSeasonBatting}
            currentTournamentPitching={cardCharacterStats?.currentSeasonPitching}
            allTimeBatting={cardCharacterStats?.allTimeBatting}
            allTimePitching={cardCharacterStats?.allTimePitching}
            rosterNames={rosterNames}
            onClose={() => setCardCharacterId(null)}
          />
        </>
      ) : null}
    </div>
  )
}
