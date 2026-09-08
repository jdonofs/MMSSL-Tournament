import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { X } from 'lucide-react'
import CharacterPortrait from '../CharacterPortrait'
import BetProgressMeter from './BetProgressMeter'
import OddsHistoryPanel, { selectMarketObservations } from './OddsHistoryPanel'
import useOddsHistory from '../../hooks/useOddsHistory'
import { formatOdds } from '../../utils/bettingMarkets'
import { buildScorebookPath } from '../../utils/scorebookRouting'

const STATUS_COLORS = {
  open: '#EAB308',
  pending: '#EAB308',
  won: '#22C55E',
  lost: '#EF4444',
  void: '#94A3B8',
}

const STATUS_LABELS = {
  open: 'Open',
  pending: 'Pending',
  won: 'Won',
  lost: 'Lost',
  void: 'Void / Push',
}

const CREDIT_LABELS = {
  credited: 'Credited',
  pending: 'Awaiting credit',
  'no-credit-expected': 'No credit due',
  mismatch: 'Awaiting resettlement',
  unknown: 'Not confirmed here',
  open: 'Not settled',
}

const FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])'

function formatTimestamp(value) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}

function Money({ value, formatter, fallback = 'Not recorded' }) {
  if (value == null) return <strong className="muted">{fallback}</strong>
  return <strong>{formatter(value)}</strong>
}

