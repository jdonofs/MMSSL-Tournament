import assert from 'node:assert/strict'
import test from 'node:test'
import { createRefreshCoordinator } from '../src/utils/refreshCoordinator.js'

function fakeClock() {
  let time = 1
  let nextId = 1
  const timers = new Map()
  return {
    now: () => time,
    setTimer(fn, delay) {
      const id = nextId++
      timers.set(id, { at: time + delay, fn })
      return id
    },
    clearTimer: (id) => timers.delete(id),
    async advance(ms) {
      const end = time + ms
      while (true) {
        const due = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]
        if (!due || due[1].at > end) break
        time = due[1].at
        timers.delete(due[0])
        await due[1].fn()
      }
      time = end
    },
  }
}

test('idle consumers make no repeated requests and a burst becomes one request', async () => {
  const clock = fakeClock()
  let requests = 0
  const refresh = createRefreshCoordinator({
    run: async () => { requests += 1 },
    delayMs: 100,
    maxWaitMs: 500,
    ...clock,
  })

  await clock.advance(10_000)
  assert.equal(requests, 0)
  refresh.request()
  await clock.advance(40)
  refresh.request()
  await clock.advance(40)
  refresh.request()
  await clock.advance(99)
  assert.equal(requests, 0)
  await clock.advance(1)
  assert.equal(requests, 1)
})

test('sustained events refresh within maxWaitMs', async () => {
  const clock = fakeClock()
  const requestedAt = []
  const refresh = createRefreshCoordinator({
    run: async () => { requestedAt.push(clock.now()) },
    delayMs: 100,
    maxWaitMs: 300,
    ...clock,
  })

  for (let elapsed = 0; elapsed < 300; elapsed += 80) {
    refresh.request()
    await clock.advance(80)
  }
  assert.equal(requestedAt.length, 1)
  assert.ok(requestedAt[0] <= 301)
})

test('an event during an in-flight request queues exactly one follow-up', async () => {
  const clock = fakeClock()
  let requests = 0
  let release
  const firstRun = new Promise((resolve) => { release = resolve })
  const refresh = createRefreshCoordinator({
    run: async () => {
      requests += 1
      if (requests === 1) await firstRun
    },
    delayMs: 10,
    maxWaitMs: 50,
    ...clock,
  })

  refresh.request({ immediate: true })
  const firstTimer = clock.advance(0)
  await Promise.resolve()
  refresh.request()
  refresh.request()
  release()
  await firstTimer
  await clock.advance(10)
  assert.equal(requests, 2)
})

test('hidden work waits and resume reconciles once; dispose cancels it', async () => {
  const clock = fakeClock()
  let hidden = true
  let requests = 0
  const refresh = createRefreshCoordinator({
    run: async () => { requests += 1 },
    isPaused: () => hidden,
    ...clock,
  })
  refresh.request()
  await clock.advance(10_000)
  assert.equal(requests, 0)
  hidden = false
  refresh.resume()
  await clock.advance(0)
  assert.equal(requests, 1)
  hidden = true
  refresh.request()
  refresh.dispose()
  hidden = false
  refresh.resume()
  await clock.advance(10_000)
  assert.equal(requests, 1)
})
