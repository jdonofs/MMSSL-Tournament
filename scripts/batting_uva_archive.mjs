import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  indexCharactersByName,
  normalizeCharacterName,
  resolveTrackerCharacterId,
  trackerCharacterName,
} from './tracker_character_ids.mjs'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const TRACKING_DIR = path.join(ROOT, 'data', 'player_tracking')
export const BRIDGE_DIR = path.join(ROOT, 'data', 'tracker_bridge_state')

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

export function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return []
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) } catch (error) {
      throw new Error(`${filePath}:${index + 1}: ${error.message}`)
    }
  })
}

function stemFromManifest(manifest) {
  return path.basename(String(manifest?.stem || '')).replace(/\.(?:json|bin)$/i, '')
}

export function selectedSeasonManifests() {
  return fs.readdirSync(TRACKING_DIR)
    .filter((name) => /^season-\d+\.manifest\.json$/.test(name))
    .sort((left, right) => Number(left.match(/\d+/)[0]) - Number(right.match(/\d+/)[0]))
    .map((name) => {
      const manifest = readJson(path.join(TRACKING_DIR, name))
      return {
        ...manifest,
        gameId: String(manifest.game_id ?? name.match(/\d+/)[0]),
        session: stemFromManifest(manifest),
        manifestFile: name,
      }
    })
}

export function captureInventory() {
  const selectedByGame = new Map(selectedSeasonManifests().map((row) => [row.gameId, row.session]))
  return fs.readdirSync(TRACKING_DIR)
    .filter((name) => name.endsWith('.pitches.jsonl') && !name.includes('.pre-recovery.'))
    .sort()
    .map((name) => {
      const session = name.slice(0, -'.pitches.jsonl'.length)
      const headerPath = path.join(TRACKING_DIR, `${session}.json`)
      const header = fs.existsSync(headerPath) ? readJson(headerPath) : {}
      const gameId = header.game_id == null ? null : String(header.game_id)
      let eligibility = 'no_game_identity'
      if (header.calibration_excluded === true) eligibility = 'calibration_excluded'
      else if (gameId && selectedByGame.get(gameId) === session) eligibility = 'selected_game_session'
      else if (gameId && selectedByGame.has(gameId)) eligibility = 'duplicate_game_capture'
      else if (gameId) eligibility = 'game_without_selected_manifest'
      return {
        session,
        gameId,
        competitionType: header.competition_type ?? null,
        calibrationExcluded: header.calibration_excluded === true,
        calibrationExcludedReason: header.calibration_excluded_reason ?? null,
        eligibility,
        pitches: readJsonLines(path.join(TRACKING_DIR, name)).length,
      }
    })
}

function eventBatterName(event) {
  return event?.pitches?.find((pitch) => pitch?.batter_id)?.batter_id ?? null
}

function eventPitcherName(event) {
  return event?.pitches?.find((pitch) => pitch?.pitcher_id)?.pitcher_id ?? null
}

function pitchGroups(pitches) {
  const groups = []
  for (const pitch of pitches) {
    const current = groups.at(-1)
    const previous = current?.at(-1)
    const same = previous
      && Number(previous.inning) === Number(pitch.inning)
      && Number(previous.inning_half) === Number(pitch.inning_half)
      && Number(previous.batter_index) === Number(pitch.batter_index)
      && Number(previous.batter_id) === Number(pitch.batter_id)
      && Number(pitch.pitch_in_pa) > Number(previous.pitch_in_pa)
    if (!same) groups.push([pitch])
    else current.push(pitch)
  }
  return groups
}

