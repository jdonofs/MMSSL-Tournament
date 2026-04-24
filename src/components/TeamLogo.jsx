const KNOWN_KEYS = new Set([
  'mario-fireballs', 'luigi-knights', 'peach-monarchs', 'daisy-flowers',
  'wario-muscles', 'waluigi-symbiants', 'yoshi-eggs', 'birdo-bows',
  'dk-wilds', 'diddy-monkeys', 'bowser-monsters', 'bowser-rookies',
])

export default function TeamLogo({
  logoKey,
  teamName,
  height = 24,
  placeholder = false,
  style = {},
}) {
  if (!logoKey || !KNOWN_KEYS.has(logoKey)) {
    return (
      <span
        aria-hidden="true"
        style={{
          display: 'inline-block',
          width: Math.round(height * 2.4),
          height,
          flexShrink: 0,
          ...style,
        }}
      />
    )
  }

  return (
    <img
      alt={teamName || logoKey}
      src={`/team-logos/${logoKey}.png`}
      style={{
        height,
        width: 'auto',
        flexShrink: 0,
        objectFit: 'contain',
        display: 'inline-block',
        verticalAlign: 'middle',
        ...style,
      }}
    />
  )
}
