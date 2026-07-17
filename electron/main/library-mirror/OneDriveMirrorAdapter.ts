import { posix } from 'node:path'
import type { DbFolder } from '@shared/types/db'
import {
  CloudHttpError,
  getOneDriveClient,
  type DriveItem,
  type OneDriveClient,
  type UploadedItem,
} from '../cloud/OneDriveClient.ts'
import { cloudRelativePath, isSafePortablePath } from '../cloud/cloudPortableManifest.ts'
import { driveItemRemotePath } from '../cloud/cloudMetadata.ts'
import { isExcludedMirrorPath } from './LocalMirrorAdapter.ts'
import {
  MirrorPreconditionError,
  MirrorRootUnavailableError,
  MirrorVerificationError,
  type MirrorAdapter,
  type MirrorEntry,
  type MirrorInventory,
  type MirrorWriteRequest,
} from './types.ts'

interface CloudLocation {
  driveId: string
  rootItemId: string
}

interface LiveCloudRoot {
  item: DriveItem
  remotePath: string
  identity: string
}

interface UploadResumeState {
  provider: 'onedrive'
  uploadUrl: string
  expirationDateTime: string | null
}

const TRANSFER_CHUNK_BYTES = 10 * 1024 * 1024

function cloudLocation(location: DbFolder): CloudLocation {
  if (
    location.provider !== 'onedrive'
    || !location.drive_id
    || !location.item_id
  ) {
    throw new MirrorRootUnavailableError(`OneDrive location ${location.id} has incomplete provider identity.`)
  }
  return {
    driveId: location.drive_id,
    rootItemId: location.item_id,
  }
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replaceAll('\\', '/')
  if (!isSafePortablePath(normalized)) throw new Error(`Unsafe mirror relative path: ${value}`)
  return normalized
}

function parentPath(relativePath: string): string | null {
  const parent = posix.dirname(relativePath)
  return parent === '.' ? null : parent
}

function itemEtag(item: DriveItem): string | null {
  return item.eTag ?? item.cTag ?? null
}

function itemEntry(relativePath: string, item: DriveItem): MirrorEntry {
  const kind = item.folder ? 'directory' : 'file'
  return {
    relativePath,
    kind,
    size: kind === 'file' ? Math.max(0, item.size ?? 0) : 0,
    modifiedAtMs: item.lastModifiedDateTime ? Date.parse(item.lastModifiedDateTime) || null : null,
    sha256: null,
    quickXorHash: kind === 'file' ? item.file?.hashes?.quickXorHash ?? null : null,
    etag: itemEtag(item),
    providerItemId: item.id,
  }
}

function sameObservedEntry(observed: MirrorEntry | null, planned: MirrorEntry | null): boolean {
  if (!observed || !planned) return observed === planned
  if (observed.kind !== planned.kind || observed.size !== planned.size) return false
  if (planned.etag && observed.etag) return planned.etag === observed.etag
  if (planned.kind === 'directory') return true
  return Boolean(
    planned.quickXorHash
    && observed.quickXorHash
    && planned.quickXorHash === observed.quickXorHash,
  )
}

function matchesPlannedSource(observed: MirrorEntry | null, expected: MirrorEntry): boolean {
  return Boolean(
    observed
    && observed.kind === 'file'
    && expected.kind === 'file'
    && observed.size === expected.size
    && expected.quickXorHash
    && observed.quickXorHash === expected.quickXorHash,
  )
}

function isResumeState(value: unknown): value is UploadResumeState {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<UploadResumeState>
  return candidate.provider === 'onedrive'
    && typeof candidate.uploadUrl === 'string'
    && candidate.uploadUrl.startsWith('https://')
}

function nextExpectedOffset(ranges: readonly string[], size: number): number | null {
  const first = ranges[0]
  if (!first) return size
  const match = /^(\d+)-/.exec(first)
  if (!match) return null
  const offset = Number(match[1])
  return Number.isSafeInteger(offset) && offset >= 0 && offset <= size ? offset : null
}

/** Sequential reader with one bounded replay buffer. Graph may retry the same
 * range after 429/5xx; retaining only that range avoids rewinding the source or
 * materializing the complete file. */
