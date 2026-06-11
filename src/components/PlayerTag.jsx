import TeamLogo from './TeamLogo'
import { getTeamAbbreviation, getTeamPrimaryColor, getTeamShortName } from '../utils/teamIdentity'

export default function PlayerTag({
  player,
  playerId,
  playersById = {},
  identitiesByPlayerId = {},
  showPlaceholder = true,
  showLogo = true,
  height = 36,
  nameMode = 'short',
  textStyle = {},
  color,
  style = {},
}) {
  const resolvedPlayer = player || playersById[playerId] || null
  const identity = identitiesByPlayerId[resolvedPlayer?.id || playerId] || null
  const displayName = (
    nameMode === 'abbreviation'
      ? getTeamAbbreviation(identity)
      : getTeamShortName(identity)
  ) || resolvedPlayer?.name || 'TBD'

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        minWidth: 0,
        ...style,
      }}
    >
      <TeamLogo
        height={height}
        logoKey={showLogo ? identity?.teamLogoKey : null}
        logoUrl={showLogo ? identity?.teamLogoUrl : null}
        placeholder={showLogo ? showPlaceholder : false}
        teamName={identity?.teamName}
      />
      <span
        style={{
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          color: color || getTeamPrimaryColor(identity, resolvedPlayer?.color) || 'inherit',
          ...textStyle,
        }}
      >
        {displayName}
      </span>
    </span>
  )
}
