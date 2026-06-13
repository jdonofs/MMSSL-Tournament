import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../supabaseClient'
import { useAuth } from '../context/AuthContext'
import { useSeason } from '../context/SeasonContext'
import { useTournament } from '../context/TournamentContext'
import TeamLogo from '../components/TeamLogo'
import CharacterPortrait from '../components/CharacterPortrait'
import StatIcon from '../components/StatIcon'
import useTournamentTeamIdentity from '../hooks/useTournamentTeamIdentity'
import { chemBreakdown, getChemistry } from '../data/chemistry'
import { analyzeCharacterTalent, getTalentTierMeta } from '../utils/characterAnalysis'
import { formatCharacterDisplayName, getCharacterChemistryName } from '../utils/mii'
import { getCurrentDraftState, normalizeSeasonDraftPicks, snakeOrder } from '../utils/draftOrder'
import { OVERALL_WEIGHTS } from '../utils/seasonPowerRankings'

const C = {
  bg: '#0F172A',
  accent: '#EAB308',
  text: '#FFFFFF',
  muted: '#94A3B8',
}

const PIXELATED = { imageRendering: 'pixelated' }
const DEFAULT_CROWD_NOISE_URL = '/audio/default-crowd-noise.mp3'
const PICK_IN_CHIME_URL = '/audio/nfl-draft-chime.mp3'
const PICK_IN_BASS_CHIME_URL = '/audio/nfl-draft-chime-bass-boosted.mp3'
const CUSTOM_PICK_IN_AUDIO_CONFIGS = Object.freeze({
  Mario: { url: '/audio/into-the-pipe-theme.mp3', volume: 0.92 },
  'Funky Kong': { url: '/audio/funky-kong.wav', volume: 0.92 },
  Luigi: { url: '/audio/weegee-time.wav', volume: 0.92 },
  'Monty Mole': { url: '/audio/stinky-sound-effect.mp3', volume: 0.92 },
  Bowser: { url: '/audio/bowser-peaches-cut.mp3', volume: 0.92 },
  'Bowser Jr.': { url: '/audio/cuppa-jr.wav', volume: 0.92 },
  Birdo: { url: '/audio/cather.wav', volume: 0.92 },
  'King K. Rool': { url: '/audio/fat-tuba.mp3', volume: 0.92 },
  'King Boo': { url: '/audio/k-teresa.wav', volume: 0.92 },
  Mii: { url: '/audio/mii-channel-theme-cut.mp3', volume: 0.92 },
  Yoshi: { url: '/audio/yossy.wav', volume: 0.92 },
  'Red Yoshi': { url: '/audio/yossy.wav', volume: 0.92 },
  'Blue Yoshi': { url: '/audio/yossy.wav', volume: 0.92 },
  'Yellow Yoshi': { url: '/audio/yossy.wav', volume: 0.92 },
  'Pink Yoshi': { url: '/audio/yossy.wav', volume: 0.92 },
  'Light-Blue Yoshi': { url: '/audio/yossy.wav', volume: 0.92 },
  Wiggler: { url: '/audio/wiggler.wav', volume: 0.92 },
  Kritter: { url: '/audio/kurittar.wav', volume: 0.92 },
  'Red Kritter': { url: '/audio/kurittar.wav', volume: 0.92 },
  'Blue Kritter': { url: '/audio/kurittar.wav', volume: 0.92 },
  'Brown Kritter': { url: '/audio/kurittar.wav', volume: 0.92 },
  Blooper: { url: '/audio/ges.wav', volume: 0.92 },
  'Dry Bones': { url: '/audio/karon.wav', volume: 0.92 },
  'Green Dry Bones': { url: '/audio/karon.wav', volume: 0.92 },
  'Blue Dry Bones': { url: '/audio/karon.wav', volume: 0.92 },
  'Dark Bones': { url: '/audio/karon.wav', volume: 0.92 },
  Peach: { url: '/audio/peach-combined.mp3', volume: 0.92 },
  Wario: { url: '/audio/wario.wav', volume: 0.92 },
  Waluigi: { url: '/audio/waluigi.wav', volume: 0.92 },
  Daisy: { url: '/audio/daisy.wav', volume: 0.92 },
  'Donkey Kong': { url: '/audio/donkey-kong-okay.mp3', volume: 0.92 },
  Toad: { url: '/audio/kinopio.wav', volume: 0.92 },
  Toadette: { url: '/audio/kinopico.wav', volume: 0.92 },
  'Hammer Bro': { url: '/audio/h-bros.wav', volume: 0.92 },
  'Fire Bro': { url: '/audio/h-bros.wav', volume: 0.92 },
  'Boomerang Bro': { url: '/audio/h-bros.wav', volume: 0.92 },
  'Shy Guy': { url: '/audio/heyho.wav', volume: 0.92 },
  'Red Shy Guy': { url: '/audio/heyho.wav', volume: 0.92 },
  'Blue Shy Guy': { url: '/audio/heyho.wav', volume: 0.92 },
  'Green Shy Guy': { url: '/audio/heyho.wav', volume: 0.92 },
  'Yellow Shy Guy': { url: '/audio/heyho.wav', volume: 0.92 },
  'Gray Shy Guy': { url: '/audio/heyho.wav', volume: 0.92 },
  Magikoopa: { url: '/audio/kameku.wav', volume: 0.92 },
  'Red Magikoopa': { url: '/audio/kameku.wav', volume: 0.92 },
  'Green Magikoopa': { url: '/audio/kameku.wav', volume: 0.92 },
  'Yellow Magikoopa': { url: '/audio/kameku.wav', volume: 0.92 },
  'Blue Pianta': { url: '/audio/delfino-plaza-theme.mp3', volume: 0.92 },
  'Red Pianta': { url: '/audio/delfino-plaza-theme.mp3', volume: 0.92 },
  'Yellow Pianta': { url: '/audio/delfino-plaza-theme.mp3', volume: 0.92 },
  'Diddy Kong': {
    urls: [
      '/audio/big-d-voice-lines/BASK IN STARLIGHT.mp3',
      '/audio/big-d-voice-lines/BUILDING A WORMHOLE.mp3',
      '/audio/big-d-voice-lines/ENOUGH.mp3',
      '/audio/big-d-voice-lines/GET CLOSE TO ME.mp3',
      '/audio/big-d-voice-lines/GIVE UP.mp3',
      '/audio/big-d-voice-lines/HEALING.mp3',
      '/audio/big-d-voice-lines/HERE WE GO.mp3',
      '/audio/big-d-voice-lines/HOPE I REASSEMBLE.mp3',
      '/audio/big-d-voice-lines/I AM THE COSMOS.mp3',
      "/audio/big-d-voice-lines/I CAN'T FAIL.mp3",
      '/audio/big-d-voice-lines/I COULD USE SOME HELP.mp3',
      '/audio/big-d-voice-lines/I GOTCHA.mp3',
      '/audio/big-d-voice-lines/I WONT QUIT.mp3',
      "/audio/big-d-voice-lines/I'LL HOLD THEM AS LONG AS I CAN.mp3",
      "/audio/big-d-voice-lines/I'M DOIN IT.mp3",
      "/audio/big-d-voice-lines/I'M HELPING.mp3",
      "/audio/big-d-voice-lines/I'M HOLDING THEM.mp3",
      "/audio/big-d-voice-lines/I'M NOT DEAD YET.mp3",
      "/audio/big-d-voice-lines/IT'S YOU OR ME.mp3",
      '/audio/big-d-voice-lines/LEAVE ME ALONE.mp3',
      '/audio/big-d-voice-lines/MY CONDITION HAS ITS ADVANTAGES.mp3',
      '/audio/big-d-voice-lines/NOW OR NEVER.mp3',
      "/audio/big-d-voice-lines/NOW'S OUR CHANCE.mp3",
      '/audio/big-d-voice-lines/OPENING BLACK HOLE.mp3',
      '/audio/big-d-voice-lines/PLEASE HELP ME.mp3',
      '/audio/big-d-voice-lines/PLEASE WORK .mp3',
      '/audio/big-d-voice-lines/REARRANGING ATOMS.mp3',
      '/audio/big-d-voice-lines/RELEASING SINGULARITY.mp3',
      '/audio/big-d-voice-lines/SENDING SHOCKWAVE.mp3',
      '/audio/big-d-voice-lines/SHOCKWAVE OUT.mp3',
      '/audio/big-d-voice-lines/STAY BACK.mp3',
      '/audio/big-d-voice-lines/TELEPORTING.mp3',
      "/audio/big-d-voice-lines/THEY CAN'T SHOOT AN ATOM.mp3",
      '/audio/big-d-voice-lines/TIME FOR APPLIED SCIENCE.mp3',
      '/audio/big-d-voice-lines/TIME FOR SOME APPLIED PHYSICS.mp3',
      '/audio/big-d-voice-lines/TRANSLOCATING.mp3',
      "/audio/big-d-voice-lines/WE'LL MAKE IT THROUGH THIS....mp3",
      "/audio/big-d-voice-lines/YOU CAN'T GIVE UP.mp3",
      "/audio/big-d-voice-lines/YOU'RE SAFE WITH ME.mp3",
    ],
    volume: 0.92,
  },
  'Dixie Kong': { randomFromCharacter: 'Diddy Kong' },
  'Tiny Kong': { randomFromCharacter: 'Diddy Kong' },
  'Baby DK': { randomFromCharacter: 'Diddy Kong' },
})
const REVEAL_REACTION_AUDIO_URLS = Object.freeze({
  'cheers-1': '/audio/crowd-cheers-1.mp3',
  'cheers-2': '/audio/crowd-cheers-2.mp3',
  'bad-angry': '/audio/crowd-angry.mp3',
  'bad-boos': '/audio/crowd-boooooo.mp3',
})
const RANDOM_BAD_CROWD_AUDIO_KEYS = Object.freeze(['bad-angry', 'bad-boos'])
const AMBIENT_CROWD_VOLUME = 0.16
const PICK_IN_CHIME_VOLUME = 0.88
const REVEAL_CROWD_VOLUME = 0.92
const CROWD_FADE_OUT_DURATION_MS = 850
const CUSTOM_REVEAL_CROWD_FADE_IN_MS = 900
const CUSTOM_REVEAL_CROWD_DELAY_MS = 2000
const AMBIENT_CROWD_CROSSFADE_MS = 1200
const MIN_REACTION_PLAY_DURATION_MS = 7000
const MAX_REACTION_PLAY_DURATION_MS = 12000
const LEAGUE_LOGO_URL = '/MSL.png'
const ADVANCE_KEYS = new Set(['ArrowRight', 'Enter', ' ', 'Spacebar'])
const BACK_KEYS = new Set(['ArrowLeft', 'Backspace'])
const BACKGROUND_LOGO_LAYOUTS = [
  { top: '12%', left: '10%', rotate: -18, scale: 0.9 },
  { top: '18%', left: '34%', rotate: -8, scale: 1.06 },
  { top: '12%', left: '67%', rotate: 14, scale: 0.96 },
  { top: '30%', left: '86%', rotate: 20, scale: 0.84 },
  { top: '52%', left: '16%', rotate: 10, scale: 1.02 },
  { top: '56%', left: '46%', rotate: -14, scale: 0.92 },
  { top: '52%', left: '76%', rotate: 8, scale: 1.08 },
  { top: '80%', left: '12%', rotate: -10, scale: 0.82 },
  { top: '82%', left: '38%', rotate: 17, scale: 1.02 },
  { top: '80%', left: '68%', rotate: -16, scale: 0.88 },
]