class SequentialChunkReader {
  private readonly iterator: AsyncIterator<Uint8Array>
  private remainder: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
  private position = 0
  private lastOffset = -1
  private lastChunk: Uint8Array | null = null

  constructor(source: AsyncIterable<Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]()
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (offset === this.lastOffset && this.lastChunk?.byteLength === length) return this.lastChunk
    if (offset < this.position) throw new Error(`Upload source cannot rewind from ${this.position} to ${offset}.`)
    if (offset > this.position) await this.consume(offset - this.position, false)
    const chunk = await this.consume(length, true)
    this.lastOffset = offset
    this.lastChunk = chunk
    return chunk
  }

  private async consume(length: number, retain: boolean): Promise<Uint8Array> {
    const output = retain ? new Uint8Array(length) : null
    let written = 0
    while (written < length) {
      if (this.remainder.byteLength === 0) {
        const next = await this.iterator.next()
        if (next.done) break
        this.remainder = next.value
        if (this.remainder.byteLength === 0) continue
      }
      const take = Math.min(length - written, this.remainder.byteLength)
      if (output) output.set(this.remainder.subarray(0, take), written)
      this.remainder = this.remainder.subarray(take)
      written += take
      this.position += take
    }
    if (written !== length) throw new MirrorPreconditionError(`Source ended at ${this.position}; expected ${length} more bytes.`)
    return output ?? new Uint8Array(0)
  }
}

export class OneDriveMirrorAdapter implements MirrorAdapter {
  readonly provider = 'onedrive' as const
  private readonly client: OneDriveClient

  constructor(client = getOneDriveClient()) {
    this.client = client
  }

  async inventory(location: DbFolder, signal?: AbortSignal): Promise<MirrorInventory> {
    const cloud = cloudLocation(location)
    const entries: MirrorEntry[] = []
    const warnings: MirrorInventory['warnings'][number][] = []

    try {
      const root = await this.currentRoot(location, signal)
      let completed = false
      for await (const page of this.client.listDelta(cloud.driveId, cloud.rootItemId, null, signal)) {
        for (const item of page.items) {
          signal?.throwIfAborted()
          if (item.deleted || item.id === cloud.rootItemId) continue
          const relativePath = cloudRelativePath(root.remotePath, driveItemRemotePath(item))
          if (!relativePath) {
            throw new MirrorRootUnavailableError(
              `OneDrive returned a live item outside the configured root: ${item.name ?? item.id}`,
            )
          }
          if (isExcludedMirrorPath(relativePath)) {
            warnings.push({
              code: 'entry_excluded',
              relativePath,
              message: 'Crate or operating-system temporary entry excluded.',
            })
            continue
          }
          if (!item.file && !item.folder) {
            warnings.push({ code: 'special_entry_skipped', relativePath, message: 'Unsupported OneDrive entry skipped.' })
            continue
          }
          if (item.file && !item.file.hashes?.quickXorHash) {
            throw new MirrorVerificationError(`OneDrive did not provide QuickXorHash for ${relativePath}.`)
          }
          entries.push(itemEntry(relativePath, item))
        }
        if (page.deltaLink) completed = true
      }
      if (!completed) throw new MirrorRootUnavailableError('OneDrive inventory completed without a delta cursor.')
      const completedRoot = await this.currentRoot(location, signal)
      if (completedRoot.identity !== root.identity) {
        throw new MirrorRootUnavailableError('The configured OneDrive root changed while it was inventoried.')
      }
      entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
      return { rootIdentity: root.identity, entries, warnings }
    } catch (error) {
      if (error instanceof MirrorRootUnavailableError || error instanceof MirrorVerificationError) throw error
      throw new MirrorRootUnavailableError(`OneDrive root is unavailable: ${location.name}`, { cause: error })
    }
  }

