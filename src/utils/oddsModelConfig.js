// Which pricing model is live, and how to switch it.
//
// `game-model-v4` is the default. It is the default because it fixes pricing
// errors that are demonstrable without any historical data — a run line that
// disagreed with the moneyline about the same event, ties allocated to the home
// team instead of priced as a push, and live quotes on outcomes already decided
// — not because it has been shown to predict better. This repo's archive is far
// too small for that claim; see `docs/odds-engine-overhaul-2026-09-06.md`.
//
// `legacy-v3` is the established model, kept whole in `oddsEngineLegacy.js`, and
// is selected by setting `ODDS_MODEL_VERSION=legacy-v3` in the environment or by
// calling `setOddsModelVersion('legacy-v3')`.

export const ODDS_MODEL_VERSIONS = Object.freeze({
  legacy: 'legacy-v3',
  gameModel: 'game-model-v4',
})

export const DEFAULT_ODDS_MODEL_VERSION = ODDS_MODEL_VERSIONS.gameModel

function readEnvironmentVersion() {
  try {
    if (typeof process !== 'undefined' && process?.env?.ODDS_MODEL_VERSION) {
      return String(process.env.ODDS_MODEL_VERSION)
    }
  } catch { /* not running under Node */ }
  try {
    if (typeof import.meta !== 'undefined' && import.meta?.env?.VITE_ODDS_MODEL_VERSION) {
      return String(import.meta.env.VITE_ODDS_MODEL_VERSION)
    }
  } catch { /* no bundler env */ }
  return null
}

function normalizeVersion(value) {
  const candidate = String(value || '').trim()
  if (!candidate) return null
  return Object.values(ODDS_MODEL_VERSIONS).includes(candidate) ? candidate : null
}

let overrideVersion = null

export function setOddsModelVersion(version) {
  overrideVersion = normalizeVersion(version)
  return resolveOddsModelVersion()
}

export function resolveOddsModelVersion(explicit = null) {
  return normalizeVersion(explicit)
    || overrideVersion
    || normalizeVersion(readEnvironmentVersion())
    || DEFAULT_ODDS_MODEL_VERSION
}

export function isLegacyModel(version = null) {
  return resolveOddsModelVersion(version) === ODDS_MODEL_VERSIONS.legacy
}
