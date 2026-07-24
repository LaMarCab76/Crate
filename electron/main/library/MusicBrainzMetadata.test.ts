import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { MusicBrainzRequestQueue } from './MusicBrainzMetadata.ts'

test('serializes concurrent MusicBrainz requests and spaces their start times', async () => {
  let now = 100
  const waits: number[] = []
  const queue = new MusicBrainzRequestQueue(
    1_100,
    () => now,
    async milliseconds => {
      waits.push(milliseconds)
      now += milliseconds
    },
  )
  let active = 0
  let maximumActive = 0
  const starts: Array<{ name: string; at: number }> = []
  let releaseFirst!: () => void
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })

  const first = queue.run(async () => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    starts.push({ name: 'first', at: now })
    await firstGate
    active -= 1
    return 'first'
  })
  const second = queue.run(async () => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    starts.push({ name: 'second', at: now })
    active -= 1
    return 'second'
  })

  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(starts, [{ name: 'first', at: 100 }])
  releaseFirst()
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second'])
  assert.equal(maximumActive, 1)
  assert.deepEqual(waits, [1_100])
  assert.deepEqual(starts, [
    { name: 'first', at: 100 },
    { name: 'second', at: 1_200 },
  ])
})

test('a failed MusicBrainz request does not poison the shared queue', async () => {
  const queue = new MusicBrainzRequestQueue(0)
  await assert.rejects(queue.run(async () => { throw new Error('network failed') }), /network failed/)
  assert.equal(await queue.run(async () => 'recovered'), 'recovered')
})
