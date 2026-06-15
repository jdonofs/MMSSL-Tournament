import CharacterPortrait from './CharacterPortrait'
import { formatPlateAppearanceResult } from '../utils/plateAppearance'

export default function BatterCard({
  batter,
  batterName,
  playerName,
  playerColor,
  battingOrder,
  seasonStats,
  gameResults = [],
  onPrev,
  onNext,
  disableCycle,
}) {
  if (!batter) return null

  return (
    <div style={{ background: '#1E293B', borderRadius: 16, padding: 12, border: '1px solid #334155', marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button type="button" onClick={onPrev} disabled={disableCycle} style={{ minWidth: 44, minHeight: 44, borderRadius: 12, border: '1px solid #334155', background: '#0F172A', color: '#CBD5E1' }}>{'<'}</button>
        <div style={{ width: 56, height: 56, borderRadius: '50%', overflow: 'hidden', border: `2px solid ${playerColor || '#EAB308'}` }}>
          <CharacterPortrait name={batterName} size={56} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{batterName}</div>
          <div style={{ color: playerColor || '#EAB308', fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }}>{playerName} · #{battingOrder}</div>
          {seasonStats?.plateAppearances > 0 ? (
            <div style={{ display: 'flex', gap: 10, marginTop: 4, color: '#94A3B8', fontSize: 11 }}>
              <span>AVG {seasonStats.avg.toFixed(3)}</span>
              <span>HR {seasonStats.homeRuns}</span>
              <span>RBI {seasonStats.rbi}</span>
            </div>
          ) : null}
        </div>
        <button type="button" onClick={onNext} disabled={disableCycle} style={{ minWidth: 44, minHeight: 44, borderRadius: 12, border: '1px solid #334155', background: '#0F172A', color: '#CBD5E1' }}>{'>'}</button>
      </div>
      {gameResults.length ? (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
          {gameResults.map((result) => (
            <span key={result.id} style={{ borderRadius: 999, border: '1px solid rgba(255,255,255,0.12)', padding: '4px 8px', fontSize: 11, fontWeight: 700, color: '#E2E8F0' }}>
              {formatPlateAppearanceResult(result)}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}