export function alignCaptureToBridge({ pitches = [], events = [] } = {}) {
  const groups = pitchGroups(pitches)
  const ordered = [...events].filter((event) => event?.pa && event?.paId != null)
    .sort((left, right) => Number(left.paNumber ?? Infinity) - Number(right.paNumber ?? Infinity))
  const unused = new Set(ordered.map((_, index) => index))
  const charactersByName = indexCharactersByName(appCharacterRowsFromBridge(ordered))
  const rows = []
  const unmatchedGroups = []
  const unmatchedPitches = []
  let floor = 0

  for (const group of groups) {
    const first = group[0]
    const batterId = resolveTrackerCharacterId(first.batter_id, charactersByName)
    const candidates = [...unused].filter((index) => index >= floor)
    const exact = batterId == null ? null : candidates.find((index) => {
      const event = ordered[index]
      return Number(event.pa.inning) === Number(first.inning)
        && Number(event.pa.character_id) === Number(batterId)
    })
    // Match the production restatement contract: positional fallback is only
    // allowed when the tracked character cannot resolve into the app's id
    // space. A resolved disagreement is evidence against the join.
    const selected = exact ?? (batterId == null
      ? candidates.find((index) => Number(ordered[index].pa.inning) === Number(first.inning))
      : null)
    if (selected == null) {
      unmatchedGroups.push({
        inning: first.inning ?? null,
        inning_half: first.inning_half ?? null,
        batter: first.batter ?? trackerCharacterName(first.batter_id) ?? null,
        pitches: group.length,
      })
      continue
    }
    const event = ordered[selected]
    unused.delete(selected)
    floor = selected + 1
    const canonicalByNumber = new Map((event.pitches || []).map((pitch) => [Number(pitch.pitch_number_pa), pitch]))
    for (const raw of group) {
      const canonical = canonicalByNumber.get(Number(raw.pitch_in_pa))
      if (!canonical) {
        unmatchedPitches.push({
          paId: event.paId,
          paNumber: event.paNumber,
          pitchNumberPa: raw.pitch_in_pa ?? null,
          pitchTimer: raw.pitch_timer ?? null,
        })
        continue
      }
      rows.push({ raw, canonical, event })
    }
  }
  return {
    rows,
    matchedGroups: groups.length - unmatchedGroups.length,
    captureGroups: groups.length,
    unmatchedGroups,
    unmatchedPitches,
    unmatchedCanonicalPas: [...unused].map((index) => ({
      paId: ordered[index].paId,
      paNumber: ordered[index].paNumber,
      inning: ordered[index].pa.inning,
      batter: eventBatterName(ordered[index]),
    })),
  }
}

export function loadOfficialArchiveGames() {
  return selectedSeasonManifests().map((manifest) => {
    const stem = path.join(TRACKING_DIR, manifest.session)
    const bridgePath = path.join(BRIDGE_DIR, `season-${manifest.gameId}.json`)
    const bridge = fs.existsSync(bridgePath) ? readJson(bridgePath) : { events: [] }
    const pitches = readJsonLines(`${stem}.pitches.jsonl`)
    const plays = readJsonLines(`${stem}.plays.jsonl`)
    const alignment = alignCaptureToBridge({ pitches, events: bridge.events || [] })
    const playsBySwingTimer = new Map()
    for (const play of plays) {
      const key = String(play.swing_timer ?? '')
      if (!playsBySwingTimer.has(key)) playsBySwingTimer.set(key, [])
      playsBySwingTimer.get(key).push(play)
    }
    return {
      gameId: manifest.gameId,
      competitionType: manifest.competition_type || 'season',
      sourceId: manifest.source_id ?? null,
      park: manifest.park ?? null,
      recordedUtc: manifest.recorded_utc ?? null,
      session: manifest.session,
      manifestFile: manifest.manifestFile,
      bridgeEvents: bridge.events || [],
      pitches,
      plays,
      alignment,
      alignedRows: alignment.rows.map((row) => {
        const candidates = playsBySwingTimer.get(String(row.raw.swing_timer ?? '')) || []
        const play = candidates.find((candidate) => (
          Number(candidate.inning) === Number(row.raw.inning)
          && Number(candidate.batter_id) === Number(row.raw.batter_id)
        )) || null
        return { ...row, play }
      }),
    }
  })
}

export function appCharacterRowsFromBridge(events = []) {
  const rows = new Map()
  for (const event of events) {
    const name = eventBatterName(event)
    if (name && event?.pa?.character_id != null) {
      rows.set(normalizeCharacterName(name), { id: event.pa.character_id, name })
    }
    const pitcher = eventPitcherName(event)
    if (pitcher && event?.pa?.pitcher_id != null) {
      rows.set(normalizeCharacterName(pitcher), { id: event.pa.pitcher_id, name: pitcher })
    }
  }
  return [...rows.values()]
}

export function canonicalPitchRowsFromBridge(events = []) {
  return events.flatMap((event) => (event.pitches || []).map((pitch) => ({
    ...pitch,
    id: `bridge:${event.paId}:${pitch.pitch_number_pa}`,
    pa_id: event.paId,
    pitch_number_pa: pitch.pitch_number_pa,
  })))
}
