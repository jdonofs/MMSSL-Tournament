// Normalizes draft picks / trades / waiver-and-free-agent moves — sourced differently in
// tournament mode (Roster.jsx) vs season mode (SeasonRoster.jsx) — into one unified,
// chronologically-sorted feed for a single character. Generalizes the merge-and-sort pattern
// already used inline for each page's own "Transaction History" tab.
function draftPickRow(pick) {
  return {
    type: 'draft',
    date: pick.created_at || null,
    playerId: pick.player_id,
    eventLabel: pick.tournament_number != null
      ? `Tournament ${pick.tournament_number}`
      : (pick.season_name || null),
    round: pick.round ?? null,
    pickNumber: pick.pick_number ?? null,
  }
}

function tradeRows(trades = [], characterName) {
  const rows = []
  trades.forEach((trade) => {
    const moves = (trade.moves || []).filter((m) => m.character_name === characterName)
    if (!moves.length) return
    moves.forEach((move) => {
      rows.push({
        type: 'trade',
        date: trade.created_at || null,
        fromPlayerId: move.from_player_id ?? null,
        toPlayerId: move.to_player_id ?? null,
      })
    })
  })
  return rows
}

// `season_waivers` rows represent an *available* claim, created whenever a character is
// dropped (see SeasonRoster.jsx's createDroppedPlayerWaiver) — status starts 'active' and only
// resolves to 'claimed' (won by a new team, team stored in awarded_to_team_id) or 'free_agent'
// (nobody claimed it). Only 'claimed' represents an actual team-to-team move worth showing here;
// 'free_agent'/'active' rows aren't a "won off waivers" event and are intentionally excluded.
function waiverRows(waivers = [], characterName) {
  return waivers
    .filter((w) => w.claiming_character === characterName && w.status === 'claimed')
    .map((w) => ({
      type: 'waiver',
      date: w.resolved_at || w.created_at || null,
      teamId: w.awarded_to_team_id ?? null,
    }))
}

// season_roster has no separate "season draft" table — the initial team assignment is just a
// row with acquired_via 'draft' (or null, its default) or 'free_agent'. 'trade'/'waiver'
// acquisitions are intentionally skipped here since those are already represented by the
// trade/waiver feeds above and would otherwise double up as duplicate transactions.
function seasonRosterRows(seasonRosterEntries = [], characterName) {
  return seasonRosterEntries
    .filter((entry) => entry.character_name === characterName)
    .map((entry) => {
      const via = entry.acquired_via || 'draft'
      if (via === 'draft') {
        return {
          type: 'season_draft', date: entry.created_at || null, teamId: entry.team_id ?? null,
          eventLabel: entry.season_name ?? null, round: entry.round ?? null, pickNumber: entry.pick_number ?? null,
        }
      }
      if (via === 'free_agent') return { type: 'free_agent_add', date: entry.created_at || null, teamId: entry.team_id ?? null, eventLabel: entry.season_name ?? null }
      return null
    })
    .filter(Boolean)
}

export function buildCharacterTransactionFeed({
  draftPicks = [],
  trades = [],
  waivers = [],
  seasonRosterEntries = [],
  characterName,
  characterId,
}) {
  const feed = [
    ...draftPicks.filter((p) => String(p.character_id) === String(characterId)).map(draftPickRow),
    ...tradeRows(trades, characterName),
    ...waiverRows(waivers, characterName),
    ...seasonRosterRows(seasonRosterEntries, characterName),
  ]
  return feed.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
}
