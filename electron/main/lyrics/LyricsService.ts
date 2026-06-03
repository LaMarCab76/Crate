import { dialog } from 'electron'
import { writeFileSync } from 'node:fs'
import { getRepos, type Repos } from '../db/repositories'
import { broadcast } from '../ipc/events'
import type { DbTrack } from '@shared/types/db'
import type { LyricsIndexEntry } from '@shared/types/lyrics-index'
import type {
  LyricsCandidate,
  LyricsLibraryOverview,
  LyricsSource,
  LyricsView,
  LyricsSelectionSummary,
} from '@shared/types/lyrics'
import { isSyncedLrc, setLrcOffset } from '@shared/lyrics/lrc'
import {
  ACCEPT_AUTO,
  ACCEPT_REVIEW,
  isExactDurationCompatible,
  scoreCandidate,
  toConfidence,
} from './LyricsMatcher'
import { getLyricsLookupQueue, type LyricsLookupQueue } from './LyricsLookupQueue'
import {
  buildOverviewWithIndex,
  emptyLyricsView as emptyView,
  viewFromDiskReads,
  viewFromLyricsResult as viewFromResult,
} from './lyricsLibraryOverview'
import { getLibraryWorkerClient } from '../workers/LibraryWorkerClient'
import { getLyricsIndexService } from './LyricsIndexService'
import { LrclibProvider, type LrclibQuery, type LrclibRaw } from './providers/LrclibProvider'
import { readEmbeddedLyrics } from './providers/EmbeddedLyricsProvider'
import { readSidecarLrc } from './providers/SidecarLrcProvider'
import { writeSidecarLrc, removeSidecarLrc } from './writers/SidecarLrcWriter'

const NOT_FOUND_TTL_MS = 7 * 24 * 60 * 60 * 1000

function userView(trackId: number, plain: string | null, synced: string | null, sidecarWritten: boolean): LyricsView {
  return {
    trackId,
    status: synced ? 'found_synced' : 'found_plain',
    source: 'user',
    plainLyrics: plain,
    syncedLyricsLrc: synced,
    instrumental: false,
    isUserEdited: true,
    embeddedInFile: false,
    sidecarWritten,
    confidence: 1,
  }
}

function trackToQuery(t: DbTrack): LrclibQuery {
  return {
    title: t.title,
    artist: t.artist,
    album: t.album && t.album !== 'Unknown Album' ? t.album : null,
    durationSeconds: t.duration > 0 ? Math.round(t.duration) : null,
  }
}

function rawScore(track: DbTrack, raw: LrclibRaw): number {
  return scoreCandidate({
    fileTitle: track.title,
    fileArtist: track.artist,
    fileAlbum: track.album && track.album !== 'Unknown Album' ? track.album : null,
    fileDuration: track.duration > 0 ? track.duration : null,
    candTitle: raw.trackName,
    candArtist: raw.artistName,
    candAlbum: raw.albumName,
    candDuration: raw.duration,
  })
}

export class LyricsService {
  private repos: Repos
  private lrclib = new LrclibProvider()
  private index = getLyricsIndexService()
  private lookupQueue: LyricsLookupQueue = getLyricsLookupQueue()
  private searchCache = new Map<number, { createdAt: number; results: LrclibRaw[] }>()

  // Session-only memory of tracks LRCLIB had no usable match for, so repeated
  // plays / sync passes don't re-hit the network. Replaces the persistent
  // `lyrics_failures` TTL now that lyrics state lives only on disk. Resets on
  // restart — a not-found track may be queried once more after relaunch.
  private notFound = new Map<number, number>() // trackId -> epoch ms of last miss

  constructor() {
    this.repos = getRepos()
  }

  nextLookupAllowedAt(): number | null {
    return this.lookupQueue.nextAllowedAt()
  }

  // --- read-only resolution (no network) ---------------------------------

  getForTrack(trackId: number): LyricsView {
    const track = this.repos.tracks.getById(trackId)
    if (!track) return emptyView(trackId, 'none')

    // Sidecar is the source of truth; embedded tags are a secondary read source.
    // Shared with the library worker via viewFromDiskReads so both paths agree.
    const sidecar = readSidecarLrc(track.path)
    const embedded = sidecar ? null : readEmbeddedLyrics(track.path)
    const view = viewFromDiskReads(trackId, sidecar, embedded)
    if (view.status !== 'none') return view

    if (this.notFound.has(trackId)) return emptyView(trackId, 'not_found')
    return view
  }

