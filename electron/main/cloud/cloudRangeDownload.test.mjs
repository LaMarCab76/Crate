import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { downloadRangesIntoBuffer, isExpiredDownloadStatus, CloudRangeError } from './cloudRangeDownload.ts'

// Build a deterministic "file" of sizeBytes where byte i === i % 256.
function makeFile(sizeBytes) {
  const f = new Uint8Array(sizeBytes)
  for (let i = 0; i < sizeBytes; i++) f[i] = i % 256
  return f
}

function rangeOf(file, start, endInclusive) {
  return file.subarray(start, Math.min(endInclusive + 1, file.length))
}

const noDelay = async () => {}

test('isExpiredDownloadStatus flags 401/403/410 only', () => {
  for (const s of [401, 403, 410]) assert.equal(isExpiredDownloadStatus(s), true)
  for (const s of [200, 206, 404, 429, 500]) assert.equal(isExpiredDownloadStatus(s), false)
})

test('assembles a file from sequential 206 chunks', async () => {
  const size = 25
  const file = makeFile(size)
  const buffer = Buffer.allocUnsafe(size)
  const progress = []
  let resolveCount = 0

  await downloadRangesIntoBuffer({
    sizeBytes: size,
    buffer,
    onProgress: n => progress.push(n),
    deps: {
      chunkBytes: 10,
      maxUrlRefreshes: 3,
      resolveUrl: async () => { resolveCount++; return 'url-1' },
      delay: noDelay,
      fetchRange: async (_url, start, end) => ({
        status: 206,
        body: rangeOf(file, start, end),
        retryAfterSec: null,
      }),
    },
  })

  assert.deepEqual(new Uint8Array(buffer), file)
  assert.equal(resolveCount, 1, 'resolves the URL once for the happy path')
  assert.deepEqual(progress, [10, 20, 25], 'reports cumulative progress per chunk')
})

test('refreshes the download URL when a chunk returns 401, then resumes', async () => {
  const size = 20
  const file = makeFile(size)
  const buffer = Buffer.allocUnsafe(size)
  const urls = []
  let calls = 0

  await downloadRangesIntoBuffer({
    sizeBytes: size,
    buffer,
    deps: {
      chunkBytes: 10,
      maxUrlRefreshes: 3,
      resolveUrl: async () => { const u = `url-${urls.length + 1}`; urls.push(u); return u },
      delay: noDelay,
      fetchRange: async (url, start, end) => {
        calls++
        // Expire the URL exactly once, on the second chunk's first attempt.
        if (start === 10 && url === 'url-1') return { status: 401, body: null, retryAfterSec: null }
        return { status: 206, body: rangeOf(file, start, end), retryAfterSec: null }
      },
    },
  })

  assert.deepEqual(new Uint8Array(buffer), file)
  assert.deepEqual(urls, ['url-1', 'url-2'], 'resolved a fresh URL after the 401')
  assert.equal(calls, 3, 'chunk0 ok, chunk1 401, chunk1 retry ok')
})

test('backs off on 429 (Retry-After) then continues', async () => {
  const size = 10
  const file = makeFile(size)
  const buffer = Buffer.allocUnsafe(size)
  const delays = []
  let attempts = 0

  await downloadRangesIntoBuffer({
    sizeBytes: size,
    buffer,
    deps: {
      chunkBytes: 10,
      maxUrlRefreshes: 3,
      resolveUrl: async () => 'url-1',
      delay: async ms => { delays.push(ms) },
      fetchRange: async (_url, start, end) => {
        attempts++
        if (attempts === 1) return { status: 429, body: null, retryAfterSec: 3 }
        return { status: 206, body: rangeOf(file, start, end), retryAfterSec: null }
      },
    },
  })

  assert.deepEqual(new Uint8Array(buffer), file)
  assert.deepEqual(delays, [3000], 'honored Retry-After of 3s')
})

test('accepts a 200 full-content response at offset 0', async () => {
  const size = 15
  const file = makeFile(size)
  const buffer = Buffer.allocUnsafe(size)

  await downloadRangesIntoBuffer({
    sizeBytes: size,
    buffer,
    deps: {
      chunkBytes: 5,
      maxUrlRefreshes: 3,
      resolveUrl: async () => 'url-1',
      delay: noDelay,
      fetchRange: async () => ({ status: 200, body: file.subarray(0, size), retryAfterSec: null }),
    },
  })

  assert.deepEqual(new Uint8Array(buffer), file)
})

test('throws CloudRangeError when the URL keeps expiring past the refresh cap', async () => {
  const size = 10
  const buffer = Buffer.allocUnsafe(size)

  await assert.rejects(
    downloadRangesIntoBuffer({
      sizeBytes: size,
      buffer,
      deps: {
        chunkBytes: 10,
        maxUrlRefreshes: 2,
        resolveUrl: async () => 'url-x',
        delay: noDelay,
        fetchRange: async () => ({ status: 403, body: null, retryAfterSec: null }),
      },
    }),
    err => err instanceof CloudRangeError && err.status === 403,
  )
})

test('throws on a non-retryable HTTP status', async () => {
  const size = 10
  const buffer = Buffer.allocUnsafe(size)

  await assert.rejects(
    downloadRangesIntoBuffer({
      sizeBytes: size,
      buffer,
      deps: {
        chunkBytes: 10,
        maxUrlRefreshes: 2,
        resolveUrl: async () => 'url-1',
        delay: noDelay,
        fetchRange: async () => ({ status: 500, body: null, retryAfterSec: null }),
      },
    }),
    err => err instanceof CloudRangeError && err.status === 500,
  )
})

test('aborts promptly when the signal is already aborted', async () => {
  const size = 10
  const buffer = Buffer.allocUnsafe(size)
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(
    downloadRangesIntoBuffer({
      sizeBytes: size,
      buffer,
      signal: controller.signal,
      deps: {
        chunkBytes: 10,
        maxUrlRefreshes: 2,
        resolveUrl: async () => 'url-1',
        delay: noDelay,
        fetchRange: async (_url, start, end) => ({ status: 206, body: new Uint8Array(end - start + 1), retryAfterSec: null }),
      },
    }),
    err => err.name === 'AbortError',
  )
})
