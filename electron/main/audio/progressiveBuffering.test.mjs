import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  decidePlaybackMemoryUse,
  estimateBufferedSeconds,
  PRELOAD_MEMORY_TIMEOUT_MS,
  TWO_TRACK_MEMORY_FREE_THRESHOLD_BYTES,
} from './progressiveBuffering.ts'

const GiB = 1024 * 1024 * 1024
const MiB = 1024 * 1024

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

test('two-track memory threshold is 1 GiB', () => {
  assert.equal(TWO_TRACK_MEMORY_FREE_THRESHOLD_BYTES, GiB)
})

test('loads a second track into memory when more than 1 GB is free', () => {
  // 200 MB track (above the 128 MB small-track grace, so only the second-track
  // rule can put it in memory). 48 GB total → proportional reserve is ~2.4 GB,
  // so 1.5 GB free would normally reject it. The second-track rule overrides that.
  const args = {
    fileSizeBytes: 200 * MiB,
    freeMemBytes: 1.5 * GiB,
    totalMemBytes: 48 * GiB,
  }

  assert.deepEqual(decidePlaybackMemoryUse(args), {
    canUse: false,
    reason: 'memory-size-limit',
    sizeBytes: 200 * MiB,
  })

  assert.deepEqual(decidePlaybackMemoryUse({ ...args, allowSecondTrack: true }), {
    canUse: true,
    reason: null,
    sizeBytes: 200 * MiB,
  })
})

test('keeps the second track out of memory at or under 1 GB free', () => {
  const base = {
    fileSizeBytes: 200 * MiB,
    totalMemBytes: 48 * GiB,
    allowSecondTrack: true,
  }

  // Exactly 1 GB is not "more than 1 GB".
  assert.deepEqual(decidePlaybackMemoryUse({ ...base, freeMemBytes: GiB }), {
    canUse: false,
    reason: 'memory-size-limit',
    sizeBytes: 200 * MiB,
  })

  assert.deepEqual(decidePlaybackMemoryUse({ ...base, freeMemBytes: 900 * MiB }), {
    canUse: false,
    reason: 'memory-size-limit',
    sizeBytes: 200 * MiB,
  })
})

test('second-track rule still respects the 256 MB post-read safety floor', () => {
  const sizeBytes = 900 * MiB
  // 1.1 GB free minus a 900 MB track leaves ~205 MB < 256 MB floor.
  assert.deepEqual(decidePlaybackMemoryUse({
    fileSizeBytes: sizeBytes,
    freeMemBytes: 1.1 * GiB,
    totalMemBytes: 48 * GiB,
    allowSecondTrack: true,
  }), {
    canUse: false,
    reason: 'memory-size-limit',
    sizeBytes,
  })
})

test('second-track rule still respects the max-per-track cap', () => {
  const sizeBytes = 3 * GiB
  assert.deepEqual(decidePlaybackMemoryUse({
    fileSizeBytes: sizeBytes,
    freeMemBytes: 40 * GiB,
    totalMemBytes: 48 * GiB,
    allowSecondTrack: true,
  }), {
    canUse: false,
    reason: 'memory-size-limit',
    sizeBytes,
  })
})