  // Build the library-wide lyrics overview. Reads from the per-folder lyrics
  // index where possible (no disk I/O) and only scans `.lrc`/embedded tags for
  // tracks the index doesn't yet know. The scan is chunked and yields the event
  // loop so a cold/forced build keeps the app responsive instead of freezing the
  // main process. `force` ignores the cache and rescans everything, reconciling
  // sidecars added/removed outside the app.
  async libraryOverview(opts?: { force?: boolean }): Promise<LyricsLibraryOverview> {
    const force = opts?.force === true
    const tracks = this.repos.tracks.getAll({ orderBy: 'artist' })

    const folderPaths = new Map<number, string | null>()
    const folderPathFor = (folderId: number): string | null => {
      const cached = folderPaths.get(folderId)
      if (cached !== undefined) return cached
      const folder = this.repos.folders.getById(folderId)
      const path = folder?.path ?? null
      folderPaths.set(folderId, path)
      return path
    }

    const lookup = (track: DbTrack): LyricsIndexEntry | null => {
      const path = folderPathFor(track.folder_id)
      return path ? this.index.lookup(track.folder_id, path, track.path) : null
    }
    const persistEntry = (track: DbTrack, entry: LyricsIndexEntry): void => {
      const path = folderPathFor(track.folder_id)
      if (path) this.index.set(track.folder_id, path, track.path, entry)
    }

    if (force) {
      // Drop each affected folder's entries first so tracks removed from the
      // library since the last scan are pruned, then repopulate via the scan.
      for (const folderId of new Set(tracks.map(t => t.folder_id))) {
        const path = folderPathFor(folderId)
        if (path) this.index.clearFolder(folderId, path)
      }
    }

    // The heavy work — reading every `.lrc` sidecar and opening every audio file
    // for embedded tags — runs in the library worker (utilityProcess) so the main
    // process never freezes. We pre-scan only the tracks the index can't resolve,
    // populate the index from the streamed results, then build the overview from
    // cache hits. On worker failure we fall back to the in-main scan below.
    const toScan = force ? tracks : tracks.filter(track => !lookup(track))
    try {
      if (toScan.length > 0) {
        const trackById = new Map(tracks.map(t => [t.id, t] as const))
        const total = toScan.length
        await getLibraryWorkerClient().scanLyrics(
          toScan.map(track => ({ trackId: track.id, path: track.path })),
          (trackId, entry) => {
            const track = trackById.get(trackId)
            if (track) persistEntry(track, entry)
          },
          (done, t) => broadcast('lyrics:library:progress', { done, total: t }),
        )
        broadcast('lyrics:library:progress', { done: total, total })
      }
      // The index now resolves every scanned track, so force=false and the
      // builder reads from cache. `scan` is only a safety net for tracks with no
      // folder path (which can't be cached); it never opens audio at scale here.
      return await buildOverviewWithIndex(tracks, {
        force: false,
        lookup,
        scan: track => this.getForTrack(track.id),
        onScanned: persistEntry,
      })
    } catch (err) {
      console.warn(
        `[lyrics] library worker scan failed, using in-main path: ${err instanceof Error ? err.message : String(err)}`,
      )
      return buildOverviewWithIndex(tracks, {
        force,
        lookup,
        scan: track => this.getForTrack(track.id),
        onScanned: persistEntry,
        onProgress: (done, total) => broadcast('lyrics:library:progress', { done, total }),
      })
    }
  }

  // --- online fetch (auto-accept) ----------------------------------------

  async fetchOnline(trackId: number, opts?: { force?: boolean }): Promise<LyricsView> {
    const track = this.repos.tracks.getById(trackId)
    if (!track) return emptyView(trackId, 'none')

    // Local lyrics mean the track is resolved — never hit the
    // network for it unless the user explicitly forces a re-fetch.
    if (!opts?.force) {
      const sidecar = readSidecarLrc(track.path)
      if (sidecar) return viewFromResult(trackId, sidecar, { sidecarWritten: true, embeddedInFile: false })
      const embedded = readEmbeddedLyrics(track.path)
      if (embedded) return viewFromResult(trackId, embedded, { sidecarWritten: false, embeddedInFile: true })
    }

    if (!track.title.trim() || !track.artist.trim()) {
      this.notFound.set(trackId, Date.now())
      return emptyView(trackId, 'not_found')
    }

    if (!opts?.force) {
      const lastMiss = this.notFound.get(trackId)
      if (lastMiss != null && Date.now() - lastMiss < NOT_FOUND_TTL_MS) {
        return emptyView(trackId, 'not_found')
      }
    }

    return this.lookupQueue.enqueue(() => this.fetchOnlineFromProvider(track, opts))
  }

