import { open, mkdtemp, rm, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  getOneDriveClient,
  type DriveItem,
  type OneDriveClient,
} from '../../cloud/OneDriveClient.ts'
import type { FingerprintSource } from '../fingerprint.ts'
import type {
  ChromaprintSourceResolver,
  ResolvedFingerprintInput,
} from './ChromaprintFingerprintProvider.ts'

const DEFAULT_CLOUD_CHUNK_BYTES = 4 * 1024 * 1024
const DEFAULT_MAX_TEMP_BYTES = 8 * 1024 * 1024 * 1024

type DownloadClient = Pick<OneDriveClient, 'getItem' | 'downloadChunks'>

export interface DefaultChromaprintSourceResolverOptions {
  client?: DownloadClient
  tempRoot?: string
  chunkBytes?: number
  maxTempBytes?: number
  authorizeLocalRead?: (source: FingerprintSource, signal?: AbortSignal) => Promise<void>
}

export interface OneDriveLocator {
  driveId: string
  itemId: string
}

function decodeLocatorPart(value: string, label: string): string {
  try {
    const decoded = decodeURIComponent(value)
    if (!decoded || decoded.includes('/') || decoded.includes('\\')) throw new Error('invalid')
    return decoded
  } catch {
    throw new Error(`Invalid OneDrive ${label} in duplicate fingerprint locator.`)
  }
}

