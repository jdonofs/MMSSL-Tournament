// Older databases may not have the star-swing column yet. Keep pitch saves
// usable until the pitch tracking migration is applied, without masking other
// schema errors or dropping the value on databases that support it.
export async function writePitchesWithSchemaFallback(write, rows) {
  const first = await write(rows)
  const error = first?.error
  const missingStarSwing = (error?.code === 'PGRST204' || error?.code === '42703')
    && /(?:['"]is_star_swing['"]|\bis_star_swing\b)/i.test(error?.message || '')
  if (!missingStarSwing) return first

  const omitStarSwing = (row) => {
    const { is_star_swing, ...rest } = row
    return rest
  }
  return write(Array.isArray(rows) ? rows.map(omitStarSwing) : omitStarSwing(rows))
}
