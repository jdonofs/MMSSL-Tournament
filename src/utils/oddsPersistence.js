function stripTransientOddsFields(row = {}) {
  const {
    prop_current_count,
    ...rest
  } = row
  return rest
}

function stripPropColumnsFromRow(row = {}) {
  const {
    prop_lambda,
    prop_variance_multiplier,
    ...rest
  } = row
  return rest
}

export function stripPropPricingColumns(rows = []) {
  return (rows || []).map((row) => stripPropColumnsFromRow(row))
}

export function isMissingPropPricingColumnError(error) {
  const message = String(error?.message || '')
  return message.includes("'prop_lambda'") || message.includes("'prop_variance_multiplier'")
}

export async function persistOddsRowsWithFallback({
  supabase,
  table,
  updates = [],
  inserts = [],
}) {
  const sanitizedUpdates = (updates || []).map((row) => stripTransientOddsFields(row))
  const sanitizedInserts = (inserts || []).map((row) => stripTransientOddsFields(row))
  let persistedRows = [...sanitizedUpdates]

  if (sanitizedUpdates.length) {
    let { error: updateError } = await supabase.from(table).upsert(sanitizedUpdates)
    if (updateError && isMissingPropPricingColumnError(updateError)) {
      const strippedUpdates = stripPropPricingColumns(sanitizedUpdates)
      const retry = await supabase.from(table).upsert(strippedUpdates)
      if (retry.error) throw retry.error
      persistedRows = [...strippedUpdates]
    } else if (updateError) {
      throw updateError
    }
  }

  if (sanitizedInserts.length) {
    let insertResponse = await supabase.from(table).insert(sanitizedInserts).select()
    if (insertResponse.error && isMissingPropPricingColumnError(insertResponse.error)) {
      const strippedInserts = stripPropPricingColumns(sanitizedInserts)
      insertResponse = await supabase.from(table).insert(strippedInserts).select()
    }
    if (insertResponse.error) throw insertResponse.error
    if (insertResponse.data) persistedRows = [...persistedRows, ...insertResponse.data]
  }

  return persistedRows
}
