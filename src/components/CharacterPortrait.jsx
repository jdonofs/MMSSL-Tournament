import { getCharacterImage } from '../utils/characterImages'
import { getCharacterSpriteMeta } from '../utils/characterSprites'

const PORTRAIT_ASSET_VERSION = 'mss-select-icons-2026-05-11'

const CUSTOM_IMAGE_OVERRIDES = {
  Mii: '/characters/mii-custom.png',
}

// Base characters that only exist as colored variants in the sprite sheet
const PORTRAIT_FALLBACKS = {
  'Pianta': 'Blue Pianta',
  'Noki':   'Blue Noki',
  'Toad':   'Red Toad',
}

function withAssetVersion(src) {
  if (!src) return src
  const separator = src.includes('?') ? '&' : '?'
  return `${src}${separator}v=${PORTRAIT_ASSET_VERSION}`
}

export default function CharacterPortrait({
  name,
  size = 36,
  style = {},
  borderRadius = '50%',
  fallbackText,
  draggable = false,
  objectFit = 'cover',
}) {
  const overrideSrc = CUSTOM_IMAGE_OVERRIDES[name] || (name?.endsWith?.(' Mii') ? CUSTOM_IMAGE_OVERRIDES.Mii : null)
  const resolvedName = PORTRAIT_FALLBACKS[name] || name
  const fallbackLabel = fallbackText || name?.[0] || '?'

  if (overrideSrc) {
    return (
      <img
        src={withAssetVersion(overrideSrc)}
        alt={name}
        draggable={draggable}
        style={{
          width: size,
          height: size,
          borderRadius,
          objectFit,
          objectPosition: 'center',
          flexShrink: 0,
          ...style,
        }}
      />
    )
  }

  const src = getCharacterImage(resolvedName)
  if (src) {
    return (
      <img
        src={withAssetVersion(src)}
        alt={name}
        draggable={draggable}
        style={{
          width: size,
          height: size,
          borderRadius,
          objectFit,
          objectPosition: 'center',
          flexShrink: 0,
          ...style,
        }}
      />
    )
  }

  const sprite = getCharacterSpriteMeta(resolvedName)
  if (sprite) {
    const scaleX = size / sprite.sourceWidth
    const scaleY = size / sprite.sourceHeight

    return (
      <div
        style={{
          position: 'relative',
          width: size,
          height: size,
          overflow: 'hidden',
          borderRadius,
          flexShrink: 0,
          background: 'transparent',
          ...style,
        }}
      >
        <img
          src={withAssetVersion(sprite.sheetPath)}
          alt={name}
          draggable={draggable}
          style={{
            position: 'absolute',
            left: -(sprite.sourceX * scaleX),
            top: -(sprite.sourceY * scaleY),
            width: sprite.sheetWidth * scaleX,
            height: sprite.sheetHeight * scaleY,
            maxWidth: 'none',
            userSelect: 'none',
            pointerEvents: 'none',
          }}
        />
      </div>
    )
  }

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius,
        background: '#334155',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.38,
        color: '#94A3B8',
        fontWeight: 700,
        flexShrink: 0,
        ...style,
      }}
    >
      {fallbackLabel}
    </div>
  )
}