function buildSeasonIdentities(seasonTeams) {
  return Object.fromEntries(
    (seasonTeams || []).map((team) => [team.player_id, {
      playerId: team.player_id,
      teamName: team.team_name || 'Season Team',
      teamMascot: team.team_mascot || null,
      teamAbbreviation: team.team_abbreviation || null,
      teamPrimaryColor: team.team_primary_color || null,
      teamSecondaryColor: team.team_secondary_color || null,
      teamLogoKey: team.team_logo_key || null,
      teamLogoUrl: team.logo_url || null,
    }]),
  )
}

function getLogoFrame(identity, size) {
  const isUploadedLogo = Boolean(identity?.teamLogoUrl)
  if (isUploadedLogo) {
    const squareSize = Math.round(size * 0.58)
    return { width: squareSize, height: squareSize, imageRendering: 'auto' }
  }

  return { width: size, height: Math.round(size * 0.38), imageRendering: 'pixelated' }
}

function resolvePlayerTeamName(player) {
  if (!player) return null

  const explicitName = String(player.team_name || '').trim()
  if (explicitName) return explicitName

  const derivedName = [player.team_location, player.team_mascot]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ')

  return derivedName || null
}

function buildPlayerIdentity(player) {
  if (!player?.id) return null

  return {
    playerId: player.id,
    teamName: resolvePlayerTeamName(player),
    teamMascot: player.team_mascot || null,
    teamLocation: player.team_location || null,
    teamAbbreviation: player.team_abbreviation || null,
    teamPrimaryColor: player.team_primary_color || player.color || null,
    teamSecondaryColor: player.team_secondary_color || null,
    teamLogoUrl: player.team_logo_url || null,
  }
}

function mergeIdentityLayers(...layers) {
  const keys = [
    'playerId',
    'teamName',
    'teamMascot',
    'teamLocation',
    'teamAbbreviation',
    'teamPrimaryColor',
    'teamSecondaryColor',
    'teamLogoKey',
    'teamLogoUrl',
    'captainCharacterId',
    'captainCharacterName',
    'draftPickId',
  ]

  const merged = {}
  let hasValue = false

  for (const key of keys) {
    for (const layer of layers) {
      const value = layer?.[key]
      if (value !== undefined && value !== null && value !== '') {
        merged[key] = value
        hasValue = true
        break
      }
    }
  }

  return hasValue ? merged : null
}

