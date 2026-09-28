// One-time recovery for TEST season games whose completed tracker workbooks
// were missed by the old Chokidar glob watcher. Run without --apply to inspect.
import path from 'node:path'
import ExcelJS from 'exceljs'
import { createAdvancedMetricsClient } from './recompute_advanced_metrics.mjs'

const games = [
  { id: 2766, file: 'Fireballs vs Muscles - 2026-09-18 11-31-38.xlsx', scores: [4, 5] },
  { id: 2767, file: 'Knights vs Monarchs - 2026-09-18 14-47-15.xlsx', scores: [7, 0] },
  { id: 2768, file: 'Spitballs vs Flowers - 2026-09-18 15-11-14.xlsx', scores: [4, 3] },
]
const labels = [
  'Away Team', 'Home Team', 'Stadium - Time of Day', 'Innings - X',
  'Stars - On/Off', 'Items - On/Off', 'Mercy - On/Off',
]

function valueOf(cell) {
  return cell.value && typeof cell.value === 'object' && 'result' in cell.value
    ? cell.value.result : cell.value
}

function records(sheet) {
  const headers = []
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
    headers[col] = String(cell.value ?? '').trim()
  })
  const result = []
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return
    const record = {}
    let hasValue = false
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      if (!headers[col]) return
      const value = valueOf(cell)
      if (value !== null && value !== undefined && value !== '') hasValue = true
      record[headers[col]] = value ?? null
    })
    if (hasValue) result.push(record)
  })
  return result
}

function gameInfo(sheet) {
  const raw = []
  sheet.eachRow((row, rowNumber) => {
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const value = valueOf(cell)
      if (value !== null && value !== undefined && value !== '') {
        raw.push({ row: rowNumber, col, address: cell.address, value })
      }
    })
  })
  const byPosition = new Map(raw.map((cell) => [`${cell.row}:${cell.col}`, cell]))
  const fields = {}
  for (const label of labels) {
    const cell = raw.find((entry) => String(entry.value).trim() === label)
    if (!cell) continue
    const value = byPosition.get(`${cell.row}:${cell.col + 1}`)
      || byPosition.get(`${cell.row + 1}:${cell.col}`)
    if (value) fields[label] = value.value
  }
  return { fields, raw }
}

const apply = process.argv.includes('--apply')
const db = await createAdvancedMetricsClient()
for (const game of games) {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(path.join('sluggers-stat-tracker-advanced-stats-dev', 'output', game.file))
  const infoSheet = workbook.getWorksheet('Game Info')
  const statsSheet = workbook.getWorksheet('Stats')
  const pitchingSheet = workbook.getWorksheet('Pitching')
  if (!infoSheet || !statsSheet || !pitchingSheet) throw new Error(`Game ${game.id}: workbook sheets missing`)
  let finalColumn = null
  infoSheet.getRow(30).eachCell({ includeEmpty: false }, (cell, col) => {
    if (String(cell.value).trim() === 'Final') finalColumn = col
  })
  if (!finalColumn) throw new Error(`Game ${game.id}: final scorecard column missing`)
  const scorecard = [31, 32].map((row) => Number(infoSheet.getRow(row).getCell(finalColumn).value))
  if (scorecard.some((score, index) => score !== game.scores[index])) {
    throw new Error(`Game ${game.id}: workbook score ${scorecard} differs from expected ${game.scores}`)
  }
  const [{ data: scheduled, error: gameError }, { data: current, error: statsError }] = await Promise.all([
    db.from('season_schedule').select('id,status,away_score,home_score').eq('id', game.id).single(),
    db.from('season_tracker_live_stats').select('game_id,batting,pitching').eq('game_id', game.id).single(),
  ])
  if (gameError || statsError) throw gameError || statsError
  if (scheduled.status !== 'completed'
    || scheduled.away_score !== game.scores[0] || scheduled.home_score !== game.scores[1]) {
    throw new Error(`Game ${game.id}: completed database score differs from workbook`)
  }
  const batting = records(statsSheet)
  const pitching = records(pitchingSheet)
  if (batting.length < 18 || pitching.length < 2) {
    throw new Error(`Game ${game.id}: workbook has too few rows (${batting.length}, ${pitching.length})`)
  }
  if (current.batting?.length || current.pitching?.length) {
    throw new Error(`Game ${game.id}: box score already populated; refusing to overwrite it`)
  }
  console.log(`Game ${game.id}: ${scorecard.join('-')}, ${batting.length} batting rows, ${pitching.length} pitching rows${apply ? ' — applying' : ' — ready'}`)
  if (!apply) continue
  const { data: updated, error } = await db.from('season_tracker_live_stats')
    .update({ game_info: gameInfo(infoSheet), batting, pitching, updated_at: new Date().toISOString() })
    .eq('game_id', game.id).select('game_id,batting,pitching').single()
  if (error) throw error
  if (updated.batting?.length !== batting.length || updated.pitching?.length !== pitching.length) {
    throw new Error(`Game ${game.id}: box score write did not verify`)
  }
}
