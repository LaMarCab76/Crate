export interface RangeResult {
  status: number
  body: Uint8Array | null
  retryAfterSec: number | null
}

export interface RangeDownloadDeps {
  chunkBytes: number
  maxUrlRefreshes: number
  maxRateLimitRetries: number
  fetchRange: (
    url: string,
    start: number,
    endInclusive: number,
    signal?: AbortSignal,
  ) => Promise<RangeResult>
  resolveUrl: (signal?: AbortSignal) => Promise<string>
  delay: (milliseconds: number, signal?: AbortSignal) => Promise<void>
}

export class CloudRangeError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'CloudRangeError'
    this.status = status
  }
}

export function isExpiredDownloadStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 410
}

/** Fill a caller-owned buffer with sequential ranged reads. No temporary file
 * is created, and the short-lived preauthenticated URL may be refreshed without
 * losing the completed prefix. */
export async function downloadRangesIntoBuffer(options: {
  sizeBytes: number
  buffer: Buffer
  deps: RangeDownloadDeps
  signal?: AbortSignal
  onProgress?: (loadedBytes: number) => void
  initialUrl?: string
}): Promise<void> {
  const { sizeBytes, buffer, deps, signal, onProgress } = options
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new Error(`Invalid cloud file size: ${sizeBytes}`)
  }
  if (buffer.byteLength < sizeBytes) {
    throw new Error(`Destination buffer is too small: ${buffer.byteLength}/${sizeBytes}`)
  }
  if (!Number.isSafeInteger(deps.chunkBytes) || deps.chunkBytes <= 0) {
    throw new Error(`Invalid cloud chunk size: ${deps.chunkBytes}`)
  }
  if (sizeBytes === 0) {
    onProgress?.(0)
    return
  }

  const throwIfAborted = (): void => {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  }

  throwIfAborted()
  let url = options.initialUrl ?? await deps.resolveUrl(signal)
  let offset = 0
  let urlRefreshes = 0
  let rateLimitRetries = 0

  while (offset < sizeBytes) {
    throwIfAborted()
    const end = Math.min(offset + deps.chunkBytes, sizeBytes) - 1
    const response = await deps.fetchRange(url, offset, end, signal)

    if (response.status === 429) {
      if (rateLimitRetries >= deps.maxRateLimitRetries) {
        throw new CloudRangeError(429, 'Cloud download remained rate limited.')
      }
      rateLimitRetries += 1
      const waitSeconds = response.retryAfterSec && response.retryAfterSec > 0
        ? response.retryAfterSec
        : Math.min(2 ** rateLimitRetries, 30)
      await deps.delay(waitSeconds * 1000, signal)
      continue
    }
    rateLimitRetries = 0

    if (isExpiredDownloadStatus(response.status)) {
      if (urlRefreshes >= deps.maxUrlRefreshes) {
        throw new CloudRangeError(response.status, 'Cloud download URL expired repeatedly.')
      }
      urlRefreshes += 1
      url = await deps.resolveUrl(signal)
      continue
    }
    if (response.status !== 206 && response.status !== 200) {
      throw new CloudRangeError(response.status, `Cloud range download failed (${response.status}).`)
    }
    if (!response.body || response.body.byteLength === 0) {
      throw new Error(`Incomplete cloud download: ${offset}/${sizeBytes} bytes.`)
    }

    if (response.status === 200) {
      if (offset !== 0) {
        throw new CloudRangeError(200, 'Cloud server ignored Range after a partial download.')
      }
      const copied = Math.min(response.body.byteLength, sizeBytes)
      buffer.set(response.body.subarray(0, copied), 0)
      offset = copied
      if (offset !== sizeBytes) {
        throw new Error(`Incomplete cloud download: ${offset}/${sizeBytes} bytes.`)
      }
    } else {
      const copied = Math.min(response.body.byteLength, end - offset + 1, sizeBytes - offset)
      buffer.set(response.body.subarray(0, copied), offset)
      offset += copied
    }

    onProgress?.(offset)
    await new Promise<void>(resolve => setImmediate(resolve))
  }

  if (offset !== sizeBytes) {
    throw new Error(`Incomplete cloud download: ${offset}/${sizeBytes} bytes.`)
  }
}
