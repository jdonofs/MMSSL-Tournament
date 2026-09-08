import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import CharacterPortrait from '../CharacterPortrait'
import { buildPropResearch } from '../../utils/propResearch'
import { buildScorebookPath } from '../../utils/scorebookRouting'

// Recent per-game values as a compact bar strip. One series, no axis furniture:
// each bar is labelled with its own value and its game, so the numbers are read
// from the labels rather than estimated off a scale.
function RecentStrip({ entries, unit, sourceType }) {
  const max = Math.max(1, ...entries.map((entry) => entry.value))
  return (
    <ul className="prop-research-strip">
      {entries.map((entry) => (
        <li key={entry.gameId}>
          <Link
            className="prop-research-strip-link"
            to={buildScorebookPath({ gameId: entry.sourceGameId, source: sourceType })}
          >
            <span className="prop-research-strip-bar" style={{ height: `${Math.max(6, (entry.value / max) * 34)}px` }} />
            <strong>{entry.value}</strong>
            <span className="muted">{entry.opponent || entry.gameCode}</span>
          </Link>
        </li>
      ))}
      <li className="prop-research-strip-unit muted">{unit}</li>
    </ul>
  )
}

// Optional context beside a hit / home-run / strikeout market.
//
// It reports what the target has actually done in this competition's completed
// games and nothing else: no probability, no implied edge, no recommendation.
// The odds model is not consulted and is not affected.
export default function PropResearchCard({
  betType,
  targetEntity,
  games = [],
  plateAppearances = [],
  pitchingStints = [],
  charactersById = {},
  playersById = {},
  currentGameId = null,
  competitionLabel = '',
  labelForPlayer = null,
  matchupNote = '',
  sourceType = 'tournament',
  characterId = null,
  competitionId = null,
  defaultOpen = false,
}) {
  const [open, setOpen] = useState(defaultOpen)

  const research = useMemo(() => (open ? buildPropResearch({
    betType,
    targetEntity,
    games,
    plateAppearances,
    pitchingStints,
    charactersById,
    playersById,
    currentGameId,
    competitionLabel,
    labelForPlayer,
    matchupNote,
  }) : null), [
    open, betType, targetEntity, games, plateAppearances, pitchingStints,
    charactersById, playersById, currentGameId, competitionLabel, labelForPlayer, matchupNote,
  ])

  const characterPath = characterId != null && competitionId != null
    ? `/character/${characterId}/${sourceType === 'season' ? 'season' : 'tournament'}/${competitionId}`
    : null

  return (
    <div className="prop-research">
      <button
        aria-expanded={open}
        className="link-button prop-research-toggle"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        {open ? 'Hide research' : 'Research'}
      </button>

      {open && research ? (
        <div className="prop-research-body">
          <div className="prop-research-head">
            <CharacterPortrait name={research.entity.characterName} size={30} />
            <div>
              <strong>
                {characterPath
                  ? <Link to={characterPath}>{research.entity.characterName}</Link>
                  : research.entity.characterName}
              </strong>
              <span className="muted">
                {research.role === 'pitcher' ? 'Pitcher' : 'Batter'}
                {research.entity.playerName ? ` · ${research.entity.playerName}` : ''}
                {research.matchupNote ? ` · ${research.matchupNote}` : ''}
              </span>
            </div>
          </div>

          <div className="prop-research-stats">
            <div>
              <span className="muted">{research.statLabel} per game</span>
              <strong>{research.average == null ? '--' : research.average.toFixed(2)}</strong>
              <span className="muted">{research.denominatorLabel}</span>
            </div>
            <div>
              <span className="muted">Eligible sample</span>
              <strong>{research.eligibleGames}</strong>
              <span className="muted">
                of {research.completedGamesInCompetition} completed {competitionLabel ? `${competitionLabel} ` : ''}
                game{research.completedGamesInCompetition === 1 ? '' : 's'}
              </span>
            </div>
            <div>
              <span className="muted">Total {research.statLabel.toLowerCase()}</span>
              <strong>{research.total}</strong>
              <span className="muted">across the eligible games</span>
            </div>
          </div>

          {research.recent.length ? (
            <>
              <span className="muted prop-research-label">
                Last {research.recent.length} completed game{research.recent.length === 1 ? '' : 's'} played
              </span>
              <RecentStrip entries={research.recent} sourceType={sourceType} unit={research.unit} />
            </>
          ) : (
            <p className="muted">No completed game with a recorded appearance to show.</p>
          )}

          {research.live && research.live.appeared ? (
            <p className="muted prop-research-live">
              This game so far: <strong>{research.live.value} {research.live.value === 1 ? research.unitSingular : research.unit}</strong>. {research.live.note}
            </p>
          ) : null}

          {research.coverage.map((note) => (
            <p className="muted prop-research-coverage" key={note}>{note}</p>
          ))}

          <p className="muted prop-research-disclaimer">
            Past results only. This is not a probability and does not describe the price.
          </p>
        </div>
      ) : null}
    </div>
  )
}
