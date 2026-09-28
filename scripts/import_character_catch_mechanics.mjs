import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import ExcelJS from 'exceljs'

const workbookPath = process.argv[2]
if (!workbookPath) {
  throw new Error('Usage: node scripts/import_character_catch_mechanics.mjs <workbook.xlsx>')
}

const repoRoot = path.resolve(import.meta.dirname, '..')
const profilePath = path.join(repoRoot, 'src', 'data', 'characterTalentProfiles.json')
const outputPath = path.join(repoRoot, 'src', 'data', 'characterCatchMechanics.json')
const profiles = JSON.parse(await fs.readFile(profilePath, 'utf8'))

const workbook = new ExcelJS.Workbook()
await workbook.xlsx.readFile(path.resolve(workbookPath))
const sheet = workbook.getWorksheet('Final Catch Radii')
if (!sheet) throw new Error('Workbook is missing the "Final Catch Radii" sheet')

const numberAt = (row, column) => {
  const raw = row.getCell(column).value
  const value = Number(raw && typeof raw === 'object' && 'result' in raw ? raw.result : raw)
  if (!Number.isFinite(value)) throw new Error(`Invalid catch value at ${row.number}:${column}`)
  return value
}

const mechanics = {}
sheet.eachRow((row, rowNumber) => {
  if (rowNumber === 1) return
  const name = String(row.getCell(1).value || '').trim().toLowerCase()
  if (!name) return
  mechanics[name] = {
    regular: numberAt(row, 2),
    facingAway: numberAt(row, 3),
    saferCatch: numberAt(row, 4),
    height: numberAt(row, 5),
    reachUpThreshold: numberAt(row, 6),
    unknownHeightLike: numberAt(row, 7),
    dive: numberAt(row, 8),
    lineDriveDiveHeight: numberAt(row, 9),
    jump: numberAt(row, 10),
    unknownRegularLike: numberAt(row, 11),
  }
})

const expected = Object.keys(profiles).map((name) => name.toLowerCase()).sort()
const actual = Object.keys(mechanics).sort()
const missing = expected.filter((name) => !mechanics[name])
const unexpected = actual.filter((name) => !profiles[name])
if (missing.length || unexpected.length || actual.length !== expected.length) {
  throw new Error(`Catch profile mismatch: missing=${missing.join(', ')} unexpected=${unexpected.join(', ')}`)
}

await fs.writeFile(outputPath, `${JSON.stringify(mechanics, null, 2)}\n`, 'utf8')
console.log(`Wrote ${actual.length} corrected catch profiles to ${path.relative(repoRoot, outputPath)}`)