export default function BetReceiptModal({
  receipt,
  onClose,
  payoutFormatter,
  progress = null,
  sourceType = 'tournament',
  competitionId = null,
  characterId = null,
  returnFocusRef = null,
}) {
  const dialogRef = useRef(null)
  const closeRef = useRef(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const history = useOddsHistory({
    sourceType,
    gameId: receipt?.bet?.game_id ?? null,
    enabled: Boolean(receipt) && historyOpen,
  })

  const handleKeyDown = useCallback((event) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key !== 'Tab') return
    const nodes = Array.from(dialogRef.current?.querySelectorAll(FOCUSABLE) || [])
      .filter((node) => node.offsetParent !== null || node === document.activeElement)
    if (!nodes.length) return
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }, [onClose])

  useEffect(() => {
    if (!receipt) return undefined
    const previouslyFocused = returnFocusRef?.current || document.activeElement
    closeRef.current?.focus()
    return () => {
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') previouslyFocused.focus()
    }
  }, [receipt, returnFocusRef])

  const marketObservations = useMemo(
    () => (receipt
      ? selectMarketObservations(history.rows, {
        betType: receipt.bet.bet_type,
        targetEntity: receipt.bet.target_entity || null,
      })
      : []),
    [history.rows, receipt],
  )

  if (!receipt) return null

  const { bet, game, labels, acceptedTerms, currentMarket, financials, outcome, settlement } = receipt
  const statusColor = STATUS_COLORS[bet.status] || '#94A3B8'
  const gamePath = game ? buildScorebookPath({ gameId: game.source_game_id ?? game.id, source: sourceType }) : null
  const characterPath = characterId != null && competitionId != null
    ? `/character/${characterId}/${sourceType === 'season' ? 'season' : 'tournament'}/${competitionId}`
    : null
  const teamPathFor = (playerId) => (playerId && competitionId != null
    ? `/teams/${playerId}/${sourceType === 'season' ? 'season' : 'tournament'}/${competitionId}`
    : null)

  return (
    <div className="bet-receipt-backdrop" onClick={onClose} role="presentation">
      <div
        aria-labelledby="bet-receipt-title"
        aria-modal="true"
        className="bet-receipt-dialog"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="bet-receipt-head">
          <div className="bet-receipt-head-copy">
            <span className="muted bet-receipt-kicker">
              {receipt.competitionLabel ? `${receipt.competitionLabel} · ` : ''}{receipt.marketLabel}
            </span>
            <h2 id="bet-receipt-title">{acceptedTerms.sideLabel}</h2>
            <span className="muted">{receipt.matchup || 'Game unavailable'}</span>
          </div>
          <div className="bet-receipt-head-actions">
            <span className="status-pill" style={{ background: `${statusColor}22`, color: statusColor }}>
              {STATUS_LABELS[bet.status] || bet.status}
            </span>
            <button aria-label="Close receipt" className="icon-button" onClick={onClose} ref={closeRef} type="button">
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="bet-receipt-body">
          <section className="bet-receipt-section">
            <h3>Ticket</h3>
            <dl className="bet-receipt-grid">
              <div>
                <dt>Market</dt>
                <dd>{receipt.marketLabel}</dd>
              </div>
              <div>
                <dt>Selection</dt>
                <dd>{acceptedTerms.sideLabel}</dd>
              </div>
              <div>
                <dt>Teams</dt>
                <dd>
                  {teamPathFor(game?.team_a_player_id)
                    ? <Link to={teamPathFor(game.team_a_player_id)}>{labels.away}</Link>
                    : labels.away}
                  {' @ '}
                  {teamPathFor(game?.team_b_player_id)
                    ? <Link to={teamPathFor(game.team_b_player_id)}>{labels.home}</Link>
                    : labels.home}
                </dd>
              </div>
              {receipt.targetEntity ? (
                <div>
                  <dt>Target</dt>
                  <dd className="bet-receipt-target">
                    <CharacterPortrait name={receipt.targetCharacterName} size={28} />
                    {characterPath
                      ? <Link to={characterPath}>{receipt.targetEntity}</Link>
                      : <span>{receipt.targetEntity}</span>}
                  </dd>
                </div>
              ) : null}
            </dl>
          </section>

          <section className="bet-receipt-section">
            <h3>Accepted terms</h3>
            <dl className="bet-receipt-grid">
              <div>
                <dt>Accepted odds</dt>
                <dd><strong>{acceptedTerms.oddsLabel}</strong></dd>
              </div>
              <div>
                <dt>Accepted line</dt>
                <dd><strong>{acceptedTerms.lineLabel ?? 'No line on this market'}</strong></dd>
              </div>
              <div>
                <dt>Placed</dt>
                <dd>{formatTimestamp(acceptedTerms.placedAt) || <span className="muted">Not recorded</span>}</dd>
              </div>
              <div>
                <dt>Score / inning at placement</dt>
                <dd className="muted">Not recorded</dd>
              </div>
            </dl>
            <p className="bet-receipt-note muted">
              {receipt.placementContext.note} This ticket settles on the accepted odds and line above; a later
              board move does not change them.
            </p>
          </section>

          <section className="bet-receipt-section">
            <h3>Current market</h3>
            {currentMarket.available ? (
              <dl className="bet-receipt-grid">
                <div>
                  <dt>Current odds (your side)</dt>
                  <dd>
                    <strong>{formatOdds(currentMarket.currentOdds)}</strong>
                    {currentMarket.oddsDelta ? (
                      <span className="muted"> ({currentMarket.oddsDelta > 0 ? '+' : ''}{currentMarket.oddsDelta} vs accepted)</span>
                    ) : null}
                  </dd>
                </div>
                <div>
                  <dt>Current line</dt>
                  <dd><strong>{currentMarket.currentLine == null ? '--' : Number(currentMarket.currentLine).toFixed(1)}</strong></dd>
                </div>
                <div>
                  <dt>Market state</dt>
                  <dd>{currentMarket.isLocked ? 'Locked' : 'Open'}</dd>
                </div>
              </dl>
            ) : null}
            <p className="bet-receipt-note muted">{currentMarket.note}</p>
          </section>

          <section className="bet-receipt-section">
            <h3>How this ticket wins</h3>
            <p className="bet-receipt-conditions">{receipt.winningConditions}</p>
            {receipt.isOpen && progress ? (
              <>
                <BetProgressMeter progress={progress} status={bet.status} />
                <p className="bet-receipt-note muted">Live progress from the game’s recorded rows. Nothing is settled yet.</p>
              </>
            ) : null}
          </section>

          {outcome ? (
            <section className="bet-receipt-section">
              <h3>Result</h3>
              <p className="bet-receipt-outcome"><strong>{outcome.headline}.</strong> {outcome.detail}</p>
              <p className="bet-receipt-note muted">
                {outcome.basis === 'final-score' ? 'Explained from this game’s recorded final score.'
                  : outcome.basis === 'scoring-facts' ? 'Explained from this game’s recorded plate appearances and pitching lines.'
                    : outcome.basis === 'graded-result' ? 'Derived from the recorded grade — the first-inning evidence a settlement used is not retained.'
                      : 'Taken from the ticket’s recorded status; the underlying facts are not available here.'}
              </p>
            </section>
          ) : null}

          <section className="bet-receipt-section">
            <h3>Money</h3>
            <dl className="bet-receipt-grid bet-receipt-money">
              <div>
                <dt>Wager</dt>
                <dd><Money formatter={payoutFormatter} value={financials.wager} /></dd>
              </div>
              <div>
                <dt>Potential net profit</dt>
                <dd><Money formatter={payoutFormatter} value={financials.potentialProfit} /></dd>
              </div>
              <div>
                <dt>Potential total return</dt>
                <dd><Money formatter={payoutFormatter} value={financials.potentialReturn} /></dd>
              </div>
              <div>
                <dt>Actual credited return</dt>
                <dd>
                  <Money formatter={payoutFormatter} value={financials.creditedReturn} fallback="—" />
                  <span className={`bet-receipt-credit-pill bet-receipt-credit-${financials.creditState}`}>
                    {CREDIT_LABELS[financials.creditState] || financials.creditState}
                  </span>
                </dd>
              </div>
            </dl>
            <p className="bet-receipt-note muted">
              Potential total return is the wager plus the potential net profit. {financials.creditNote}
            </p>
          </section>

          <section className="bet-receipt-section">
            <h3>Settlement record</h3>
            {settlement.entries.length ? (
              <ol className="bet-receipt-timeline">
                {settlement.entries.map((entry) => (
                  <li key={`${entry.kind}-${entry.at}`}>
                    <strong>{entry.label}</strong>
                    <span className="muted">{formatTimestamp(entry.at) || 'time not recorded'}</span>
                    {entry.note ? <span className="muted bet-receipt-note">{entry.note}</span> : null}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="muted">No settlement entries are recorded for this ticket.</p>
            )}
            {settlement.notes.map((note) => (
              <p className="bet-receipt-note bet-receipt-warning" key={note}>{note}</p>
            ))}
            <p className="bet-receipt-note muted">{settlement.coverage}</p>
          </section>

          <section className="bet-receipt-section">
            <button
              aria-expanded={historyOpen}
              className="ghost-button bet-receipt-history-toggle"
              onClick={() => setHistoryOpen((current) => !current)}
              type="button"
            >
              {historyOpen ? 'Hide odds history' : 'Show odds history for this market'}
            </button>
            {historyOpen ? (
              <OddsHistoryPanel
                acceptedTerms={acceptedTerms}
                betType={bet.bet_type}
                compact
                labels={labels}
                observations={marketObservations}
                status={history.status === 'refreshing' ? 'ready' : history.status}
              />
            ) : null}
          </section>

          {gamePath ? (
            <div className="bet-receipt-links">
              <Link className="ghost-button" to={gamePath}>Open the game</Link>
              {characterPath ? <Link className="ghost-button" to={characterPath}>{receipt.targetCharacterName}</Link> : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
