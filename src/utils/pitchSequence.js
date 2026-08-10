export function assignAuthoritativePitchNumbers(pitchRows = [], committedRows = []) {
  const latestByPitcher = committedRows.reduce((map, row) => {
    const key = String(row.pitcher_id || '')
    map[key] = Math.max(Number(map[key] || 0), Number(row.pitch_number_game || 0))
    return map
  }, {})

  const rows = pitchRows.map((row) => {
    const key = String(row.pitcher_id || '')
    latestByPitcher[key] = Number(latestByPitcher[key] || 0) + 1
    return { ...row, pitch_number_game: latestByPitcher[key] }
  })

  return { rows, latestByPitcher }
}
