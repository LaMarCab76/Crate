import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { LyricsLookupQueue } from './LyricsLookupQueue.ts'

function createScheduler() {
  let now = 0
  const timers = []
  return {
    now: () => now,
    setTimer(handler, ms) {
      timers.push({ at: now + ms, handler })
      timers.sort((a, b) => a.at - b.at)
      return handler
    },
    advance(ms) {
      now += ms
      const due = timers.filter(timer => timer.at <= now)
      for (const timer of due) {
        const index = timers.indexOf(timer)
        if (index >= 0) timers.splice(index, 1)
        timer.handler()
      }
    },
  }
}

async function tick() {
  await Promise.resolve()
  await Promise.resolve()
}

test('serializes lyric lookups to one track per spacing window', async () => {
  const scheduler = createScheduler()
  const q = new LyricsLookupQueue({
    spacingMs: 60_000,
    now: scheduler.now,
    setTimer: scheduler.setTimer,
  })
  const started = []

  const first = q.enqueue(async () => {
    started.push(['a', scheduler.now()])
    return 'a'
  })
  const second = q.enqueue(async () => {
    started.push(['b', scheduler.now()])
    return 'b'
  })

  assert.equal(await first, 'a')
  assert.deepEqual(started, [['a', 0]])

  scheduler.advance(59_999)
  await tick()
  assert.deepEqual(started, [['a', 0]])

  scheduler.advance(1)
  assert.equal(await second, 'b')
  assert.deepEqual(started, [['a', 0], ['b', 60_000]])
})

test('continues draining after a lookup error', async () => {
  const scheduler = createScheduler()
  const q = new LyricsLookupQueue({
    spacingMs: 1_000,
    now: scheduler.now,
    setTimer: scheduler.setTimer,
  })
  const started = []

  const first = q.enqueue(async () => {
    started.push('failed')
    throw new Error('provider failed')
  })
  const second = q.enqueue(async () => {
    started.push('ok')
    return 'ok'
  })

  await assert.rejects(first, /provider failed/)
  scheduler.advance(1_000)
  assert.equal(await second, 'ok')
  assert.deepEqual(started, ['failed', 'ok'])
})

test('does not consume spacing before the first online lookup', async () => {
  const scheduler = createScheduler()
  const q = new LyricsLookupQueue({
    spacingMs: 60_000,
    now: scheduler.now,
    setTimer: scheduler.setTimer,
  })
  let startedAt = -1

  await q.enqueue(async () => {
    startedAt = scheduler.now()
    return null
  })

  assert.equal(startedAt, 0)
  assert.equal(q.nextAllowedAt(), 60_000)
})
