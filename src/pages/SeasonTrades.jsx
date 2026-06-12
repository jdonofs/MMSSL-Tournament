import { useEffect, useMemo, useState } from 'react'
import { ShieldAlert, Shuffle, Sparkles } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { useAuth } from '../context/AuthContext'
import { useSeason } from '../context/SeasonContext'
import { useToast } from '../context/ToastContext'
import PlayerTag from '../components/PlayerTag'
import { formatSeasonLabel } from '../utils/season'
import { buildSeasonTeamIdentity, getTeamShortName } from '../utils/teamIdentity'

const TABS = ['Active Trades', 'Waiver Wire', 'History']

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

function CharacterSelector({ title, entries, selectedValues, onToggle, disabled = false }) {
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <strong>{title}</strong>
      <div className="feed-list">
        {entries.map((entry) => (
          <label className="feed-row" key={entry.id || entry.character_name || entry} style={{ cursor: disabled ? 'default' : 'pointer' }}>
            <input checked={selectedValues.includes(entry.character_name || entry)} onChange={() => onToggle(entry.character_name || entry)} type="checkbox" disabled={disabled} />
            <span>{entry.character_name || entry}</span>
          </label>
        ))}
        {!entries.length ? <span className="muted">No characters available.</span> : null}
      </div>
    </div>
  )
}

