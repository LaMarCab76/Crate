import { PLAYBACK_MEMORY_READ_CHUNK_BYTES } from '../audio/progressiveBuffering.ts'
import { downloadRangesIntoBuffer, type RangeResult } from './cloudRangeDownload.ts'

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'
const SMALL_UPLOAD_LIMIT = 4 * 1024 * 1024
const UPLOAD_CHUNK_BYTES = 10 * 1024 * 1024 // 32 * 320 KiB
const MAX_RETRIES = 5
const MAX_DOWNLOAD_URL_REFRESHES = 3
const MAX_TEXT_BYTES = 10 * 1024 * 1024

export interface DriveItemAudioFacet {
  album?: string
  albumArtist?: string
  artist?: string
  bitrate?: number
  composers?: string
  disc?: number
  discCount?: number
  duration?: number
  genre?: string
  title?: string
  track?: number
  trackCount?: number
  year?: number
}

export interface DriveItem {
  id: string
  name?: string
  size?: number
  eTag?: string
  cTag?: string
  lastModifiedDateTime?: string
  file?: {
    mimeType?: string
    hashes?: { quickXorHash?: string; sha1Hash?: string; sha256Hash?: string }
  }
  folder?: { childCount?: number }
  audio?: DriveItemAudioFacet
  deleted?: { state?: string }
  parentReference?: { driveId?: string; id?: string; path?: string }
  ['@microsoft.graph.downloadUrl']?: string
}

export interface UploadedItem {
  id: string
  name: string
  size: number
  etag: string | null
  quickXorHash: string | null
}

export interface CloudDownloadInfo {
  url: string
  size: number
  etag: string | null
  quickXorHash: string | null
}

export interface DeltaPage {
  items: DriveItem[]
  deltaLink: string | null
  /** True on the first page after an expired cursor (HTTP 410). Consumers must
   * discard their previous snapshot before applying this full enumeration. */
  reset: boolean
}

export interface ResumableUploadSession {
  uploadUrl: string
  expirationDateTime: string | null
  nextExpectedRanges: string[]
}

export type UploadConflictBehavior = 'replace' | 'fail' | 'rename'

export class CloudHttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'CloudHttpError'
    this.status = status
  }
}

export interface OneDriveClientDeps {
  getAccessToken?: (forceRefresh: boolean) => Promise<string>
  fetch?: typeof fetch
  delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
}

function defaultDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function graphUrl(pathOrUrl: string): string {
  if (pathOrUrl.startsWith('/')) return `${GRAPH_BASE}${pathOrUrl}`
  const url = new URL(pathOrUrl)
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'graph.microsoft.com') {
    throw new Error('Refusing to send a Graph access token to an untrusted URL.')
  }
  return url.toString()
}

function preauthenticatedUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:') throw new Error('OneDrive transfer URL must use HTTPS.')
  return url.toString()
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get('Retry-After'))
  return (Number.isFinite(retryAfter) && retryAfter > 0
    ? retryAfter
    : Math.min(2 ** attempt, 30)) * 1000
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value)
}

function itemPath(driveId: string, itemId: string): string {
  return `/drives/${encodeSegment(driveId)}/items/${encodeSegment(itemId)}`
}

function childPath(driveId: string, parentItemId: string, name: string, suffix = ''): string {
  return `${itemPath(driveId, parentItemId)}:/${encodeSegment(name)}:${suffix}`
}

function uploadedItem(value: Record<string, unknown>): UploadedItem {
  if (typeof value.id !== 'string') throw new Error('Upload response did not contain an item id.')
  const file = value.file && typeof value.file === 'object'
    ? value.file as { hashes?: { quickXorHash?: unknown } }
    : undefined
  return {
    id: value.id,
    name: typeof value.name === 'string' ? value.name : '',
    size: typeof value.size === 'number' ? value.size : Number(value.size) || 0,
    etag: typeof value.eTag === 'string'
      ? value.eTag
      : typeof value.cTag === 'string' ? value.cTag : null,
    quickXorHash: typeof file?.hashes?.quickXorHash === 'string'
      ? file.hashes.quickXorHash
      : null,
  }
}

function uploadOffset(ranges: readonly string[] | undefined, fallback: number, size: number): number {
  const match = ranges?.[0] ? /^(\d+)-/.exec(ranges[0]) : null
  if (!match) return fallback
  const value = Number(match[1])
  if (!Number.isSafeInteger(value) || value < 0 || value > size) {
    throw new Error(`Upload session returned an invalid offset: ${String(ranges?.[0])}.`)
  }
  return value
}

