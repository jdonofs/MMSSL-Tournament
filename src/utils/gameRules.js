export const DEFAULT_REGULATION_INNINGS = 3

export function normalizeRegulationInnings(value, fallback = DEFAULT_REGULATION_INNINGS) {
  const fallbackValue = Number.isFinite(Number(fallback)) && Number(fallback) >= 1
    ? Math.trunc(Number(fallback))
    : DEFAULT_REGULATION_INNINGS
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 1) return fallbackValue
  return Math.trunc(numeric)
}