function useSeasonDraftPicks(seasonId, seasonTeams, characters) {
  const [rosterRows, setRosterRows] = useState([])

  useEffect(() => {
    if (!seasonId) {
      setRosterRows([])
      return undefined
    }

    let active = true
    const load = async () => {
      const { data } = await supabase.from('season_roster').select('*').eq('season_id', seasonId).order('created_at')
      if (active) setRosterRows(data || [])
    }

    load()
    const channel = supabase
      .channel(`season-draft-presentation-${seasonId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_roster', filter: `season_id=eq.${seasonId}` }, load)
      .subscribe()

    return () => {
      active = false
      supabase.removeChannel(channel)
    }
  }, [seasonId])

  const charactersByName = useMemo(() => Object.fromEntries(characters.map((character) => [character.name, character])), [characters])

  return useMemo(
    () => normalizeSeasonDraftPicks(rosterRows, seasonId, seasonTeams, charactersByName),
    [rosterRows, seasonId, seasonTeams, charactersByName],
  )
}

function buildDraftSlides(players, totalPicks) {
  const slides = []

  for (let pickNumber = 1; pickNumber <= totalPicks; pickNumber += 1) {
    const round = Math.ceil(pickNumber / Math.max(players.length, 1))
    const orderThisRound = snakeOrder(players, round)
    const pickInRound = (pickNumber - 1) % Math.max(players.length, 1)
    const drafter = orderThisRound[pickInRound] || null
    const pickMeta = { pickNumber, round, pickInRound: pickInRound + 1, drafter }

    slides.push({ key: `clock-${pickNumber}`, kind: 'clock', pickNumber, pickMeta })
    slides.push({ key: `pick-in-${pickNumber}`, kind: 'pick-in', pickNumber, pickMeta })
    slides.push({ key: `reveal-${pickNumber}`, kind: 'reveal', pickNumber, pickMeta })
  }

  slides.push({ key: 'draft-complete', kind: 'complete' })
  return slides
}

function stopAudio(audio, reset = true) {
  if (!audio) return
  audio.pause()
  if (!reset) return

  try {
    audio.currentTime = 0
  } catch {
    // Some browsers can briefly reject currentTime writes while metadata loads.
  }
}

function safePlayAudio(audio, { restart = true, volume } = {}) {
  if (!audio) return

  if (Number.isFinite(volume)) {
    audio.volume = clamp(volume, 0, 1)
  }

  if (restart) {
    stopAudio(audio)
  } else if (!audio.paused) {
    return
  }

  const playPromise = audio.play()
  if (typeof playPromise?.catch === 'function') {
    playPromise.catch(() => {})
  }
}

function getCustomPickInAudioConfig(characterName) {
  if (!characterName) return null
  const config = CUSTOM_PICK_IN_AUDIO_CONFIGS[characterName] || null
  if (!config?.randomFromCharacter) return config
  return CUSTOM_PICK_IN_AUDIO_CONFIGS[config.randomFromCharacter] || null
}

function getCustomPickInAudioUrls(config) {
  if (!config) return []
  if (Array.isArray(config.urls)) return config.urls
  return config.url ? [config.url] : []
}

function pickRandomCustomPickInAudioUrl(config) {
  const urls = getCustomPickInAudioUrls(config)
  if (!urls.length) return null
  return urls[Math.floor(Math.random() * urls.length)]
}

function fadeAudioVolume(audio, targetVolume, durationMs, onComplete) {
  if (!audio) return () => {}

  const startVolume = Number.isFinite(audio.volume) ? audio.volume : 1
  const endVolume = clamp(targetVolume, 0, 1)

  if (durationMs <= 0 || Math.abs(startVolume - endVolume) < 0.01) {
    audio.volume = endVolume
    onComplete?.()
    return () => {}
  }

  const startTime = performance.now()
  let frameId = 0
  let cancelled = false

  const step = (now) => {
    if (cancelled) return

    const progress = clamp((now - startTime) / durationMs, 0, 1)
    audio.volume = startVolume + ((endVolume - startVolume) * progress)

    if (progress >= 1) {
      onComplete?.()
      return
    }

    frameId = window.requestAnimationFrame(step)
  }

  frameId = window.requestAnimationFrame(step)

  return () => {
    cancelled = true
    window.cancelAnimationFrame(frameId)
  }
}

// Loops an audio clip with sample-accurate, gapless crossfading via the Web
// Audio API. A single decoded buffer is scheduled as overlapping copies, each
// fading in/out over `crossfadeMs`, so there's no re-buffering pause or click
// at the loop seam (the kind of gap that <audio loop> / re-triggering play()
// produces due to mp3 encoder padding and playback start latency).
class SeamlessLoopAudio {
  constructor(url, { volume = 1, crossfadeMs = 1000 } = {}) {
    this.targetVolume = clamp(volume, 0, 1)
    this.crossfadeSec = crossfadeMs / 1000
    this.buffer = null
    this.sources = []
    this.scheduleTimer = null
    this.nextStartTime = 0
    this.started = false
    this.destroyed = false

    const ContextClass = window.AudioContext || window.webkitAudioContext
    this.context = ContextClass ? new ContextClass() : null
    if (!this.context) return

    this.masterGain = this.context.createGain()
    this.masterGain.gain.value = this.targetVolume
    this.masterGain.connect(this.context.destination)

    fetch(url)
      .then((response) => response.arrayBuffer())
      .then((arrayBuffer) => this.context.decodeAudioData(arrayBuffer))
      .then((buffer) => {
        if (this.destroyed) return
        this.buffer = buffer
        if (this.started) this._scheduleLoop()
      })
      .catch(() => {})
  }

  get paused() {
    return !this.context || this.context.state !== 'running'
  }

  get volume() {
    return this.targetVolume
  }

  set volume(value) {
    this.targetVolume = clamp(value, 0, 1)
    if (this.masterGain) this.masterGain.gain.value = this.targetVolume
  }

  // Stops the current loop sequence so the next play() reschedules fresh.
  set currentTime(_value) {
    this._stopScheduledSources()
    this.nextStartTime = 0
    this.started = false
  }

  play() {
    if (!this.context) return
    this.started = true
    if (this.context.state === 'suspended') {
      this.context.resume().catch(() => {})
    }
    if (this.buffer && this.sources.length === 0) {
      this._scheduleLoop()
    }
  }

  pause() {
    this.context?.suspend().catch(() => {})
  }

  _scheduleLoop() {
    const duration = this.buffer.duration
    const crossfade = Math.min(this.crossfadeSec, duration / 2)
    const interval = duration - crossfade

    if (this.nextStartTime === 0) {
      this.nextStartTime = this.context.currentTime
    }

    const scheduleAhead = () => {
      while (this.nextStartTime < this.context.currentTime + interval * 2) {
        this._scheduleSource(this.nextStartTime, duration, crossfade)
        this.nextStartTime += interval
      }
    }

    scheduleAhead()
    this.scheduleTimer = window.setInterval(scheduleAhead, Math.max(interval * 500, 250))
  }

  _scheduleSource(startTime, duration, crossfade) {
    const source = this.context.createBufferSource()
    source.buffer = this.buffer

    const gain = this.context.createGain()
    source.connect(gain)
    gain.connect(this.masterGain)

    gain.gain.setValueAtTime(0, startTime)
    gain.gain.linearRampToValueAtTime(1, startTime + crossfade)
    gain.gain.setValueAtTime(1, startTime + duration - crossfade)
    gain.gain.linearRampToValueAtTime(0, startTime + duration)

    source.start(startTime)
    source.stop(startTime + duration + 0.05)
    this.sources.push(source)
    source.onended = () => {
      this.sources = this.sources.filter((entry) => entry !== source)
    }
  }

  _stopScheduledSources() {
    this.sources.forEach((source) => {
      try { source.stop() } catch { /* already stopped */ }
    })
    this.sources = []
    if (this.scheduleTimer != null) {
      window.clearInterval(this.scheduleTimer)
      this.scheduleTimer = null
    }
  }

  destroy() {
    this.destroyed = true
    this._stopScheduledSources()
    this.context?.close().catch(() => {})
  }
}

function pickWeightedKey(weights) {
  const entries = Object.entries(weights).filter(([, value]) => Number(value) > 0)
  if (!entries.length) return null

  const totalWeight = entries.reduce((sum, [, value]) => sum + Number(value), 0)
  let cursor = Math.random() * totalWeight

  for (const [key, value] of entries) {
    cursor -= Number(value)
    if (cursor <= 0) {
      return key
    }
  }

  return entries[entries.length - 1][0]
}

function pickRandomItem(items) {
  if (!Array.isArray(items) || !items.length) return null
  return items[Math.floor(Math.random() * items.length)]
}

function pickRandomInteger(min, max) {
  const lower = Math.ceil(Math.min(min, max))
  const upper = Math.floor(Math.max(min, max))
  return Math.floor(Math.random() * ((upper - lower) + 1)) + lower
}

function resolveCrowdReactionAudioKey(reactionKey) {
  if (reactionKey === 'boos') {
    return 'bad-boos'
  }

  // Shocked/disappointed share the new bad-crowd clips. True boos always
  // resolve to the dedicated boos track.
  if (reactionKey === 'shocked' || reactionKey === 'disappointed') {
    return pickRandomItem(RANDOM_BAD_CROWD_AUDIO_KEYS)
  }

  return reactionKey
}

function buildCharacterValueRanks(characterAnalysesById) {
  return Object.fromEntries(
    Object.entries(characterAnalysesById)
      .sort(([, analysisA], [, analysisB]) => (analysisB?.rawRatings?.overall ?? -Infinity) - (analysisA?.rawRatings?.overall ?? -Infinity))
      .map(([characterId], index) => [characterId, index + 1]),
  )
}

function buildPriorTeamSelections(draftPicks, pickNumber, playerId, charactersById) {
  if (!pickNumber || !playerId) return []

  return draftPicks
    .filter((pick) => Number(pick.pick_number || 0) < pickNumber)
    .filter((pick) => String(pick.player_id) === String(playerId) && pick.character_id)
    .map((pick) => {
      const character = charactersById[pick.character_id]
      if (!character) return null

      return {
        characterId: character.id,
        displayName: formatCharacterDisplayName(character.name, pick.mii_color),
        chemistryName: getCharacterChemistryName(character.name, pick.mii_color),
      }
    })
    .filter(Boolean)
}

function average(values = []) {
  const valid = values.filter((value) => Number.isFinite(value))
  if (!valid.length) return 0
  return valid.reduce((sum, value) => sum + value, 0) / valid.length
}

function buildTeamOverallRating(draftPicks, playerId, characterAnalysesById) {
  const analyses = draftPicks
    .filter((pick) => String(pick.player_id) === String(playerId) && pick.character_id)
    .map((pick) => characterAnalysesById[pick.character_id]?.displayRatings)
    .filter(Boolean)

  if (!analyses.length) return null

  const categoryAverage = (key) => average(analyses.map((ratings) => ratings[key]))

  const battingRating = categoryAverage('batting')
  const pitchingRating = categoryAverage('pitching')
  const fieldingRating = categoryAverage('fielding')
  const speedRating = categoryAverage('speed')

  return Math.round(
    (battingRating * OVERALL_WEIGHTS.batting) +
    (pitchingRating * OVERALL_WEIGHTS.pitching) +
    (fieldingRating * OVERALL_WEIGHTS.fielding) +
    (speedRating * OVERALL_WEIGHTS.speed),
  )
}

function buildPriorRosterNames(draftPicks, pickNumber, playerId, charactersById) {
  return buildPriorTeamSelections(draftPicks, pickNumber, playerId, charactersById)
    .map((selection) => selection.chemistryName)
}

function buildPriorTeamRosterRows(draftPicks, pickNumber, playerId, charactersById, characterAnalysesById) {
  if (!pickNumber || !playerId) return []

  return draftPicks
    .filter((pick) => Number(pick.pick_number || 0) < pickNumber)
    .filter((pick) => String(pick.player_id) === String(playerId) && pick.character_id)
    .sort((pickA, pickB) => Number(pickA.pick_number || 0) - Number(pickB.pick_number || 0))
    .map((pick) => {
      const character = charactersById[pick.character_id]
      if (!character) return null

      const analysis = characterAnalysesById[character.id] || null
      return {
        characterId: character.id,
        displayName: formatCharacterDisplayName(character.name, pick.mii_color),
        pickNumber: Number(pick.pick_number || 0),
        ratings: {
          pitching: analysis?.displayRatings?.pitching ?? null,
          batting: analysis?.displayRatings?.batting ?? null,
          fielding: analysis?.displayRatings?.fielding ?? null,
          speed: analysis?.displayRatings?.speed ?? null,
        },
      }
    })
    .filter(Boolean)
}

function buildTeamChemistryConnections(candidateName, priorSelections) {
  if (!candidateName || !priorSelections?.length) {
    return { positive: [], negative: [], net: 0 }
  }

  const candidateChemistry = getChemistry(candidateName)
  const positive = []
  const negative = []

  for (const selection of priorSelections) {
    const partnerChemistry = getChemistry(selection.chemistryName)
    const isPositive = candidateChemistry.good.includes(selection.chemistryName) || partnerChemistry.good.includes(candidateName)
    const isNegative = candidateChemistry.bad.includes(selection.chemistryName) || partnerChemistry.bad.includes(candidateName)

    if (isPositive && !isNegative) positive.push(selection)
    if (isNegative && !isPositive) negative.push(selection)
  }

  return {
    positive,
    negative,
    net: positive.length - negative.length,
  }
}

function buildCrowdReactionWeights(profile, { chemistry, pickValueDelta, reachDelta }) {
  const weights = {
    'cheers-1': 0.02,
    'cheers-2': 0.02,
    disappointed: 0.02,
    shocked: 0.02,
    boos: 0.02,
  }

  switch (profile) {
    case 'boos':
      weights['cheers-1'] += 0.03
      weights['cheers-2'] += 0.01
      weights.disappointed += 0.12
      weights.shocked += 0.08
      weights.boos += 0.72
      break
    case 'shocked':
      weights['cheers-1'] += 0.03
      weights['cheers-2'] += 0.03
      weights.disappointed += 0.06
      weights.shocked += 0.82
      break
    case 'cheers-2':
      weights.disappointed = 0
      weights.shocked = 0
      weights.boos = 0
      weights['cheers-2'] += 0.72
      weights['cheers-1'] += 0.24
      break
    case 'cheers-1':
      weights.disappointed = 0
      weights.shocked = 0
      weights.boos = 0
      weights['cheers-1'] += 0.7
      weights['cheers-2'] += 0.22
      break
    case 'disappointed':
      weights['cheers-1'] += 0.07
      weights['cheers-2'] += 0.06
      weights.disappointed += 0.62
      weights.shocked += 0.05
      weights.boos += 0.04
      break
    default:
      weights['cheers-1'] += 0.42
      weights['cheers-2'] += 0.22
      weights.disappointed += 0.08
      weights.shocked += 0.03
      break
  }

  if (chemistry?.positive >= 2 && chemistry.net > 0) {
    weights['cheers-1'] += 0.06
    weights['cheers-2'] += 0.08
  }

  if (chemistry?.negative >= 2 && profile !== 'cheers-1' && profile !== 'cheers-2') {
    weights.boos += 0.03
    weights.disappointed += 0.03
  }

  if (pickValueDelta >= 16) {
    weights['cheers-2'] += 0.05
  }

  if (reachDelta >= 14) {
    weights.shocked += 0.02
  }

  return weights
}

function resolveCrowdReactionForPick({
  pickMeta,
  submittedPick,
  character,
  characters,
  charactersById,
  draftPicks,
  characterAnalysesById,
  overallRankByCharacterId,
}) {
  if (!pickMeta?.pickNumber || !submittedPick?.character_id || !character) return null

  const priorPicks = draftPicks.filter((pick) => Number(pick.pick_number || 0) < pickMeta.pickNumber)
  const draftedCharacterIds = new Set(
    priorPicks
      .filter((pick) => pick.character_id)
      .map((pick) => String(pick.character_id)),
  )
  const availableBeforePick = characters
    .filter((entry) => !draftedCharacterIds.has(String(entry.id)))
    .sort((entryA, entryB) => (characterAnalysesById[entryB.id]?.rawRatings?.overall ?? -Infinity) - (characterAnalysesById[entryA.id]?.rawRatings?.overall ?? -Infinity))
  const availableCount = Math.max(availableBeforePick.length, 1)
  const availableIndex = availableBeforePick.findIndex((entry) => String(entry.id) === String(character.id))
  const availableRank = availableIndex >= 0 ? availableIndex + 1 : availableCount
  const overallRank = overallRankByCharacterId[character.id] || overallRankByCharacterId[String(character.id)] || pickMeta.pickNumber
  const pickValueDelta = pickMeta.pickNumber - overallRank
  const reachDelta = overallRank - pickMeta.pickNumber
  const priorRosterNames = buildPriorRosterNames(draftPicks, pickMeta.pickNumber, submittedPick.player_id, charactersById)
  const chemistryName = getCharacterChemistryName(character.name, submittedPick.mii_color)
  const chemistry = chemBreakdown(chemistryName, priorRosterNames)
  const strongNegativeChemistryThreshold = Math.max(3, Math.ceil(priorRosterNames.length / 2))
  const majorNegativeChemistry = chemistry && chemistry.negative >= strongNegativeChemistryThreshold && chemistry.net <= -2
  const mildNegativeChemistry = chemistry && (chemistry.net <= -2 || chemistry.negative >= 3)
  const majorReach = reachDelta >= 14 || (reachDelta >= 8 && availableRank >= Math.max(10, Math.ceil(availableCount * 0.22)))
  const mildReach = !majorReach && (reachDelta >= 8 || availableRank >= Math.max(8, Math.ceil(availableCount * 0.18)))
  const majorSteal = pickValueDelta >= 12 || (pickValueDelta >= 6 && availableRank <= 3)
  const mildSteal = !majorSteal && (pickValueDelta >= 6 || availableRank <= 2)

  let profile = 'neutral'
  if (majorSteal) {
    profile = availableRank === 1 || pickValueDelta >= 18 ? 'cheers-2' : 'cheers-1'
  } else if (mildSteal) {
    profile = 'cheers-1'
  } else if (majorNegativeChemistry) {
    profile = 'boos'
  } else if (majorReach) {
    profile = 'shocked'
  } else if (mildNegativeChemistry || mildReach) {
    profile = 'disappointed'
  }

  const reactionKey = pickWeightedKey(buildCrowdReactionWeights(profile, { chemistry, pickValueDelta, reachDelta }))

  return {
    reactionKey,
    soundKey: resolveCrowdReactionAudioKey(reactionKey),
    profile,
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function normalizeHexColor(value, fallback) {
  const text = String(value || '').trim()
  if (/^#?[0-9a-fA-F]{6}$/.test(text)) {
    return text.startsWith('#') ? text.toUpperCase() : `#${text.toUpperCase()}`
  }

  if (/^#?[0-9a-fA-F]{3}$/.test(text)) {
    const raw = text.startsWith('#') ? text.slice(1) : text
    return `#${raw.split('').map((char) => `${char}${char}`).join('').toUpperCase()}`
  }

  return fallback
}

function hexToRgb(hex) {
  const normalized = normalizeHexColor(hex, '#000000')
  return {
    r: parseInt(normalized.slice(1, 3), 16),
    g: parseInt(normalized.slice(3, 5), 16),
    b: parseInt(normalized.slice(5, 7), 16),
  }
}

function rgbToHex({ r, g, b }) {
  return `#${[r, g, b].map((value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`
}

function mixColors(colorA, colorB, weight = 0.5) {
  const a = hexToRgb(colorA)
  const b = hexToRgb(colorB)
  return rgbToHex({
    r: a.r + (b.r - a.r) * weight,
    g: a.g + (b.g - a.g) * weight,
    b: a.b + (b.b - a.b) * weight,
  })
}

function rgba(color, alpha) {
  const { r, g, b } = hexToRgb(color)
  return `rgba(${r}, ${g}, ${b}, ${clamp(alpha, 0, 1)})`
}

function getRelativeLuminance(color) {
  const { r, g, b } = hexToRgb(color)
  const channelToLinear = (channel) => {
    const value = channel / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }

  const [red, green, blue] = [r, g, b].map(channelToLinear)
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue)
}

function buildPresentationTheme(identity) {
  const primaryBase = normalizeHexColor(identity?.teamPrimaryColor, C.accent)
  const secondaryBase = normalizeHexColor(identity?.teamSecondaryColor, C.bg)
  const primary = getRelativeLuminance(primaryBase) < 0.12
    ? mixColors(primaryBase, '#F8FAFC', 0.42)
    : primaryBase
  const primarySoft = mixColors(primary, '#F8FAFC', 0.26)
  const secondary = mixColors(secondaryBase, '#020617', 0.58)
  const secondaryEdge = mixColors(secondaryBase, '#020617', 0.74)
  const backgroundBase = mixColors(secondaryBase, '#020617', 0.76)
  const backgroundEdge = mixColors(primaryBase, '#020617', 0.84)

  return {
    primary,
    primarySoft,
    primaryContrast: getRelativeLuminance(primary) > 0.62 ? '#08111F' : '#F8FAFC',
    secondary,
    secondaryEdge,
    backgroundBase,
    backgroundEdge,
    text: C.text,
    muted: 'rgba(226,232,240,0.78)',
    subtleText: 'rgba(226,232,240,0.6)',
    line: rgba(primary, 0.34),
    lineSoft: 'rgba(255,255,255,0.1)',
    chipBackground: rgba(primary, 0.16),
    chipBorder: rgba(primary, 0.38),
    shadow: 'rgba(2,6,23,0.56)',
    spotlight: rgba(primary, 0.2),
    background: [
      `radial-gradient(circle at 18% 16%, ${rgba(primary, 0.28)} 0%, transparent 30%)`,
      `radial-gradient(circle at 82% 14%, ${rgba(secondaryBase, 0.32)} 0%, transparent 34%)`,
      `radial-gradient(circle at 50% 100%, ${rgba(primarySoft, 0.16)} 0%, transparent 36%)`,
      `linear-gradient(140deg, ${backgroundBase} 0%, ${mixColors(secondary, '#0F172A', 0.38)} 54%, ${backgroundEdge} 100%)`,
    ].join(', '),
    announcementBackground: `linear-gradient(180deg, ${secondary} 0%, ${secondaryEdge} 100%)`,
    announcementAccent: `linear-gradient(90deg, transparent 0%, ${rgba(primary, 0.7)} 16%, ${rgba(primarySoft, 0.96)} 50%, ${rgba(primary, 0.7)} 84%, transparent 100%)`,
    revealBackground: `linear-gradient(135deg, ${rgba(secondary, 0.94)} 0%, ${rgba(secondaryEdge, 0.98)} 58%, ${rgba(backgroundEdge, 0.95)} 100%)`,
    teamPlate: `linear-gradient(180deg, ${rgba(secondary, 0.7)} 0%, ${rgba(backgroundBase, 0.84)} 100%)`,
  }
}

function LeagueBrandBadge() {
  return (
    <div
      style={{
        position: 'absolute',
        top: 'clamp(14px, 2vw, 24px)',
        right: 'clamp(14px, 2vw, 24px)',
        zIndex: 2,
        borderRadius: 18,
        overflow: 'hidden',
        filter: 'drop-shadow(0 18px 32px rgba(2,6,23,0.28))',
        pointerEvents: 'none',
      }}
    >
      <img
        alt="MSL league logo"
        src={LEAGUE_LOGO_URL}
        style={{
          display: 'block',
          width: 'calc(clamp(132px, 16vw, 210px) + 8px)',
          height: 'auto',
          marginLeft: -8,
        }}
      />
    </div>
  )
}

function BackgroundLogoPattern({ identity }) {
  const hasLogo = Boolean(identity?.teamLogoKey || identity?.teamLogoUrl)
  if (!hasLogo) return null

  const logoSize = identity?.teamLogoUrl ? 190 : 260
  const frame = getLogoFrame(identity, logoSize)

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        overflow: 'hidden',
      }}
    >
      {BACKGROUND_LOGO_LAYOUTS.map((entry, index) => (
        <div
          key={`${entry.top}-${entry.left}-${index}`}
          style={{
            position: 'absolute',
            top: entry.top,
            left: entry.left,
            transform: `translate(-50%, -50%) rotate(${entry.rotate}deg) scale(${entry.scale})`,
            opacity: 0.1,
            filter: 'drop-shadow(0 10px 24px rgba(2,6,23,0.18))',
          }}
        >
          <TeamLogo
            logoKey={identity?.teamLogoKey}
            logoUrl={identity?.teamLogoUrl}
            teamName={identity?.teamName}
            height={frame.height}
            placeholder={false}
            style={{
              width: frame.width,
              height: frame.height,
              imageRendering: frame.imageRendering,
              objectFit: 'contain',
            }}
          />
        </div>
      ))}
    </div>
  )
}

