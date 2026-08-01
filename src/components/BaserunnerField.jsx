import CharacterPortrait from './CharacterPortrait'

const SAFE_DESTINATIONS = ['first', 'second', 'third', 'home']
const DESTINATION_OPTIONS = [
  { key: 'first', label: '1B', color: '#22C55E' },
  { key: 'second', label: '2B', color: '#22C55E' },
  { key: 'third', label: '3B', color: '#22C55E' },
  { key: 'home', label: 'Home', color: '#EAB308' },
  { key: 'out', label: 'Out', color: '#EF4444' },
]
const POSITION_LABELS = {
  plate: 'Plate',
  first: '1B',
  second: '2B',
  third: '3B',
  home: 'Home',
  out: 'Out',
}

function getRunnerFloor(entry) {
  return entry.id === 'batter' ? 'first' : entry.origin
}

function isDestinationAllowed(entry, destination) {
  if (destination === 'out') return true
  const floorIndex = SAFE_DESTINATIONS.indexOf(getRunnerFloor(entry))
  const destinationIndex = SAFE_DESTINATIONS.indexOf(destination)
  return floorIndex !== -1 && destinationIndex >= floorIndex
}

function getStatusLabel(entry) {
  if (entry.id === 'batter') return 'Batter'
  return POSITION_LABELS[entry.origin] || entry.origin
}

export default function BaserunnerField({
  entries = [],
  charactersById = {},
  onSetPosition,
  accent = '#EAB308',
  label = 'Where Did The Runners End Up',
}) {
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {label ? (
        <div style={{ fontSize: 12, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase' }}>{label}</div>
      ) : null}

      <div style={{ border: '1px solid #1E293B', borderRadius: 16, background: '#0B1120', overflow: 'hidden' }}>
        {!entries.length ? (
          <div style={{ padding: 16, color: '#94A3B8', fontSize: 13 }}>No active runners to place.</div>
        ) : (
          <div>
            {entries.map((entry, index) => {
              const name = charactersById[entry.runner?.characterId]?.name || 'Unknown runner'
              const startedLabel = POSITION_LABELS[entry.origin] || entry.origin

              return (
                <div
                  key={entry.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '56px minmax(0, 1fr)',
                    gap: 12,
                    alignItems: 'center',
                    padding: '12px',
                    borderTop: index ? '1px solid #1E293B' : 'none',
                  }}
                >
                  <div style={{ display: 'grid', justifyItems: 'center', gap: 4 }}>
                    <div style={{ width: 40, height: 40, borderRadius: '50%', overflow: 'hidden', border: `2px solid ${accent}`, background: '#0F172A', flexShrink: 0 }}>
                      <CharacterPortrait name={name} size={40} borderRadius={0} objectFit="contain" />
                    </div>
                    <div style={{ color: '#94A3B8', fontSize: 10, fontWeight: 800, textTransform: 'uppercase', textAlign: 'center', lineHeight: 1.1 }}>
                      {getStatusLabel(entry)}
                    </div>
                  </div>

                  <div style={{ overflowX: 'auto', overflowY: 'hidden' }}>
                    <div style={{ display: 'flex', flexWrap: 'nowrap', gap: 6, minWidth: 'max-content' }}>
                      {DESTINATION_OPTIONS.map((option) => {
                        const isAllowed = isDestinationAllowed(entry, option.key)
                        const isSelected = entry.position === option.key

                        return (
                          <button
                            key={option.key}
                            type="button"
                            onClick={() => onSetPosition?.(entry.id, option.key)}
                            disabled={!isAllowed}
                            style={{
                              minWidth: option.key === 'home' ? 58 : 44,
                              minHeight: 34,
                              padding: '0 10px',
                              borderRadius: 999,
                              border: `1px solid ${isSelected ? option.color : '#334155'}`,
                              background: isSelected ? `${option.color}26` : 'transparent',
                              color: isSelected ? option.color : isAllowed ? '#CBD5E1' : '#64748B',
                              fontSize: 11,
                              fontWeight: 800,
                              cursor: isAllowed ? 'pointer' : 'not-allowed',
                              opacity: isAllowed ? 1 : 0.35,
                              whiteSpace: 'nowrap',
                              flex: '0 0 auto',
                            }}
                            title={!isAllowed ? `Can't move this runner behind ${startedLabel}.` : undefined}
                          >
                            {option.label}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
