export function parseDollarWager(value) {
  const raw = String(value ?? '').trim()
  if (!/^\d+(\.\d{0,2})?$/.test(raw)) return Number.NaN
  return Number(raw)
}

export function sanitizeDollarWagerInput(value) {
  const raw = String(value ?? '')
  if (raw === '') return ''
  if (!/^\d*(\.\d{0,2})?$/.test(raw)) return null
  return raw
}

export function summarizeSlipWagers(entries = []) {
  let totalWager = 0
  let hasInvalidWager = false

  entries.forEach((entry) => {
    const wager = parseDollarWager(entry?.wagerSips)
    if (!Number.isFinite(wager) || wager < 0.01) {
      hasInvalidWager = true
      return
    }
    totalWager += wager
  })

  return {
    totalWager: Math.round(totalWager * 100) / 100,
    hasInvalidWager,
  }
}
