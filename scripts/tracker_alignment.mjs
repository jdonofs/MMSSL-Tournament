export const TRACKER_POSITION_NUMBERS = Object.freeze({
  P: 1,
  C: 2,
  '1B': 3,
  '2B': 4,
  '3B': 5,
  SS: 6,
  LF: 7,
  CF: 8,
  RF: 9,
})

const POSITION_ORDER = Object.keys(TRACKER_POSITION_NUMBERS)
const BATTING_MESSAGE_RE = /^\[TRACKER_BATTING\]\s+team=([^|]*)\|batting=(.*)$/
const LINEUP_MESSAGE_RE = /^\[TRACKER_LINEUP\]\s+team=([^|]*)\|batting=([^|]*)\|fielding=(.*)$/
const RUNNER_MESSAGE_RE = /^(.+?)\s+is on (first|second|third)\.$/i

function clean(value) {
  return String(value ?? '').trim()
}

function parseFieldingList(value) {
  const fielding = {}
  for (const entry of clean(value).split(',').filter(Boolean)) {
    const separator = entry.indexOf('=')
    if (separator <= 0) continue
    const position = clean(entry.slice(0, separator)).toUpperCase()
    const character = clean(entry.slice(separator + 1))
    if (TRACKER_POSITION_NUMBERS[position] && character) fielding[position] = character
  }
  return fielding
}

export function parseTrackerLineupMessage(message) {
  const match = clean(message).match(LINEUP_MESSAGE_RE)
  if (!match) return null
  return {
    teamName: clean(match[1]),
    batting: match[2].split(',').map(clean).filter(Boolean),
    fielding: parseFieldingList(match[3]),
    source: 'live',
  }
}

export function parseTrackerBattingMessage(message) {
  const match = clean(message).match(BATTING_MESSAGE_RE)
  if (!match) return null
  return {
    teamName: clean(match[1]),
    batting: match[2].split(',').map(clean).filter(Boolean),
    source: 'live',
  }
}

export function parseTrackerRunnerMessage(message) {
  const match = clean(message).match(RUNNER_MESSAGE_RE)
  if (!match) return null
  return {
    characterName: clean(match[1]),
    base: match[2].toLowerCase(),
  }
}

function cellValue(worksheet, address) {
  const raw = worksheet?.getCell(address)?.value
  if (raw && typeof raw === 'object' && 'result' in raw) return clean(raw.result)
  return clean(raw)
}

export function parseWorkbookStartingLineups(worksheet) {
  if (!worksheet) return []

  const sides = [
    { teamCell: 'L11', nameColumn: 'J', positionColumn: 'K' },
    { teamCell: 'P11', nameColumn: 'R', positionColumn: 'Q' },
  ]

  return sides.map(({ teamCell, nameColumn, positionColumn }) => {
    const batting = []
    const fielding = {}
    for (let row = 20; row <= 28; row++) {
      const character = cellValue(worksheet, `${nameColumn}${row}`)
      const position = cellValue(worksheet, `${positionColumn}${row}`).toUpperCase()
      if (character) batting.push(character)
      if (character && TRACKER_POSITION_NUMBERS[position]) fielding[position] = character
    }
    return {
      teamName: cellValue(worksheet, teamCell),
      batting,
      fielding,
      source: 'workbook',
    }
  }).filter((alignment) => alignment.teamName || alignment.batting.length)
}

export function validateTrackerAlignment(alignment) {
  const battingValidation = validateTrackerBattingOrder(alignment)
  const errors = [...battingValidation.errors]
  const batting = battingValidation.batting
  const fielding = alignment?.fielding || {}
  const fieldingNames = POSITION_ORDER.map((position) => fielding[position]).filter(Boolean)

  if (fieldingNames.length !== 9) errors.push(`expected 9 fielders, received ${fieldingNames.length}`)
  if (new Set(fieldingNames).size !== fieldingNames.length) errors.push('fielding map contains duplicate characters')

  const battingSet = new Set(batting)
  const missingFromBatting = fieldingNames.filter((name) => !battingSet.has(name))
  const fieldingSet = new Set(fieldingNames)
  const missingFromField = batting.filter((name) => !fieldingSet.has(name))
  if (missingFromBatting.length || missingFromField.length) {
    errors.push('batting order and fielding map do not contain the same characters')
  }

  return { valid: errors.length === 0, errors }
}

export function validateTrackerBattingOrder(alignment) {
  const errors = []
  const batting = alignment?.batting || []
  if (batting.length !== 9) errors.push(`expected 9 batters, received ${batting.length}`)
  if (new Set(batting).size !== batting.length) errors.push('batting order contains duplicate characters')
  return { valid: errors.length === 0, errors, batting }
}
