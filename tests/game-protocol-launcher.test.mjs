import assert from 'node:assert/strict'
import test from 'node:test'
import { launchFromLink, parseGameLink } from '../scripts/game_protocol_launcher.mjs'

test('game links accept only a pinned game and known table', () => {
  assert.deepEqual(parseGameLink('sluggers-game://start?game=2751&table=season_schedule'), {
    gameId: 2751, table: 'season_schedule',
  })
  for (const uri of [
    'sluggers-game://start?game=-1&table=games',
    'sluggers-game://start?game=abc&table=games',
    'sluggers-game://start?game=1&table=other',
    'sluggers-game://other?game=1&table=games',
    'https://example.com/?game=1&table=games',
  ]) assert.throws(() => parseGameLink(uri), /Invalid Sluggers game link/)
})

test('a game link reuses an online helper and sends only game id and table', async () => {
  const calls = []
  await launchFromLink('sluggers-game://start?game=42&table=games', {
    spawnChild: () => { throw new Error('helper should already be online') },
    fetchApi: async (url, options) => {
      calls.push({ url, options })
      return { ok: true, json: async () => ({ service: 'sluggers-game-control' }) }
    },
  })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url.endsWith('/status'), true)
  assert.equal(calls[1].url.endsWith('/start'), true)
  assert.deepEqual(JSON.parse(calls[1].options.body), { gameId: 42, table: 'games' })
})
