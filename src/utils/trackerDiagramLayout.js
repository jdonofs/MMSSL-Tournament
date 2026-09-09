// The two parts of the play diagram that are arithmetic rather than drawing.
//
// They live outside the component so they can be tested without a browser --
// and both of them encode a rule that is easy to break by accident while
// nudging pixels:
//
//   A MARKER IS NEVER MOVED TO MAKE ROOM. Two fielders standing on top of each
//   other is a fact about the play. Only the LABEL is displaced, on a leader
//   line, so a readability fix can never become a false position.
//
//   THE TEXT ALTERNATIVE COMES FROM THE SAME GEOMETRY THE SVG DRAWS, so a
//   screen reader cannot be told something the picture does not show.

export const VIEW_WIDTH = 1000
export const VIEW_HEIGHT = 760
export const PADDING = 46

// Label placement. Candidates are tried in order and the first one that clears
// every marker and every label already placed wins, so the result is stable
// across renders rather than depending on iteration luck.
const LABEL_OFFSETS = [
  [0, 22], [0, -16], [30, 6], [-30, 6], [26, -14], [-26, -14], [0, 38], [0, -32],
]
const LABEL_HALF_HEIGHT = 8

/** Where each fielder's name can be written without landing on something else. */
export function placeLabels(markers = [], {
  width = VIEW_WIDTH, height = VIEW_HEIGHT, spread = 1,
} = {}) {
  const placed = []
  const halfHeight = LABEL_HALF_HEIGHT * spread
  // Named fielders first: if something has to end up in an awkward slot it
  // should be the fielder who did nothing, not the one who made the play.
  const ordered = [...markers].sort(
    (a, b) => Number(Boolean(b.priority)) - Number(Boolean(a.priority)),
  )
  const results = []
  for (const marker of ordered) {
    const halfWidth = Math.max(14, (marker.text?.length || 2) * 3.6) * spread
    let chosen = null
    for (const [baseDx, baseDy] of LABEL_OFFSETS) {
      const dx = baseDx * spread
      const dy = baseDy * spread
      const cx = marker.x + dx
      const cy = marker.y + dy
      if (cx - halfWidth < 2 || cx + halfWidth > width - 2) continue
      if (cy - halfHeight < 2 || cy + halfHeight > height - 2) continue
      const collides = placed.some((box) => (
        Math.abs(box.cx - cx) < box.halfWidth + halfWidth + 3
        && Math.abs(box.cy - cy) < halfHeight * 2 + 2
      )) || markers.some((other) => (
        other !== marker
        && Math.abs(other.x - cx) < halfWidth + 8 * spread
        && Math.abs(other.y - cy) < halfHeight + 8 * spread
      ))
      if (collides) continue
      chosen = { cx, cy, dx, dy }
      break
    }
    // Nothing cleared: keep the first candidate rather than dropping the label.
    // A slightly crowded name is more use than a missing one.
    if (!chosen) {
      const dx = LABEL_OFFSETS[0][0] * spread
      const dy = LABEL_OFFSETS[0][1] * spread
      chosen = { cx: marker.x + dx, cy: marker.y + dy, dx, dy }
    }
    placed.push({ ...chosen, halfWidth })
    results.push({ ...marker, label: chosen, halfWidth })
  }
  return results
}

/** The diagram in words, for a reader who cannot see it. */
export function describePlayGeometry(geometry, stadiumKey) {
  if (!geometry) return 'No measured play geometry is attached to this at-bat.'
  const parts = []
  const park = stadiumKey ? String(stadiumKey).replace(/_/g, ' ') : 'an unnamed park'
  const fielders = geometry.fielders || []
  const movers = fielders.filter((fielder) => fielder.path_units != null && fielder.path_units > 1)
  parts.push(`Measured play at ${park} with ${fielders.length} fielders at pitch release`)
  if (geometry.first_touch) {
    parts.push(`first touch by ${geometry.first_touch.character || geometry.first_touch.by}`
      + `${geometry.landing ? ' after the ball landed' : ' before the ball landed'}`)
  } else if (geometry.landing) {
    parts.push('the ball landed with no fielder touching it')
  } else {
    parts.push('no endpoint was measured')
  }
  if (movers.length) {
    const furthest = movers.reduce(
      (best, entry) => (entry.path_units > (best?.path_units ?? -1) ? entry : best), null,
    )
    parts.push(`${movers.length} fielders moved, furthest ${furthest.position} at `
      + `${furthest.path_units.toFixed(1)} units`)
  } else {
    parts.push('no fielder moved more than a step')
  }
  const throwCount = (geometry.throws || []).length
  parts.push(throwCount === 1 ? '1 throw recorded'
    : throwCount ? `${throwCount} throws recorded` : 'no throws recorded')
  return `${parts.join('; ')}.`
}
