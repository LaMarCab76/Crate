import { getOneDriveAuth } from './OneDriveAuth'
import { PLAYBACK_MEMORY_READ_CHUNK_BYTES } from '../audio/progressiveBuffering'
import { downloadRangesIntoBuffer, type RangeResult } from './cloudRangeDownload'

// Thin Microsoft Graph client for OneDrive. Uses native fetch (the app already
// depends on it for Qobuz/Tidal). Auth bearer comes from OneDriveAuth; the
// preauthenticated download URL needs no auth header and is short-lived, so the
// streaming path refreshes it mid-download when it expires.

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'
const MAX_429_RETRIES = 5
const MAX_URL_REFRESHES = 3
// Files at or below this size use a single PUT; larger ones use a resumable
// upload session. Chunk size must be a multiple of 320 KiB (10 MiB = 32×320 KiB).
const SMALL_UPLOAD_LIMIT = 4 * 1024 * 1024
const UPLOAD_CHUNK_BYTES = 10 * 1024 * 1024

export interface UploadedItem {
  id: string
  name: string
  size: number
  etag: string | null
}

export interface CloudDownloadInfo {
  url: string
  size: number
  etag: string | null
}

// Subset of a Graph driveItem we care about for indexing.
export interface DriveItemAudioFacet {
  album?: string
  albumArtist?: string
  artist?: string
  bitrate?: number
  composers?: string
  disc?: number
  discCount?: number
  duration?: number // milliseconds
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
  file?: { mimeType?: string }
  folder?: { childCount?: number }
  audio?: DriveItemAudioFacet
  deleted?: { state?: string }
  parentReference?: { driveId?: string; id?: string; path?: string }
}