  async *readFile(location: DbFolder, entry: MirrorEntry, signal?: AbortSignal): AsyncIterable<Uint8Array> {
    if (entry.kind !== 'file') throw new Error(`Cannot read directory as a file: ${entry.relativePath}`)
    const cloud = cloudLocation(location)
    const item = await this.resolvePlannedItem(location, entry, signal)
    const before = itemEntry(entry.relativePath, item)
    if (!sameObservedEntry(before, entry)) {
      throw new MirrorPreconditionError(`OneDrive source changed after planning: ${entry.relativePath}`)
    }
    for await (const chunk of this.client.downloadChunks({
      driveId: cloud.driveId,
      itemId: item.id,
      sizeBytes: entry.size,
      chunkBytes: TRANSFER_CHUNK_BYTES,
      signal,
    })) {
      yield chunk
    }
    const afterItem = await this.client.getItem(cloud.driveId, item.id, signal)
    await this.assertItemAtPath(location, afterItem, entry.relativePath, signal)
    const after = itemEntry(entry.relativePath, afterItem)
    if (!sameObservedEntry(after, entry)) {
      throw new MirrorPreconditionError(`OneDrive source changed while copying: ${entry.relativePath}`)
    }
  }

  async createDirectory(location: DbFolder, relativePath: string, signal?: AbortSignal): Promise<void> {
    const normalized = normalizeRelativePath(relativePath)
    const observed = await this.resolveItem(location, normalized, signal)
    if (observed?.folder) return
    if (observed) throw new MirrorPreconditionError(`A file occupies the planned directory: ${normalized}`)
    const cloud = cloudLocation(location)
    const parent = await this.requireParent(location, normalized, signal)
    const created = await this.client.createFolder({
      driveId: cloud.driveId,
      parentItemId: parent.id,
      name: posix.basename(normalized),
      conflictBehavior: 'fail',
      signal,
    })
    const refreshed = await this.client.getItem(cloud.driveId, created.id, signal)
    await this.assertItemAtPath(location, refreshed, normalized, signal)
  }

  async writeFile(request: MirrorWriteRequest): Promise<MirrorEntry> {
    const { location, expectedSource, destinationBefore, signal } = request
    const relativePath = normalizeRelativePath(request.relativePath)
    const cloud = cloudLocation(location)
    const observed = await this.observeDestination(location, relativePath, destinationBefore, signal)
    if (!sameObservedEntry(observed, destinationBefore)) {
      if (matchesPlannedSource(observed, expectedSource)) {
        request.onProgress?.(expectedSource.size)
        return observed!
      }
      throw new MirrorPreconditionError(`Backup destination changed after planning: ${relativePath}`)
    }
    const parent = await this.requireParent(location, relativePath, signal)
    const reader = new SequentialChunkReader(request.source)
    let uploaded: UploadedItem

    if (expectedSource.size === 0) {
      uploaded = await this.client.uploadBuffer({
        driveId: cloud.driveId,
        parentItemId: parent.id,
        itemId: destinationBefore?.providerItemId ?? undefined,
        filename: posix.basename(relativePath),
        buffer: Buffer.alloc(0),
        conflictBehavior: 'replace',
        ifMatch: destinationBefore?.etag ?? undefined,
        signal,
        onProgress: completed => request.onProgress?.(completed),
      })
    } else {
      let state = isResumeState(request.resumeState) ? request.resumeState : null
      let startOffset = 0
      if (state) {
        try {
          const session = await this.client.getUploadSession(state.uploadUrl, signal)
          const expected = nextExpectedOffset(session.nextExpectedRanges, expectedSource.size)
          if (expected == null || expected >= expectedSource.size) state = null
          else startOffset = expected
        } catch (error) {
          if (!(error instanceof CloudHttpError) || ![404, 410].includes(error.status)) throw error
          state = null
        }
      }
      if (!state) {
        const session = await this.client.createUploadSession({
          driveId: cloud.driveId,
          parentItemId: parent.id,
          itemId: destinationBefore?.providerItemId ?? undefined,
          filename: posix.basename(relativePath),
          conflictBehavior: 'replace',
          ifMatch: destinationBefore?.etag ?? undefined,
          signal,
        })
        state = {
          provider: 'onedrive',
          uploadUrl: session.uploadUrl,
          expirationDateTime: session.expirationDateTime,
        }
        startOffset = nextExpectedOffset(session.nextExpectedRanges, expectedSource.size) ?? 0
      }
      request.onResumeState?.(state)
      request.onProgress?.(startOffset)
      uploaded = await this.client.uploadResumable({
        uploadUrl: state.uploadUrl,
        sizeBytes: expectedSource.size,
        startOffset,
        readChunk: (offset, length) => reader.read(offset, length),
        signal,
        onProgress: completed => request.onProgress?.(completed),
      })
      request.onResumeState?.(null)
    }

    const remote = await this.client.getItem(cloud.driveId, uploaded.id, signal)
    await this.assertItemAtPath(location, remote, relativePath, signal)
    const result = itemEntry(relativePath, remote)
    if (
      result.size !== expectedSource.size
      || !result.quickXorHash
      || !expectedSource.quickXorHash
      || result.quickXorHash !== expectedSource.quickXorHash
    ) {
      throw new MirrorVerificationError(`OneDrive verification failed for ${relativePath}.`)
    }
    return result
  }

