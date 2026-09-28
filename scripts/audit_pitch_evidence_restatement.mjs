import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import {
  appCharacterRowsFromBridge,
  canonicalPitchRowsFromBridge,
  captureInventory,
  loadOfficialArchiveGames,
  ROOT,
} from './batting_uva_archive.mjs'
import { indexCharactersByName } from './tracker_character_ids.mjs'
import { planDerivedPitchEvidenceUpdates } from './ingest_player_tracking.mjs'

export const RESTATEMENT_AUDIT_VERSION = 'pitch-evidence-restatement-v1'
export const OUTPUT = path.join(ROOT, 'data', 'calibration', 'pitch-evidence-restatement-audit-v1.json')

const EVIDENCE_FIELDS = Object.freeze([
  'is_star_pitch', 'swing_offer', 'swing_mode', 'swing_mode_source',
  'swing_charge_frames', 'swing_charge_release_timing_frames',
  'plate_x_units', 'plate_y_units', 'plate_z_units',
  'pitch_zone', 'pitch_zone_source', 'is_chase',
])
const SCORING_FIELDS = new Set([
  'result', 'rbi', 'runs', 'outs', 'count_balls_after', 'count_strikes_after',
  'is_hit', 'is_out', 'runs_scored',
])

function countFields(updates) {
  const counts = Object.fromEntries(EVIDENCE_FIELDS.map((field) => [field, 0]))
  for (const update of updates) {
    for (const field of EVIDENCE_FIELDS) if (Object.hasOwn(update.fields, field)) counts[field] += 1
  }
  return counts
}

export function summarizeRestatementGame(game) {
  const plateAppearances = game.bridgeEvents.map((event) => ({
    ...event.pa,
    id: event.paId,
    pa_number: event.paNumber,
  }))
  const pitchRows = canonicalPitchRowsFromBridge(game.bridgeEvents)
  const characters = appCharacterRowsFromBridge(game.bridgeEvents)
  const plan = planDerivedPitchEvidenceUpdates({
    derivedPitches: game.pitches,
    plateAppearances,
    pitchRows,
    charactersByName: indexCharactersByName(characters),
  })
  const mixed = new Map()
  for (const update of plan.updates) {
    const mode = update.fields.swing_mode
    if (!mode) continue
    if (!mixed.has(update.pa_id)) mixed.set(update.pa_id, new Set())
    mixed.get(update.pa_id).add(mode)
  }
  const scoringFieldAttempts = plan.updates.flatMap((update) => (
    Object.keys(update.fields).filter((field) => SCORING_FIELDS.has(field))
      .map((field) => ({ id: update.id, field }))
  ))
  const duplicateTargets = plan.updates.length - new Set(plan.updates.map((row) => row.id)).size
  return {
    gameId: game.gameId,
    session: game.session,
    park: game.park,
    capturePitches: game.pitches.length,
    capturePlateAppearanceGroups: plan.matchedGroups + plan.unmatchedGroups.length,
    canonicalPlateAppearances: plateAppearances.length,
    canonicalPitchRows: pitchRows.length,
    plannedUpdates: plan.updates.length,
    matchedGroups: plan.matchedGroups,
    unmatchedGroups: plan.unmatchedGroups,
    unmatchedPitches: plan.unmatchedPitches,
    mixedModePlateAppearances: [...mixed.entries()]
      .filter(([, modes]) => modes.size > 1)
      .map(([paId, modes]) => ({ paId, modes: [...modes].sort() })),
    duplicateTargets,
    scoringFieldAttempts,
    evidenceFieldCoverage: countFields(plan.updates),
    positiveStarPitchUpdates: plan.updates.filter((row) => row.fields.is_star_pitch === true).length,
    negativeStarPitchUpdates: plan.updates.filter((row) => row.fields.is_star_pitch === false).length,
  }
}

