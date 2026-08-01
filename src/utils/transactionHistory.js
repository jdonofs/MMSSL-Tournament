// Normalizes draft picks / trades / waiver-and-free-agent moves — sourced differently in
// tournament mode (Roster.jsx) vs season mode (SeasonRoster.jsx) — into one unified,
// chronologically-sorted feed for a single character. Generalizes the merge-and-sort pattern
// already used inline for each page's own "Transaction History" tab.
function draftPickRow(pick) {
  return {
    type: 'draft',
    date: pick.created_at || null,
    playerId: pick.player_id,
    characterName: pick.character_name ?? null,
    eventLabel: pick.tournament_number != null
      ? `MST ${pick.tournament_number}`
      : (pick.season_name || null),
    round: pick.round ?? null,
    pickNumber: pick.pick_number ?? null,
  }
}

// Only a proposal that all parties actually agreed to ('accepted') represents a real roster
// move — 'pending'/'rejected'/'cancelled' proposals never happened and shouldn't show up here.
function acceptedTrades(trades = []) {
  return trades.filter((trade) => trade.status === 'accepted')
}

function tradeRows(trades = [], characterName) {
  const rows = []
  acceptedTrades(trades).forEach((trade) => {
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

// True when a row belongs to the currently-viewed scope. `scope` of `{ type: 'career' }` (or
// omitted) means "show everything" — draft_picks only ever carry a tournament_id and
// season_roster/season_waivers/season trades only ever carry a season_id, so a row from the
// *other* mode never matches a season/tournament scope and is correctly excluded.
function matchesTeamScope(row, scope) {
  if (!scope || scope.type === 'career') return true
  if (scope.type === 'tournament') return String(row.tournament_id) === String(scope.id)
  if (scope.type === 'season') return String(row.season_id) === String(scope.id)
  return true
}

// Team-scoped mirror of buildCharacterTransactionFeed — the same 4 sources, but filtered by
// player/team id (tournament player_id, season season_teams.id) instead of one character name,
// so a team's feed spans every character that's ever moved in/out of it. Each row carries
// whichever character identifier the source row already has (characterId for draft_picks,
// characterName for trade/waiver/season_roster rows) for the caller to resolve a display name.
// `scope` narrows the feed to one season/tournament (career shows everything, unfiltered).
export function buildTeamTransactionFeed({
  draftPicks = [],
  trades = [],
  waivers = [],
  seasonRosterEntries = [],
  playerId,
  teamId,
  scope = null,
}) {
  const draftRows = draftPicks
    .filter((p) => String(p.player_id) === String(playerId) && matchesTeamScope(p, scope))
    .map((p) => ({ ...draftPickRow(p), characterId: p.character_id }))

  const tradeMoveRows = []
  acceptedTrades(trades).filter((trade) => matchesTeamScope(trade, scope)).forEach((trade) => {
    (trade.moves || [])
      .filter((m) => String(m.from_player_id) === String(playerId) || String(m.to_player_id) === String(playerId))
      .forEach((move) => {
        tradeMoveRows.push({
          type: 'trade',
          date: trade.created_at || null,
          characterName: move.character_name,
          fromPlayerId: move.from_player_id ?? null,
          toPlayerId: move.to_player_id ?? null,
        })
      })
  })

  const waiverWinRows = waivers
    .filter((w) => String(w.awarded_to_team_id) === String(teamId) && w.status === 'claimed' && matchesTeamScope(w, scope))
    .map((w) => ({ type: 'waiver', date: w.resolved_at || w.created_at || null, characterName: w.claiming_character, teamId: w.awarded_to_team_id ?? null }))

  const rosterRows = seasonRosterEntries
    .filter((entry) => String(entry.team_id) === String(teamId) && matchesTeamScope(entry, scope))
    .map((entry) => {
      const via = entry.acquired_via || 'draft'
      if (via === 'draft') {
        return {
          type: 'season_draft', date: entry.created_at || null, characterName: entry.character_name,
          eventLabel: entry.season_name ?? null, round: entry.round ?? null, pickNumber: entry.pick_number ?? null,
        }
      }
      if (via === 'free_agent') return { type: 'free_agent_add', date: entry.created_at || null, characterName: entry.character_name, eventLabel: entry.season_name ?? null }
      return null
    })
    .filter(Boolean)

  const feed = [...draftRows, ...tradeMoveRows, ...waiverWinRows, ...rosterRows]
  return feed.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
}
