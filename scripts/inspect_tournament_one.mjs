import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')

function loadEnvFile(filePath) {
  const env = {}
  const content = fs.readFileSync(filePath, 'utf8')
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) continue
    env[trimmed.slice(0, eqIndex)] = trimmed.slice(eqIndex + 1)
  }
  return env
}

const env = loadEnvFile(path.join(repoRoot, '.env'))
const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)

const { data: tournament, error: tournamentError } = await supabase
  .from('tournaments')
  .select('id, tournament_number')
  .eq('tournament_number', 1)
  .single()

if (tournamentError) throw tournamentError

const { data: players, error: playersError } = await supabase.from('players').select('id, name')
if (playersError) throw playersError
const playerMap = Object.fromEntries((players || []).map((player) => [player.id, player.name]))

const { data: games, error: gamesError } = await supabase
  .from('games')
  .select('*')
  .eq('tournament_id', tournament.id)
  .order('game_code')

if (gamesError) throw gamesError

const gameIds = (games || []).map((game) => game.id)
const { data: pas, error: pasError } = await supabase
  .from('plate_appearances')
  .select('game_id, player_id, rbi, run_scored')
  .in('game_id', gameIds)

if (pasError) throw pasError

const scoreMap = {}
for (const pa of pas || []) {
  const key = `${pa.game_id}:${pa.player_id}`
  scoreMap[key] = (scoreMap[key] || 0) + Number(pa.rbi || 0) + (pa.run_scored ? 1 : 0)
}

const summary = (games || []).map((game) => ({
  game_code: game.game_code,
  stage: game.stage,
  team_a: playerMap[game.team_a_player_id] || null,
  team_b: playerMap[game.team_b_player_id] || null,
  winner: playerMap[game.winner_player_id] || null,
  stored_score: `${game.team_a_runs}-${game.team_b_runs}`,
  pa_score: `${scoreMap[`${game.id}:${game.team_a_player_id}`] || 0}-${scoreMap[`${game.id}:${game.team_b_player_id}`] || 0}`,
}))

console.log(JSON.stringify(summary, null, 2))