export function buildRestatementAudit() {
  const inventory = captureInventory()
  const games = loadOfficialArchiveGames().map(summarizeRestatementGame)
  const sum = (key) => games.reduce((total, game) => total + Number(game[key] || 0), 0)
  const fieldCoverage = Object.fromEntries(EVIDENCE_FIELDS.map((field) => [
    field,
    games.reduce((total, game) => total + game.evidenceFieldCoverage[field], 0),
  ]))
  return {
    version: RESTATEMENT_AUDIT_VERSION,
    generatedAt: new Date().toISOString(),
    dryRun: true,
    databaseWrites: 0,
    canonicalSource: 'saved tracker bridge state; canonical identities are paId plus pitch_number_pa',
    scope: {
      archivedPitchSessions: inventory.length,
      selectedGameSessions: inventory.filter((row) => row.eligibility === 'selected_game_session').length,
      excludedByReason: Object.fromEntries([...new Set(inventory.map((row) => row.eligibility))].sort()
        .map((reason) => [reason, inventory.filter((row) => row.eligibility === reason).length])),
    },
    safety: {
      scoringFieldsMayBeUpdated: false,
      scoringFieldAttempts: games.reduce((total, game) => total + game.scoringFieldAttempts.length, 0),
      absentOrZeroStarEvidenceMayClearTrue: false,
      negativeStarPitchUpdates: games.reduce((total, game) => total + game.negativeStarPitchUpdates, 0),
      mixedModePlateAppearancesRemainPitchLevel: games.every((game) => game.duplicateTargets === 0),
      duplicateCanonicalTargets: sum('duplicateTargets'),
    },
    coverage: {
      games: games.length,
      archivePitches: sum('capturePitches'),
      canonicalPitchRows: sum('canonicalPitchRows'),
      plannedUpdates: sum('plannedUpdates'),
      matchedPlateAppearanceGroups: sum('matchedGroups'),
      unmatchedPlateAppearanceGroups: games.reduce((n, game) => n + game.unmatchedGroups.length, 0),
      unmatchedPitches: games.reduce((n, game) => n + game.unmatchedPitches.length, 0),
      mixedModePlateAppearances: games.reduce((n, game) => n + game.mixedModePlateAppearances.length, 0),
      positiveStarPitchUpdates: sum('positiveStarPitchUpdates'),
      evidenceFieldCoverage: fieldCoverage,
    },
    archiveSessions: inventory,
    games,
    limitations: [
      'The base audit uses saved scorebook bridge state as a canonical-row mirror; --remote adds a read-only check of rows visible to the tracker account.',
      'Captures without a durable game identity cannot be joined safely to canonical player-owned rows.',
      'Duplicate captures for a game are excluded in favor of the session named by its selected manifest.',
    ],
  }
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {}
  return Object.fromEntries(fs.readFileSync(filePath, 'utf8').split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*)\s*$/)
    if (!match) return []
    let value = match[2]
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    return [[match[1], value]]
  }))
}

async function selectAll(queryFactory) {
  const rows = []
  const pageSize = 1000
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await queryFactory().range(from, from + pageSize - 1)
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < pageSize) return rows
  }
}

/**
 * Read-only verification against the currently connected database. This
 * function never calls insert, update, upsert, delete, or an RPC.
 */
