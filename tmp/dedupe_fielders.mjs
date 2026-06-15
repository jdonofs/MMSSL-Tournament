const URL_BASE = 'https://cfowednmssmbvspbxzyb.supabase.co/rest/v1'
const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNmb3dlZG5tc3NtYnZzcGJ4enliIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY2MzE4MTgsImV4cCI6MjA5MjIwNzgxOH0.cudgbAdYF8sXOWgdfA_3kZP8t7inCRWRoaRFBjvz1ao'
const GAMES = [1351, 1353, 1358]
const DRY_RUN = process.argv.includes('--apply') ? false : true

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }

async function get(path) {
  const res = await fetch(`${URL_BASE}${path}`, { headers })
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`)
  return res.json()
}

async function del(path) {
  const res = await fetch(`${URL_BASE}${path}`, { method: 'DELETE', headers: { ...headers, Prefer: 'return=representation' } })
  if (!res.ok) throw new Error(`DELETE ${path} failed: ${res.status} ${await res.text()}`)
  return res.json()
}

const gameIdFilter = `(${GAMES.join(',')})`

const [fielders, lineups, seasonTeams] = await Promise.all([
  get(`/season_game_fielders?game_id=in.${gameIdFilter}&select=*`),
  get(`/season_lineups?game_id=in.${gameIdFilter}&select=*`),
  get(`/season_teams?select=id,player_id`),
])

const teamIdByPlayerId = Object.fromEntries(seasonTeams.map((t) => [t.player_id, t.id]))

const characterIds = [...new Set(lineups.map((l) => l.character_id))]
const characters = await get(`/characters?id=in.(${characterIds.join(',')})&select=id,name`)
const charNameById = Object.fromEntries(characters.map((c) => [c.id, c.name]))

// position N (1-9) corresponds to season_lineups.batting_order N for that team's player
const desiredCharByGameTeamPos = {}
lineups.forEach((row) => {
  const teamId = teamIdByPlayerId[row.player_id]
  const key = `${row.game_id}:${teamId}:${row.batting_order}`
  desiredCharByGameTeamPos[key] = charNameById[row.character_id]
})

// Group fielders by game/team/position
const groups = {}
fielders.forEach((f) => {
  const key = `${f.game_id}:${f.team_id}:${f.position}`
  groups[key] = groups[key] || []
  groups[key].push(f)
})

const toDelete = []
const toFlag = []

for (const [key, rows] of Object.entries(groups)) {
  if (rows.length <= 1) continue
  const [gameId, teamId, position] = key.split(':')
  const desired = desiredCharByGameTeamPos[`${gameId}:${teamId}:${position}`]
  let keep = rows.find((r) => r.character === desired)
  if (!keep) {
    keep = [...rows].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]
    toFlag.push({ key, desired, rows: rows.map((r) => ({ id: r.id, character: r.character, created_at: r.created_at })) })
  }
  rows.forEach((r) => {
    if (r.id !== keep.id) toDelete.push(r.id)
  })
}

console.log(`Found ${toDelete.length} duplicate rows to delete across games ${GAMES.join(', ')}`)
if (toFlag.length) {
  console.log('Groups where no fielder row matched the lineup-derived character (kept newest):')
  console.log(JSON.stringify(toFlag, null, 2))
}

if (DRY_RUN) {
  console.log('Dry run only. Re-run with --apply to delete.')
} else {
  for (const id of toDelete) {
    await del(`/season_game_fielders?id=eq.${id}`)
  }
  console.log(`Deleted ${toDelete.length} rows.`)
}

console.log('\n-- SQL (run in Supabase SQL editor, which bypasses RLS) --')
console.log(`delete from public.season_game_fielders where id in (\n  ${toDelete.map((id) => `'${id}'`).join(',\n  ')}\n);`)
