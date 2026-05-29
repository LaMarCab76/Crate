import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { shouldPreloadUpcomingTrack } from './progressivePreload.ts'

const base = {
  status: 'playing',
  durationSec: 180,
  positionSec: 91,
  streamSource: 'memory',
  bufferComplete: true,
  isTrackTransitioning: false,
  nextPath: '/music/next.flac',
  alreadyPreloadedPath: null,
}

test('allows preloading once the current memory stream reaches the threshold', () => {
  assert.equal(shouldPreloadUpcomingTrack(base), true)
})

test('blocks preloading while the current progressive stream is still filling', () => {
  assert.equal(shouldPreloadUpcomingTrack({
    ...base,
    streamSource: 'progressive',
    bufferComplete: false,
  }), false)
})

test('blocks preloading for direct file streams to avoid competing disk reads', () => {
  assert.equal(shouldPreloadUpcomingTrack({
    ...base,
    streamSource: 'file',
    bufferComplete: false,
  }), false)
})

test('blocks preloading before threshold, during transitions, or for duplicate targets', () => {
  assert.equal(shouldPreloadUpcomingTrack({ ...base, positionSec: 89 }), false)
  assert.equal(shouldPreloadUpcomingTrack({ ...base, isTrackTransitioning: true }), false)
  assert.equal(shouldPreloadUpcomingTrack({ ...base, alreadyPreloadedPath: '/music/next.flac' }), false)
  assert.equal(shouldPreloadUpcomingTrack({ ...base, nextPath: null }), false)
})
