import StatIcon from '../../../components/StatIcon'
import { Avatar } from './ScorebookPrimitives'
import { C } from './theme'

export default function ScorebookLineupColumn({
  lineup,
  currentIdx,
  teamColor,
  stat,
  draggable: isDraggable,
  currentPitcherCharId,
  pendingPitcherCharId,
  onDragStart,
  onItemClick,
  onCharacterClick,
  charactersById,
  orientation = 'vertical',
  wrap = false,
}) {
  const isHorizontal = orientation === 'horizontal'
  const isCompact = isHorizontal && wrap
  const avatarSize = isCompact ? 30 : 36
  return (
    <div style={{
      display: 'flex',
      flexDirection: isHorizontal ? 'row' : 'column',
      alignItems: isHorizontal ? 'center' : 'center',
      gap: isHorizontal ? (isCompact ? 4 : 8) : 2,
      minWidth: 0,
      width: '100%',
    }}>
      <div style={{
        marginBottom: isHorizontal ? 0 : 2,
        flexShrink: 0,
        width: isHorizontal ? (isCompact ? 20 : 28) : 'auto',
        display: 'flex',
        justifyContent: 'center',
      }}>
        <StatIcon stat={stat} size={isCompact ? 14 : 16} style={{ opacity: 0.75 }} />
      </div>
      <div style={{
        display: 'flex',
        flexDirection: isHorizontal ? 'row' : 'column',
        flexWrap: isHorizontal && wrap ? 'wrap' : 'nowrap',
        gap: isCompact ? 2 : 3,
        overflowX: isHorizontal && !wrap ? 'auto' : 'visible',
        overflowY: isHorizontal ? 'hidden' : 'auto',
        scrollbarWidth: 'none',
        maxHeight: isHorizontal ? 'none' : 220,
        width: '100%',
        minWidth: 0,
        alignItems: isHorizontal && wrap ? 'flex-start' : 'center',
        paddingBottom: isHorizontal ? 2 : 0,
      }}>
        {lineup.map((entry, i) => {
          const char = charactersById[entry.character_id]
          const isCurrentPitcher = isDraggable && entry.character_id === currentPitcherCharId
          const isPending = isDraggable && entry.character_id === pendingPitcherCharId
          const isCurrent = isDraggable ? isCurrentPitcher : i === currentIdx
          const borderColor = isPending ? '#A78BFA' : isCurrent ? teamColor : C.border
          const shadow = isPending ? '0 0 8px #A78BFA' : isCurrent ? `0 0 6px ${teamColor}` : 'none'
          const handleClick = isDraggable && onItemClick
            ? () => onItemClick(entry.character_id, entry.player_id)
            : (!isDraggable && onCharacterClick ? () => onCharacterClick(entry.character_id, entry.player_id) : undefined)
          return (
            <div
              key={entry.character_id ?? entry.id ?? i}
              draggable={isDraggable}
              onDragStart={isDraggable ? onDragStart(entry.character_id, entry.player_id) : undefined}
              onClick={handleClick}
              title={char?.name}
              style={{ position: 'relative', cursor: handleClick ? 'pointer' : 'default', opacity: (isCurrent || isPending) ? 1 : 0.45, flexShrink: 0 }}
            >
              <div style={{ width: avatarSize, height: avatarSize, borderRadius: '50%', overflow: 'hidden', border: `2px solid ${borderColor}`, boxShadow: shadow, transition: 'border-color 0.15s, box-shadow 0.15s' }}>
                <Avatar name={char?.name} size={avatarSize} />
              </div>
              <div style={{ position: 'absolute', bottom: -1, right: -1, width: 13, height: 13, borderRadius: '50%', background: isPending ? '#A78BFA' : isCurrent ? teamColor : C.card, border: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 7, fontWeight: 900, color: (isCurrent || isPending) ? '#000' : C.muted }}>
                {i + 1}
              </div>
            </div>
          )
        })}
        {lineup.length === 0 && (
          <div style={{ fontSize: 10, color: C.border, textAlign: 'center', padding: 6 }}>—</div>
        )}
      </div>
    </div>
  )
}