  private async fetchOnlineFromProvider(track: DbTrack, opts?: { force?: boolean }): Promise<LyricsView> {
    const trackId = track.id
    const query = trackToQuery(track)
    try {
      let chosen: LrclibRaw | null = null
      let confidence = 0

      const exact = await this.lrclib.getExact(query)
      if (exact) {
        const score = rawScore(track, exact)
        if (score >= ACCEPT_AUTO || isExactDurationCompatible(query.durationSeconds ?? null, exact.duration)) {
          chosen = exact
          confidence = Math.max(toConfidence(score), 0.9)
        }
      }

      if (!chosen) {
        const results = await this.lrclib.search(query)
        if (results.length > 0) {
          this.rememberSearchResults(track.id, results)
          const ranked = results
            .map(raw => ({ raw, score: rawScore(track, raw) }))
            .sort((a, b) => b.score - a.score)
          const best = ranked[0]
          if (best.score >= ACCEPT_AUTO) {
            chosen = best.raw
            confidence = toConfidence(best.score)
          } else if (best.score >= ACCEPT_REVIEW) {
            // Ambiguous: don't auto-import; surface for manual review.
            return emptyView(trackId, 'low_confidence')
          }
        }
      }

      if (!chosen) {
        this.notFound.set(trackId, Date.now())
        return emptyView(trackId, 'not_found')
      }

      return this.persistChosen(track, chosen, confidence)
    } catch {
      // Provider timeout / rate-limit. Not remembered as not-found, so a later
      // attempt can still succeed.
      return emptyView(trackId, 'failed_provider')
    }
  }

  // --- explicit online search (chooser) ----------------------------------

  async searchOnline(trackId: number): Promise<LyricsCandidate[]> {
    const track = this.repos.tracks.getById(trackId)
    if (!track || !track.title.trim() || !track.artist.trim()) return []
    let results: LrclibRaw[]
    try {
      results = await this.lookupQueue.enqueue(() => this.lrclib.search(trackToQuery(track)))
      this.rememberSearchResults(trackId, results)
    } catch {
      return []
    }
    return results
      .map(raw => ({
        id: String(raw.id),
        trackName: raw.trackName,
        artistName: raw.artistName,
        albumName: raw.albumName,
        durationSeconds: raw.duration,
        instrumental: raw.instrumental,
        hasSynced: Boolean(raw.syncedLyrics),
        hasPlain: Boolean(raw.plainLyrics),
        score: rawScore(track, raw),
      }))
      .sort((a, b) => b.score - a.score)
  }

  async importCandidate(trackId: number, lrclibId: string): Promise<LyricsView> {
    const track = this.repos.tracks.getById(trackId)
    if (!track) return emptyView(trackId, 'none')
    let raw: LrclibRaw | null
    try {
      raw = this.cachedSearchResult(trackId, lrclibId)
        ?? await this.lookupQueue.enqueue(() => this.lrclib.getById(lrclibId))
    } catch {
      return emptyView(trackId, 'failed_provider')
    }
    if (!raw) return emptyView(trackId, 'not_found')
    return this.persistChosen(track, raw, toConfidence(rawScore(track, raw)))
  }

  // --- user import / edit -------------------------------------------------

  importLrcText(trackId: number, lrcText: string): LyricsView {
    const track = this.repos.tracks.getById(trackId)
    if (!track) return emptyView(trackId, 'none')
    const synced = isSyncedLrc(lrcText)
    const written = this.writeSidecar(track, lrcText, 'user')
    this.notFound.delete(trackId)
    return userView(trackId, synced ? null : lrcText, synced ? lrcText : null, written)
  }

  saveUserEdit(trackId: number, plain: string | null, synced: string | null): LyricsView {
    const track = this.repos.tracks.getById(trackId)
    if (!track) return emptyView(trackId, 'none')
    const content = synced ?? plain
    if (!content) {
      // Empty save clears the lyrics: remove the assigned sidecar file.
      removeSidecarLrc(track.path)
      this.index.removeEntryForTrack(track)
      return emptyView(trackId, 'none')
    }
    const written = this.writeSidecar(track, content, 'user')
    this.notFound.delete(trackId)
    return userView(trackId, plain, synced, written)
  }

  setOffset(trackId: number, offsetMs: number): LyricsView {
    const track = this.repos.tracks.getById(trackId)
    if (!track) return emptyView(trackId, 'none')
    const current = readSidecarLrc(track.path) ?? readEmbeddedLyrics(track.path)
    const synced = current?.syncedLyricsLrc ?? null
    if (!synced || !isSyncedLrc(synced)) {
      throw new Error('Synced lyrics are required to set an offset.')
    }
    const shifted = setLrcOffset(synced, offsetMs)
    const written = this.writeSidecar(track, shifted, 'user')
    return userView(trackId, current?.plainLyrics ?? null, shifted, written)
  }

