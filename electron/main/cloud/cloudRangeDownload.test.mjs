import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  CloudRangeError,
  downloadRangesIntoBuffer,
  isExpiredDownloadStatus,
} from './cloudRangeDownload.ts'

function makeBytes(size) {
  return Uint8Array.from({ length: size }, (_, index) => index % 256)
}

function deps(file, patch = {}) {
  return {
    chunkBytes: 10,
    maxUrlRefreshes: 2,
    maxRateLimitRetries: 2,
    resolveUrl: async () => 'download-url',
    delay: async () => {},
    fetchRange: async (_url, start, end) => ({
      status: 206,
      body: file.subarray(start, end + 1),
      retryAfterSec: null,
    }),
    ...patch,
  }
}

test('expired preauthenticated statuses are refreshable', () => {
  for (const status of [401, 403, 410]) assert.equal(isExpiredDownloadStatus(status), true)
  for (const status of [200, 206, 404, 429, 500]) assert.equal(isExpiredDownloadStatus(status), false)
})

test('downloads all ranges directly into the caller buffer', async () => {
  const file = makeBytes(25)
  const buffer = Buffer.alloc(file.byteLength)
  const progress = []
  await downloadRangesIntoBuffer({
    sizeBytes: file.byteLength,
    buffer,
    deps: deps(file),
    onProgress: value => progress.push(value),
  })
  assert.deepEqual(new Uint8Array(buffer), file)
  assert.deepEqual(progress, [10, 20, 25])
})

test('refreshes an expired URL and resumes at the completed offset', async () => {
  const file = makeBytes(20)
  const buffer = Buffer.alloc(file.byteLength)
  let urlNumber = 0
  const starts = []
  await downloadRangesIntoBuffer({
    sizeBytes: file.byteLength,
    buffer,
    deps: deps(file, {
      resolveUrl: async () => `url-${++urlNumber}`,
      fetchRange: async (url, start, end) => {
        starts.push([url, start])
        if (url === 'url-1' && start === 10) {
          return { status: 401, body: null, retryAfterSec: null }
        }
        return { status: 206, body: file.subarray(start, end + 1), retryAfterSec: null }
      },
    }),
  })
  assert.deepEqual(new Uint8Array(buffer), file)
  assert.deepEqual(starts, [['url-1', 0], ['url-1', 10], ['url-2', 10]])
})

test('honors Retry-After but caps repeated rate limits', async () => {
  const file = makeBytes(10)
  const waits = []
  let attempts = 0
  await downloadRangesIntoBuffer({
    sizeBytes: file.byteLength,
    buffer: Buffer.alloc(file.byteLength),
    deps: deps(file, {
      delay: async milliseconds => waits.push(milliseconds),
      fetchRange: async (_url, start, end) => {
        attempts += 1
        if (attempts === 1) return { status: 429, body: null, retryAfterSec: 3 }
        return { status: 206, body: file.subarray(start, end + 1), retryAfterSec: null }
      },
    }),
  })
  assert.deepEqual(waits, [3000])

  await assert.rejects(
    downloadRangesIntoBuffer({
      sizeBytes: file.byteLength,
      buffer: Buffer.alloc(file.byteLength),
      deps: deps(file, {
        fetchRange: async () => ({ status: 429, body: null, retryAfterSec: null }),
      }),
    }),
    error => error instanceof CloudRangeError && error.status === 429,
  )
})

test('accepts whole content only at offset zero and rejects short bodies', async () => {
  const file = makeBytes(12)
  const buffer = Buffer.alloc(file.byteLength)
  await downloadRangesIntoBuffer({
    sizeBytes: file.byteLength,
    buffer,
    deps: deps(file, {
      fetchRange: async () => ({ status: 200, body: file, retryAfterSec: null }),
    }),
  })
  assert.deepEqual(new Uint8Array(buffer), file)

  await assert.rejects(
    downloadRangesIntoBuffer({
      sizeBytes: file.byteLength,
      buffer: Buffer.alloc(file.byteLength),
      deps: deps(file, {
        fetchRange: async () => ({ status: 200, body: file.subarray(0, 5), retryAfterSec: null }),
      }),
    }),
    /Incomplete cloud download/,
  )
})

test('rejects an undersized destination and an already-aborted request', async () => {
  const file = makeBytes(10)
  await assert.rejects(
    downloadRangesIntoBuffer({ sizeBytes: 10, buffer: Buffer.alloc(9), deps: deps(file) }),
    /too small/,
  )

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    downloadRangesIntoBuffer({
      sizeBytes: 10,
      buffer: Buffer.alloc(10),
      deps: deps(file),
      signal: controller.signal,
    }),
    error => error.name === 'AbortError',
  )
})
