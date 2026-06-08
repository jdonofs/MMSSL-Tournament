import battingIcon from '../assets/stat-icons/batting.png'
import fieldingIcon from '../assets/stat-icons/fielding.png'
import pitchingIcon from '../assets/stat-icons/pitching.png'
import speedIcon from '../assets/stat-icons/speed.png'

const ICONS = {
  batting: { src: battingIcon, label: 'Batting' },
  pitch: { src: pitchingIcon, label: 'Pitching' },
  pitching: { src: pitchingIcon, label: 'Pitching' },
  field: { src: fieldingIcon, label: 'Fielding' },
  fielding: { src: fieldingIcon, label: 'Fielding' },
  speed: { src: speedIcon, label: 'Speed' },
}

export default function StatIcon({ stat, size = 14, style = {} }) {
  const icon = ICONS[String(stat || '').toLowerCase()]
  if (!icon) return null

  return (
    <img
      src={icon.src}
      alt={icon.label}
      title={icon.label}
      style={{ width: size, height: size, objectFit: 'contain', display: 'block', ...style }}
    />
  )
}
