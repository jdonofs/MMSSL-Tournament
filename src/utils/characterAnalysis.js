import talentProfiles from '../data/characterTalentProfiles.json'
import { buildCharacterIntrinsics } from './statsCalculator'
import { getChemistry } from '../data/chemistry'
import { isMiiCharacter } from './mii'
import { isCaptainCharacterName } from './teamIdentity'
import {
  BASERUNNING_ABILITY_OFFENSE_BONUS,
  CHARACTER_BASERUNNING_ABILITY,
  CHARACTER_FIELDING_ABILITY,
  CHARACTER_STAR_PITCH,
  CHARACTER_STAR_SWING,
  CHEMISTRY_NAME_MAP,
  FIELDING_ABILITY_DEFENSE_BONUS,
  STAR_PITCH_BONUS,
  STAR_SWING_BONUS,
} from '../data/characterAbilities'


// Reference distribution from the current character pool. We map scores into
// bell-curve style percentile buckets instead of using fixed absolute cutoffs.
const TIER_REFERENCE_MEAN = 57.14
const TIER_REFERENCE_STD_DEV = 9.36
const MII_TALENT_COLOR_MAP = {
  'Dark Green': 'green',
  'Dark Blue': 'blue',
}

function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value))
}

export function toDisplayRating(score) {
  return Math.max(0, Math.round(Number(score || 0)))
}

function average(values = []) {
  const valid = values.filter((value) => Number.isFinite(value))
  if (!valid.length) return 0
  return valid.reduce((sum, value) => sum + value, 0) / valid.length
}