export default function SeasonTrades() {
  const { player } = useAuth()
  const { currentSeason, seasonTeams, standings, tradeDeadlinePassed } = useSeason()
  const { pushToast } = useToast()
  const [players, setPlayers] = useState([])
  const [characters, setCharacters] = useState([])
  const [roster, setRoster] = useState([])
  const [trades, setTrades] = useState([])
  const [tradePlayers, setTradePlayers] = useState([])
  const [waivers, setWaivers] = useState([])
  const [activeTab, setActiveTab] = useState(TABS[0])
  const [tradeTargetTeamId, setTradeTargetTeamId] = useState('')
  const [outgoingCharacters, setOutgoingCharacters] = useState([])
  const [incomingCharacters, setIncomingCharacters] = useState([])
  const [waiverClaimCharacter, setWaiverClaimCharacter] = useState('')
  const [waiverDropCharacter, setWaiverDropCharacter] = useState('')
  const [freeAgentCharacter, setFreeAgentCharacter] = useState('')
  const [freeAgentDropCharacter, setFreeAgentDropCharacter] = useState('')

  useEffect(() => {
    async function load() {
      if (!currentSeason?.id) return
      const [
        { data: playersData },
        { data: charactersData },
        { data: rosterData },
        { data: tradesData },
        { data: tradePlayersData },
        { data: waiversData },
      ] = await Promise.all([
        supabase.from('players').select('*'),
        supabase.from('characters').select('*').order('name'),
        supabase.from('season_roster').select('*').eq('season_id', currentSeason.id).order('created_at'),
        supabase.from('season_trades').select('*').eq('season_id', currentSeason.id).order('created_at', { ascending: false }),
        supabase.from('season_trade_players').select('*').order('id'),
        supabase.from('season_waivers').select('*').eq('season_id', currentSeason.id).order('created_at', { ascending: false }),
      ])
      setPlayers(playersData || [])
      setCharacters(charactersData || [])
      setRoster(rosterData || [])
      setTrades(tradesData || [])
      setTradePlayers(tradePlayersData || [])
      setWaivers(waiversData || [])
    }

    load()
  }, [currentSeason?.id])

  const myTeam = useMemo(
    () => seasonTeams.find((entry) => String(entry.player_id) === String(player?.id)) || null,
    [seasonTeams, player?.id],
  )
  const playersById = useMemo(() => Object.fromEntries(players.map((entry) => [entry.id, entry])), [players])
  const teamsById = useMemo(() => Object.fromEntries(seasonTeams.map((entry) => [entry.id, entry])), [seasonTeams])
  const identitiesByPlayerId = useMemo(
    () => Object.fromEntries(seasonTeams.map((team) => [team.player_id, buildSeasonTeamIdentity(team)])),
    [seasonTeams],
  )
  const activeRoster = useMemo(() => roster.filter((entry) => entry.is_active !== false), [roster])
  const myRoster = useMemo(() => activeRoster.filter((entry) => entry.team_id === myTeam?.id), [activeRoster, myTeam?.id])
  const targetRoster = useMemo(() => activeRoster.filter((entry) => String(entry.team_id) === String(tradeTargetTeamId)), [activeRoster, tradeTargetTeamId])
  const activeCharacterNames = useMemo(() => new Set(activeRoster.map((entry) => entry.character_name)), [activeRoster])
  const availableCharacters = useMemo(
    () => characters.map((entry) => entry.name).filter((name) => !activeCharacterNames.has(name)),
    [characters, activeCharacterNames],
  )
  const reverseStandings = useMemo(() => [...standings].reverse(), [standings])

  const toggleCharacter = (setter, name) => {
    setter((current) => current.includes(name) ? current.filter((entry) => entry !== name) : [...current, name])
  }

  const submitTradeProposal = async () => {
    if (!myTeam?.id || !tradeTargetTeamId || outgoingCharacters.length === 0 || outgoingCharacters.length !== incomingCharacters.length) {
      pushToast({ title: 'Invalid trade', message: 'Select a target team and equal numbers of outgoing and incoming characters.', type: 'error' })
      return
    }
    if (tradeDeadlinePassed) {
      pushToast({ title: 'Trade deadline passed', message: 'Trades are closed for this season.', type: 'error' })
      return
    }
    const { data: trade, error } = await supabase.from('season_trades').insert({
      season_id: currentSeason.id,
      proposing_team_id: myTeam.id,
      receiving_team_id: Number(tradeTargetTeamId),
      status: 'pending',
    }).select().single()
    if (error) {
      pushToast({ title: 'Trade failed', message: error.message, type: 'error' })
      return
    }
    const payload = [
      ...outgoingCharacters.map((characterName) => ({ trade_id: trade.id, character_name: characterName, from_team_id: myTeam.id, to_team_id: Number(tradeTargetTeamId) })),
      ...incomingCharacters.map((characterName) => ({ trade_id: trade.id, character_name: characterName, from_team_id: Number(tradeTargetTeamId), to_team_id: myTeam.id })),
    ]
    const { data: tradePlayerRows, error: tradePlayerError } = await supabase.from('season_trade_players').insert(payload).select()
    if (tradePlayerError) {
      pushToast({ title: 'Trade detail failed', message: tradePlayerError.message, type: 'error' })
      return
    }
    setTrades((current) => [trade, ...current])
    setTradePlayers((current) => [...(tradePlayerRows || []), ...current])
    setOutgoingCharacters([])
    setIncomingCharacters([])
    setTradeTargetTeamId('')
    pushToast({ title: 'Trade proposed', message: 'The receiving team can now accept or reject it.', type: 'success' })
  }

  const resolveTrade = async (trade, status) => {
    if (!trade) return
    if (status === 'accepted') {
      const scopedPlayers = tradePlayers.filter((entry) => entry.trade_id === trade.id)
      await Promise.all(scopedPlayers.map((entry) => (
        supabase
          .from('season_roster')
          .update({ team_id: entry.to_team_id, acquired_via: 'trade' })
          .eq('season_id', currentSeason.id)
          .eq('team_id', entry.from_team_id)
          .eq('character_name', entry.character_name)
          .eq('is_active', true)
      )))
      setRoster((current) => current.map((entry) => {
        const move = scopedPlayers.find((moveEntry) => moveEntry.character_name === entry.character_name && moveEntry.from_team_id === entry.team_id)
        return move ? { ...entry, team_id: move.to_team_id, acquired_via: 'trade' } : entry
      }))
    }
    const { error } = await supabase.from('season_trades').update({ status, resolved_at: new Date().toISOString() }).eq('id', trade.id)
    if (error) {
      pushToast({ title: 'Trade update failed', message: error.message, type: 'error' })
      return
    }
    setTrades((current) => current.map((entry) => entry.id === trade.id ? { ...entry, status, resolved_at: new Date().toISOString() } : entry))
    pushToast({ title: `Trade ${status}`, type: 'success' })
    window.dispatchEvent(new Event('season-trades-updated'))
  }

  const submitWaiverClaim = async () => {
    if (!myTeam?.id || !waiverClaimCharacter || !waiverDropCharacter) {
      pushToast({ title: 'Incomplete waiver', message: 'Choose a claim and a drop.', type: 'error' })
      return
    }
    const priority = reverseStandings.findIndex((entry) => entry.id === myTeam.id) + 1 || reverseStandings.length
    const { data, error } = await supabase.from('season_waivers').insert({
      season_id: currentSeason.id,
      claiming_team_id: myTeam.id,
      dropping_character: waiverDropCharacter,
      claiming_character: waiverClaimCharacter,
      priority_order: priority,
      status: 'pending',
    }).select().single()
    if (error) {
      pushToast({ title: 'Waiver failed', message: error.message, type: 'error' })
      return
    }
    setWaivers((current) => [data, ...current])
    setWaiverClaimCharacter('')
    setWaiverDropCharacter('')
    pushToast({ title: 'Waiver submitted', type: 'success' })
  }

  const resolveWaivers = async () => {
    const pending = waivers.filter((entry) => entry.status === 'pending')
    const grouped = pending.reduce((acc, entry) => {
      acc[entry.claiming_character] = acc[entry.claiming_character] || []
      acc[entry.claiming_character].push(entry)
      return acc
    }, {})

    for (const claims of Object.values(grouped)) {
      const sortedClaims = [...claims].sort((a, b) => Number(a.priority_order) - Number(b.priority_order) || new Date(a.created_at) - new Date(b.created_at))
      const winner = sortedClaims[0]
      const losers = sortedClaims.slice(1)

      const dropRow = activeRoster.find((entry) => entry.team_id === winner.claiming_team_id && entry.character_name === winner.dropping_character)
      if (dropRow) {
        await supabase.from('season_roster').update({ is_active: false }).eq('id', dropRow.id)
      }
      await supabase.from('season_roster').insert({
        season_id: currentSeason.id,
        team_id: winner.claiming_team_id,
        character_name: winner.claiming_character,
        acquired_via: 'waiver',
        is_active: true,
      })
      await supabase.from('season_waivers').update({ status: 'approved', resolved_at: new Date().toISOString() }).eq('id', winner.id)
      if (losers.length) {
        await supabase.from('season_waivers').update({ status: 'denied', resolved_at: new Date().toISOString() }).in('id', losers.map((entry) => entry.id))
      }
    }

    const [{ data: rosterData }, { data: waiversData }] = await Promise.all([
      supabase.from('season_roster').select('*').eq('season_id', currentSeason.id).order('created_at'),
      supabase.from('season_waivers').select('*').eq('season_id', currentSeason.id).order('created_at', { ascending: false }),
    ])
    setRoster(rosterData || [])
    setWaivers(waiversData || [])
    pushToast({ title: 'Waivers resolved', type: 'success' })
  }

  const addFreeAgent = async () => {
    if (!myTeam?.id || !freeAgentCharacter || !freeAgentDropCharacter) {
      pushToast({ title: 'Incomplete pickup', message: 'Choose a free agent and a drop.', type: 'error' })
      return
    }
    const dropRow = activeRoster.find((entry) => entry.team_id === myTeam.id && entry.character_name === freeAgentDropCharacter)
    if (!dropRow) return
    await supabase.from('season_roster').update({ is_active: false }).eq('id', dropRow.id)
    const { data, error } = await supabase.from('season_roster').insert({
      season_id: currentSeason.id,
      team_id: myTeam.id,
      character_name: freeAgentCharacter,
      acquired_via: 'waiver',
      is_active: true,
    }).select().single()
    if (error) {
      pushToast({ title: 'Pickup failed', message: error.message, type: 'error' })
      return
    }
    setRoster((current) => current.map((entry) => entry.id === dropRow.id ? { ...entry, is_active: false } : entry).concat(data))
    setFreeAgentCharacter('')
    setFreeAgentDropCharacter('')
    pushToast({ title: 'Free agent added', type: 'success' })
  }

  const pendingTrades = trades.filter((entry) => entry.status === 'pending')
  const historyTrades = trades.filter((entry) => entry.status !== 'pending')
  const historyWaivers = waivers.filter((entry) => entry.status !== 'pending')

  return (
    <div className="page-stack">
      <div className="page-head">
        <div>
          <span className="brand-kicker">Season Transactions</span>
          <h1>{currentSeason?.name || 'No season selected'}</h1>
          <p className="muted">{tradeDeadlinePassed ? 'Trade deadline has passed.' : 'Trades are open.'}</p>
        </div>
        <div className="inline-actions">
          <StatusChip value={tradeDeadlinePassed ? 'rejected' : 'approved'} />
        </div>
      </div>

      <div className="tab-row">
        {TABS.map((tab) => (
          <button key={tab} className={`tab-button ${activeTab === tab ? 'tab-button-active' : ''}`} onClick={() => setActiveTab(tab)} type="button">
            {tab}
          </button>
        ))}
      </div>

      {activeTab === 'Active Trades' ? (
        <div className="summary-grid" style={{ gridTemplateColumns: '1.25fr 1fr' }}>
          <section className="panel" style={{ padding: 18 }}>
            <div className="section-head">
              <div>
                <h2>Propose Trade</h2>
                <span className="muted">Equal player counts only. Both teams stay at 9 active roster spots.</span>
              </div>
              {tradeDeadlinePassed ? <StatusChip value="rejected" /> : <StatusChip value="pending" />}
            </div>
            <div style={{ display: 'grid', gap: 14 }}>
              <select value={tradeTargetTeamId} onChange={(event) => setTradeTargetTeamId(event.target.value)} disabled={tradeDeadlinePassed}>
                <option value="">Choose trade partner</option>
                {seasonTeams.filter((entry) => entry.id !== myTeam?.id).map((team) => (
                  <option key={team.id} value={team.id}>{getTeamShortName(team) || playersById[team.player_id]?.name}</option>
                ))}
              </select>
              <div className="summary-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
                <CharacterSelector
                  title="Your Characters"
                  entries={myRoster}
                  onToggle={(name) => toggleCharacter(setOutgoingCharacters, name)}
                  selectedValues={outgoingCharacters}
                  disabled={tradeDeadlinePassed}
                />
                <CharacterSelector
                  title="Requested Characters"
                  entries={targetRoster}
                  onToggle={(name) => toggleCharacter(setIncomingCharacters, name)}
                  selectedValues={incomingCharacters}
                  disabled={tradeDeadlinePassed}
                />
              </div>
              <button className="solid-button" disabled={tradeDeadlinePassed} onClick={submitTradeProposal} type="button">
                <Shuffle size={16} />
                Propose Trade
              </button>
            </div>
          </section>

          <section className="panel" style={{ padding: 18 }}>
            <div className="section-head">
              <div>
                <h2>Pending Trades</h2>
                <span className="muted">{pendingTrades.length} open proposal{pendingTrades.length === 1 ? '' : 's'}</span>
              </div>
            </div>
            <div className="feed-list">
              {pendingTrades.map((trade) => {
                const canReceive = String(teamsById[trade.receiving_team_id]?.player_id) === String(player?.id)
                const canCancel = player?.is_commissioner === true
                const scopedMoves = tradePlayers.filter((entry) => entry.trade_id === trade.id)
                return (
                  <div key={trade.id} style={{ padding: 14, borderRadius: 14, background: 'rgba(15,23,42,0.55)', border: '1px solid rgba(51,65,85,0.9)', display: 'grid', gap: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
                      <div style={{ display: 'grid', gap: 6 }}>
                        <PlayerTag height={28} identitiesByPlayerId={identitiesByPlayerId} playerId={teamsById[trade.proposing_team_id]?.player_id} playersById={playersById} />
                        <PlayerTag height={28} identitiesByPlayerId={identitiesByPlayerId} playerId={teamsById[trade.receiving_team_id]?.player_id} playersById={playersById} />
                      </div>
                      <StatusChip value={trade.status} />
                    </div>
                    <div className="muted" style={{ fontSize: 13 }}>{scopedMoves.map((entry) => entry.character_name).join(' · ')}</div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {canReceive ? <button className="solid-button" onClick={() => resolveTrade(trade, 'accepted')} type="button">Accept</button> : null}
                      {canReceive ? <button className="ghost-button" onClick={() => resolveTrade(trade, 'rejected')} type="button">Reject</button> : null}
                      {canCancel ? <button className="ghost-button" onClick={() => resolveTrade(trade, 'cancelled')} type="button">Cancel</button> : null}
                    </div>
                  </div>
                )
              })}
              {!pendingTrades.length ? <span className="muted">No pending trades.</span> : null}
            </div>
          </section>
        </div>
      ) : null}

      {activeTab === 'Waiver Wire' ? (
        <div className="summary-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <section className="panel" style={{ padding: 18 }}>
            <div className="section-head">
              <div>
                <h2>Waiver Claim</h2>
                <span className="muted">Priority runs in reverse standings order.</span>
              </div>
            </div>
            <div style={{ display: 'grid', gap: 12 }}>
              <select value={waiverClaimCharacter} onChange={(event) => setWaiverClaimCharacter(event.target.value)}>
                <option value="">Claim character</option>
                {availableCharacters.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
              <select value={waiverDropCharacter} onChange={(event) => setWaiverDropCharacter(event.target.value)}>
                <option value="">Drop character</option>
                {myRoster.map((entry) => <option key={entry.id} value={entry.character_name}>{entry.character_name}</option>)}
              </select>
              <button className="solid-button" onClick={submitWaiverClaim} type="button">
                <ShieldAlert size={16} />
                Submit Waiver
              </button>
            </div>
            <div className="feed-list" style={{ marginTop: 18 }}>
              {waivers.filter((entry) => entry.status === 'pending').map((waiver) => (
                <div className="feed-row" key={waiver.id}>
                  <div style={{ display: 'grid', gap: 4 }}>
                    <strong>{waiver.claiming_character}</strong>
                    <span className="muted">Priority {waiver.priority_order}</span>
                  </div>
                  <PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} playerId={teamsById[waiver.claiming_team_id]?.player_id} playersById={playersById} />
                </div>
              ))}
              {!waivers.some((entry) => entry.status === 'pending') ? <span className="muted">No pending waiver claims.</span> : null}
            </div>
          </section>

          <section className="panel" style={{ padding: 18 }}>
            <div className="section-head">
              <div>
                <h2>Free Agent Pickup</h2>
                <span className="muted">Unclaimed characters can be added immediately with a drop.</span>
              </div>
              <Sparkles size={16} color="#EAB308" />
            </div>
            <div style={{ display: 'grid', gap: 12 }}>
              <select value={freeAgentCharacter} onChange={(event) => setFreeAgentCharacter(event.target.value)}>
                <option value="">Free agent</option>
                {availableCharacters.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
              <select value={freeAgentDropCharacter} onChange={(event) => setFreeAgentDropCharacter(event.target.value)}>
                <option value="">Drop character</option>
                {myRoster.map((entry) => <option key={entry.id} value={entry.character_name}>{entry.character_name}</option>)}
              </select>
              <button className="ghost-button" onClick={addFreeAgent} type="button">Add Free Agent</button>
            </div>
          </section>
        </div>
      ) : null}

      {activeTab === 'History' ? (
        <div className="summary-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <section className="panel" style={{ padding: 18 }}>
            <div className="section-head"><h2>Trade History</h2></div>
            <div className="feed-list">
              {sortNewestFirst(historyTrades).map((trade) => (
                <div className="feed-row" key={trade.id}>
                  <div style={{ display: 'grid', gap: 6 }}>
                    <PlayerTag height={26} identitiesByPlayerId={identitiesByPlayerId} playerId={teamsById[trade.proposing_team_id]?.player_id} playersById={playersById} />
                    <PlayerTag height={26} identitiesByPlayerId={identitiesByPlayerId} playerId={teamsById[trade.receiving_team_id]?.player_id} playersById={playersById} />
                  </div>
                  <StatusChip value={trade.status} />
                </div>
              ))}
              {!historyTrades.length ? <span className="muted">No completed trade history.</span> : null}
            </div>
          </section>
          <section className="panel" style={{ padding: 18 }}>
            <div className="section-head"><h2>Waiver History</h2></div>
            <div className="feed-list">
              {sortNewestFirst(historyWaivers).map((waiver) => (
                <div className="feed-row" key={waiver.id}>
                  <div style={{ display: 'grid', gap: 4 }}>
                    <strong>{waiver.claiming_character}</strong>
                    <span className="muted">{formatSeasonLabel(waiver.status)}</span>
                  </div>
                  <PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} playerId={teamsById[waiver.claiming_team_id]?.player_id} playersById={playersById} />
                </div>
              ))}
              {!historyWaivers.length ? <span className="muted">No waiver history.</span> : null}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  )
}