/** Microsoft Graph client with injectable auth/fetch for deterministic tests. */
export class OneDriveClient {
  private readonly token: (forceRefresh: boolean) => Promise<string>
  private readonly fetchImpl: typeof fetch
  private readonly wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>

  constructor(deps: OneDriveClientDeps = {}) {
    this.token = deps.getAccessToken ?? (async forceRefresh => {
      const { getOneDriveAuth } = await import('./OneDriveAuth')
      return getOneDriveAuth().getAccessToken(forceRefresh)
    })
    this.fetchImpl = deps.fetch ?? fetch
    this.wait = deps.delay ?? defaultDelay
  }

  private async graphFetch(
    pathOrUrl: string,
    init: RequestInit = {},
    attempt = 0,
    forceRefresh = false,
  ): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${await this.token(forceRefresh)}`)
    const response = await this.fetchImpl(graphUrl(pathOrUrl), { ...init, headers })

    if (response.status === 401 && attempt < 1) {
      return this.graphFetch(pathOrUrl, init, attempt + 1, true)
    }
    if (
      (response.status === 429 || response.status === 503 || response.status === 504) &&
      attempt < MAX_RETRIES
    ) {
      await this.wait(retryDelayMs(response, attempt), init.signal ?? undefined)
      return this.graphFetch(pathOrUrl, init, attempt + 1, forceRefresh)
    }
    return response
  }

  async getDefaultDriveId(signal?: AbortSignal): Promise<string> {
    const response = await this.graphFetch('/me/drive?$select=id', { signal })
    if (!response.ok) throw new CloudHttpError(response.status, `Drive lookup failed (${response.status}).`)
    const value = await response.json() as Record<string, unknown>
    if (typeof value.id !== 'string') throw new Error('Microsoft Graph returned no drive id.')
    return value.id
  }

  async getItem(driveId: string, itemId: string, signal?: AbortSignal): Promise<DriveItem> {
    const response = await this.graphFetch(
      `${itemPath(driveId, itemId)}?$select=id,name,size,eTag,cTag,lastModifiedDateTime,file,folder,parentReference,audio`,
      { signal },
    )
    if (!response.ok) throw new CloudHttpError(response.status, `Item lookup failed (${response.status}).`)
    return await response.json() as DriveItem
  }

  async listChildren(
    driveId: string,
    parentItemId: string | null,
    signal?: AbortSignal,
  ): Promise<DriveItem[]> {
    const parent = parentItemId ? `/items/${encodeSegment(parentItemId)}` : '/root'
    let cursor = `/drives/${encodeSegment(driveId)}${parent}/children?` +
      '$select=id,name,size,eTag,cTag,lastModifiedDateTime,file,folder,parentReference,audio&$top=200'
    const result: DriveItem[] = []
    while (cursor) {
      const response = await this.graphFetch(cursor, { signal })
      if (!response.ok) {
        throw new CloudHttpError(response.status, `List children failed (${response.status}).`)
      }
      const page = await response.json() as {
        value?: DriveItem[]
        ['@odata.nextLink']?: string
      }
      result.push(...(page.value ?? []))
      cursor = page['@odata.nextLink'] ?? ''
    }
    return result
  }

  async listChildFolders(
    driveId: string,
    parentItemId: string | null,
    signal?: AbortSignal,
  ): Promise<DriveItem[]> {
    return (await this.listChildren(driveId, parentItemId, signal)).filter(item => Boolean(item.folder))
  }

  async *listDelta(
    driveId: string,
    rootItemId: string,
    deltaLink: string | null = null,
    signal?: AbortSignal,
  ): AsyncGenerator<DeltaPage> {
    const initialPath = `${itemPath(driveId, rootItemId)}/delta?` +
      '$select=id,name,size,eTag,cTag,lastModifiedDateTime,file,folder,parentReference,audio,deleted'
    let cursor = deltaLink || initialPath
    let didReset = false
    let resetNextPage = false

    while (cursor) {
      const response = await this.graphFetch(cursor, { signal })
      if (response.status === 410 && deltaLink && !didReset) {
        // The cursor is invalid. Do not emit an empty page: restart a complete
        // inventory and mark its first page so the indexer can atomically drop
        // the stale snapshot before applying the replacement.
        didReset = true
        resetNextPage = true
        cursor = initialPath
        continue
      }
      if (!response.ok) {
        throw new CloudHttpError(response.status, `Delta enumeration failed (${response.status}).`)
      }
      const page = await response.json() as {
        value?: DriveItem[]
        ['@odata.nextLink']?: string
        ['@odata.deltaLink']?: string
      }
      yield {
        items: page.value ?? [],
        deltaLink: page['@odata.deltaLink'] ?? null,
        reset: resetNextPage,
      }
      resetNextPage = false
      cursor = page['@odata.nextLink'] ?? ''
    }
  }

  async getDownloadUrl(
    driveId: string,
    itemId: string,
    signal?: AbortSignal,
  ): Promise<CloudDownloadInfo> {
    const response = await this.graphFetch(
      `${itemPath(driveId, itemId)}?` +
        '$select=id,size,eTag,cTag,file,@microsoft.graph.downloadUrl',
      { signal },
    )
    if (!response.ok) {
      throw new CloudHttpError(response.status, `Download lookup failed (${response.status}).`)
    }
    const item = await response.json() as DriveItem
    const url = item['@microsoft.graph.downloadUrl']
    if (typeof url !== 'string' || !url) throw new Error('OneDrive item has no download URL.')
    return {
      url: preauthenticatedUrl(url),
      size: typeof item.size === 'number' ? item.size : 0,
      etag: item.eTag ?? item.cTag ?? null,
      quickXorHash: item.file?.hashes?.quickXorHash ?? null,
    }
  }

  async downloadChildText(
    driveId: string,
    parentItemId: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const response = await this.graphFetch(
      `${childPath(driveId, parentItemId, name)}?$select=id,size,@microsoft.graph.downloadUrl`,
      { signal },
    )
    if (response.status === 404) return null
    if (!response.ok) {
      throw new CloudHttpError(response.status, `Child lookup failed (${response.status}).`)
    }
    const item = await response.json() as DriveItem
    if ((item.size ?? 0) > MAX_TEXT_BYTES) throw new Error('Cloud manifest is unexpectedly large.')
    const url = item['@microsoft.graph.downloadUrl']
    if (typeof url !== 'string') return null
    const download = await this.fetchImpl(preauthenticatedUrl(url), { signal })
    if (!download.ok) {
      throw new CloudHttpError(download.status, `Child download failed (${download.status}).`)
    }
    return download.text()
  }

  async fetchPrefix(
    driveId: string,
    itemId: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<{ buffer: Buffer; size: number }> {
    const info = await this.getDownloadUrl(driveId, itemId, signal)
    if (info.size === 0 || maxBytes <= 0) return { buffer: Buffer.alloc(0), size: info.size }
    const end = Math.min(maxBytes, info.size) - 1
    const response = await this.fetchImpl(info.url, {
      headers: { Range: `bytes=0-${end}` },
      signal,
    })
    if (response.status !== 200 && response.status !== 206) {
      throw new CloudHttpError(response.status, `Prefix download failed (${response.status}).`)
    }
    return { buffer: Buffer.from(await response.arrayBuffer()), size: info.size }
  }

  async fetchFullIntoBuffer(options: {
    driveId: string
    itemId: string
    sizeBytes: number
    buffer: Buffer
    signal?: AbortSignal
    onProgress?: (loadedBytes: number) => void
    initialUrl?: string
  }): Promise<void> {
    const { driveId, itemId, sizeBytes, buffer, signal, onProgress } = options
    await downloadRangesIntoBuffer({
      sizeBytes,
      buffer,
      signal,
      onProgress,
      initialUrl: options.initialUrl,
      deps: {
        chunkBytes: PLAYBACK_MEMORY_READ_CHUNK_BYTES,
        maxUrlRefreshes: MAX_DOWNLOAD_URL_REFRESHES,
        maxRateLimitRetries: MAX_RETRIES,
        resolveUrl: async activeSignal =>
          (await this.getDownloadUrl(driveId, itemId, activeSignal)).url,
        delay: (milliseconds, activeSignal) => this.wait(milliseconds, activeSignal),
        fetchRange: async (url, start, endInclusive, activeSignal): Promise<RangeResult> => {
          const response = await this.fetchImpl(preauthenticatedUrl(url), {
            headers: { Range: `bytes=${start}-${endInclusive}` },
            signal: activeSignal,
          })
          const retryAfter = Number(response.headers.get('Retry-After'))
          return {
            status: response.status,
            body: response.status === 200 || response.status === 206
              ? new Uint8Array(await response.arrayBuffer())
              : null,
            retryAfterSec: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
          }
        },
      },
    })
  }

  /** Bounded-memory range reader used by library mirrors. Unlike playback's
   * caller-owned full buffer, this yields one verified range at a time and
   * refreshes expired preauthenticated URLs without restarting the file. */
  async *downloadChunks(options: {
    driveId: string
    itemId: string
    sizeBytes: number
    chunkBytes?: number
    signal?: AbortSignal
  }): AsyncGenerator<Uint8Array> {
    const chunkBytes = Math.max(
      320 * 1024,
      Math.min(options.chunkBytes ?? UPLOAD_CHUNK_BYTES, 32 * 1024 * 1024),
    )
    let info = await this.getDownloadUrl(options.driveId, options.itemId, options.signal)
    if (info.size !== options.sizeBytes) {
      throw new Error(`OneDrive item size changed from ${options.sizeBytes} to ${info.size}.`)
    }
    let offset = 0
    let urlRefreshes = 0
    let retryCount = 0
    while (offset < options.sizeBytes) {
      options.signal?.throwIfAborted()
      const endInclusive = Math.min(options.sizeBytes, offset + chunkBytes) - 1
      const expected = endInclusive - offset + 1
      const response = await this.fetchImpl(preauthenticatedUrl(info.url), {
        headers: { Range: `bytes=${offset}-${endInclusive}` },
        signal: options.signal,
      })
      if (response.status === 206 || (response.status === 200 && offset === 0 && expected === options.sizeBytes)) {
        const body = new Uint8Array(await response.arrayBuffer())
        if (body.byteLength !== expected) {
          throw new Error(`OneDrive range returned ${body.byteLength} bytes; expected ${expected}.`)
        }
        yield body
        offset += body.byteLength
        retryCount = 0
        continue
      }
      if ([401, 403, 404, 410].includes(response.status) && urlRefreshes < MAX_DOWNLOAD_URL_REFRESHES) {
        info = await this.getDownloadUrl(options.driveId, options.itemId, options.signal)
        if (info.size !== options.sizeBytes) {
          throw new Error(`OneDrive item changed while downloading ${options.itemId}.`)
        }
        urlRefreshes += 1
        continue
      }
      if ((response.status === 429 || response.status >= 500) && retryCount < MAX_RETRIES) {
        await this.wait(retryDelayMs(response, retryCount), options.signal)
        retryCount += 1
        continue
      }
      throw new CloudHttpError(response.status, `Range download failed (${response.status}).`)
    }
  }

  async downloadToBuffer(options: {
    driveId: string
    itemId: string
    signal?: AbortSignal
    onProgress?: (loadedBytes: number) => void
  }): Promise<{ buffer: Buffer; info: CloudDownloadInfo }> {
    const info = await this.getDownloadUrl(options.driveId, options.itemId, options.signal)
    const buffer = Buffer.allocUnsafe(info.size)
    await this.fetchFullIntoBuffer({
      ...options,
      sizeBytes: info.size,
      buffer,
      initialUrl: info.url,
    })
    return { buffer, info }
  }

  async uploadBuffer(options: {
    driveId: string
    parentItemId: string
    /** Known destination identity. Supplying it makes replacements use the
     * item endpoint so Graph actually evaluates the accompanying If-Match. */
    itemId?: string
    filename: string
    buffer: Buffer
    conflictBehavior?: UploadConflictBehavior
    ifMatch?: string
    signal?: AbortSignal
    onProgress?: (uploadedBytes: number, totalBytes: number) => void
  }): Promise<UploadedItem> {
    return this.uploadFile(options)
  }

  async uploadFile(options: {
    driveId: string
    parentItemId: string
    itemId?: string
    filename: string
    buffer: Buffer
    conflictBehavior?: UploadConflictBehavior
    ifMatch?: string
    signal?: AbortSignal
    onProgress?: (uploadedBytes: number, totalBytes: number) => void
  }): Promise<UploadedItem> {
    if (
      options.buffer.byteLength <= SMALL_UPLOAD_LIMIT &&
      (options.conflictBehavior ?? 'replace') === 'replace'
    ) return this.uploadSmall(options)
    const session = await this.createUploadSession(options)
    return this.uploadResumable({
      uploadUrl: session.uploadUrl,
      sizeBytes: options.buffer.byteLength,
      readChunk: async (offset, length) => options.buffer.subarray(offset, offset + length),
      signal: options.signal,
      onProgress: options.onProgress,
    })
  }

  private async uploadSmall(options: {
    driveId: string
    parentItemId: string
    itemId?: string
    filename: string
    buffer: Buffer
    ifMatch?: string
    signal?: AbortSignal
    onProgress?: (uploadedBytes: number, totalBytes: number) => void
  }): Promise<UploadedItem> {
    const headers = new Headers({ 'Content-Type': 'application/octet-stream' })
    if (options.ifMatch) headers.set('If-Match', options.ifMatch)
    const target = options.itemId
      ? `${itemPath(options.driveId, options.itemId)}/content`
      : childPath(options.driveId, options.parentItemId, options.filename, '/content')
    const response = await this.graphFetch(
      target,
      { method: 'PUT', headers, body: options.buffer, signal: options.signal },
    )
    if (!response.ok) throw new CloudHttpError(response.status, `Upload failed (${response.status}).`)
    options.onProgress?.(options.buffer.byteLength, options.buffer.byteLength)
    return uploadedItem(await response.json() as Record<string, unknown>)
  }

  async createUploadSession(options: {
    driveId: string
    parentItemId: string
    /** Existing item to replace. Graph documents If-Match on this endpoint;
     * using only the parent/name creation endpoint would not provide the same
     * optimistic-concurrency guarantee. */
    itemId?: string
    filename: string
    conflictBehavior?: UploadConflictBehavior
    ifMatch?: string
    signal?: AbortSignal
  }): Promise<ResumableUploadSession> {
    const headers = new Headers({ 'Content-Type': 'application/json' })
    if (options.ifMatch) headers.set('If-Match', options.ifMatch)
    const target = options.itemId
      ? `${itemPath(options.driveId, options.itemId)}/createUploadSession`
      : childPath(options.driveId, options.parentItemId, options.filename, '/createUploadSession')
    const response = await this.graphFetch(
      target,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          item: {
            '@microsoft.graph.conflictBehavior': options.conflictBehavior ?? 'replace',
            name: options.filename,
          },
        }),
        signal: options.signal,
      },
    )
    if (!response.ok) {
      throw new CloudHttpError(response.status, `Create upload session failed (${response.status}).`)
    }
    const value = await response.json() as {
      uploadUrl?: string
      expirationDateTime?: string
      nextExpectedRanges?: string[]
    }
    if (!value.uploadUrl) throw new Error('Microsoft Graph returned no upload session URL.')
    return {
      uploadUrl: preauthenticatedUrl(value.uploadUrl),
      expirationDateTime: value.expirationDateTime ?? null,
      nextExpectedRanges: value.nextExpectedRanges ?? ['0-'],
    }
  }

  async getUploadSession(uploadUrl: string, signal?: AbortSignal): Promise<ResumableUploadSession> {
    const response = await this.fetchImpl(preauthenticatedUrl(uploadUrl), { signal })
    if (!response.ok) {
      throw new CloudHttpError(response.status, `Upload session lookup failed (${response.status}).`)
    }
    const value = await response.json() as {
      expirationDateTime?: string
      nextExpectedRanges?: string[]
    }
    return {
      uploadUrl: preauthenticatedUrl(uploadUrl),
      expirationDateTime: value.expirationDateTime ?? null,
      nextExpectedRanges: value.nextExpectedRanges ?? [],
    }
  }

  async uploadResumable(options: {
    uploadUrl: string
    sizeBytes: number
    readChunk: (offset: number, length: number) => Promise<Uint8Array>
    startOffset?: number
    signal?: AbortSignal
    onProgress?: (uploadedBytes: number, totalBytes: number) => void
  }): Promise<UploadedItem> {
    const uploadUrl = preauthenticatedUrl(options.uploadUrl)
    let offset = options.startOffset ?? 0
    let retryCount = 0

    while (offset < options.sizeBytes) {
      if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const length = Math.min(UPLOAD_CHUNK_BYTES, options.sizeBytes - offset)
      const chunk = await options.readChunk(offset, length)
      if (chunk.byteLength !== length) {
        throw new Error(`Upload chunk had ${chunk.byteLength} bytes; expected ${length}.`)
      }
      const endExclusive = offset + length
      const response = await this.fetchImpl(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Length': String(length),
          'Content-Range': `bytes ${offset}-${endExclusive - 1}/${options.sizeBytes}`,
        },
        body: chunk,
        signal: options.signal,
      })
      if (response.status === 202) {
        const state = await response.json() as { nextExpectedRanges?: string[] }
        offset = uploadOffset(state.nextExpectedRanges, endExclusive, options.sizeBytes)
        retryCount = 0
        options.onProgress?.(offset, options.sizeBytes)
        continue
      }
      if (response.status === 200 || response.status === 201) {
        options.onProgress?.(options.sizeBytes, options.sizeBytes)
        return uploadedItem(await response.json() as Record<string, unknown>)
      }
      if ((response.status === 416 || response.status === 429 || response.status >= 500) && retryCount < MAX_RETRIES) {
        await this.wait(retryDelayMs(response, retryCount), options.signal)
        try {
          const state = await this.getUploadSession(uploadUrl, options.signal)
          const serverOffset = uploadOffset(state.nextExpectedRanges, offset, options.sizeBytes)
          if (serverOffset > offset) {
            offset = serverOffset
            options.onProgress?.(offset, options.sizeBytes)
            retryCount = 0
            continue
          }
        } catch {
          // The session probe is advisory; retrying the same bounded fragment
          // remains safe and Graph will answer with its expected range.
        }
        retryCount += 1
        continue
      }
      throw new CloudHttpError(response.status, `Upload chunk failed (${response.status}).`)
    }
    throw new Error('Upload session ended without a final driveItem.')
  }

  async createFolder(options: {
    driveId: string
    parentItemId: string
    name: string
    conflictBehavior?: UploadConflictBehavior
    ifMatch?: string
    signal?: AbortSignal
  }): Promise<DriveItem> {
    const headers = new Headers({ 'Content-Type': 'application/json' })
    if (options.ifMatch) headers.set('If-Match', options.ifMatch)
    const response = await this.graphFetch(
      `${itemPath(options.driveId, options.parentItemId)}/children`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: options.name,
          folder: {},
          '@microsoft.graph.conflictBehavior': options.conflictBehavior ?? 'fail',
        }),
        signal: options.signal,
      },
    )
    if (!response.ok) {
      throw new CloudHttpError(response.status, `Create folder failed (${response.status}).`)
    }
    return await response.json() as DriveItem
  }

  /** Rename or move an item within a drive. If-Match protects publication from
   * replacing a staging item that changed after verification. */
  async moveItem(options: {
    driveId: string
    itemId: string
    parentItemId: string
    name: string
    ifMatch?: string
    signal?: AbortSignal
  }): Promise<DriveItem> {
    const headers = new Headers({ 'Content-Type': 'application/json' })
    if (options.ifMatch) headers.set('If-Match', options.ifMatch)
    const response = await this.graphFetch(itemPath(options.driveId, options.itemId), {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        name: options.name,
        parentReference: { id: options.parentItemId },
      }),
      signal: options.signal,
    })
    if (!response.ok) {
      throw new CloudHttpError(response.status, `Move item failed (${response.status}).`)
    }
    return await response.json() as DriveItem
  }

  /** Graph DELETE on OneDrive moves the item to the recycle bin. */
  async deleteItemToRecycleBin(options: {
    driveId: string
    itemId: string
    ifMatch?: string
    signal?: AbortSignal
  }): Promise<void> {
    const headers = new Headers()
    if (options.ifMatch) headers.set('If-Match', options.ifMatch)
    const response = await this.graphFetch(itemPath(options.driveId, options.itemId), {
      method: 'DELETE',
      headers,
      signal: options.signal,
    })
    if (!response.ok) {
      throw new CloudHttpError(response.status, `Delete item failed (${response.status}).`)
    }
  }

  async deleteItem(options: {
    driveId: string
    itemId: string
    ifMatch?: string
    signal?: AbortSignal
  }): Promise<void> {
    return this.deleteItemToRecycleBin(options)
  }
}

let instance: OneDriveClient | null = null

export function getOneDriveClient(): OneDriveClient {
  if (!instance) instance = new OneDriveClient()
  return instance
}
