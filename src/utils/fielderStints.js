// Who was standing at a position for a given plate appearance.
//
// A game_fielders / season_game_fielders row spans innings, and a position
// change made MID-inning also bounds it by the game's pa_number (pa_from /
// pa_to): the inning alone cannot say which side of the change a play in that
// inning fell on. Null bounds mean the row is bounded by its innings alone.

/** Whether `row` was on the field for plate appearance `pa` ({ inning, pa_number }). */
export function fielderCoversPa(row, pa = {}) {
  const inning = Number(pa.inning || 1)
  const paNumber = pa.pa_number == null ? null : Number(pa.pa_number)
  return Number(row.inning_from || 1) <= inning
    && (row.inning_to == null || Number(row.inning_to) >= inning)
    && (row.pa_from == null || paNumber == null || paNumber >= Number(row.pa_from))
    && (row.pa_to == null || paNumber == null || paNumber <= Number(row.pa_to))
}

/** Whether `row` is on the field now, in `inning`. A stint a mid-inning change closed is over. */
export function fielderIsCurrent(row, inning) {
  return row.pa_to == null && fielderCoversPa(row, { inning })
}

/**
 * How to retire the rows a position change replaces.
 *
 * `lastPa` is the game's latest saved plate appearance ({ pa_number, inning }),
 * or null before the first one. A change that lands after a PA in the current
 * inning closes the old rows AT that PA instead of deleting them, and the new
 * rows start with the next one. Otherwise it is an inning boundary and the old
 * behaviour stands: rows from earlier innings close the inning before, rows
 * that began this inning never covered a play and are deleted.
 */
export function planFielderStintChange(affectedRows = [], { currentInning, lastPa = null } = {}) {
  const inning = Math.max(1, Number(currentInning || 1))
  const lastPaNumber = lastPa?.pa_number == null ? null : Number(lastPa.pa_number)
  if (lastPaNumber != null && Number(lastPa.inning || 1) >= inning) {
    const changeInning = Math.max(inning, Number(lastPa.inning || 1))
    // A row that starts after the last PA (a second change before any play)
    // never covered one.
    const unused = (row) => row.pa_from != null && Number(row.pa_from) > lastPaNumber
    return {
      toClose: affectedRows.filter((row) => !unused(row)),
      toDelete: affectedRows.filter(unused),
      closeWith: { inning_to: changeInning, pa_to: lastPaNumber },
      newRowBounds: { inning_from: changeInning, pa_from: lastPaNumber + 1 },
    }
  }
  return {
    toClose: affectedRows.filter((row) => Number(row.inning_from || 1) < inning),
    toDelete: affectedRows.filter((row) => Number(row.inning_from || 1) >= inning),
    closeWith: { inning_to: inning - 1 },
    newRowBounds: { inning_from: inning },
  }
}