function ScreenShell({ theme, identity, onAdvance, children }) {
  return (
    <div
      onClick={onAdvance}
      style={{
        position: 'fixed',
        inset: 0,
        background: theme.background,
        color: theme.text,
        display: 'grid',
        placeItems: 'center',
        textAlign: 'center',
        padding: 32,
        overflow: 'hidden',
        cursor: onAdvance ? 'pointer' : 'default',
      }}
    >
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          background: [
            `linear-gradient(180deg, rgba(255,255,255,0.04), transparent 22%, transparent 78%, rgba(255,255,255,0.04))`,
            `repeating-linear-gradient(90deg, transparent 0 88px, rgba(255,255,255,0.018) 88px 89px)`,
          ].join(', '),
          pointerEvents: 'none',
        }}
      />
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: '8% -14% auto',
          height: '22vh',
          transform: 'skewY(-7deg)',
          background: `linear-gradient(90deg, transparent, ${rgba(theme.primary, 0.12)}, transparent)`,
          pointerEvents: 'none',
        }}
      />
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 'auto -12% 6%',
          height: '18vh',
          transform: 'skewY(6deg)',
          background: `linear-gradient(90deg, transparent, ${rgba(theme.secondary, 0.22)}, transparent)`,
          pointerEvents: 'none',
        }}
      />
      <BackgroundLogoPattern identity={identity} />
      <LeagueBrandBadge />
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 24,
          width: '100%',
          maxWidth: 1400,
        }}
      >
        {children}
      </div>
    </div>
  )
}

function PickCounter({ round, pickNumber, theme }) {
  return (
    <div
      style={{
        fontSize: 20,
        fontWeight: 800,
        letterSpacing: '0.2em',
        color: theme.primarySoft,
        textTransform: 'uppercase',
        padding: '10px 18px',
        borderRadius: 999,
        border: `1px solid ${theme.line}`,
        background: rgba(theme.secondary, 0.52),
        boxShadow: `0 16px 36px ${rgba('#020617', 0.22)}`,
      }}
    >
      Round {round} - Pick {pickNumber}
    </div>
  )
}

function TeamBlock({ identity, fallbackName, size = 260, theme }) {
  const teamName = identity?.teamName || fallbackName || 'Team TBD'
  const abbreviation = identity?.teamAbbreviation || null
  const logoFrame = getLogoFrame(identity, size)

  return (
    <div style={{ display: 'grid', gap: 16, justifyItems: 'center' }}>
      <div>
        <TeamLogo
          logoKey={identity?.teamLogoKey}
          logoUrl={identity?.teamLogoUrl}
          teamName={teamName}
          height={logoFrame.height}
          placeholder
          style={{
            width: logoFrame.width,
            height: logoFrame.height,
            imageRendering: logoFrame.imageRendering,
            objectFit: 'contain',
          }}
        />
      </div>
      {abbreviation ? (
        <div
          style={{
            padding: '7px 14px',
            borderRadius: 999,
            border: `1px solid ${theme.chipBorder}`,
            background: theme.chipBackground,
            color: theme.primary,
            fontSize: 13,
            fontWeight: 900,
            letterSpacing: '0.24em',
            textTransform: 'uppercase',
          }}
        >
          {abbreviation}
        </div>
      ) : null}
      <div style={{ fontSize: 48, fontWeight: 900, lineHeight: 1.1, textShadow: `0 10px 28px ${theme.shadow}` }}>{teamName}</div>
    </div>
  )
}

