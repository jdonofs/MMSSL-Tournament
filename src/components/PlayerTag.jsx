import TeamLogo from './TeamLogo'

export default function PlayerTag({
  player,
  playerId,
  playersById = {},
  identitiesByPlayerId = {},
  showPlaceholder = true,
  height = 24,
  textStyle = {},
  color,
  style = {},
}) {
  const resolvedPlayer = player || playersById[playerId] || null
  const identity = identitiesByPlayerId[resolvedPlayer?.id || playerId] || null

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
        logoKey={identity?.teamLogoKey}
        placeholder={showPlaceholder}
        teamName={identity?.teamName}
      />
      <span
        style={{
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          color: color || resolvedPlayer?.color || 'inherit',
          ...textStyle,
        }}
      >
        {resolvedPlayer?.name || 'TBD'}
      </span>
    </span>
  )
}
