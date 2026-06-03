import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { shouldPreloadUpcomingTrack, PRELOAD_EARLY_FRACTION, PRELOAD_LEAD_SECONDS } from './progressivePreload.ts'

const DURATION = 180
const THRESHOLD = Math.min(DURATION * PRELOAD_EARLY_FRACTION, DURATION - PRELOAD_LEAD_SECONDS)

const base = {
  status: 'playing',
  durationSec: DURATION,
  positionSec: THRESHOLD + 2,
  streamSource: 'memory',
  bufferComplete: true,
  isTrackTransitioning: false,
  nextPath: '/music/next.flac',
  alreadyPreloadedPath: null,
}

test('allows preloading once the current memory stream reaches the early threshold', () => {
  assert.equal(shouldPreloadUpcomingTrack(base), true)
})

test('preloads immediately for tracks shorter than the lead window', () => {
  assert.equal(shouldPreloadUpcomingTrack({ ...base, durationSec: 8, positionSec: 1 }), true)
})

test('uses the final lead window before the halfway point on short tracks', () => {
  assert.equal(shouldPreloadUpcomingTrack({ ...base, durationSec: 20, positionSec: 7.9 }), false)
  assert.equal(shouldPreloadUpcomingTrack({ ...base, durationSec: 20, positionSec: 8 }), true)
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
  assert.equal(shouldPreloadUpcomingTrack({ ...base, positionSec: THRESHOLD - 1 }), false)
  assert.equal(shouldPreloadUpcomingTrack({ ...base, isTrackTransitioning: true }), false)
  assert.equal(shouldPreloadUpcomingTrack({ ...base, alreadyPreloadedPath: '/music/next.flac' }), false)
  assert.equal(shouldPreloadUpcomingTrack({ ...base, nextPath: null }), false)
})
