import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import BetProgressMeter from './BetProgressMeter'
import BetReceiptModal from './BetReceiptModal'
import CumulativeProfitChart from './CumulativeProfitChart'
import {
  formatBetTitle,
  formatMyBetContext,
  formatOdds,
  getBetProgress,
  getMarketLabel,
} from '../../utils/bettingMarkets'
import { buildBetReceipt } from '../../utils/betReceipt'
import {
  PROFIT_BASIS_LABEL,
  PROFIT_BASIS_NOTE,
  ROI_DENOMINATOR_NOTE,
  TICKET_STATUS_FILTERS,
  buildBettingDashboard,
  listCompetitionOptions,
  listMarketOptions,
} from '../../utils/bettingPerformance'

const STATUS_COLORS = {
  open: '#EAB308',
  pending: '#EAB308',
  won: '#22C55E',
  lost: '#EF4444',
  void: '#94A3B8',
}

const PAGE_SIZE = 20

const DEFAULT_FILTERS = { competitionId: 'all', status: 'all', market: 'all', from: '', to: '' }

function formatPercent(value) {
  if (value == null) return '--'
  return `${(value * 100).toFixed(1)}%`
}

function StatTile({ label, value, sub, tone = 'neutral' }) {
  return (
    <div className={`betting-stat-tile betting-stat-tile-${tone}`}>
      <span className="muted">{label}</span>
      <strong>{value}</strong>
      {sub ? <span className="muted betting-stat-sub">{sub}</span> : null}
    </div>
  )
}

