import { readFileSync } from 'fs'
const report = JSON.parse(readFileSync('c:/Users/jdono/Sluggers/tmp/stats_audit_report.json', 'utf8'))

const seasonHL = report.season.fielding.issues.hitLocationOnlyNoOutContactRows
console.log('season hitLocationOnlyNoOutContactRows count:', seasonHL.count, ' (sample size:', seasonHL.samples.length, ')')
const resultCounts = {}
for (const s of seasonHL.samples) resultCounts[s.result] = (resultCounts[s.result] || 0) + 1
console.log('result breakdown among samples:', JSON.stringify(resultCounts))

const tournMFC = report.tournament.fielding.issues.missingFielderForCredit
console.log('\ntournament missingFielderForCredit count:', tournMFC.count)
const creditCounts = {}
const resultCounts2 = {}
for (const s of tournMFC.samples) { creditCounts[s.credit] = (creditCounts[s.credit] || 0) + 1; resultCounts2[s.result] = (resultCounts2[s.result] || 0) + 1 }
console.log('credit breakdown:', JSON.stringify(creditCounts))
console.log('result breakdown:', JSON.stringify(resultCounts2))
console.log('\ncounts.game_fielders (tournament table):', report.counts.game_fielders)
console.log('counts.pitching_stints/season_pitching_stints:', report.counts.pitching_stints, report.counts.season_pitching_stints)
