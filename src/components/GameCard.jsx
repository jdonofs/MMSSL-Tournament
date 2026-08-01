import TeamLogo from './TeamLogo'
import { buildPlayerTeamIdentity, buildSeasonTeamIdentity, getTeamShortName } from '../utils/teamIdentity'

// Picker tile for a completed game, shared by admin tools that start with
// "pick a finished game" (Video Timestamps, At-Bat Data Entry).
export default function GameCard({ game, source, playersById, teamsById, stadiumNamesById, selected, onSelect }) {
  const isSeason = source === 'season'
  const homeIdentity = isSeason
    ? buildSeasonTeamIdentity(teamsById[game.home_team_id] || {})
    : buildPlayerTeamIdentity(playersById[game.team_a_player_id])
  const awayIdentity = isSeason
    ? buildSeasonTeamIdentity(teamsById[game.away_team_id] || {})
    : buildPlayerTeamIdentity(playersById[game.team_b_player_id])
  const homeScore = isSeason ? game.home_score : game.team_a_runs
  const awayScore = isSeason ? game.away_score : game.team_b_runs
  const stadiumLabel = isSeason ? game.stadium : stadiumNamesById[game.stadium_id]
  const subLabel = isSeason ? `Round ${game.round_number}` : (game.game_code || `Game ${game.id}`)

  return (
    <button
      type="button"
      onClick={onSelect}
      className="game-picker-card"
      style={{
        display: 'grid',
        gap: 8,
        textAlign: 'left',
        padding: 14,
        borderRadius: 12,
        border: selected ? '2px solid #EAB308' : '1px solid var(--border, rgba(148,163,184,0.25))',
        background: selected ? 'rgba(234,179,8,0.08)' : 'rgba(15,23,42,0.4)',
        cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, fontWeight: 800, textTransform: 'uppercase', color: 'var(--muted, #94A3B8)' }}>
        <span>{subLabel}</span>
        <span>Final</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <TeamLogo logoUrl={awayIdentity?.teamLogoUrl} logoKey={awayIdentity?.teamLogoKey} teamName={awayIdentity?.teamName} height={24} />
          <span style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {getTeamShortName(awayIdentity) || 'Away'}
          </span>
        </div>
        <span style={{ fontSize: 14, fontWeight: 800 }}>{awayScore ?? '—'}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <TeamLogo logoUrl={homeIdentity?.teamLogoUrl} logoKey={homeIdentity?.teamLogoKey} teamName={homeIdentity?.teamName} height={24} />
          <span style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {getTeamShortName(homeIdentity) || 'Home'}
          </span>
        </div>
        <span style={{ fontSize: 14, fontWeight: 800 }}>{homeScore ?? '—'}</span>
      </div>
      {stadiumLabel ? <div className="muted" style={{ fontSize: 11 }}>{stadiumLabel}</div> : null}
      {game.video_url ? <div style={{ fontSize: 11, color: '#4ADE80', fontWeight: 700 }}>Video linked</div> : null}
    </button>
  )
}
