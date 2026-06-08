const KNOWN_KEYS = new Set([
  'mario-fireballs', 'luigi-knights', 'peach-monarchs', 'daisy-flowers',
  'wario-muscles', 'waluigi-symbiants', 'yoshi-eggs', 'birdo-bows',
  'dk-wilds', 'diddy-monkeys', 'bowser-monsters', 'bowser-rookies',
])

export default function TeamLogo({
  logoKey,
  logoUrl,
  teamName,
  height = 24,
  placeholder = false,
  style = {},
}) {
  // Uploaded logos are square (500×500); static captain logos are wide banners.
  if (logoUrl) {
    return (
      <img
        alt={teamName || 'Team logo'}
        src={logoUrl}
        style={{
          height,
          width: height,
          flexShrink: 0,
          objectFit: 'contain',
          display: 'inline-block',
          verticalAlign: 'middle',
          borderRadius: 4,
          ...style,
        }}
      />
    )
  }

  if (!logoKey || !KNOWN_KEYS.has(logoKey)) {
    if (!placeholder) return null

    // Placeholder matches the wide shape of the static captain logos
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