  async moveEntry(request: NonNullable<MirrorAdapter['moveEntry']> extends (...args: infer A) => unknown ? A[0] : never): Promise<MirrorEntry> {
    const sourcePath = normalizeRelativePath(request.sourceRelativePath)
    const destinationPath = normalizeRelativePath(request.destinationRelativePath)
    const cloud = cloudLocation(request.location)
    const [sourceItem, observedDestination] = await Promise.all([
      this.resolveItem(request.location, sourcePath, request.signal),
      this.observeDestination(request.location, destinationPath, request.destinationBefore, request.signal),
    ])
    if (!sourceItem && matchesPlannedSource(observedDestination, request.sourceBefore)) {
      return observedDestination!
    }
    if (!sourceItem) throw new MirrorPreconditionError(`Staged OneDrive file disappeared: ${sourcePath}`)
    const observedSource = itemEntry(sourcePath, sourceItem)
    if (!sameObservedEntry(observedSource, request.sourceBefore)) {
      throw new MirrorPreconditionError(`Staged OneDrive file changed before publication: ${sourcePath}`)
    }
    if (!sameObservedEntry(observedDestination, request.destinationBefore)) {
      throw new MirrorPreconditionError(`OneDrive migration destination changed before publication: ${destinationPath}`)
    }
    const parent = await this.requireParent(request.location, destinationPath, request.signal)
    const moved = await this.client.moveItem({
      driveId: cloud.driveId,
      itemId: sourceItem.id,
      parentItemId: parent.id,
      name: posix.basename(destinationPath),
      ifMatch: observedSource.etag ?? undefined,
      signal: request.signal,
    })
    await this.assertItemAtPath(request.location, moved, destinationPath, request.signal)
    return itemEntry(destinationPath, moved)
  }

  async deleteEntry(request: Parameters<MirrorAdapter['deleteEntry']>[0]): Promise<void> {
    const relativePath = normalizeRelativePath(request.relativePath)
    const cloud = cloudLocation(request.location)
    let observedItem: DriveItem | null
    try {
      observedItem = request.destinationBefore?.providerItemId
        ? await this.client.getItem(cloud.driveId, request.destinationBefore.providerItemId, request.signal)
        : await this.resolveItem(request.location, relativePath, request.signal)
      if (observedItem) {
        await this.assertItemAtPath(request.location, observedItem, relativePath, request.signal)
      }
    } catch (error) {
      if (!(error instanceof CloudHttpError) || error.status !== 404) throw error
      observedItem = await this.resolveItem(request.location, relativePath, request.signal)
    }
    if (!observedItem) return
    const observed = itemEntry(relativePath, observedItem)
    if (!request.destinationBefore || !sameObservedEntry(observed, request.destinationBefore)) {
      throw new MirrorPreconditionError(`Backup destination changed after planning: ${relativePath}`)
    }
    if (observed.kind === 'directory') {
      const children = await this.client.listChildren(cloud.driveId, observedItem.id, request.signal)
      if (children.length > 0) {
        throw new MirrorPreconditionError(`Refusing to recycle a non-empty OneDrive directory: ${relativePath}`)
      }
    }
    try {
      await this.client.deleteItemToRecycleBin({
        driveId: cloud.driveId,
        itemId: observedItem.id,
        ifMatch: request.destinationBefore.etag ?? undefined,
        signal: request.signal,
      })
    } catch (error) {
      if (!(error instanceof CloudHttpError) || error.status !== 404) throw error
      // A retried DELETE is idempotent only if the planned path is still
      // absent. A replacement at the same path is independent destination
      // state and must be reviewed as a divergence.
      const replacement = await this.resolveItem(request.location, relativePath, request.signal)
      if (replacement) {
        throw new MirrorPreconditionError(`A replacement appeared at the deleted OneDrive path: ${relativePath}`)
      }
    }
  }

