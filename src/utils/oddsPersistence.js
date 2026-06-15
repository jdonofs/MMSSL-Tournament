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

// Thrown when onConflict references a unique constraint that doesn't exist
// (e.g. migration 045/046 hasn't been applied yet). Fall back to a plain
// insert rather than silently dropping the row, so new props still appear
// even before that constraint exists — at the cost of possible duplicates
// until the migration is run.
export function isMissingConflictConstraintError(error) {
  const message = String(error?.message || '')
  return message.includes('no unique or exclusion constraint')
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
    // Use upsert (onConflict game_id+bet_type+target_entity) rather than a
    // plain insert: two near-simultaneous syncs (e.g. pitching changes for
    // both teams) can both see "no existing row" for the same prop and both
    // try to insert, which previously created duplicate prop rows.
    let insertResponse = await supabase.from(table).upsert(sanitizedInserts, { onConflict: 'game_id,bet_type,target_entity' }).select()
    if (insertResponse.error && isMissingPropPricingColumnError(insertResponse.error)) {
      const strippedInserts = stripPropPricingColumns(sanitizedInserts)
      insertResponse = await supabase.from(table).upsert(strippedInserts, { onConflict: 'game_id,bet_type,target_entity' }).select()
    }
    if (insertResponse.error && isMissingConflictConstraintError(insertResponse.error)) {
      insertResponse = await supabase.from(table).insert(sanitizedInserts).select()
      if (insertResponse.error && isMissingPropPricingColumnError(insertResponse.error)) {
        insertResponse = await supabase.from(table).insert(stripPropPricingColumns(sanitizedInserts)).select()
      }
    }
    if (insertResponse.error) throw insertResponse.error
    if (insertResponse.data) persistedRows = [...persistedRows, ...insertResponse.data]
  }

  return persistedRows
}
