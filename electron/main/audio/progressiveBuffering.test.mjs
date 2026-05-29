import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  calculateProgressiveInitialBytes,
  decidePlaybackMemoryUse,
  estimateBufferedSeconds,
  PROGRESSIVE_FALLBACK_INITIAL_BYTES,
  PROGRESSIVE_MIN_INITIAL_BYTES,
  PROGRESSIVE_START_WINDOW_SEC,
  pumpProgressiveChunks,
} from './progressiveBuffering.ts'

test('calculates the initial progressive window for 15 seconds', () => {
  const fileSizeBytes = 100 * 1024 * 1024

  assert.equal(
    calculateProgressiveInitialBytes({ fileSizeBytes, durationSec: 100 }),
    Math.ceil(fileSizeBytes * (PROGRESSIVE_START_WINDOW_SEC / 100)),
  )

  assert.equal(
    calculateProgressiveInitialBytes({ fileSizeBytes, durationSec: 12 }),
    fileSizeBytes,
  )

  assert.equal(
    calculateProgressiveInitialBytes({ fileSizeBytes, durationSec: Number.NaN }),
    PROGRESSIVE_FALLBACK_INITIAL_BYTES,
  )

  assert.equal(
    calculateProgressiveInitialBytes({ fileSizeBytes, durationSec: 10_000 }),
    PROGRESSIVE_MIN_INITIAL_BYTES,
  )

  assert.equal(calculateProgressiveInitialBytes({ fileSizeBytes: 0, durationSec: 120 }), 0)
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

test('progressive pump pushes chunks, reports completion, and writes end marker', async () => {
  const source = Buffer.from('abcdefghijklmnopqrstuvwxyz')
  const written = []
  const progress = []
  let ended = false

  await pumpProgressiveChunks({
    totalBytes: source.byteLength,
    startOffset: 5,
    chunkBytes: 8,
    waitMs: async () => undefined,
    readChunk: async (offset, length) => source.subarray(offset, offset + length),
    writeChunk: chunk => {
      const accepted = Math.min(3, chunk.byteLength)
      written.push(chunk.subarray(0, accepted).toString('utf8'))
      return accepted
    },
    writeEnd: () => {
      ended = true
    },
    onProgress: bytes => progress.push(bytes),
  })

  assert.equal(written.join(''), source.subarray(5).toString('utf8'))
  assert.equal(progress.at(-1), source.byteLength)
  assert.equal(ended, true)
})

test('progressive pump does not signal completion after read/write errors', async () => {
  let cleanupCalled = false
  let ended = false

  await assert.rejects(async () => {
    try {
      await pumpProgressiveChunks({
        totalBytes: 10,
        startOffset: 0,
        chunkBytes: 5,
        readChunk: async () => Buffer.from('12345'),
        writeChunk: () => -1,
        writeEnd: () => {
          ended = true
        },
      })
    } finally {
      cleanupCalled = true
    }
  }, /rejected buffered data/)

  assert.equal(cleanupCalled, true)
  assert.equal(ended, false)
})