export function normalizeCharacterTalentKey(name = '') {
  return String(name)
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

const TALENT_KEY_ALIASES = {
  'koopa':            'koopa troopa',
  'paratroopa':       'koopa paratroopa',
  'red koopa':        'red koopa troopa',
  'green paratroopa': 'green koopa paratroopa',
}

function resolveCharacterTalentKey(character) {
  if (!character) return ''

  const directKey = normalizeCharacterTalentKey(character.name)
  if (talentProfilesByKey[directKey]) return directKey

  const aliasKey = normalizeCharacterTalentKey(TALENT_KEY_ALIASES[directKey] || '')
  if (aliasKey && talentProfilesByKey[aliasKey]) return aliasKey

  if (isMiiCharacter(character)) {
    const rawColor = character.miiColor || character.mii_color || character.displayName?.replace(/\s+mii$/i, '')
    const normalizedColor = MII_TALENT_COLOR_MAP[rawColor] || rawColor
    if (normalizedColor) {
      const miiKey = normalizeCharacterTalentKey(`${normalizedColor} mii (m)`)
      if (talentProfilesByKey[miiKey]) return miiKey
    }

    const genericMiiKey = normalizeCharacterTalentKey('red mii (m)')
    if (talentProfilesByKey[genericMiiKey]) return genericMiiKey
  }

  return directKey
}

function resolveCharacterAbilityKey(character) {
  if (!character) return ''
  if (isMiiCharacter(character)) return 'mii'
  return normalizeCharacterTalentKey(character.name)
}

function buildDerivedProfile(profile = {}) {
  const contact = profile.contact || {}
  const starContact = profile.starContact || {}
  const hitbox = profile.hitbox || {}
  const catchProfile = profile.catch || {}
  const charge = profile.charge || {}
  const changeup = profile.changeup || {}
  const batterLocation = profile.batterLocation || {}
  const size = profile.size || {}

  const normalPerfectWindow = average([contact.slapPerfectTotal, contact.chargePerfectTotal])
  const normalForgiveness = average([contact.slapNicePerfect, contact.chargeNicePerfect])
  const starPerfectWindow = average([starContact.slapPerfectTotal, starContact.chargePerfectTotal])
  const starForgiveness = average([starContact.slapNicePerfect, starContact.chargeNicePerfect])
  const plateCoverage =
    ((Number(batterLocation.farLimit || 0) - Number(batterLocation.nearLimit || 0)) * 100) +
    (Number(batterLocation.hitZoneHeight || 0) * 15) +
    (Number(batterLocation.finalHitHeight || 0) * 10) +
    (normalForgiveness * 35)

  return {
    power:
      (Number(profile.chargePower || 0) * 1.0) +
      (Number(profile.slapPower || 0) * 0.35) +
      (Number(profile.chargeContact || 0) * 0.15) +
      (Number(profile.slapContact || 0) * 0.05),
    chargeContact: Number(profile.chargeContact || 0),
    slapContact: Number(profile.slapContact || 0),
    contactPerfectWindow: normalPerfectWindow * 1000,
    contactForgiveness: normalForgiveness * 100,
    pcHorizontalReach: Number(batterLocation.farLimit || 0) - Number(batterLocation.nearLimit || 0),
    pcZoneHeight: Number(batterLocation.hitZoneHeight || 0),
    pcMoveSpeed: Number(batterLocation.moveSpeed || 0),
    pcHitboxWidth: Number(hitbox.width || 0),
    velocity: (Number(profile.fastballSpeed || 0) * 0.65) + (Number(profile.curveballSpeed || 0) * 0.35),
    curve: Number(profile.curve || 0),
    stamina: Number(profile.stamina || 0),
    changeupSeparation:
      ((1 - Number(changeup.speedMultiplier || 0.7)) * 100) +
      (Number(changeup.height || 15) * 0.6),
    catchCoverage:
      (Number(catchProfile.regular || 0) * 0.35) +
      (Number(catchProfile.dive || 0) * 0.26) +
      (Number(catchProfile.height || 0) * 0.25) +
      (Number(catchProfile.jumpWidth || 0) * 0.14),
    armStrength: Number(profile.throwingSpeed || 0),
    fielding: Number(profile.fielding || 0),
    physicality:
      (Number(hitbox.height || 0) * 0.75) +
      (Number(hitbox.width || 0) * 0.25) +
      (Number(size.gameplayScale || 1) * 0.2),
    mobility:
      Number(profile.runSpeed || 0) +
      (Number(batterLocation.moveSpeed || 0) * 900) -
      (Number(size.gameplayScale || 1) * 6),
    bunting: Number(profile.bunting || 0),
    chargeControl:
      (Number(charge.keepFrames || 30) * 1.2) -
      Number(charge.upFrames || 60) +
      (Number(batterLocation.moveSpeed || 0) * 1500),
    starCeilingBase: Number(profile.chargePower || 0) * 1.5,
  }
}

const profileEntries = Object.entries(talentProfiles).map(([name, profile]) => [
  normalizeCharacterTalentKey(name),
  profile,
])

const talentProfilesByKey = Object.fromEntries(profileEntries)
const derivedProfilesByKey = Object.fromEntries(profileEntries.map(([key, profile]) => [key, buildDerivedProfile(profile)]))
const derivedMetricKeys = Object.keys(Object.values(derivedProfilesByKey)[0] || {})

const derivedRanges = derivedMetricKeys.reduce((ranges, metric) => {
  const values = Object.values(derivedProfilesByKey)
    .map((profile) => profile[metric])
    .filter((value) => Number.isFinite(value))
  ranges[metric] = {
    min: Math.min(...values),
    max: Math.max(...values),
  }
  return ranges
}, {})

function scaleDerivedMetric(metric, value) {
  if (!Number.isFinite(value)) return 0
  // contactWindow raw values cluster in a narrow band (e.g. 200–296) with some zeros
  // for characters without profile data. Soft-normalize using the observed distribution
  // with 10% padding so actual min/max don't land exactly at 0 or 100.
  if (metric === 'contactPerfectWindow' || metric === 'contactForgiveness' ||
      metric === 'pcHorizontalReach' || metric === 'pcHitboxWidth' ||
      metric === 'pcZoneHeight' || metric === 'pcMoveSpeed') {
    const range = derivedRanges[metric]
    if (!range || range.max === range.min) return value
    const pad = (range.max - range.min) * 0.10
    const softMin = range.min - pad
    const softMax = range.max + pad
    return clamp(((value - softMin) / (softMax - softMin)) * 100)
  }
  return value
}

function scaleStarCeiling(value) {
  return clamp(((Number(value || 0) - 20) / (150 - 20)) * 100)
}

function deriveArchetype(scores = {}) {
  const ordered = Object.entries(scores).sort((a, b) => b[1] - a[1])
  const topKey = ordered[0]?.[0]
  const secondKey = ordered[1]?.[0]
  const topScore = ordered[0]?.[1] || 0
  const secondScore = ordered[1]?.[1] || 0

  if (topScore >= 72 && secondScore >= 68) {
    if (topKey === 'offense' && secondKey === 'pitching') return 'Two-way anchor'
    if (topKey === 'pitching' && secondKey === 'defense') return 'Run-prevention ace'
    if (topKey === 'defense' && secondKey === 'speed') return 'Elite glove catalyst'
    if (topKey === 'offense' && secondKey === 'speed') return 'Pressure bat'
  }

  if (topKey === 'offense') return 'Impact bat'
  if (topKey === 'pitching') return 'Mound specialist'
  if (topKey === 'defense') return 'Defensive stopper'
  if (topKey === 'speed') return 'Utility burner'
  return 'Balanced contributor'
}

function buildTier(score) {
  const zScore = (Number(score || 0) - TIER_REFERENCE_MEAN) / TIER_REFERENCE_STD_DEV

  if (zScore >= 1.645) return 'S'
  if (zScore >= 0.842) return 'A'
  if (zScore >= 0) return 'B'
  if (zScore >= -0.842) return 'C'
  if (zScore >= -1.645) return 'D'
  return 'F'
}

export function getTalentTierMeta(tier = 'C') {
  switch (tier) {
    case 'S':
      return { label: 'S Tier', color: '#7DD3FC' }
    case 'A':
      return { label: 'A Tier', color: '#166534' }
    case 'B':
      return { label: 'B Tier', color: '#4ADE80' }
    case 'C':
      return { label: 'C Tier', color: '#EAB308' }
    case 'D':
      return { label: 'D Tier', color: '#F97316' }
    case 'F':
      return { label: 'F Tier', color: '#EF4444' }
    default:
      return { label: `${tier} Tier`, color: '#EAB308' }
  }
}

function buildHistoryAdjustment(history = []) {
  const valid = history.filter((entry) => Number.isFinite(entry?.perfScore))
  if (!valid.length) {
    return { historyScore: null, weight: 0, tournaments: 0 }
  }
  const historyScore = average(valid.map((entry) => entry.perfScore)) * 10
  const weight = Math.min(valid.length / 4, 1) * 0.18
  return { historyScore, weight, tournaments: valid.length }
}

function describeStrength(label, score) {
  if (score >= 78) return `elite ${label}`
  if (score >= 65) return `strong ${label}`
  return label
}

function buildSummary(archetype, scores = {}) {
  const labels = {
    offense: 'offense',
    pitching: 'pitching',
    defense: 'defense',
    speed: 'mobility',
  }
  const ordered = Object.entries(scores).sort((a, b) => b[1] - a[1])
  const strengths = ordered.slice(0, 2).map(([key, score]) => describeStrength(labels[key], score))
  const weakness = ordered.at(-1)
  const weaknessLabel = weakness && weakness[1] < 48 ? labels[weakness[0]] : null
  return `${archetype}. ${strengths.join(' and ')} carry the profile${weaknessLabel ? `, while ${weaknessLabel} is the main tradeoff.` : '.'}`
}

const TARGET_TIER_BREAKS = [
  ['F', 0.05],
  ['D', 0.15],
  ['C', 0.30],
  ['B', 0.30],
  ['A', 0.15],
  ['S', 0.05],
]

let cachedPoolScores = null
let cachedRolePoolScores = null
let cachedRoleDisplayDistributions = null
let cachedDisplayOverallPoolScores = null

function isTierReferenceProfileKey(key = '') {
  return !key.includes('mii') && !key.startsWith('unused ')
}

export function getCharacterTalentProfile(name) {
  return talentProfilesByKey[normalizeCharacterTalentKey(name)] || null
}

function partnerStrength(partnerName) {
  let key = normalizeCharacterTalentKey(partnerName)
  key = CHEMISTRY_NAME_MAP[key] || key
  const p = talentProfilesByKey[key]
  if (!p) return null
  // Use batting + pitching average as proxy for how impactful a partner is
  return ((Number(p.displayedBatting) || 5) + (Number(p.displayedPitching) || 5)) / 2
}

function computeChemistryAdjustment(characterName) {
  const chem = getChemistry(characterName)
  if (!chem || (chem.good.length === 0 && chem.bad.length === 0)) return 0
  const goodStrengths = chem.good.map(partnerStrength).filter(v => v !== null)
  const badStrengths  = chem.bad.map(partnerStrength).filter(v => v !== null)
  // Each partner above average (5) contributes to the bonus/penalty
  const goodSum = goodStrengths.reduce((s, v) => s + Math.max(0, v - 5), 0)
  const badSum  = badStrengths.reduce((s, v) => s + Math.max(0, v - 5), 0)
  const goodBonus  = Math.min(goodSum * 0.45, 4.0)
  const badPenalty = Math.min(badSum  * 0.18, 1.5)
  return goodBonus - badPenalty
}

function getPoolScores() {
  if (cachedPoolScores) return cachedPoolScores

  cachedPoolScores = profileEntries
    .filter(([key]) => isTierReferenceProfileKey(key))
    .map(([key]) => computeTalentAnalysis({ name: key }, [])?.trueValue ?? 0)
    .sort((a, b) => a - b)

  return cachedPoolScores
}

function getRolePoolScores() {
  if (cachedRolePoolScores) return cachedRolePoolScores

  const analyses = profileEntries
    .filter(([key]) => isTierReferenceProfileKey(key))
    .map(([key]) => computeTalentAnalysis({ name: key }, []))

  cachedRolePoolScores = {
    batting: analyses.map((a) => a?.battingScore ?? 0).sort((a, b) => a - b),
    pitching: analyses.map((a) => a?.pitchingScore ?? 0).sort((a, b) => a - b),
    fielding: analyses.map((a) => a?.fieldingScore ?? 0).sort((a, b) => a - b),
    speed: analyses.map((a) => a?.speedScore ?? 0).sort((a, b) => a - b),
  }

  return cachedRolePoolScores
}

function getRoleDisplayDistributions() {
  if (cachedRoleDisplayDistributions) return cachedRoleDisplayDistributions

  const roleScores = getRolePoolScores()
  const buildDistribution = (scores = []) => {
    const mean = average(scores)
    const stdDev = Math.sqrt(average(scores.map((score) => (score - mean) ** 2))) || 1
    return { mean, stdDev }
  }

  cachedRoleDisplayDistributions = {
    batting: buildDistribution(roleScores.batting),
    pitching: buildDistribution(roleScores.pitching),
    fielding: buildDistribution(roleScores.fielding),
    speed: buildDistribution(roleScores.speed),
  }

  return cachedRoleDisplayDistributions
}

function getDisplayOverallPoolScores() {
  if (cachedDisplayOverallPoolScores) return cachedDisplayOverallPoolScores

  const roleDisplayDistributions = getRoleDisplayDistributions()

  cachedDisplayOverallPoolScores = profileEntries
    .filter(([key]) => isTierReferenceProfileKey(key))
    .map(([key]) => {
      const a = computeTalentAnalysis({ name: key }, [])
      if (!a) return 0
      const db = mapRawRoleScoreToDisplayRating(a.battingScore, roleDisplayDistributions.batting)
      const dp = mapRawRoleScoreToDisplayRating(a.pitchingScore, roleDisplayDistributions.pitching)
      const df = mapRawRoleScoreToDisplayRating(a.fieldingScore, roleDisplayDistributions.fielding)
      const ds = mapRawRoleScoreToDisplayRating(a.speedScore, roleDisplayDistributions.speed)
      return buildDisplayedOverallRating({ batting: db, pitching: dp, fielding: df, speed: ds })
    })
    .sort((a, b) => a - b)

  return cachedDisplayOverallPoolScores
}

function mapRawRoleScoreToDisplayRating(rawScore, distribution = {}) {
  const mean = Number(distribution.mean || 0)
  const stdDev = Number(distribution.stdDev || 1) || 1
  const zScore = (Number(rawScore || 0) - mean) / stdDev

  const coreRating = 70 + (zScore * 12)
  const eliteTailBonus = zScore > 2.2 ? ((zScore - 2.2) ** 2) * 8 : 0
  const lowTailPenalty = zScore < -3 ? ((Math.abs(zScore) - 3) ** 2) * 6 : 0

  return Math.max(0, coreRating + eliteTailBonus - lowTailPenalty)
}

function buildDisplayedOverallRating({
  batting = 0,
  pitching = 0,
  fielding = 0,
  speed = 0,
} = {}) {
  const weighted =
    (batting * 0.35) +
    (pitching * 0.35) +
    (fielding * 0.18) +
    (speed * 0.12)

  // Reward standout specialists: a character carried by one elite category
  // (e.g. a slugger with so-so glove/legs) shouldn't score below a character
  // who is merely average across the board. The peak bonus credits the best
  // category beyond the weighted-average treatment.
  const peak = Math.max(batting, pitching, fielding, speed)
  const peakBonus = Math.max(0, peak - 70) * 0.25

  return weighted + peakBonus
}

function poolPercentile(scores, score) {
  if (!scores.length) return 0.5
  let lower = 0
  while (lower < scores.length && scores[lower] < score) lower += 1
  let upper = lower
  while (upper < scores.length && scores[upper] <= score) upper += 1
  return ((lower + upper) / 2) / scores.length
}

function getPoolPercentile(score) {
  return poolPercentile(getPoolScores(), Number(score || 0))
}

function buildPoolTier(score) {
  const percentile = getPoolPercentile(Number(score || 0))

  if (percentile >= 0.95) return 'S'
  if (percentile >= 0.80) return 'A'
  if (percentile >= 0.50) return 'B'
  if (percentile >= 0.20) return 'C'
  if (percentile >= 0.05) return 'D'
  return 'F'
}

function buildRolePoolTier(roleScores, score) {
  const percentile = poolPercentile(roleScores, Number(score || 0))
  if (percentile >= 0.95) return 'S'
  if (percentile >= 0.80) return 'A'
  if (percentile >= 0.50) return 'B'
  if (percentile >= 0.20) return 'C'
  if (percentile >= 0.05) return 'D'
  return 'F'
}

function computeTalentAnalysis(character, history = []) {
  if (!character) return null

  const normalizedKey = resolveCharacterTalentKey(character)
  const abilityKey = resolveCharacterAbilityKey(character)
  const profile = talentProfilesByKey[normalizedKey]
  const derived = profile ? derivedProfilesByKey[normalizedKey] : buildDerivedProfile({
    slapContact: character.slap_contact,
    chargeContact: character.charge_contact,
    slapPower: character.slap_power,
    chargePower: character.charge_power,
    bunting: character.bunting,
    runSpeed: character.run_speed ?? character.speed,
    throwingSpeed: character.throwing_speed,
    fielding: character.fielding_stat ?? character.fielding,
    curveballSpeed: character.curveball_speed,
    fastballSpeed: character.fastball_speed,
    curve: character.curve,
    stamina: character.stamina,
  })
  const intrinsics = buildCharacterIntrinsics(character)

  // ── Ability lookups ──────────────────────────────────────────────────────────
  const fieldingAbility = CHARACTER_FIELDING_ABILITY[abilityKey] || 'None'
  const baserunningAbility = CHARACTER_BASERUNNING_ABILITY[abilityKey] || 'None'
  const starPitchAbility = CHARACTER_STAR_PITCH[abilityKey] || 'Standard'
  const starSwingAbility = CHARACTER_STAR_SWING[abilityKey] || 'Standard'
  const fieldDefenseBonus = FIELDING_ABILITY_DEFENSE_BONUS[fieldingAbility] ?? 0
  const baserunningBonus = BASERUNNING_ABILITY_OFFENSE_BONUS[baserunningAbility] ?? 0
  const isCaptain = isCaptainCharacterName(character?.name)
  const starPitchBonus = (STAR_PITCH_BONUS[starPitchAbility] ?? 0) + (isCaptain ? 0 : 1)
  const starSwingBonus = STAR_SWING_BONUS[starSwingAbility] ?? 0

  const normalized = {
    power: scaleDerivedMetric('power', derived.power),
    chargeContact: scaleDerivedMetric('chargeContact', derived.chargeContact),
    slapContact: scaleDerivedMetric('slapContact', derived.slapContact),
    contactPerfectWindow: scaleDerivedMetric('contactPerfectWindow', derived.contactPerfectWindow),
    contactForgiveness: scaleDerivedMetric('contactForgiveness', derived.contactForgiveness),
    pcHorizontalReach: scaleDerivedMetric('pcHorizontalReach', derived.pcHorizontalReach),
    pcHitboxWidth: scaleDerivedMetric('pcHitboxWidth', derived.pcHitboxWidth),
    pcZoneHeight: scaleDerivedMetric('pcZoneHeight', derived.pcZoneHeight),
    pcMoveSpeed: scaleDerivedMetric('pcMoveSpeed', derived.pcMoveSpeed),
    velocity: scaleDerivedMetric('velocity', derived.velocity),
    curve: scaleDerivedMetric('curve', derived.curve),
    stamina: scaleDerivedMetric('stamina', derived.stamina),
    changeupSeparation: scaleDerivedMetric('changeupSeparation', derived.changeupSeparation),
    catchCoverage: scaleDerivedMetric('catchCoverage', derived.catchCoverage),
    armStrength: scaleDerivedMetric('armStrength', derived.armStrength),
    fielding: scaleDerivedMetric('fielding', derived.fielding),
    physicality: scaleDerivedMetric('physicality', derived.physicality),
    mobility: scaleDerivedMetric('mobility', derived.mobility),
    bunting: scaleDerivedMetric('bunting', derived.bunting),
    chargeControl: scaleDerivedMetric('chargeControl', derived.chargeControl),
    starCeiling: scaleStarCeiling(intrinsics.starCeiling ?? derived.starCeilingBase),
  }

  // Baserunning: mobility plus the character's actual baserunning ability.
  const baserunning = clamp((normalized.mobility * 0.75) + baserunningBonus)

  // Power ceiling bonus: home runs guarantee runs regardless of baserunners, so elite
  // charge power has strategic value beyond what expected-value (power × contact%)
  // captures. pureContact already penalizes low contact; this counterbalances for
  // characters who make up for low contact with game-breaking power when they connect.
  const powerCeilingBonus = Math.max(0, (profile?.chargePower || 0) - 75) * 0.16

  // Offense: pureContact reduced from 0.20→0.10 because contact is already baked into
  // powerTranslation (chargePower × chargeContact/100). Carrying it at full weight
  // double-penalizes low-contact power hitters. Freed weight goes to powerTranslation.
  const plateCoverage = clamp(
    (normalized.pcHorizontalReach * 0.60) +
    (normalized.pcHitboxWidth * 0.25) +
    (normalized.pcZoneHeight * 0.10) +
    (normalized.pcMoveSpeed * 0.05),
  )

  const contact = clamp(
    (normalized.chargeContact * 0.25) +
    (normalized.slapContact * 0.25) +
    (normalized.contactPerfectWindow * 0.30) +
    (normalized.contactForgiveness * 0.20),
  )

  const offense = clamp(
    (normalized.power * 0.51) +
    (contact * 0.26) +
    (plateCoverage * 0.15) +
    (baserunning * 0.08) +
    powerCeilingBonus +
    (starSwingBonus * 0.6),
  )

  // Pitching: same weights, star pitch ability added on top.
  const pitching = clamp(
    (normalized.velocity * 0.32) +
    (normalized.curve * 0.46) +
    (normalized.stamina * 0.22) +
    (starPitchBonus * 0.6),
  )

  // Defense: base weights unchanged; speed contributes range bonus; field ability is additive
  const baseDefense = clamp(
    (normalized.catchCoverage * 0.37) +
    (normalized.fielding * 0.37) +
    (normalized.armStrength * 0.26),
  )
  const speedRangeBonus = (normalized.mobility - 50) * 0.05
  const defense = clamp(baseDefense + speedRangeBonus + fieldDefenseBonus)

  const speed = normalized.mobility

  const star = clamp(
    normalized.starCeiling,
  )

  const categoryScores = { offense, pitching, defense, speed, star }
  const talentCategories = [offense, pitching, defense, speed]
  const categoryMean = average(talentCategories)
  const categoryStdDev = Math.sqrt(average(talentCategories.map((score) => (score - categoryMean) ** 2)))
  const versatilityCount = talentCategories.filter((score) => score >= 62).length
  const starBonus = Math.max(0, star - 55) * 0.08
  const balanceBonus = Math.max(0, 10 - categoryStdDev) / 3
  const versatilityBonus = Math.max(0, versatilityCount - 1) * 1.8

  const talentScore = clamp(
    (offense * 0.35) +
    (pitching * 0.35) +
    (defense * 0.18) +
    (speed * 0.12) +
    starBonus +
    balanceBonus +
    versatilityBonus,
  )

  // Chemistry: small adjustment to final score based on partner quality
  const chemAdjustment = computeChemistryAdjustment(character.name)

  const historyAdjustment = buildHistoryAdjustment(history)
  const trueValue = historyAdjustment.historyScore === null
    ? clamp(talentScore + chemAdjustment)
    : clamp((talentScore * (1 - historyAdjustment.weight)) + (historyAdjustment.historyScore * historyAdjustment.weight) + chemAdjustment)

  // ── Role OVRs ────────────────────────────────────────────────────────────────
  // Batting OVR: pure hitting value — offense score + star ceiling bonus.
  // Defense and speed are irrelevant to how good a batter someone is.
  const battingBase = clamp(offense + starBonus)
  const battingScore = historyAdjustment.historyScore === null
    ? clamp(battingBase + chemAdjustment)
    : clamp((battingBase * (1 - historyAdjustment.weight)) + (historyAdjustment.historyScore * historyAdjustment.weight) + chemAdjustment)

  // Pitching OVR: rates a character as a captain/pitcher
  // History is batting-based (perfScore = OPS), so apply at half weight to avoid
  // batting performance overriding pitching talent (e.g. a power hitter shouldn't
  // get a pitching boost just because they slug well)
  const pitchingBase = clamp(
    pitching +
    (starBonus * 0.5),
  )
  const pitchingHistoryWeight = historyAdjustment.weight * 0.5
  const pitchingScore = historyAdjustment.historyScore === null
    ? pitchingBase
    : clamp((pitchingBase * (1 - pitchingHistoryWeight)) + (historyAdjustment.historyScore * pitchingHistoryWeight))

  // Fielding OVR: defense score anchors it; speed adds range value since fast characters
  // can cover more ground and be placed in demanding positions like center field
  const fieldingScore = clamp((defense * 0.75) + (speed * 0.25))

  // Speed OVR: pure mobility score
  const speedScore = speed

  const archetype = deriveArchetype(categoryScores)
  const summary = buildSummary(archetype, categoryScores)

  return {
    normalizedKey,
    talentScore,
    trueValue,
    battingScore,
    pitchingScore,
    fieldingScore,
    speedScore,
    archetype,
    summary,
    historyScore: historyAdjustment.historyScore,
    historyWeight: historyAdjustment.weight,
    historyTournaments: historyAdjustment.tournaments,
    chemAdjustment,
    categoryScores,
    componentScores: normalized,
    displayRatings: {
      overall:      toDisplayRating(trueValue),
      batting:      toDisplayRating(battingScore),
      pitching:     toDisplayRating(pitchingScore),
      fielding:     toDisplayRating(fieldingScore),
      speed:        toDisplayRating(speedScore),
      offense:      toDisplayRating(offense),
      pitchingCat:  toDisplayRating(pitching),
      defense:      toDisplayRating(defense),
      speedCat:     toDisplayRating(speed),
    },
    rawMetrics: {
      batting: {
        power: normalized.power,
        contact,
        chargeContact: normalized.chargeContact,
        slapContact: normalized.slapContact,
        contactPerfectWindow: normalized.contactPerfectWindow,
        contactForgiveness: normalized.contactForgiveness,
        plateCoverage,
        pcHorizontalReach: normalized.pcHorizontalReach,
        pcHitboxWidth: normalized.pcHitboxWidth,
        pcZoneHeight: normalized.pcZoneHeight,
        pcMoveSpeed: normalized.pcMoveSpeed,
        baserunning,
      },
      pitching: {
        velocity: normalized.velocity,
        curve: normalized.curve,
        stamina: normalized.stamina,
      },
      fielding: {
        catchCoverage: normalized.catchCoverage,
        fielding: normalized.fielding,
        armStrength: normalized.armStrength,
        physicality: normalized.physicality,
        mobility: normalized.mobility,
        baseDefense,
      },
    },
    intrinsics,
    profile,
    fieldAbility: fieldingAbility,
    fieldingAbility,
    baserunningAbility,
    starPitchAbility,
    starSwingAbility,
    categoryBreakdown: {
      batting: {
        score: offense,
        metrics: {
          power: normalized.power,
          contact,
          chargeContact: normalized.chargeContact,
          slapContact: normalized.slapContact,
          contactPerfectWindow: normalized.contactPerfectWindow,
          contactForgiveness: normalized.contactForgiveness,
          plateCoverage,
          pcHorizontalReach: normalized.pcHorizontalReach,
          pcHitboxWidth: normalized.pcHitboxWidth,
          pcZoneHeight: normalized.pcZoneHeight,
          pcMoveSpeed: normalized.pcMoveSpeed,
          baserunning,
        },
        bonuses: {
          baserunningAbilityBonus: baserunningBonus,
          powerCeilingBonus,
          starSwingBonus,
        },
      },
      pitching: {
        score: pitching,
        metrics: {
          velocity: normalized.velocity,
          curve: normalized.curve,
          stamina: normalized.stamina,
        },
        bonuses: {
          starPitchBonus,
        },
      },
      fielding: {
        score: defense,
        metrics: {
          catchCoverage: normalized.catchCoverage,
          fielding: normalized.fielding,
          armStrength: normalized.armStrength,
          physicality: normalized.physicality,
          mobility: normalized.mobility,
          baseDefense,
        },
        bonuses: {
          speedRangeBonus,
          fieldDefenseBonus,
        },
      },
      speed: {
        score: speed,
        metrics: {
          mobility: normalized.mobility,
        },
        bonuses: {},
      },
    },
  }
}

export function analyzeCharacterTalent(character, history = []) {
  const analysis = computeTalentAnalysis(character, history)
  if (!analysis) return null

  const roleDisplayDistributions = getRoleDisplayDistributions()
  const displayedBatting = mapRawRoleScoreToDisplayRating(analysis.battingScore, roleDisplayDistributions.batting)
  const displayedPitching = mapRawRoleScoreToDisplayRating(analysis.pitchingScore, roleDisplayDistributions.pitching)
  const displayedFielding = mapRawRoleScoreToDisplayRating(analysis.fieldingScore, roleDisplayDistributions.fielding)
  const displayedSpeed = mapRawRoleScoreToDisplayRating(analysis.speedScore, roleDisplayDistributions.speed)
  const displayedOverall = buildDisplayedOverallRating({
    batting: displayedBatting,
    pitching: displayedPitching,
    fielding: displayedFielding,
    speed: displayedSpeed,
  })

  const tier = poolPercentile(getDisplayOverallPoolScores(), displayedOverall) >= 0.95 ? 'S'
    : poolPercentile(getDisplayOverallPoolScores(), displayedOverall) >= 0.80 ? 'A'
    : poolPercentile(getDisplayOverallPoolScores(), displayedOverall) >= 0.50 ? 'B'
    : poolPercentile(getDisplayOverallPoolScores(), displayedOverall) >= 0.20 ? 'C'
    : poolPercentile(getDisplayOverallPoolScores(), displayedOverall) >= 0.05 ? 'D'
    : 'F'
  const roleScores = getRolePoolScores()
  const battingTier  = buildRolePoolTier(roleScores.batting, analysis.battingScore)
  const pitchingTier = buildRolePoolTier(roleScores.pitching, analysis.pitchingScore)
  const fieldingTier = buildRolePoolTier(roleScores.fielding, analysis.fieldingScore)
  const speedTier    = buildRolePoolTier(roleScores.speed, analysis.speedScore)

  return {
    ...analysis,
    battingScore: displayedBatting,
    pitchingScore: displayedPitching,
    fieldingScore: displayedFielding,
    speedScore: displayedSpeed,
    tier,
    battingTier,
    pitchingTier,
    fieldingTier,
    speedTier,
    rawRatings: {
      overall: analysis.trueValue,
      batting: analysis.battingScore,
      pitching: analysis.pitchingScore,
      fielding: analysis.fieldingScore,
      speed: analysis.speedScore,
    },
    displayRatings: {
      ...analysis.displayRatings,
      overall: toDisplayRating(displayedOverall),
      batting: toDisplayRating(displayedBatting),
      pitching: toDisplayRating(displayedPitching),
      fielding: toDisplayRating(displayedFielding),
      speed: toDisplayRating(displayedSpeed),
    },
  }
}
