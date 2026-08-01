import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getStatDescription } from '../utils/statGlossary'

const LONG_PRESS_MS = 450
const TOUCH_DISMISS_MS = 2500
const BUBBLE_HALF_WIDTH = 115

// Renders a stat column label with a hover (desktop) / tap-and-hold (mobile) tooltip when a
// description is available for it. Plain text is returned untouched for simple counting stats
// (H, HR, RBI, ...) that don't need one, so callers can wrap every header unconditionally.
//
// The bubble is portaled to document.body and positioned with `fixed` coordinates computed from
// the label's own bounding box, rather than living inline as an absolutely-positioned child —
// most stat tables live inside sticky-header / horizontally-scrolling containers with
// `overflow: hidden` on the header cells themselves, which would silently clip an inline bubble.
export default function StatLabel({ label, description }) {
  const tip = description ?? getStatDescription(label)
  const wrapRef = useRef(null)
  const [pos, setPos] = useState(null)
  const pressTimer = useRef(null)
  const dismissTimer = useRef(null)
  const longPressed = useRef(false)

  if (!tip) return label

  function clearTimers() {
    if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null }
    if (dismissTimer.current) { clearTimeout(dismissTimer.current); dismissTimer.current = null }
  }

  function show() {
    const rect = wrapRef.current?.getBoundingClientRect()
    if (!rect) return
    const left = Math.min(
      Math.max(rect.left + rect.width / 2, BUBBLE_HALF_WIDTH + 8),
      window.innerWidth - BUBBLE_HALF_WIDTH - 8,
    )
    setPos({ top: rect.bottom + 6, left })
  }

  function hide() {
    setPos(null)
  }

  function handleTouchStart() {
    longPressed.current = false
    clearTimers()
    pressTimer.current = setTimeout(() => {
      longPressed.current = true
      show()
    }, LONG_PRESS_MS)
  }

  function handleTouchEnd(event) {
    if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null }
    if (longPressed.current) {
      // A long-press shouldn't also trigger the header's click-to-sort handler.
      event.preventDefault()
      event.stopPropagation()
      dismissTimer.current = setTimeout(hide, TOUCH_DISMISS_MS)
    }
  }

  function handleClickCapture(event) {
    if (longPressed.current) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  return (
    <span
      ref={wrapRef}
      className="stat-tip"
      tabIndex={0}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
      onTouchMove={clearTimers}
      onClickCapture={handleClickCapture}
    >
      {label}
      {pos && createPortal(
        <span className="stat-tip-bubble" role="tooltip" style={{ top: pos.top, left: pos.left }}>
          {tip}
        </span>,
        document.body,
      )}
    </span>
  )
}