export class CloudHttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'CloudHttpError'
    this.status = status
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const id = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(id)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export class OneDriveClient {
  // Authenticated Graph request with bearer injection, 429 backoff (Retry-After)
  // and a single 401 retry after a forced token re-acquire.
  private async graphFetch(
    pathOrUrl: string,
    init: RequestInit = {},
    attempt = 0,
  ): Promise<Response> {
    const token = await getOneDriveAuth().getAccessToken()
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${GRAPH_BASE}${pathOrUrl}`
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token}`)
    const res = await fetch(url, { ...init, headers })

    if (res.status === 429 && attempt < MAX_429_RETRIES) {
      const retryAfter = Number(res.headers.get('Retry-After'))
      const waitMs = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2 ** attempt) * 1000
      await delay(waitMs, init.signal ?? undefined)
      return this.graphFetch(pathOrUrl, init, attempt + 1)
    }
    if (res.status === 401 && attempt < 1) {
      // MSAL may have handed us a token that the service already rejected; one
      // retry forces a fresh acquireTokenSilent on the next loop.
      return this.graphFetch(pathOrUrl, init, attempt + 1)
    }
    return res
  }

  private itemPath(driveId: string, itemId: string): string {
    return `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`
  }

  // Resolve the short-lived preauthenticated download URL plus size/etag.
  async getDownloadUrl(driveId: string, itemId: string, signal?: AbortSignal): Promise<CloudDownloadInfo> {
    const res = await this.graphFetch(
      `${this.itemPath(driveId, itemId)}?$select=id,size,eTag,@microsoft.graph.downloadUrl`,
      { signal },
    )
    if (!res.ok) {
      throw new CloudHttpError(res.status, `Graph item lookup failed (${res.status})`)
    }
    const json = (await res.json()) as Record<string, unknown>
    const url = json['@microsoft.graph.downloadUrl']
    if (typeof url !== 'string' || !url) {
      throw new Error('Item has no download URL (it may be a folder or unavailable offline).')
    }
    return {
      url,
      size: typeof json.size === 'number' ? json.size : Number(json.size) || 0,
      etag: typeof json.eTag === 'string' ? json.eTag : null,
    }
  }

  // Download a named child file of a folder as text (e.g. the library manifest).
  // Returns null if the file doesn't exist.
  async downloadChildText(
    driveId: string,
    parentItemId: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const res = await this.graphFetch(
      `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(parentItemId)}:/${encodeURIComponent(name)}?$select=id,@microsoft.graph.downloadUrl`,
      { signal },
    )
    if (res.status === 404) return null
    if (!res.ok) throw new CloudHttpError(res.status, `Manifest lookup failed (${res.status})`)
    const json = (await res.json()) as Record<string, unknown>
    const url = json['@microsoft.graph.downloadUrl']
    if (typeof url !== 'string') return null
    const dl = await fetch(url, { signal })
    if (!dl.ok) throw new CloudHttpError(dl.status, `Manifest download failed (${dl.status})`)
    return dl.text()
  }

  // Fetch the first `maxBytes` of a file into RAM (for header-only metadata
  // parsing). Never writes to disk. Returns the prefix plus the full file size.
  async fetchPrefix(
    driveId: string,
    itemId: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<{ buffer: Buffer; size: number }> {
    const info = await this.getDownloadUrl(driveId, itemId, signal)
    const total = info.size || maxBytes
    const end = Math.min(maxBytes, total) - 1
    const res = await fetch(info.url, { headers: { Range: `bytes=0-${end}` }, signal })
    if (res.status !== 206 && res.status !== 200) {
      throw new CloudHttpError(res.status, `Prefix fetch failed (${res.status})`)
    }
    return { buffer: Buffer.from(await res.arrayBuffer()), size: total }
  }

  // The signed-in user's default drive id (used as the root for folder browsing).
  async getDefaultDriveId(signal?: AbortSignal): Promise<string> {
    const res = await this.graphFetch('/me/drive?$select=id', { signal })
    if (!res.ok) throw new CloudHttpError(res.status, `Drive lookup failed (${res.status})`)
    const json = (await res.json()) as Record<string, unknown>
    if (typeof json.id !== 'string') throw new Error('Could not resolve the default OneDrive drive id.')
    return json.id
  }

  // List only the sub-folders of a drive item (for the folder picker). When
  // driveId/itemId are null, lists the default drive root. Paginates fully.
  async listChildFolders(driveId: string | null, itemId: string | null, signal?: AbortSignal): Promise<DriveItem[]> {
    const base = driveId ? `/drives/${encodeURIComponent(driveId)}` : '/me/drive'
    const node = itemId ? `/items/${encodeURIComponent(itemId)}` : '/root'
    let url: string = `${base}${node}/children?$select=id,name,folder,parentReference&$top=200`
    const out: DriveItem[] = []
    while (url) {
      const res = await this.graphFetch(url, { signal })
      if (!res.ok) throw new CloudHttpError(res.status, `List children failed (${res.status})`)
      const json = (await res.json()) as { value?: DriveItem[]; ['@odata.nextLink']?: string }
      for (const it of json.value ?? []) {
        if (it.folder) out.push(it)
      }
      url = json['@odata.nextLink'] ?? ''
    }
    return out
  }

  // Enumerate a folder hierarchy via the delta API. Pass a folder itemId for the
  // first sync, or a persisted @odata.deltaLink (full URL) for an incremental
  // one. Yields pages; the final page carries the new deltaLink to persist.
  async *listDelta(
    driveId: string,
    startItemIdOrLink: string,
    signal?: AbortSignal,
  ): AsyncGenerator<{ items: DriveItem[]; deltaLink: string | null }> {
    let url: string = startItemIdOrLink.startsWith('http')
      ? startItemIdOrLink
      : `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(startItemIdOrLink)}/delta`
    while (url) {
      const res = await this.graphFetch(url, { signal })
      if (!res.ok) throw new CloudHttpError(res.status, `Delta enumeration failed (${res.status})`)
      const json = (await res.json()) as {
        value?: DriveItem[]
        ['@odata.nextLink']?: string
        ['@odata.deltaLink']?: string
      }
      const deltaLink = json['@odata.deltaLink'] ?? null
      yield { items: json.value ?? [], deltaLink }
      url = json['@odata.nextLink'] ?? ''
    }
  }

  // Download the entire file into a preallocated RAM buffer using ranged GETs.
  // Never writes to disk. The pure download loop (cloudRangeDownload) handles
  // 429 backoff and expired-URL refresh mid-stream; here we just wire the real
  // fetch + Graph URL resolution into it.
  async fetchFullIntoBuffer(args: {
    driveId: string
    itemId: string
    sizeBytes: number
    buffer: Buffer
    signal?: AbortSignal
    onProgress?: (loadedBytes: number) => void
    initialUrl?: string
  }): Promise<void> {
    const { driveId, itemId, sizeBytes, buffer, signal, onProgress } = args
    await downloadRangesIntoBuffer({
      sizeBytes,
      buffer,
      signal,
      onProgress,
      initialUrl: args.initialUrl,
      deps: {
        chunkBytes: PLAYBACK_MEMORY_READ_CHUNK_BYTES,
        maxUrlRefreshes: MAX_URL_REFRESHES,
        resolveUrl: async sig => (await this.getDownloadUrl(driveId, itemId, sig)).url,
        delay: (ms, sig) => delay(ms, sig),
        fetchRange: async (url, start, endInclusive, sig): Promise<RangeResult> => {
          // The preauthenticated download URL needs no auth header.
          const res = await fetch(url, { headers: { Range: `bytes=${start}-${endInclusive}` }, signal: sig })
          const retryAfter = Number(res.headers.get('Retry-After'))
          const retryAfterSec = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null
          // Only read the body for the statuses the loop will actually copy.
          const body = res.status === 206 || res.status === 200
            ? new Uint8Array(await res.arrayBuffer())
            : null
          return { status: res.status, body, retryAfterSec }
        },
      },
    })
  }

  // Upload a local file's bytes to a OneDrive folder. Picks a simple PUT for small
  // files and a resumable upload session (320 KiB-multiple chunks) for large ones.
  async uploadFile(args: {
    driveId: string
    parentItemId: string
    filename: string
    buffer: Buffer
    signal?: AbortSignal
    onProgress?: (uploadedBytes: number, totalBytes: number) => void
  }): Promise<UploadedItem> {
    if (args.buffer.byteLength <= SMALL_UPLOAD_LIMIT) {
      return this.uploadSmall(args)
    }
    return this.uploadLarge(args)
  }

  private uploadContentPath(driveId: string, parentItemId: string, filename: string, suffix: string): string {
    return `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(parentItemId)}:/${encodeURIComponent(filename)}:/${suffix}`
  }

  private async uploadSmall(args: {
    driveId: string
    parentItemId: string
    filename: string
    buffer: Buffer
    signal?: AbortSignal
    onProgress?: (uploadedBytes: number, totalBytes: number) => void
  }): Promise<UploadedItem> {
    const res = await this.graphFetch(
      this.uploadContentPath(args.driveId, args.parentItemId, args.filename, 'content'),
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: args.buffer,
        signal: args.signal,
      },
    )
    if (!res.ok) throw new CloudHttpError(res.status, `Upload failed (${res.status})`)
    const json = (await res.json()) as Record<string, unknown>
    args.onProgress?.(args.buffer.byteLength, args.buffer.byteLength)
    return toUploadedItem(json)
  }

  private async uploadLarge(args: {
    driveId: string
    parentItemId: string
    filename: string
    buffer: Buffer
    signal?: AbortSignal
    onProgress?: (uploadedBytes: number, totalBytes: number) => void
  }): Promise<UploadedItem> {
    const { buffer, signal, onProgress } = args
    const sessionRes = await this.graphFetch(
      this.uploadContentPath(args.driveId, args.parentItemId, args.filename, 'createUploadSession'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename', name: args.filename } }),
        signal,
      },
    )
    if (!sessionRes.ok) throw new CloudHttpError(sessionRes.status, `createUploadSession failed (${sessionRes.status})`)
    const session = (await sessionRes.json()) as { uploadUrl?: string }
    if (!session.uploadUrl) throw new Error('No upload URL returned from createUploadSession.')

    const total = buffer.byteLength
    let offset = 0
    let finalItem: Record<string, unknown> | null = null

    while (offset < total) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const end = Math.min(offset + UPLOAD_CHUNK_BYTES, total)
      const chunk = buffer.subarray(offset, end)
      // The upload session URL is preauthenticated — no Authorization header.
      const res = await fetch(session.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Range': `bytes ${offset}-${end - 1}/${total}` },
        body: chunk,
        signal,
      })

      if (res.status === 202) {
        offset = end
        onProgress?.(offset, total)
        continue
      }
      if (res.status === 200 || res.status === 201) {
        finalItem = (await res.json()) as Record<string, unknown>
        offset = end
        onProgress?.(offset, total)
        break
      }
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('Retry-After'))
        await delay((Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2) * 1000, signal)
        continue // retry the same range
      }
      throw new CloudHttpError(res.status, `Chunk upload failed (${res.status})`)
    }

    if (!finalItem) throw new Error('Upload did not complete with a final driveItem.')
    return toUploadedItem(finalItem)
  }
}

function toUploadedItem(json: Record<string, unknown>): UploadedItem {
  if (typeof json.id !== 'string') throw new Error('Upload response had no item id.')
  return {
    id: json.id,
    name: typeof json.name === 'string' ? json.name : '',
    size: typeof json.size === 'number' ? json.size : Number(json.size) || 0,
    etag: typeof json.eTag === 'string' ? json.eTag : (typeof json.cTag === 'string' ? json.cTag : null),
  }
}

let instance: OneDriveClient | null = null
export function getOneDriveClient(): OneDriveClient {
  if (!instance) instance = new OneDriveClient()
  return instance
}