function RevealRatingCard({ label, value, accent, theme }) {
  return (
    <div
      style={{
        minWidth: 0,
        padding: '14px 16px',
        borderRadius: 18,
        border: `1px solid ${rgba(accent, 0.42)}`,
        background: `linear-gradient(180deg, ${rgba(accent, 0.18)} 0%, ${rgba(theme.secondary, 0.52)} 100%)`,
        boxShadow: `0 16px 32px ${rgba('#020617', 0.18)}`,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: rgba(accent, 0.98),
        }}
      >
        {label}
      </div>
      <div style={{ marginTop: 8, fontSize: 'clamp(28px, 3vw, 38px)', fontWeight: 900, lineHeight: 1 }}>
        {Number.isFinite(value) ? value : '—'}
      </div>
    </div>
  )
}

function RevealChemistryChip({ selection, accent }) {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 12px',
        borderRadius: 999,
        border: `1px solid ${rgba(accent, 0.42)}`,
        background: rgba(accent, 0.14),
        color: '#F8FAFC',
        maxWidth: '100%',
      }}
    >
      <CharacterPortrait
        name={selection.displayName}
        size={28}
        style={{
          ...PIXELATED,
          borderRadius: '50%',
          flexShrink: 0,
        }}
      />
      <span style={{ fontSize: 14, fontWeight: 800, lineHeight: 1.15 }}>
        {selection.displayName}
      </span>
    </div>
  )
}

