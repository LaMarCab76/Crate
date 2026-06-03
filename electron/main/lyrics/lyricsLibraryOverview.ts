import type { DbTrack } from '@shared/types/db'
import type {
  LyricsLibraryItem,
  LyricsLibraryOverview,
  LyricsResult,
  LyricsStatus,
  LyricsView,
} from '@shared/types/lyrics'
import type { LyricsIndexEntry } from '@shared/types/lyrics-index'

// --- pure view construction ---------------------------------------------------
// These build a LyricsView from on-disk reads without any fs/DB access, so the
// library worker (utilityProcess) and LyricsService share one derivation and can
// never disagree on how a sidecar/embedded read maps to a status. The actual
// disk reads (readSidecarLrc / readEmbeddedLyrics) happen in the caller.

export function emptyLyricsView(trackId: number, status: LyricsStatus): LyricsView {
  return {
    trackId,
    status,
    source: null,
    plainLyrics: null,
    syncedLyricsLrc: null,
    instrumental: false,
    isUserEdited: false,
    embeddedInFile: false,
    sidecarWritten: false,
    confidence: 0,
  }
}

// Build the renderer-facing view from a single on-disk read (a sidecar `.lrc` or
// an embedded tag read). `isUserEdited` / `low_confidence` are not persisted — a
// freshly written sidecar simply reads back as found_synced / found_plain.
export function viewFromLyricsResult(
  trackId: number,
  res: LyricsResult,
  flags: { sidecarWritten: boolean; embeddedInFile: boolean },
): LyricsView {
  const synced = res.syncedLyricsLrc ?? null
  const plain = res.plainLyrics ?? null
  let status: LyricsStatus
  if (res.instrumental) status = 'instrumental'
  else if (synced) status = 'found_synced'
  else if (plain) status = 'found_plain'
  else status = 'none'

  return {
    trackId,
    status,
    source: res.source,
    plainLyrics: plain,
    syncedLyricsLrc: synced,
    instrumental: res.instrumental,
    isUserEdited: false,
    embeddedInFile: flags.embeddedInFile,
    sidecarWritten: flags.sidecarWritten,
    confidence: res.confidence,
  }
}

// Resolve the two disk reads into a view, applying the sidecar-over-embedded
// precedence. Returns a 'none' view when neither read produced lyrics; callers
// that track session-only not_found state overlay it themselves.
export function viewFromDiskReads(
  trackId: number,
  sidecar: LyricsResult | null,
  embedded: LyricsResult | null,
): LyricsView {
  if (sidecar) return viewFromLyricsResult(trackId, sidecar, { sidecarWritten: true, embeddedInFile: false })
  if (embedded) return viewFromLyricsResult(trackId, embedded, { sidecarWritten: false, embeddedInFile: true })
  return emptyLyricsView(trackId, 'none')
}

export function lyricsViewHasLibraryLyrics(view: LyricsView): boolean {
  return (
    view.status === 'found_synced' ||
    view.status === 'found_plain' ||
    view.status === 'instrumental'
  )
}

export function toLyricsLibraryItem(track: DbTrack, view: LyricsView): LyricsLibraryItem {
  return {
    trackId: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    duration: track.duration,
    path: track.path,
    status: view.status,
    source: view.source,
    hasLyrics: lyricsViewHasLibraryLyrics(view),
    sidecarWritten: view.sidecarWritten,
    embeddedInFile: view.embeddedInFile,
  }
}

export function buildLyricsLibraryOverview(
  tracks: DbTrack[],
  resolveView: (trackId: number) => LyricsView,
): LyricsLibraryOverview {
  const items = tracks
    .map(track => toLyricsLibraryItem(track, resolveView(track.id)))
    .sort((a, b) => {
      const artist = a.artist.localeCompare(b.artist, undefined, { sensitivity: 'base' })
      if (artist !== 0) return artist
      const album = a.album.localeCompare(b.album, undefined, { sensitivity: 'base' })
      if (album !== 0) return album
      return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
    })
  const withLyrics = items.filter(item => item.hasLyrics).length
  return {
    total: items.length,
    withLyrics,
    missingLyrics: items.length - withLyrics,
    items,
  }
}

