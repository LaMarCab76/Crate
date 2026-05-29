import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  decidePlaybackMemoryUse,
  estimateBufferedSeconds,
  PRELOAD_MEMORY_TIMEOUT_MS,
} from './progressiveBuffering.ts'

test('uses a tolerant memory preload timeout before the file fallback', () => {
  assert.equal(PRELOAD_MEMORY_TIMEOUT_MS, 3000)
})

test('estimates buffered seconds with clamps and invalid metadata', () => {
  assert.equal(estimateBufferedSeconds(50, 100, 200), 100)
  assert.equal(estimateBufferedSeconds(150, 100, 200), 200)
  assert.equal(estimateBufferedSeconds(50, 0, 200), null)
  assert.equal(estimateBufferedSeconds(50, 100, 0), null)
})

test('applies playback memory fallback policy', () => {
  assert.deepEqual(decidePlaybackMemoryUse({
    fileSizeBytes: 100,
    freeMemBytes: 1_000,
    totalMemBytes: 10_000,
    reserveBytes: 100,
    maxTrackBytes: 1_000,
  }), {
    canUse: true,
    reason: null,
    sizeBytes: 100,
  })

  assert.deepEqual(decidePlaybackMemoryUse({
    fileSizeBytes: 1_001,
    freeMemBytes: 10_000,
    totalMemBytes: 10_000,
    reserveBytes: 100,
    maxTrackBytes: 1_000,
  }), {
    canUse: false,
    reason: 'memory-size-limit',
    sizeBytes: 1_001,
  })

  assert.deepEqual(decidePlaybackMemoryUse({
    fileSizeBytes: 950,
    freeMemBytes: 1_000,
    totalMemBytes: 10_000,
    reserveBytes: 100,
    maxTrackBytes: 2_000,
  }), {
    canUse: false,
    reason: 'memory-size-limit',
    sizeBytes: 950,
  })
})

test('allows small tracks under macOS-style low free memory when enough headroom remains', () => {
  assert.deepEqual(decidePlaybackMemoryUse({
    fileSizeBytes: 27_073_892,
    freeMemBytes: 429_735_936,
    totalMemBytes: 51_539_607_552,
  }), {
    canUse: true,
    reason: null,
    sizeBytes: 27_073_892,
  })
})

test('keeps large tracks out of memory under the same low-free-memory pressure', () => {
  const sizeBytes = 200 * 1024 * 1024
  assert.deepEqual(decidePlaybackMemoryUse({
    fileSizeBytes: sizeBytes,
    freeMemBytes: 429_735_936,
    totalMemBytes: 51_539_607_552,
  }), {
    canUse: false,
    reason: 'memory-size-limit',
    sizeBytes,
  })
})