function RevealTeamChemistry({ chemistry, theme }) {
  const positiveSelections = chemistry?.positive || []
  const negativeSelections = chemistry?.negative || []

  if (!positiveSelections.length && !negativeSelections.length) return null

  return (
    <div
      style={{
        flex: '1 0 100%',
        display: 'grid',
        gap: 16,
        padding: '22px 24px',
        borderRadius: 24,
        border: `1px solid ${theme.line}`,
        background: `linear-gradient(180deg, ${rgba(theme.secondary, 0.52)} 0%, ${rgba(theme.backgroundBase, 0.78)} 100%)`,
        boxShadow: `0 22px 48px ${rgba('#020617', 0.22)}`,
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: '0.18em', textTransform: 'uppercase', color: theme.primarySoft }}>
        Team Chemistry
      </div>

      {positiveSelections.length ? (
        <div style={{ display: 'grid', gap: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#4ADE80' }}>
            Positive
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {positiveSelections.map((selection) => (
              <RevealChemistryChip
                key={`positive-${selection.characterId}-${selection.displayName}`}
                selection={selection}
                accent="#22C55E"
              />
            ))}
          </div>
        </div>
      ) : null}

      {negativeSelections.length ? (
        <div style={{ display: 'grid', gap: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#F87171' }}>
            Negative
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {negativeSelections.map((selection) => (
              <RevealChemistryChip
                key={`negative-${selection.characterId}-${selection.displayName}`}
                selection={selection}
                accent="#EF4444"
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function RevealSkillRatingCard({ stat, value, tier, accent, theme }) {
  const tierMeta = getTalentTierMeta(tier)

  return (
    <div
      style={{
        minWidth: 0,
        padding: '14px 16px',
        borderRadius: 18,
        border: `1px solid ${rgba(accent, 0.42)}`,
        background: `linear-gradient(180deg, ${rgba(accent, 0.18)} 0%, ${rgba(theme.secondary, 0.52)} 100%)`,
        boxShadow: `0 16px 32px ${rgba('#020617', 0.18)}`,
        display: 'grid',
        justifyItems: 'center',
        gap: 8,
      }}
    >
      <div
        style={{
          width: 34,
          height: 34,
          borderRadius: '50%',
          border: `1px solid ${rgba(accent, 0.45)}`,
          background: rgba(accent, 0.16),
          display: 'grid',
          placeItems: 'center',
        }}
      >
        <StatIcon stat={stat} size={18} />
      </div>
      <div style={{ fontSize: 'clamp(28px, 3vw, 38px)', fontWeight: 900, lineHeight: 1 }}>
        {Number.isFinite(value) ? value : '—'}
      </div>
      <div
        style={{
          padding: '6px 10px',
          borderRadius: 999,
          border: `1px solid ${rgba(tierMeta.color, 0.58)}`,
          background: rgba(theme.secondary, 0.88),
          color: '#F8FAFC',
          fontSize: 11,
          fontWeight: 900,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          lineHeight: 1,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: tierMeta.color,
            boxShadow: `0 0 10px ${rgba(tierMeta.color, 0.45)}`,
            flexShrink: 0,
          }}
        />
        {tierMeta.label}
      </div>
    </div>
  )
}

function RevealChemistrySideColumn({ title, selections, accent, align = 'left' }) {
  if (!selections?.length) return null

  return (
    <div
      style={{
        display: 'grid',
        gap: 10,
        justifyItems: align === 'right' ? 'end' : 'start',
        textAlign: align,
        width: '100%',
        maxWidth: 320,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase', color: accent }}>
        {title}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: align === 'right' ? 'flex-end' : 'flex-start' }}>
        {selections.map((selection) => (
          <RevealChemistryChip
            key={`${title}-${selection.characterId}-${selection.displayName}`}
            selection={selection}
            accent={accent}
          />
        ))}
      </div>
    </div>
  )
}

function RevealDraftedBySection({ chemistry, identity, drafterName, theme }) {
  const positiveSelections = chemistry?.positive || []
  const negativeSelections = chemistry?.negative || []

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase', color: theme.muted }}>
        Drafted by
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)',
          alignItems: 'center',
          gap: 24,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'flex-start', width: '100%' }}>
          {positiveSelections.length ? (
            <RevealChemistrySideColumn title="Positive" selections={positiveSelections} accent="#4ADE80" align="left" />
          ) : null}
        </div>
        <div
          style={{
            padding: '22px 24px',
            borderRadius: 24,
            border: `1px solid ${theme.line}`,
            background: `linear-gradient(180deg, ${rgba(theme.secondary, 0.52)} 0%, ${rgba(theme.backgroundBase, 0.78)} 100%)`,
            boxShadow: `0 22px 48px ${rgba('#020617', 0.22)}`,
          }}
        >
          <TeamBlock identity={identity} fallbackName={drafterName ? `${drafterName}'s Team` : null} size={220} theme={theme} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', width: '100%' }}>
          {negativeSelections.length ? (
            <RevealChemistrySideColumn title="Negative" selections={negativeSelections} accent="#F87171" align="right" />
          ) : null}
        </div>
      </div>
    </div>
  )
}

function RevealPortraitMeta({ characterAnalysis, theme, displayName }) {
  const overall = characterAnalysis?.displayRatings?.overall
  const tierMeta = getTalentTierMeta(characterAnalysis?.tier)

  return (
    <div style={{ display: 'grid', justifyItems: 'center', gap: 12 }}>
      <CharacterPortrait
        name={displayName}
        size={300}
        style={{
          ...PIXELATED,
          border: `8px solid ${theme.primary}`,
          borderRadius: '50%',
          boxShadow: `0 0 0 10px ${theme.spotlight}`,
          background: rgba(theme.backgroundBase, 0.7),
        }}
      />
      <div style={{ display: 'grid', justifyItems: 'center', gap: 8, width: '100%' }}>
        <div
          style={{
            padding: '10px 18px',
            borderRadius: 18,
            border: `1px solid ${theme.line}`,
            background: rgba(theme.secondary, 0.54),
            boxShadow: `0 16px 32px ${rgba('#020617', 0.16)}`,
            minWidth: 126,
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.18em', textTransform: 'uppercase', color: theme.primarySoft }}>
            OVR
          </div>
          <div style={{ marginTop: 6, fontSize: 'clamp(30px, 3vw, 42px)', fontWeight: 900, lineHeight: 1 }}>
            {Number.isFinite(overall) ? overall : '—'}
          </div>
        </div>
        <div
          style={{
            padding: '8px 16px',
            borderRadius: 999,
            border: `1px solid ${rgba(tierMeta.color, 0.58)}`,
            background: rgba(theme.secondary, 0.88),
            color: '#F8FAFC',
            fontSize: 14,
            fontWeight: 900,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 9,
              height: 9,
              borderRadius: '50%',
              background: tierMeta.color,
              boxShadow: `0 0 10px ${rgba(tierMeta.color, 0.45)}`,
              flexShrink: 0,
            }}
          />
          {tierMeta.label}
        </div>
      </div>
    </div>
  )
}

function PendingPickBlock({ label, subtitle, theme }) {
  return (
    <div className="presentation-fade-in-scale" style={{ display: 'grid', gap: 12, justifyItems: 'center' }}>
      <div
        style={{
          fontSize: 54,
          fontWeight: 900,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: theme.primary,
          textShadow: `0 0 28px ${theme.spotlight}`,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 24, fontWeight: 700, color: theme.muted }}>
        {subtitle}
      </div>
    </div>
  )
}

function CurrentTeamRosterPanel({ rosterRows, theme }) {
  return (
    <div style={{ fontSize: 12, textAlign: 'left' }}>
      <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: theme.primarySoft, marginBottom: 10 }}>
        Current Team
      </div>

      {rosterRows.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rosterRows.map((row) => (
            <div
              key={`${row.pickNumber}-${row.characterId}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <CharacterPortrait
                name={row.displayName}
                size={28}
                style={{
                  ...PIXELATED,
                  borderRadius: '50%',
                  border: `1px solid ${rgba(theme.primary, 0.45)}`,
                  flexShrink: 0,
                }}
              />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#F8FAFC', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {row.displayName}
                </div>
                <div style={{ fontSize: 10, color: theme.primarySoft, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                  Pick {row.pickNumber}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 11, color: theme.muted }}>
          No players drafted yet.
        </div>
      )}
    </div>
  )
}

function OnTheClockScreen({
  draftStatusOpen,
  currentDrafter,
  currentTeamRoster,
  identity,
  captainName,
  hideCaptain,
  round,
  pickNumber,
  isCaptainRound,
  onAdvance,
}) {
  const theme = buildPresentationTheme(identity)
  const stackedLayout = typeof window !== 'undefined' && window.innerWidth < 1160

  return (
    <ScreenShell theme={theme} identity={identity} onAdvance={onAdvance}>
      <PickCounter round={round} pickNumber={pickNumber} theme={theme} />
      {/* Roster positioned absolutely on left - doesn't affect layout */}
      {!stackedLayout && (
        <div
          style={{
            position: 'absolute',
            left: 20,
            top: 120,
            maxWidth: 180,
            maxHeight: 'calc(100vh - 200px)',
            overflowY: 'auto',
            zIndex: 10,
          }}
        >
          <CurrentTeamRosterPanel rosterRows={currentTeamRoster} theme={theme} />
        </div>
      )}
      {/* Main centered content */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24, alignItems: 'center', justifyContent: 'center' }}>
        <div
          className="presentation-pulse"
          style={{
            fontSize: 72,
            fontWeight: 900,
            letterSpacing: '0.1em',
            color: theme.primary,
            textShadow: `0 0 36px ${theme.spotlight}, 0 16px 40px ${theme.shadow}`,
          }}
        >
          {draftStatusOpen ? 'ON THE CLOCK' : 'DRAFT STARTING SOON'}
        </div>
        <TeamBlock identity={identity} fallbackName={currentDrafter?.name ? `${currentDrafter.name}'s Team` : null} theme={theme} />
        {captainName && !hideCaptain ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
            <CharacterPortrait
              name={captainName}
              size={180}
              style={{
                ...PIXELATED,
                border: `4px solid ${theme.primary}`,
                boxShadow: `0 0 0 10px ${theme.spotlight}`,
                borderRadius: '50%',
              }}
            />
            <div style={{ fontSize: 28, fontWeight: 700, color: theme.muted }}>Captain - {captainName}</div>
          </div>
        ) : isCaptainRound ? (
          <div style={{ fontSize: 32, fontWeight: 700, color: theme.muted }}>Choosing their captain...</div>
        ) : null}
        <div
          style={{
            fontSize: 24,
            fontWeight: 800,
            color: theme.primarySoft,
            padding: '10px 18px',
            borderRadius: 999,
            border: `1px solid ${theme.line}`,
            background: rgba(theme.secondary, 0.42),
          }}
        >
          {currentDrafter?.name}
        </div>
      </div>
    </ScreenShell>
  )
}

function PickIsInScreen({ pickMeta, submittedPick, identity, drafterName, onAdvance }) {
  const theme = buildPresentationTheme(identity)

  return (
    <ScreenShell theme={theme} identity={identity} onAdvance={onAdvance}>
      <PickCounter round={pickMeta.round} pickNumber={pickMeta.pickNumber} theme={theme} />
      <div
        className="presentation-fade-in-scale"
        style={{
          position: 'relative',
          width: 'min(1180px, 100%)',
          padding: 'clamp(28px, 4vw, 52px)',
          borderRadius: 32,
          border: `2px solid ${theme.line}`,
          background: theme.announcementBackground,
          boxShadow: `0 28px 80px ${theme.shadow}, inset 0 0 0 1px ${theme.lineSoft}`,
          display: 'grid',
          gap: 18,
          overflow: 'hidden',
        }}
      >
        <div
          aria-hidden="true"
          style={{ position: 'absolute', inset: '0 0 auto 0', height: 10, background: theme.announcementAccent, opacity: 0.62 }}
        />
        <PendingPickBlock label="The Pick Is In" subtitle="" theme={theme} />
      </div>
    </ScreenShell>
  )
}

function PickRevealScreen({ pickMeta, submittedPick, character, characterAnalysis, teamChemistry, identity, drafterName, onAdvance }) {
  const displayName = submittedPick ? formatCharacterDisplayName(character?.name, submittedPick?.mii_color) : null
  const theme = buildPresentationTheme(identity)
  const roleRatings = [
    { stat: 'pitching', value: characterAnalysis?.displayRatings?.pitching, tier: characterAnalysis?.pitchingTier, accent: '#EF4444' },
    { stat: 'batting', value: characterAnalysis?.displayRatings?.batting, tier: characterAnalysis?.battingTier, accent: '#22C55E' },
    { stat: 'fielding', value: characterAnalysis?.displayRatings?.fielding, tier: characterAnalysis?.fieldingTier, accent: '#EAB308' },
    { stat: 'speed', value: characterAnalysis?.displayRatings?.speed, tier: characterAnalysis?.speedTier, accent: '#38BDF8' },
  ]

  return (
    <ScreenShell theme={theme} identity={identity} onAdvance={onAdvance}>
      <PickCounter round={pickMeta.round} pickNumber={pickMeta.pickNumber} theme={theme} />
      {submittedPick ? (
        <div style={{ width: 'min(1280px, 100%)', display: 'grid', gap: 28 }}>
          <div
            className="presentation-fade-in-scale"
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 32,
              alignItems: 'center',
              justifyContent: 'center',
              background: theme.revealBackground,
              border: `1px solid ${theme.line}`,
              borderRadius: 30,
              padding: 'clamp(24px, 4vw, 42px)',
              boxShadow: `0 26px 60px ${theme.shadow}`,
            }}
          >
            <div style={{ display: 'grid', gap: 18, textAlign: 'left', flex: '1 1 360px', minWidth: 0 }}>
              <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: '0.18em', textTransform: 'uppercase', color: theme.primarySoft }}>
                Round {pickMeta.round} Selection
              </div>
              <div
                style={{
                  fontSize: 'clamp(52px, 7vw, 96px)',
                  fontWeight: 900,
                  lineHeight: 0.92,
                  color: theme.primary,
                  textShadow: `0 8px 24px ${theme.spotlight}`,
                }}
              >
                {displayName}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12 }}>
                {roleRatings.map((rating) => (
                  <RevealSkillRatingCard
                    key={rating.stat}
                    stat={rating.stat}
                    value={rating.value}
                    tier={rating.tier}
                    accent={rating.accent}
                    theme={theme}
                  />
                ))}
              </div>
              <RevealDraftedBySection chemistry={teamChemistry} identity={identity} drafterName={drafterName} theme={theme} />
            </div>
            <RevealPortraitMeta characterAnalysis={characterAnalysis} theme={theme} displayName={displayName} />
          </div>
        </div>
      ) : (
        <PendingPickBlock
          label="Awaiting Selection"
          subtitle="This reveal slide will populate automatically after the pick is made."
          theme={theme}
        />
      )}
    </ScreenShell>
  )
}

function DraftCompleteScreen({ players, identitiesByPlayerId, draftPicks, characterAnalysesById, onAdvance }) {
  const theme = buildPresentationTheme(null)

  return (
    <ScreenShell theme={theme} onAdvance={onAdvance}>
      <div className="presentation-fade-in-scale" style={{ fontSize: 80, fontWeight: 900, letterSpacing: '0.1em', color: theme.primary }}>
        Draft Complete
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 32, maxWidth: 1100 }}>
        {players.map((player) => {
          const identity = identitiesByPlayerId[player.id]
          const overallRating = buildTeamOverallRating(draftPicks, player.id, characterAnalysesById)
          return (
            <div key={player.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, width: 220 }}>
              <TeamLogo
                logoKey={identity?.teamLogoKey}
                logoUrl={identity?.teamLogoUrl}
                teamName={identity?.teamName || player.name}
                height={70}
                placeholder
                style={{ ...PIXELATED, width: 220, height: 70 }}
              />
              <div style={{ fontSize: 20, fontWeight: 800 }}>{identity?.teamName || `${player.name}'s Team`}</div>
              {overallRating != null && (
                <div
                  style={{
                    fontSize: 16,
                    fontWeight: 800,
                    letterSpacing: '0.08em',
                    color: theme.primarySoft,
                    padding: '4px 14px',
                    borderRadius: 999,
                    border: `1px solid ${theme.line}`,
                    background: rgba(theme.secondary, 0.42),
                  }}
                >
                  OVR {overallRating}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </ScreenShell>
  )
}

function DraftPresentation({ mode = 'tournament' }) {
  const isSeasonMode = mode === 'season'
  const { player, loading: authLoading } = useAuth()
  const { currentTournament } = useTournament()
  const { currentSeason, seasonTeams } = useSeason()
  const activeDraftContext = isSeasonMode ? currentSeason : currentTournament

  const [players, setPlayers] = useState([])
  const [characters, setCharacters] = useState([])
  const [loading, setLoading] = useState(true)
  const [slideIndex, setSlideIndex] = useState(0)

  const ambientCrowdRef = useRef(null)
  const standardChimeRef = useRef(null)
  const bassChimeRef = useRef(null)
  const customPickInAudioRefs = useRef({})
  const reactionAudioRefs = useRef({})
  const ambientFadeCancelRef = useRef(null)
  const reactionFadeCancelRef = useRef(null)
  const reactionAutoFadeTimeoutRef = useRef(null)
  const activeReactionAudioRef = useRef(null)
  const customRevealCrowdTimeoutRef = useRef(null)
  const activeCustomRevealAudioRef = useRef(null)
  const pickInAudioStateRef = useRef({ slideKey: null, played: false })
  const revealAudioStateRef = useRef({ slideKey: null, played: false })
  const currentSlideKindRef = useRef(null)
  const requestAdvanceRef = useRef(() => {})

  useEffect(() => {
    let active = true

    const load = async () => {
      const [{ data: playersData }, { data: charactersData }] = await Promise.all([
        supabase.from('players').select('*').order('created_at'),
        supabase.from('characters').select('*').order('name'),
      ])

      if (!active) return

      setCharacters(charactersData || [])
      const orderedPlayers = isSeasonMode
        ? [...(seasonTeams || [])]
            .sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0))
            .map((team) => (playersData || []).find((player) => player.id === team.player_id))
            .filter(Boolean)
        : (() => {
            const draftOrder = activeDraftContext?.draft_order || activeDraftContext?.player_ids || []
            if (!draftOrder.length) return playersData || []
            const playersById = Object.fromEntries((playersData || []).map((player) => [player.id, player]))
            return draftOrder.map((id) => playersById[id]).filter(Boolean)
          })()

      setPlayers(orderedPlayers)
      setLoading(false)
    }

    load()
    return () => { active = false }
  }, [isSeasonMode, activeDraftContext?.id, activeDraftContext?.draft_order, activeDraftContext?.player_ids, seasonTeams])

  useEffect(() => {
    const ambientCrowd = new SeamlessLoopAudio(DEFAULT_CROWD_NOISE_URL, {
      volume: AMBIENT_CROWD_VOLUME,
      crossfadeMs: AMBIENT_CROWD_CROSSFADE_MS,
    })

    const standardChime = new Audio(PICK_IN_CHIME_URL)
    standardChime.preload = 'auto'
    standardChime.playsInline = true
    standardChime.volume = PICK_IN_CHIME_VOLUME

    const bassChime = new Audio(PICK_IN_BASS_CHIME_URL)
    bassChime.preload = 'auto'
    bassChime.playsInline = true
    bassChime.volume = PICK_IN_CHIME_VOLUME

    const customPickInUrls = [...new Set(
      Object.values(CUSTOM_PICK_IN_AUDIO_CONFIGS).flatMap((config) => getCustomPickInAudioUrls(config)),
    )]
    const customPickInAudios = Object.fromEntries(
      customPickInUrls.map((url) => {
        const audio = new Audio(url)
        audio.preload = 'auto'
        audio.playsInline = true
        audio.volume = PICK_IN_CHIME_VOLUME
        return [url, audio]
      }),
    )

    const reactionAudios = Object.fromEntries(
      Object.entries(REVEAL_REACTION_AUDIO_URLS).map(([key, url]) => {
        const audio = new Audio(url)
        audio.preload = 'auto'
        audio.playsInline = true
        audio.volume = REVEAL_CROWD_VOLUME
        return [key, audio]
      }),
    )

    ambientCrowdRef.current = ambientCrowd
    standardChimeRef.current = standardChime
    bassChimeRef.current = bassChime
    customPickInAudioRefs.current = customPickInAudios
    reactionAudioRefs.current = reactionAudios

    // Browsers won't let an AudioContext run until the user has interacted
    // with the page. Unlock it on the very first interaction anywhere (using
    // the capture phase so an in-app stopPropagation can't swallow it) so
    // ambient crowd noise starts immediately instead of waiting for the user
    // to navigate slides.
    const unlockAmbientAudio = () => {
      if (currentSlideKindRef.current === 'clock') {
        safePlayAudio(ambientCrowd, { restart: false, volume: AMBIENT_CROWD_VOLUME })
      }
    }
    const unlockEvents = ['pointerdown', 'keydown', 'touchstart']
    unlockEvents.forEach((eventName) => {
      window.addEventListener(eventName, unlockAmbientAudio, { capture: true, once: true })
    })

    return () => {
      ambientFadeCancelRef.current?.()
      ambientFadeCancelRef.current = null
      if (reactionAutoFadeTimeoutRef.current != null) {
        window.clearTimeout(reactionAutoFadeTimeoutRef.current)
        reactionAutoFadeTimeoutRef.current = null
      }
      unlockEvents.forEach((eventName) => {
        window.removeEventListener(eventName, unlockAmbientAudio, { capture: true })
      })
      ambientCrowd.destroy()
      stopAudio(standardChime)
      stopAudio(bassChime)
      Object.values(customPickInAudios).forEach((audio) => stopAudio(audio))
      Object.values(reactionAudios).forEach((audio) => stopAudio(audio))
      ambientCrowdRef.current = null
      standardChimeRef.current = null
      bassChimeRef.current = null
      customPickInAudioRefs.current = {}
      reactionAudioRefs.current = {}
    }
  }, [])

  const charactersById = useMemo(() => Object.fromEntries(characters.map((character) => [character.id, character])), [characters])
  const characterAnalysesById = useMemo(
    () => Object.fromEntries(
      characters
        .map((character) => [character.id, analyzeCharacterTalent(character)])
        .filter(([, analysis]) => Boolean(analysis)),
    ),
    [characters],
  )
  const overallRankByCharacterId = useMemo(
    () => buildCharacterValueRanks(characterAnalysesById),
    [characterAnalysesById],
  )
  const tournamentIdentity = useTournamentTeamIdentity(!isSeasonMode ? activeDraftContext?.id : null)
  const seasonDraftPicks = useSeasonDraftPicks(isSeasonMode ? activeDraftContext?.id : null, seasonTeams, characters)
  const draftPicks = isSeasonMode ? seasonDraftPicks : tournamentIdentity.draftPicks

  const identitiesByPlayerId = useMemo(
    () => (isSeasonMode ? buildSeasonIdentities(seasonTeams) : tournamentIdentity.identitiesByPlayerId),
    [isSeasonMode, seasonTeams, tournamentIdentity.identitiesByPlayerId],
  )
  const resolvedIdentitiesByPlayerId = useMemo(
    () => Object.fromEntries(
      players.map((draftPlayer) => [
        draftPlayer.id,
        mergeIdentityLayers(
          identitiesByPlayerId[draftPlayer.id],
          buildPlayerIdentity(draftPlayer),
        ),
      ]),
    ),
    [identitiesByPlayerId, players],
  )

  const { totalPicks } = useMemo(
    () => getCurrentDraftState(players, draftPicks),
    [players, draftPicks],
  )

  const draftStatusOpen = isSeasonMode ? activeDraftContext?.status === 'draft' : activeDraftContext?.status === 'drafting'
  const slideDeck = useMemo(() => buildDraftSlides(players, totalPicks), [players, totalPicks])
  const submittedPicksByNumber = useMemo(
    () => Object.fromEntries(
      draftPicks
        .filter((pick) => pick.character_id)
        .map((pick) => [Number(pick.pick_number), pick]),
    ),
    [draftPicks],
  )

  useEffect(() => {
    setSlideIndex(0)
    ambientFadeCancelRef.current?.()
    ambientFadeCancelRef.current = null
    stopAudio(ambientCrowdRef.current)
    if (ambientCrowdRef.current) {
      ambientCrowdRef.current.volume = AMBIENT_CROWD_VOLUME
    }
    stopAudio(standardChimeRef.current)
    stopAudio(bassChimeRef.current)
    Object.values(customPickInAudioRefs.current).forEach((audio) => stopAudio(audio))
    reactionFadeCancelRef.current?.()
    reactionFadeCancelRef.current = null
    if (reactionAutoFadeTimeoutRef.current != null) {
      window.clearTimeout(reactionAutoFadeTimeoutRef.current)
      reactionAutoFadeTimeoutRef.current = null
    }
    if (customRevealCrowdTimeoutRef.current != null) {
      window.clearTimeout(customRevealCrowdTimeoutRef.current)
      customRevealCrowdTimeoutRef.current = null
    }
    activeReactionAudioRef.current = null
    activeCustomRevealAudioRef.current = null
    Object.values(reactionAudioRefs.current).forEach((audio) => {
      stopAudio(audio)
      audio.volume = REVEAL_CROWD_VOLUME
      audio.loop = false
    })
    pickInAudioStateRef.current = { slideKey: null, played: false }
    revealAudioStateRef.current = { slideKey: null, played: false }
  }, [activeDraftContext?.id, mode])

  useEffect(() => {
    setSlideIndex((current) => Math.min(current, Math.max(slideDeck.length - 1, 0)))
  }, [slideDeck.length])

  const advanceSlide = useCallback(() => {
    setSlideIndex((current) => Math.min(current + 1, Math.max(slideDeck.length - 1, 0)))
  }, [slideDeck.length])

  const retreatSlide = useCallback(() => {
    setSlideIndex((current) => Math.max(current - 1, 0))
  }, [])

  useEffect(() => {
    if (!activeDraftContext?.id) return undefined

    const channelName = isSeasonMode ? `season-presentation-${activeDraftContext.id}` : `presentation-${activeDraftContext.id}`
    const channel = supabase
      .channel(channelName)
      .on('broadcast', { event: 'advance' }, () => requestAdvanceRef.current())
      .on('broadcast', { event: 'back' }, retreatSlide)
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [activeDraftContext?.id, isSeasonMode, retreatSlide])

  useEffect(() => {
    const onKeyDown = (event) => {
      if (ADVANCE_KEYS.has(event.key)) {
        event.preventDefault()
        requestAdvanceRef.current()
        return
      }

      if (BACK_KEYS.has(event.key)) {
        event.preventDefault()
        retreatSlide()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [retreatSlide])

  const currentSlide = slideDeck[slideIndex] || null
  currentSlideKindRef.current = currentSlide?.kind || null
  const currentPickMeta = currentSlide?.pickMeta || null
  const submittedPick = currentPickMeta ? submittedPicksByNumber[currentPickMeta.pickNumber] || null : null
  const submittedCharacter = submittedPick ? charactersById[submittedPick.character_id] : null
  const customPickInAudioConfig = getCustomPickInAudioConfig(submittedCharacter?.name)
  const submittedCharacterAnalysis = submittedCharacter ? characterAnalysesById[submittedCharacter.id] || null : null
  const submittedTeamChemistry = useMemo(() => {
    if (!currentPickMeta?.pickNumber || !submittedPick?.player_id || !submittedCharacter) return null

    const priorSelections = buildPriorTeamSelections(
      draftPicks,
      currentPickMeta.pickNumber,
      submittedPick.player_id,
      charactersById,
    )
    const chemistryName = getCharacterChemistryName(submittedCharacter.name, submittedPick.mii_color)

    return buildTeamChemistryConnections(chemistryName, priorSelections)
  }, [charactersById, currentPickMeta?.pickNumber, draftPicks, submittedCharacter, submittedPick])
  const currentTeamRoster = useMemo(() => {
    if (!currentPickMeta?.pickNumber || !currentPickMeta?.drafter?.id) return []

    return buildPriorTeamRosterRows(
      draftPicks,
      currentPickMeta.pickNumber,
      currentPickMeta.drafter.id,
      charactersById,
      characterAnalysesById,
    )
  }, [characterAnalysesById, charactersById, currentPickMeta?.drafter?.id, currentPickMeta?.pickNumber, draftPicks])
  const slideIdentity = currentPickMeta?.drafter
    ? resolvedIdentitiesByPlayerId[currentPickMeta.drafter.id] || null
    : null
  const captainPick = currentPickMeta?.drafter
    ? draftPicks.find((pick) => pick.player_id === currentPickMeta.drafter.id && pick.is_captain && pick.character_id)
    : null
  const captainName = captainPick
    ? formatCharacterDisplayName(charactersById[captainPick.character_id]?.name, captainPick.mii_color)
    : null
  const requestAdvance = useCallback(() => {
    advanceSlide()
  }, [advanceSlide])
  requestAdvanceRef.current = requestAdvance

  useEffect(() => {
    const ambientCrowd = ambientCrowdRef.current
    if (!ambientCrowd) return

    ambientFadeCancelRef.current?.()
    ambientFadeCancelRef.current = null

    if (currentSlide?.kind === 'clock') {
      stopAudio(standardChimeRef.current)
      stopAudio(bassChimeRef.current)
      Object.values(reactionAudioRefs.current).forEach((audio) => stopAudio(audio))
      safePlayAudio(ambientCrowd, { restart: false, volume: AMBIENT_CROWD_VOLUME })

      // Browsers block autoplay-with-sound until the user has interacted with
      // the page, so the very first play() above can silently fail. Retry once
      // on the first interaction.
      if (ambientCrowd.paused) {
        const retryPlay = () => {
          if (currentSlide?.kind === 'clock') {
            safePlayAudio(ambientCrowd, { restart: false, volume: AMBIENT_CROWD_VOLUME })
          }
          window.removeEventListener('pointerdown', retryPlay)
          window.removeEventListener('keydown', retryPlay)
        }
        window.addEventListener('pointerdown', retryPlay)
        window.addEventListener('keydown', retryPlay)
        return () => {
          window.removeEventListener('pointerdown', retryPlay)
          window.removeEventListener('keydown', retryPlay)
        }
      }
      return
    }

    if (currentSlide?.kind === 'pick-in' && !ambientCrowd.paused) {
      ambientFadeCancelRef.current = fadeAudioVolume(ambientCrowd, 0, CROWD_FADE_OUT_DURATION_MS, () => {
        stopAudio(ambientCrowd)
        ambientCrowd.volume = AMBIENT_CROWD_VOLUME
      })
      return
    }

    stopAudio(ambientCrowd)
    ambientCrowd.volume = AMBIENT_CROWD_VOLUME
  }, [currentSlide?.key, currentSlide?.kind])

  useEffect(() => {
    if (currentSlide?.kind !== 'pick-in') {
      pickInAudioStateRef.current = { slideKey: null, played: false }
      return
    }

    if (pickInAudioStateRef.current.slideKey !== currentSlide.key) {
      pickInAudioStateRef.current = { slideKey: currentSlide.key, played: false }
    }

    if (!submittedPick || pickInAudioStateRef.current.played) return

    const character = charactersById[submittedPick.character_id]
    const shouldUseBassBoosted = character?.name === 'Monty Mole'
    const audio = shouldUseBassBoosted ? bassChimeRef.current : standardChimeRef.current

    stopAudio(standardChimeRef.current)
    stopAudio(bassChimeRef.current)
    Object.values(customPickInAudioRefs.current).forEach((entry) => stopAudio(entry))
    stopAudio(audio)
    Object.values(reactionAudioRefs.current).forEach((entry) => stopAudio(entry))
    safePlayAudio(audio, { volume: PICK_IN_CHIME_VOLUME })
    pickInAudioStateRef.current = { slideKey: currentSlide.key, played: true }
    return undefined
  }, [charactersById, currentSlide?.key, currentSlide?.kind, submittedPick])

  useEffect(() => {
    if (currentSlide?.kind !== 'reveal') {
      revealAudioStateRef.current = { slideKey: null, played: false }
      return undefined
    }

    if (revealAudioStateRef.current.slideKey !== currentSlide.key) {
      revealAudioStateRef.current = { slideKey: currentSlide.key, played: false }
    }

    if (!submittedPick || revealAudioStateRef.current.played) return undefined

    const character = charactersById[submittedPick.character_id]
    const reaction = resolveCrowdReactionForPick({
      pickMeta: currentPickMeta,
      submittedPick,
      character,
      characters,
      charactersById,
      draftPicks,
      characterAnalysesById,
      overallRankByCharacterId,
    })
    const audio = reaction?.soundKey ? reactionAudioRefs.current[reaction.soundKey] : null
    const customAudioUrl = pickRandomCustomPickInAudioUrl(customPickInAudioConfig)
    const customAudio = customAudioUrl ? customPickInAudioRefs.current[customAudioUrl] : null

    if (!audio && !customAudio) return undefined

    reactionFadeCancelRef.current?.()
    reactionFadeCancelRef.current = null
    if (reactionAutoFadeTimeoutRef.current != null) {
      window.clearTimeout(reactionAutoFadeTimeoutRef.current)
      reactionAutoFadeTimeoutRef.current = null
    }
    if (customRevealCrowdTimeoutRef.current != null) {
      window.clearTimeout(customRevealCrowdTimeoutRef.current)
      customRevealCrowdTimeoutRef.current = null
    }
    Object.values(customPickInAudioRefs.current).forEach((entry) => stopAudio(entry))
    activeCustomRevealAudioRef.current = customAudio || null
    if (customAudio) {
      safePlayAudio(customAudio, { volume: customPickInAudioConfig?.volume ?? REVEAL_CROWD_VOLUME })
    }

    if (!audio) {
      revealAudioStateRef.current = { slideKey: currentSlide.key, played: true }
      return () => {
        if (activeCustomRevealAudioRef.current) {
          stopAudio(activeCustomRevealAudioRef.current)
          activeCustomRevealAudioRef.current = null
        }
      }
    }

    stopAudio(audio)
    audio.loop = true
    Object.values(reactionAudioRefs.current).forEach((entry) => {
      if (entry !== audio) {
        stopAudio(entry)
        entry.loop = false
      }
    })
    activeReactionAudioRef.current = audio
    revealAudioStateRef.current = { slideKey: currentSlide.key, played: true }
    const startCrowdReaction = () => {
      if (activeReactionAudioRef.current !== audio) return

      if (customAudio) {
        safePlayAudio(audio, { volume: 0 })
        reactionFadeCancelRef.current?.()
        reactionFadeCancelRef.current = fadeAudioVolume(audio, REVEAL_CROWD_VOLUME, CUSTOM_REVEAL_CROWD_FADE_IN_MS)
      } else {
        safePlayAudio(audio, { volume: REVEAL_CROWD_VOLUME })
      }

      reactionAutoFadeTimeoutRef.current = window.setTimeout(() => {
        reactionAutoFadeTimeoutRef.current = null
        if (activeReactionAudioRef.current !== audio) return
        reactionFadeCancelRef.current?.()
        reactionFadeCancelRef.current = fadeAudioVolume(audio, 0, CROWD_FADE_OUT_DURATION_MS, () => {
          if (activeReactionAudioRef.current === audio) {
            activeReactionAudioRef.current = null
          }
          stopAudio(audio)
          audio.loop = false
          audio.volume = REVEAL_CROWD_VOLUME
        })
      }, pickRandomInteger(MIN_REACTION_PLAY_DURATION_MS, MAX_REACTION_PLAY_DURATION_MS))
    }

    if (customAudio) {
      customRevealCrowdTimeoutRef.current = window.setTimeout(() => {
        customRevealCrowdTimeoutRef.current = null
        startCrowdReaction()
      }, CUSTOM_REVEAL_CROWD_DELAY_MS)
    } else {
      startCrowdReaction()
    }

    // Fade the crowd reaction out when the slide changes/exits, instead of
    // cutting it off abruptly.
    return () => {
      if (customRevealCrowdTimeoutRef.current != null) {
        window.clearTimeout(customRevealCrowdTimeoutRef.current)
        customRevealCrowdTimeoutRef.current = null
      }
      const activeCustomAudio = activeCustomRevealAudioRef.current
      if (activeCustomAudio) {
        stopAudio(activeCustomAudio)
        activeCustomRevealAudioRef.current = null
      }
      const activeAudio = activeReactionAudioRef.current
      if (!activeAudio) return
      if (reactionAutoFadeTimeoutRef.current != null) {
        window.clearTimeout(reactionAutoFadeTimeoutRef.current)
        reactionAutoFadeTimeoutRef.current = null
      }
      activeReactionAudioRef.current = null
      reactionFadeCancelRef.current?.()
      reactionFadeCancelRef.current = fadeAudioVolume(activeAudio, 0, CROWD_FADE_OUT_DURATION_MS, () => {
        stopAudio(activeAudio)
        activeAudio.loop = false
        activeAudio.volume = REVEAL_CROWD_VOLUME
      })
    }
  }, [
    characterAnalysesById,
    characters,
    charactersById,
    currentPickMeta,
    currentSlide?.key,
    currentSlide?.kind,
    customPickInAudioConfig,
    draftPicks,
    overallRankByCharacterId,
    submittedPick,
  ])

  if (authLoading) {
    return (
      <ScreenShell theme={buildPresentationTheme(null)}>
        <div style={{ fontSize: 36, fontWeight: 800, color: C.muted }}>Checking access...</div>
      </ScreenShell>
    )
  }

  if (!player?.is_commissioner) {
    return (
      <ScreenShell theme={buildPresentationTheme(null)}>
        <div style={{ display: 'grid', gap: 12, justifyItems: 'center', textAlign: 'center' }}>
          <div style={{ fontSize: 42, fontWeight: 900, color: C.text }}>Not authorized.</div>
          <div style={{ fontSize: 18, color: C.muted }}>Only the commissioner can use presentation mode.</div>
        </div>
      </ScreenShell>
    )
  }

  if (loading || !currentSlide) {
    return (
      <ScreenShell theme={buildPresentationTheme(null)}>
        <div style={{ fontSize: 36, fontWeight: 800, color: C.muted }}>Loading draft...</div>
      </ScreenShell>
    )
  }

  if (currentSlide.kind === 'clock') {
    return (
      <OnTheClockScreen
        draftStatusOpen={draftStatusOpen}
        currentDrafter={currentPickMeta?.drafter}
        currentTeamRoster={currentTeamRoster}
        identity={slideIdentity}
        captainName={captainName}
        hideCaptain={currentPickMeta?.round === 1}
        round={currentPickMeta?.round}
        pickNumber={currentPickMeta?.pickNumber}
        isCaptainRound={currentPickMeta?.round === 1}
        onAdvance={requestAdvance}
      />
    )
  }

  if (currentSlide.kind === 'pick-in') {
    return (
      <PickIsInScreen
        pickMeta={currentPickMeta}
        submittedPick={submittedPick}
        identity={slideIdentity}
        drafterName={currentPickMeta?.drafter?.name}
        onAdvance={requestAdvance}
      />
    )
  }

  if (currentSlide.kind === 'reveal') {
    return (
      <PickRevealScreen
        pickMeta={currentPickMeta}
        submittedPick={submittedPick}
        character={submittedCharacter}
        characterAnalysis={submittedCharacterAnalysis}
        teamChemistry={submittedTeamChemistry}
        identity={slideIdentity}
        drafterName={currentPickMeta?.drafter?.name}
        onAdvance={requestAdvance}
      />
    )
  }

  return (
    <DraftCompleteScreen
      players={players}
      identitiesByPlayerId={resolvedIdentitiesByPlayerId}
      draftPicks={draftPicks}
      characterAnalysesById={characterAnalysesById}
      onAdvance={requestAdvance}
    />
  )
}

export function TournamentDraftPresentation() {
  return <DraftPresentation mode="tournament" />
}

export function SeasonDraftPresentation() {
  return <DraftPresentation mode="season" />
}