  private async resolvePlannedItem(location: DbFolder, entry: MirrorEntry, signal?: AbortSignal): Promise<DriveItem> {
    const cloud = cloudLocation(location)
    if (entry.providerItemId) {
      const item = await this.client.getItem(cloud.driveId, entry.providerItemId, signal)
      await this.assertItemAtPath(location, item, entry.relativePath, signal)
      return item
    }
    const item = await this.resolveItem(location, entry.relativePath, signal)
    if (!item) throw new MirrorPreconditionError(`OneDrive item disappeared: ${entry.relativePath}`)
    return item
  }

  private async observeDestination(
    location: DbFolder,
    relativePath: string,
    planned: MirrorEntry | null,
    signal?: AbortSignal,
  ): Promise<MirrorEntry | null> {
    const cloud = cloudLocation(location)
    try {
      const item = planned?.providerItemId
        ? await this.client.getItem(cloud.driveId, planned.providerItemId, signal)
        : await this.resolveItem(location, relativePath, signal)
      if (!item) return null
      await this.assertItemAtPath(location, item, relativePath, signal)
      return itemEntry(relativePath, item)
    } catch (error) {
      if (error instanceof CloudHttpError && error.status === 404) {
        const replacement = await this.resolveItem(location, relativePath, signal)
        return replacement ? itemEntry(relativePath, replacement) : null
      }
      throw error
    }
  }

  private async requireParent(location: DbFolder, relativePath: string, signal?: AbortSignal): Promise<DriveItem> {
    const parent = parentPath(relativePath)
    if (parent === null) {
      return (await this.currentRoot(location, signal)).item
    }
    const item = await this.resolveItem(location, parent, signal)
    if (!item?.folder) throw new MirrorPreconditionError(`OneDrive parent directory is missing: ${parent}`)
    return item
  }

  private async resolveItem(location: DbFolder, relativePath: string, signal?: AbortSignal): Promise<DriveItem | null> {
    const normalized = normalizeRelativePath(relativePath)
    const cloud = cloudLocation(location)
    let current = (await this.currentRoot(location, signal)).item
    let traversed = ''
    for (const segment of normalized.split('/')) {
      const nextPath = traversed ? `${traversed}/${segment}` : segment
      if (!current.folder) return null
      const children = await this.client.listChildren(cloud.driveId, current.id, signal)
      const next = children.find(item => item.name === segment)
        ?? children.find(item => item.name?.toLocaleLowerCase() === segment.toLocaleLowerCase())
      if (!next) return null
      await this.assertItemAtPath(location, next, nextPath, signal)
      current = next
      traversed = nextPath
    }
    return current
  }

  private async currentRoot(location: DbFolder, signal?: AbortSignal): Promise<LiveCloudRoot> {
    const cloud = cloudLocation(location)
    let item: DriveItem
    try {
      item = await this.client.getItem(cloud.driveId, cloud.rootItemId, signal)
    } catch (error) {
      throw new MirrorRootUnavailableError(`OneDrive root is unavailable: ${location.name}`, { cause: error })
    }
    if (item.id !== cloud.rootItemId || !item.folder) {
      throw new MirrorRootUnavailableError('The configured OneDrive root is no longer a folder.')
    }
    return {
      item,
      remotePath: driveItemRemotePath(item),
      identity: `onedrive:${cloud.driveId}:${item.id}`,
    }
  }

  private async assertItemAtPath(
    location: DbFolder,
    item: DriveItem,
    expectedRelativePath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const root = await this.currentRoot(location, signal)
    const observed = cloudRelativePath(root.remotePath, driveItemRemotePath(item))
    if (observed !== normalizeRelativePath(expectedRelativePath)) {
      throw new MirrorPreconditionError(
        `OneDrive item moved outside its planned path: ${expectedRelativePath}`,
      )
    }
  }
}
