import { createWriteStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export interface DownloadTransferOptions {
  response: Response
  partPath: string
  signal: AbortSignal
  providerBytesTotal: number | null
  onProgress?: (bytesReceived: number, bytesTotal: number | null) => void
}

export function parseContentLength(value: string | null): number | null {
  if (value == null || value.trim() === '') return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('Download response contains an invalid Content-Length header.')
  }
  return parsed
}

export async function transferResponseToPart(options: DownloadTransferOptions): Promise<number> {
  const { response, partPath, signal, providerBytesTotal, onProgress } = options
  await unlink(partPath).catch(() => undefined)
  if (!response.ok || !response.body) {
    throw new Error(`Download request failed (${response.status})`)
  }
  const headerTotal = parseContentLength(response.headers.get('content-length'))
  if (providerBytesTotal != null && (!Number.isSafeInteger(providerBytesTotal) || providerBytesTotal < 0)) {
    throw new Error('Download provider returned an invalid expected file size.')
  }
  const expectedTotal = providerBytesTotal != null ? providerBytesTotal : headerTotal
  if (providerBytesTotal != null && headerTotal != null && providerBytesTotal !== headerTotal) {
    throw new Error(`Download size mismatch before transfer (provider ${providerBytesTotal}, HTTP ${headerTotal}).`)
  }
  let received = 0
  let lastEmit = 0
  const progress = new Transform({
    transform: (chunk: Buffer, _encoding, callback) => {
      received += chunk.byteLength
      if (Date.now() - lastEmit > 200) {
        lastEmit = Date.now()
        onProgress?.(received, expectedTotal)
      }
      callback(null, chunk)
    },
  })

  try {
    await pipeline(
      Readable.fromWeb(response.body as never),
      progress,
      createWriteStream(partPath, { flags: 'wx' }),
      { signal },
    )
    if (expectedTotal != null && received !== expectedTotal) {
      throw new Error(`Download is truncated (received ${received} of ${expectedTotal} bytes).`)
    }
    onProgress?.(received, expectedTotal)
    return received
  } catch (err) {
    await unlink(partPath).catch(() => undefined)
    throw err
  }
}