// --- per-folder index mapping -------------------------------------------------
// Pure projection between the authoritative LyricsView and the compact entry the
// lyrics index caches on disk, plus an index-driven overview build. Kept here
// (next to buildLyricsLibraryOverview) so the whole module stays free of fs/DB
// access and unit-testable in isolation.

// Project a full view down to the cached subset the overview needs.
export function lyricsViewToIndexEntry(view: LyricsView): LyricsIndexEntry {
  return {
    status: view.status,
    source: view.source,
    hasLyrics: lyricsViewHasLibraryLyrics(view),
    embeddedInFile: view.embeddedInFile,
    sidecarWritten: view.sidecarWritten,
  }
}

// Reconstruct a synthetic view from a cached entry. Only the fields
// toLyricsLibraryItem reads are meaningful; lyrics text/confidence are unknown
// from the index alone and default to neutral values (the overview never shows
// them).
export function lyricsIndexEntryToView(trackId: number, entry: LyricsIndexEntry): LyricsView {
  return {
    trackId,
    status: entry.status,
    source: entry.source,
    plainLyrics: null,
    syncedLyricsLrc: null,
    instrumental: entry.status === 'instrumental',
    isUserEdited: false,
    embeddedInFile: entry.embeddedInFile,
    sidecarWritten: entry.sidecarWritten,
    confidence: 0,
  }
}

export interface OverviewIndexResolver {
  // Cached entry for a track, or null when the index has no record of it.
  lookup: (track: DbTrack) => LyricsIndexEntry | null
  // Slow path: read the track's lyrics state from disk (sidecar / embedded).
  // This opens the audio file for embedded tags, so it is expensive at scale —
  // hence the chunked yielding below.
  scan: (track: DbTrack) => LyricsView
  // Invoked whenever a track had to be scanned, so the caller can populate the
  // index with the freshly derived entry.
  onScanned?: (track: DbTrack, entry: LyricsIndexEntry) => void
  // Periodic progress while disk scanning (only fires when scans happen, i.e.
  // first build / force). `done` counts tracks processed, `total` is the library
  // size. A final (total, total) is emitted once if any scan ran.
  onProgress?: (done: number, total: number) => void
  // When true, ignore the cache and rescan every track (reconciles external
  // .lrc changes).
  force?: boolean
  // Disk scans to run before yielding the event loop, so the main process stays
  // responsive (audio/IPC) during a cold build. Default 25.
  yieldEvery?: number
}

// Build the library overview, reading from the index where possible and falling
// back to a per-track disk scan only for tracks the index doesn't know (or all
// tracks when `force`). Async + chunked: cache hits are instant, but disk scans
// yield to the event loop every `yieldEvery` tracks so a cold/forced build never
// freezes the main process. Reuses buildLyricsLibraryOverview for sorting/
// counting so the output shape is identical to the legacy all-disk path.
export async function buildOverviewWithIndex(
  tracks: DbTrack[],
  resolver: OverviewIndexResolver,
): Promise<LyricsLibraryOverview> {
  const views = new Map<number, LyricsView>()
  const yieldEvery = resolver.yieldEvery ?? 25
  const total = tracks.length
  let scansSinceYield = 0
  let scannedAny = false

  for (let i = 0; i < total; i++) {
    const track = tracks[i]
    const cached = resolver.force ? null : resolver.lookup(track)
    if (cached) {
      views.set(track.id, lyricsIndexEntryToView(track.id, cached))
      continue
    }
    const view = resolver.scan(track)
    views.set(track.id, view)
    resolver.onScanned?.(track, lyricsViewToIndexEntry(view))
    scannedAny = true
    if (++scansSinceYield >= yieldEvery) {
      scansSinceYield = 0
      resolver.onProgress?.(i + 1, total)
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  }
  if (scannedAny) resolver.onProgress?.(total, total)

  return buildLyricsLibraryOverview(tracks, trackId =>
    views.get(trackId) ?? lyricsIndexEntryToView(trackId, EMPTY_INDEX_ENTRY),
  )
}

const EMPTY_INDEX_ENTRY: LyricsIndexEntry = {
  status: 'none',
  source: null,
  hasLyrics: false,
  embeddedInFile: false,
  sidecarWritten: false,
}