  async exportLrc(trackId: number): Promise<{ canceled: boolean; path: string | null }> {
    const track = this.repos.tracks.getById(trackId)
    if (!track) return { canceled: true, path: null }
    const res = readSidecarLrc(track.path) ?? readEmbeddedLyrics(track.path)
    const content = res?.syncedLyricsLrc ?? res?.plainLyrics ?? null
    if (!content) return { canceled: true, path: null }

    const safe = `${track.title} - ${track.artist}`.replace(/[\\/:*?"<>|]/g, '-')
    const result = await dialog.showSaveDialog({
      title: 'Export lyrics',
      defaultPath: `${safe}.lrc`,
      filters: [{ name: 'LRC', extensions: ['lrc'] }],
    })
    if (result.canceled || !result.filePath) return { canceled: true, path: null }
    writeFileSync(result.filePath, content, 'utf8')
    return { canceled: false, path: result.filePath }
  }

  remove(trackId: number): void {
    const track = this.repos.tracks.getById(trackId)
    if (track) {
      removeSidecarLrc(track.path)
      this.index.removeEntryForTrack(track)
    }
    this.notFound.delete(trackId)
  }

  // --- bounded selection fetch -------------------------------------------

  async fetchForSelection(trackIds: number[]): Promise<LyricsSelectionSummary> {
    const total = trackIds.length
    let done = 0
    let found = 0
    let failed = 0
    for (const id of trackIds) {
      const track = this.repos.tracks.getById(id)
      const currentView = this.getForTrack(id)
      const alreadyResolved =
        currentView.status === 'found_synced' ||
        currentView.status === 'found_plain' ||
        currentView.status === 'instrumental'
      const nextAllowedAt = alreadyResolved ? null : this.nextLookupAllowedAt()
      broadcast('lyrics:selection:progress', {
        done,
        total,
        found,
        failed,
        phase: nextAllowedAt != null && nextAllowedAt > Date.now() ? 'waiting' : 'queued',
        currentTrackId: id,
        currentTitle: track?.title,
        nextAllowedAt,
      })
      try {
        const view = await this.fetchOnline(id)
        if (view.status === 'found_synced' || view.status === 'found_plain' || view.status === 'instrumental') {
          found++
        } else if (view.status === 'failed_provider') {
          failed++
        }
        broadcast('lyrics:changed', { trackId: id })
      } catch {
        failed++
      }
      done++
      broadcast('lyrics:selection:progress', {
        done,
        total,
        found,
        failed,
        phase: done >= total ? 'complete' : 'fetching',
        currentTrackId: id,
        currentTitle: track?.title,
        nextAllowedAt: this.nextLookupAllowedAt(),
      })
    }
    return { done, found, failed }
  }

  // --- internals ----------------------------------------------------------

  private persistChosen(track: DbTrack, raw: LrclibRaw, confidence: number): LyricsView {
    const instrumental = raw.instrumental
    const plain = instrumental ? null : raw.plainLyrics ?? null
    const synced = instrumental ? null : raw.syncedLyrics ?? null
    const content = synced ?? plain
    const written = content ? this.writeSidecar(track, content, 'lrclib') : false
    this.notFound.delete(track.id)

    return {
      trackId: track.id,
      status: instrumental ? 'instrumental' : synced ? 'found_synced' : plain ? 'found_plain' : 'not_found',
      source: 'lrclib' as LyricsSource,
      plainLyrics: plain,
      syncedLyricsLrc: synced,
      instrumental,
      isUserEdited: false,
      embeddedInFile: false,
      sidecarWritten: written,
      confidence,
    }
  }

  // Write the `.lrc` sidecar next to the audio file. The sidecar is the canonical
  // store, so this always overwrites. Returns whether the write succeeded. On
  // success the per-folder lyrics index entry is refreshed (best-effort) so the
  // library overview stays accurate without a disk rescan.
  private writeSidecar(track: DbTrack, content: string, source: LyricsSource = 'sidecar'): boolean {
    try {
      writeSidecarLrc(track.path, content)
    } catch {
      return false
    }
    try {
      this.index.setForTrack(track, {
        status: isSyncedLrc(content) ? 'found_synced' : 'found_plain',
        source,
        hasLyrics: true,
        embeddedInFile: false,
        sidecarWritten: true,
      })
    } catch {
      /* index is a best-effort cache; never fail the write because of it */
    }
    return true
  }

  private rememberSearchResults(trackId: number, results: LrclibRaw[]): void {
    this.searchCache.set(trackId, { createdAt: Date.now(), results })
  }

  private cachedSearchResult(trackId: number, lrclibId: string): LrclibRaw | null {
    const cached = this.searchCache.get(trackId)
    if (!cached) return null
    if (Date.now() - cached.createdAt > 10 * 60 * 1000) {
      this.searchCache.delete(trackId)
      return null
    }
    return cached.results.find(raw => String(raw.id) === lrclibId) ?? null
  }
}

let instance: LyricsService | null = null

export function getLyricsService(): LyricsService {
  if (!instance) instance = new LyricsService()
  return instance
}