export async function auditRemoteCanonicalRows(localReport = buildRestatementAudit()) {
  const env = {
    ...loadEnvFile(path.join(ROOT, '.env')),
    ...loadEnvFile(path.join(ROOT, '.env.tracker-bridge')),
    ...process.env,
  }
  const url = env.VITE_SUPABASE_URL
  const key = env.VITE_SUPABASE_ANON_KEY
  const email = env.TRACKER_BRIDGE_EMAIL
  const password = env.TRACKER_BRIDGE_PASSWORD
  if (!url || !key || !email || !password) throw new Error('Missing Supabase read-audit credentials')
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const { error: authError } = await supabase.auth.signInWithPassword({ email, password })
  if (authError) throw authError
  const gameIds = localReport.games.map((game) => Number(game.gameId))
  const [characters, plateAppearances, pitchRows] = await Promise.all([
    selectAll(() => supabase.from('characters').select('id,name').order('id')),
    selectAll(() => supabase.from('season_plate_appearances')
      .select('id,game_id,pa_number,inning,character_id')
      .in('game_id', gameIds).order('game_id').order('pa_number')),
    selectAll(() => supabase.from('season_pitches')
      .select('id,game_id,pa_id,pitch_number_pa,is_star_pitch')
      .in('game_id', gameIds).order('game_id').order('pa_id').order('pitch_number_pa')),
  ])
  const officialGames = loadOfficialArchiveGames()
  const games = officialGames.map((game) => {
    const pas = plateAppearances.filter((row) => String(row.game_id) === game.gameId)
    const paIds = new Set(pas.map((row) => String(row.id)))
    const pitches = pitchRows.filter((row) => paIds.has(String(row.pa_id)))
    const plan = planDerivedPitchEvidenceUpdates({
      derivedPitches: game.pitches,
      plateAppearances: pas,
      pitchRows: pitches,
      charactersByName: indexCharactersByName(characters),
    })
    return {
      gameId: game.gameId,
      session: game.session,
      canonicalPlateAppearances: pas.length,
      canonicalPitchRows: pitches.length,
      plannedUpdates: plan.updates.length,
      matchedGroups: plan.matchedGroups,
      unmatchedGroups: plan.unmatchedGroups,
      unmatchedPitches: plan.unmatchedPitches,
      alreadyTrueStarFlagsPreserved: plan.updates.filter((update) => {
        const existing = pitches.find((row) => String(row.id) === String(update.id))
        return existing?.is_star_pitch === true && !Object.hasOwn(update.fields, 'is_star_pitch')
      }).length,
    }
  })
  return {
    checkedAt: new Date().toISOString(),
    readOnly: true,
    databaseWrites: 0,
    tablesRead: ['characters', 'season_plate_appearances', 'season_pitches'],
    visibility: 'Rows visible to the authenticated tracker account; zero rows may mean absent data or row-level-security scope.',
    games: games.length,
    canonicalPlateAppearances: plateAppearances.length,
    canonicalPitchRows: pitchRows.length,
    plannedUpdates: games.reduce((sum, game) => sum + game.plannedUpdates, 0),
    unmatchedGroups: games.reduce((sum, game) => sum + game.unmatchedGroups.length, 0),
    unmatchedPitches: games.reduce((sum, game) => sum + game.unmatchedPitches.length, 0),
    alreadyTrueStarFlagsPreserved: games.reduce((sum, game) => sum + game.alreadyTrueStarFlagsPreserved, 0),
    gamesDetail: games,
  }
}

export function writeRestatementAudit(report = buildRestatementAudit()) {
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true })
  fs.writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`)
  return report
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  let report = buildRestatementAudit()
  if (process.argv.includes('--remote')) {
    report = { ...report, remoteCanonicalVerification: await auditRemoteCanonicalRows(report) }
    report.canonicalSource = 'live database read-only verification plus saved tracker bridge state'
  }
  writeRestatementAudit(report)
  console.log(`Wrote ${path.relative(ROOT, OUTPUT)}`)
  console.log(JSON.stringify({
    dryRun: report.dryRun,
    databaseWrites: report.databaseWrites,
    games: report.coverage.games,
    archivePitches: report.coverage.archivePitches,
    canonicalPitchRows: report.coverage.canonicalPitchRows,
    plannedUpdates: report.coverage.plannedUpdates,
    unmatchedGroups: report.coverage.unmatchedPlateAppearanceGroups,
    unmatchedPitches: report.coverage.unmatchedPitches,
    remoteCanonicalVerification: report.remoteCanonicalVerification ? {
      databaseWrites: report.remoteCanonicalVerification.databaseWrites,
      canonicalPlateAppearances: report.remoteCanonicalVerification.canonicalPlateAppearances,
      canonicalPitchRows: report.remoteCanonicalVerification.canonicalPitchRows,
      plannedUpdates: report.remoteCanonicalVerification.plannedUpdates,
      unmatchedGroups: report.remoteCanonicalVerification.unmatchedGroups,
      unmatchedPitches: report.remoteCanonicalVerification.unmatchedPitches,
    } : null,
  }, null, 2))
}
