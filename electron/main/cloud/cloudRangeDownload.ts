// Pure, dependency-injected ranged-download loop. No electron / auth / fetch
// imports so it is unit-testable in isolation (node --test). OneDriveClient wires
// the real fetch + Graph URL resolution into the injected deps.

export interface RangeResult {
  status: number
  body: Uint8Array | null
  // Seconds from a 429 Retry-After header, when present.
  retryAfterSec: number | null
}

export interface RangeDownloadDeps {
  chunkBytes: number
  maxUrlRefreshes: number
  // Fetch the inclusive byte range [start, endInclusive] from `url`.
  fetchRange: (url: string, start: number, endInclusive: number, signal?: AbortSignal) => Promise<RangeResult>
  // (Re)resolve a fresh preauthenticated download URL (initial fetch + refreshes).
  resolveUrl: (signal?: AbortSignal) => Promise<string>
  // Abortable sleep used for 429 backoff.
  delay: (ms: number, signal?: AbortSignal) => Promise<void>
}

export class CloudRangeError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'CloudRangeError'
    this.status = status
  }
}

// 401/403/410 on a preauthenticated download URL means it expired or its
// signature rotated; the fix is to resolve a fresh URL and resume.
export function isExpiredDownloadStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 410
}

// Fill `buffer` (preallocated to sizeBytes) from sequential ranged reads. Handles
// 429 backoff, expired-URL refresh mid-stream (resuming at the current offset),
// and a server that ignores Range and returns the whole file (200 at offset 0).
export async function downloadRangesIntoBuffer(opts: {
  sizeBytes: number
  buffer: Buffer
  deps: RangeDownloadDeps
  signal?: AbortSignal
  onProgress?: (loadedBytes: number) => void
  initialUrl?: string
}): Promise<void> {
  const { sizeBytes, buffer, deps, signal, onProgress } = opts
  const throwIfAborted = (): void => {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  }

  let url = opts.initialUrl ?? (await deps.resolveUrl(signal))
  let offset = 0
  let urlRefreshes = 0

  while (offset < sizeBytes) {
    throwIfAborted()
    const end = Math.min(offset + deps.chunkBytes, sizeBytes) - 1
    const res = await deps.fetchRange(url, offset, end, signal)

    if (res.status === 429) {
      const waitSec = res.retryAfterSec && res.retryAfterSec > 0 ? res.retryAfterSec : 2
      await deps.delay(waitSec * 1000, signal)
      continue
    }
    if (isExpiredDownloadStatus(res.status)) {
      if (urlRefreshes >= deps.maxUrlRefreshes) {
        throw new CloudRangeError(res.status, 'Download URL expired repeatedly.')
      }
      urlRefreshes++
      url = await deps.resolveUrl(signal)
      continue
    }
    if (res.status !== 206 && res.status !== 200) {
      throw new CloudRangeError(res.status, `Range download failed (${res.status}).`)
    }

    const body = res.body
    if (!body || body.byteLength === 0) break

    if (res.status === 200) {
      // Range ignored → whole file. Only valid at offset 0.
      if (offset !== 0) {
        if (urlRefreshes >= deps.maxUrlRefreshes) {
          throw new CloudRangeError(200, 'Server ignored Range on a partial request.')
        }
        urlRefreshes++
        url = await deps.resolveUrl(signal)
        continue
      }
      const copyLen = Math.min(body.byteLength, sizeBytes)
      buffer.set(body.subarray(0, copyLen), 0)
      offset = copyLen
      onProgress?.(offset)
      break
    }

    const copyLen = Math.min(body.byteLength, sizeBytes - offset)
    buffer.set(body.subarray(0, copyLen), offset)
    offset += copyLen
    onProgress?.(offset)
    // Yield to the event loop between chunks so playback/UI stay responsive.
    await new Promise<void>(resolve => setImmediate(resolve))
  }

  if (offset < sizeBytes) {
    throw new Error(`Incomplete cloud download: ${offset}/${sizeBytes} bytes.`)
  }
}
