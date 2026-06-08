import { Pipette } from 'lucide-react'

// Lets the user sample a color from anywhere on screen via the browser's
// EyeDropper API. Only Chromium-based browsers support it, so the button
// quietly hides itself everywhere else (the native color input still works).
export default function EyeDropperButton({ onPick, title = 'Pick color from screen' }) {
  if (typeof window === 'undefined' || !('EyeDropper' in window)) return null

  const handleClick = async () => {
    try {
      const dropper = new window.EyeDropper()
      const result = await dropper.open()
      if (result?.sRGBHex) onPick(result.sRGBHex)
    } catch {
      // user pressed Escape or dismissed the picker
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      title={title}
      aria-label={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 32,
        height: 32,
        border: '1px solid #334155',
        borderRadius: 6,
        background: '#1E293B',
        color: '#94A3B8',
        cursor: 'pointer',
        padding: 0,
        flexShrink: 0,
      }}
    >
      <Pipette size={16} />
    </button>
  )
}