export function parseOneDriveFingerprintLocator(locator: string): OneDriveLocator {
  const match = /^onedrive:\/\/([^/?#]+)\/([^/?#]+)$/.exec(locator)
  if (!match) throw new Error('Invalid OneDrive duplicate fingerprint locator.')
  return {
    driveId: decodeLocatorPart(match[1], 'drive id'),
    itemId: decodeLocatorPart(match[2], 'item id'),
  }
}

function itemEtag(item: DriveItem): string | null {
  return item.eTag ?? item.cTag ?? null
}

function assertExpectedCloudItem(source: FingerprintSource, expected: DriveItem, current: DriveItem): void {
  const expectedEtag = itemEtag(expected)
  const currentEtag = itemEtag(current)
  if (current.id !== expected.id || current.deleted || current.folder) {
    throw new Error('OneDrive track changed while generating its duplicate fingerprint.')
  }
  if (current.size !== expected.size || (expectedEtag && currentEtag !== expectedEtag)) {
    throw new Error('OneDrive track changed while generating its duplicate fingerprint.')
  }
  if (source.etag && currentEtag !== source.etag) {
    throw new Error('OneDrive track ETag no longer matches the indexed library.')
  }
}

function safeCloudFilename(source: FingerprintSource, item: DriveItem): string {
  const original = basename(item.name ?? '')
  const extension = extname(original).replace(/[^a-zA-Z0-9.]/g, '')
  const stem = original.slice(0, original.length - extension.length)
    .replace(/[^a-zA-Z0-9._ -]/g, '_')
    .slice(0, 100)
  return `${stem || `track-${source.trackId}`}${extension}`
}

function assertSafeFileSize(size: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error(`${label} has an invalid file size: ${size}`)
  if (size > maximum) throw new Error(`${label} exceeds the ${maximum}-byte temporary analysis limit.`)
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
  fileOffset: number,
): Promise<number> {
  let chunkOffset = 0
  while (chunkOffset < chunk.byteLength) {
    const result = await handle.write(chunk, chunkOffset, chunk.byteLength - chunkOffset, fileOffset + chunkOffset)
    if (result.bytesWritten <= 0) throw new Error('Temporary OneDrive download made no write progress.')
    chunkOffset += result.bytesWritten
  }
  return fileOffset + chunkOffset
}

function localModifiedMatches(indexed: string | null, modifiedMs: number): boolean {
  if (!indexed) return true
  const parsed = Date.parse(indexed)
  return !Number.isFinite(parsed) || Math.abs(parsed - modifiedMs) <= 1_000
}

export class DefaultChromaprintSourceResolver implements ChromaprintSourceResolver {
  private readonly client: DownloadClient
  private readonly tempRoot: string
  private readonly chunkBytes: number
  private readonly maxTempBytes: number
  private readonly authorizeLocalRead?: (source: FingerprintSource, signal?: AbortSignal) => Promise<void>

  constructor(options: DefaultChromaprintSourceResolverOptions = {}) {
    this.client = options.client ?? getOneDriveClient()
    this.tempRoot = options.tempRoot ?? tmpdir()
    this.chunkBytes = Math.max(320 * 1024, Math.min(options.chunkBytes ?? DEFAULT_CLOUD_CHUNK_BYTES, 32 * 1024 * 1024))
    this.maxTempBytes = options.maxTempBytes ?? DEFAULT_MAX_TEMP_BYTES
    this.authorizeLocalRead = options.authorizeLocalRead
  }

  async resolve(source: FingerprintSource, signal?: AbortSignal): Promise<ResolvedFingerprintInput> {
    signal?.throwIfAborted()
    if (source.provider === 'local') return this.resolveLocal(source, signal)
    if (source.provider !== 'onedrive') throw new Error(`Unsupported duplicate fingerprint provider: ${source.provider}`)
    return this.resolveOneDrive(source, signal)
  }

  private async resolveLocal(source: FingerprintSource, signal?: AbortSignal): Promise<ResolvedFingerprintInput> {
    await this.authorizeLocalRead?.(source, signal)
    const before = await stat(source.locator)
    if (!before.isFile()) throw new Error('Duplicate fingerprint source is not a regular file.')
    if (source.fileSize != null && before.size !== source.fileSize) {
      throw new Error('Local track size no longer matches the indexed library.')
    }
    if (!localModifiedMatches(source.dateModified, before.mtimeMs)) {
      throw new Error('Local track modification time no longer matches the indexed library.')
    }
    return {
      localPath: source.locator,
      verifyUnchanged: async () => {
        const after = await stat(source.locator)
        if (!after.isFile() || after.size !== before.size || Math.abs(after.mtimeMs - before.mtimeMs) > 1) {
          throw new Error('Local track changed while generating its duplicate fingerprint.')
        }
      },
    }
  }

  private async resolveOneDrive(source: FingerprintSource, signal?: AbortSignal): Promise<ResolvedFingerprintInput> {
    const locator = parseOneDriveFingerprintLocator(source.locator)
    const item = await this.client.getItem(locator.driveId, locator.itemId, signal)
    if (item.deleted || item.folder || item.id !== locator.itemId) throw new Error('OneDrive duplicate source is no longer a file.')
    const size = item.size ?? source.fileSize ?? 0
    assertSafeFileSize(size, this.maxTempBytes, 'OneDrive duplicate source')
    if (source.fileSize != null && size !== source.fileSize) {
      throw new Error('OneDrive track size no longer matches the indexed library.')
    }
    if (source.etag && itemEtag(item) !== source.etag) {
      throw new Error('OneDrive track ETag no longer matches the indexed library.')
    }

    const directory = await mkdtemp(join(this.tempRoot, 'crate-duplicate-cloud-'))
    const path = join(directory, safeCloudFilename(source, item))
    const handle = await open(path, 'wx', 0o600)
    try {
      let offset = 0
      for await (const chunk of this.client.downloadChunks({
        driveId: locator.driveId,
        itemId: locator.itemId,
        sizeBytes: size,
        chunkBytes: this.chunkBytes,
        signal,
      })) {
        signal?.throwIfAborted()
        if (offset + chunk.byteLength > size) throw new Error('OneDrive download exceeded the expected file size.')
        offset = await writeAll(handle, chunk, offset)
      }
      await handle.sync()
      await handle.close()
      if (offset !== size || (await stat(path)).size !== size) {
        throw new Error(`OneDrive temporary download is incomplete (${offset}/${size} bytes).`)
      }
    } catch (error) {
      await handle.close().catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
      throw error
    }

    return {
      localPath: path,
      verifyUnchanged: async () => {
        const current = await this.client.getItem(locator.driveId, locator.itemId, signal)
        assertExpectedCloudItem(source, item, current)
      },
      cleanup: () => rm(directory, { recursive: true, force: true }),
    }
  }
}