export default function MyBetsPanel({
  tickets = [],
  gamesById = {},
  playersById = {},
  identitiesByPlayerId = {},
  charactersById = {},
  characterIdByName = {},
  plateAppearances = [],
  pitchingStints = [],
  ledgerEntries = [],
  ledgerChangeField = 'points_change',
  ledgerCompetitionId = null,
  oddsByGameId = {},
  competitionLabelsById = {},
  payoutFormatter,
  sourceType = 'tournament',
  competitionId = null,
}) {
  // The app's payout formatter is only ever handed positive amounts elsewhere,
  // so `$-30.00` is what it produces for a loss. Everything in this panel can be
  // negative, so the sign goes in front of the currency symbol.
  const money = useCallback(
    (value) => (Number(value) < 0 ? `-${payoutFormatter(Math.abs(Number(value)))}` : payoutFormatter(value)),
    [payoutFormatter],
  )

  const [filters, setFilters] = useState(() => ({
    ...DEFAULT_FILTERS,
    competitionId: competitionId == null ? 'all' : String(competitionId),
  }))
  const [page, setPage] = useState(0)
  const [receiptBetId, setReceiptBetId] = useState(null)
  const triggerRef = useRef(null)

  const dashboard = useMemo(() => buildBettingDashboard(tickets, filters), [tickets, filters])
  const marketOptions = useMemo(() => listMarketOptions(tickets), [tickets])
  const competitionOptions = useMemo(
    () => listCompetitionOptions(tickets, competitionLabelsById),
    [tickets, competitionLabelsById],
  )

  const { totals, markets, curve } = dashboard
  const filteredTickets = dashboard.tickets
  const pageCount = Math.max(1, Math.ceil(filteredTickets.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const visibleTickets = filteredTickets.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE)

  useEffect(() => { setPage(0) }, [filters])

  const updateFilter = (patch) => setFilters((current) => ({ ...current, ...patch }))

  const activeTicket = receiptBetId == null
    ? null
    : tickets.find((ticket) => String(ticket.id) === String(receiptBetId)) || null

  const receipt = useMemo(() => {
    if (!activeTicket) return null
    const game = gamesById[String(activeTicket.game_id)] || null
    const marketRow = (oddsByGameId[String(activeTicket.game_id)] || []).find((row) => (
      row.bet_type === activeTicket.bet_type
      && String(row.target_entity ?? '') === String(activeTicket.target_entity ?? '')
    )) || null
    return buildBetReceipt({
      bet: activeTicket,
      game,
      marketRow,
      playersById,
      identitiesByPlayerId,
      charactersById,
      plateAppearances,
      pitchingStints,
      ledgerEntries,
      ledgerChangeField,
      // Ledger rows are loaded for the competition currently selected in the
      // navbar only, so a ticket from another one cannot have its credit
      // confirmed here and must not pretend otherwise.
      ledgerAvailable: ledgerCompetitionId != null
        && String(activeTicket.competitionId ?? '') === String(ledgerCompetitionId),
      competitionLabel: activeTicket.competitionLabel || '',
      competitionType: sourceType,
    })
  }, [
    activeTicket, gamesById, oddsByGameId, playersById, identitiesByPlayerId, charactersById,
    plateAppearances, pitchingStints, ledgerEntries, ledgerChangeField, ledgerCompetitionId, sourceType,
  ])

  const receiptProgress = useMemo(() => {
    if (!receipt?.isOpen || !receipt.game) return null
    return getBetProgress(receipt.bet, receipt.game, plateAppearances, pitchingStints, charactersById, playersById)
  }, [receipt, plateAppearances, pitchingStints, charactersById, playersById])

  const receiptCharacterId = receipt?.targetCharacterName
    ? characterIdByName[receipt.targetCharacterName] ?? null
    : null

  return (
    <section className="panel sportsbook-my-bets">
      <div className="sportsbook-board-head">
        <div>
          <h2>My Bets</h2>
          <span className="muted">{PROFIT_BASIS_LABEL} basis</span>
        </div>
        <span className="muted">
          {filteredTickets.length} of {tickets.length} ticket{tickets.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className="betting-stat-grid">
        <StatTile
          label="Open exposure"
          sub={`${totals.openCount} open ticket${totals.openCount === 1 ? '' : 's'} at risk`}
          value={money(totals.openExposure)}
        />
        <StatTile
          label="Open potential return"
          sub={`${money(totals.openPotentialProfit)} net profit if all win`}
          value={money(totals.openPotentialReturn)}
        />
        <StatTile
          label="Settled net profit"
          sub={`over ${totals.settledCount} settled ticket${totals.settledCount === 1 ? '' : 's'}`}
          tone={totals.settledNetProfit > 0 ? 'positive' : totals.settledNetProfit < 0 ? 'negative' : 'neutral'}
          value={`${totals.settledNetProfit > 0 ? '+' : ''}${money(totals.settledNetProfit)}`}
        />
        <StatTile
          label="Settled wagered"
          sub={`${money(totals.atRiskWagered)} at risk (won + lost)`}
          value={money(totals.settledWagered)}
        />
        <StatTile
          label="ROI"
          sub={totals.roi == null ? 'no wagers at risk yet' : `on ${money(totals.atRiskWagered)} at risk`}
          tone={totals.roi == null ? 'neutral' : totals.roi > 0 ? 'positive' : totals.roi < 0 ? 'negative' : 'neutral'}
          value={totals.roi == null ? '--' : formatPercent(totals.roi)}
        />
        <StatTile
          label="Won / lost / void"
          sub={totals.winRate == null
            ? 'no decided tickets yet'
            : `${formatPercent(totals.winRate)} of ${totals.winRateDenominator} decided (won + lost)`}
          value={`${totals.wins} / ${totals.losses} / ${totals.voidsAndPushes}`}
        />
      </div>

      <p className="muted betting-basis-note">
        {PROFIT_BASIS_NOTE} {ROI_DENOMINATOR_NOTE} Void and push share one status in the database and are counted
        together.
      </p>

      <div className="betting-filter-row">
        <label>
          <span className="muted">Competition</span>
          <select
            onChange={(event) => updateFilter({ competitionId: event.target.value })}
            value={filters.competitionId}
          >
            <option value="all">All loaded competitions</option>
            {competitionOptions.map((option) => (
              <option key={option.id} value={option.id}>{option.label} ({option.count})</option>
            ))}
          </select>
        </label>
        <label>
          <span className="muted">Market</span>
          <select onChange={(event) => updateFilter({ market: event.target.value })} value={filters.market}>
            <option value="all">All markets</option>
            {marketOptions.map((option) => (
              <option key={option.id} value={option.id}>{option.label} ({option.count})</option>
            ))}
          </select>
        </label>
        <label>
          <span className="muted">Status</span>
          <select onChange={(event) => updateFilter({ status: event.target.value })} value={filters.status}>
            {TICKET_STATUS_FILTERS.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="muted">Placed from</span>
          <input onChange={(event) => updateFilter({ from: event.target.value })} type="date" value={filters.from} />
        </label>
        <label>
          <span className="muted">Placed to</span>
          <input onChange={(event) => updateFilter({ to: event.target.value })} type="date" value={filters.to} />
        </label>
        <button
          className="ghost-button"
          onClick={() => setFilters({ ...DEFAULT_FILTERS })}
          type="button"
        >
          Reset
        </button>
      </div>

      <CumulativeProfitChart curve={curve} payoutFormatter={money} />

      <div className="betting-market-breakdown">
        <h3>Results by market</h3>
        {markets.length ? (
          <div className="betting-table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Market</th>
                  <th scope="col">Tickets</th>
                  <th scope="col">Settled</th>
                  <th scope="col">W / L / V</th>
                  <th scope="col">Wagered</th>
                  <th scope="col">Net profit</th>
                  <th scope="col">ROI</th>
                </tr>
              </thead>
              <tbody>
                {markets.map((entry) => (
                  <tr key={entry.betType}>
                    <th scope="row">{entry.label}</th>
                    <td>{entry.tickets}</td>
                    <td>{entry.settled}</td>
                    <td>{entry.wins} / {entry.losses} / {entry.voidsAndPushes}</td>
                    <td>{money(entry.wagered)}</td>
                    <td className={entry.netProfit > 0 ? 'betting-positive' : entry.netProfit < 0 ? 'betting-negative' : ''}>
                      {entry.netProfit > 0 ? '+' : ''}{money(entry.netProfit)}
                    </td>
                    <td>{entry.roi == null ? '--' : formatPercent(entry.roi)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No tickets match these filters.</p>
        )}
        <p className="muted betting-basis-note">
          Ticket counts are the sample behind each row. ROI uses only that market’s won and lost wagers; a row with no
          decided tickets shows no rate rather than a zero.
        </p>
      </div>

      {filteredTickets.length ? (
        <>
          <div className="feed-list">
            {visibleTickets.map((bet) => {
              const game = gamesById[String(bet.game_id)]
              const progress = game
                ? getBetProgress(bet, game, plateAppearances, pitchingStints, charactersById, playersById)
                : null
              return (
                <button
                  className="betting-ticket my-bet-ticket my-bet-ticket-button"
                  key={bet.id}
                  onClick={(event) => {
                    triggerRef.current = event.currentTarget
                    setReceiptBetId(bet.id)
                  }}
                  type="button"
                >
                  <div className="bet-card-head">
                    <strong>{game ? formatBetTitle(bet, game, playersById, identitiesByPlayerId) : getMarketLabel(bet.bet_type)}</strong>
                    <span
                      className="status-pill"
                      style={{ background: `${STATUS_COLORS[bet.status] || '#94A3B8'}22`, color: STATUS_COLORS[bet.status] || '#94A3B8' }}
                    >
                      {bet.status}
                    </span>
                  </div>
                  <div className="muted">
                    {game ? formatMyBetContext(bet, game, playersById, identitiesByPlayerId) : 'Game unavailable'}
                    {bet.competitionLabel ? ` · ${bet.competitionLabel}` : ''}
                  </div>

                  {progress ? <BetProgressMeter progress={progress} status={bet.status} /> : null}

                  <div className="betting-ticket-meta">
                    <span className="muted">Accepted odds: <strong>{formatOdds(bet.odds)}</strong></span>
                    <span className="muted">Wager: {money(bet.wager_dollars)}</span>
                    <span className="muted">
                      To return: {money(Number(bet.wager_dollars || 0) + Number(bet.potential_payout_dollars || 0))}
                    </span>
                    <span className="my-bet-ticket-open">Receipt <ChevronRight size={14} /></span>
                  </div>
                </button>
              )
            })}
          </div>

          {pageCount > 1 ? (
            <nav aria-label="Ticket pages" className="betting-pagination">
              <button
                className="ghost-button"
                disabled={safePage === 0}
                onClick={() => setPage((current) => Math.max(0, current - 1))}
                type="button"
              >
                Previous
              </button>
              <span className="muted">Page {safePage + 1} of {pageCount}</span>
              <button
                className="ghost-button"
                disabled={safePage >= pageCount - 1}
                onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
                type="button"
              >
                Next
              </button>
            </nav>
          ) : null}
        </>
      ) : (
        <div className="empty-state betting-tickets-empty">
          <strong>{tickets.length ? 'No tickets match these filters' : 'No bets here'}</strong>
          <span className="muted">
            {tickets.length ? 'Adjust or reset the filters above.' : 'Place a bet from the board to see it here.'}
          </span>
        </div>
      )}

      {receipt ? (
        <BetReceiptModal
          characterId={receiptCharacterId}
          competitionId={activeTicket?.competitionId ?? competitionId}
          onClose={() => setReceiptBetId(null)}
          payoutFormatter={money}
          progress={receiptProgress}
          receipt={receipt}
          returnFocusRef={triggerRef}
          sourceType={sourceType}
        />
      ) : null}
    </section>
  )
}
