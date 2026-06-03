// Library worker — runs as an Electron utilityProcess (a dedicated Node process)
// so the heavy, mostly-synchronous disk reading never blocks the main process
// event loop (which would freeze/blank the window).
//
// It is pure compute: NO database, NO Electron `app`, NO BrowserWindow. It only
// reads files and returns plain serializable data. The main process owns the DB
// and all renderer broadcasts. Keep this module's import graph free of anything
// that pulls in `electron`/the DB (see ArtworkCache's lazy require).

import type { MessagePortMain } from 'electron'
import { readTrackMetadata } from '../library/MetadataExtractor'
import { setArtworkDir } from '../library/ArtworkCache'
import { readEmbeddedLyrics } from '../lyrics/providers/EmbeddedLyricsProvider'
import { readSidecarLrc } from '../lyrics/providers/SidecarLrcProvider'
import { lyricsViewToIndexEntry, viewFromDiskReads } from '../lyrics/lyricsLibraryOverview'
import type { WorkerRequest, WorkerResponse } from './protocol'

// utilityProcess injects `parentPort` onto the global process. Node's own types
// don't know about it; the type-only `electron` import is erased at build time.
const parentPort = (process as unknown as { parentPort: MessagePortMain }).parentPort

// Bound concurrency for metadata parsing (music-metadata is async I/O bound).
// Mirrors ImportService's historical chunk size so throughput is unchanged.
const METADATA_CONCURRENCY = 8
// Yield the worker event loop periodically during long scans so queued messages
// (and progress) flush promptly.
const YIELD_EVERY = 25

function post(msg: WorkerResponse): void {
  parentPort.postMessage(msg)
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function handleParseMetadata(req: Extract<WorkerRequest, { kind: 'parseMetadata' }>): Promise<void> {
  const { id, files } = req
  const total = files.length
  for (let i = 0; i < total; i += METADATA_CONCURRENCY) {
    const chunk = files.slice(i, i + METADATA_CONCURRENCY)
    // Each task streams its own result as it resolves and never rejects, so
    // allSettled here is purely a chunk barrier for bounded concurrency.
    await Promise.allSettled(
      chunk.map(async file => {
        try {
          const md = await readTrackMetadata(file)
          post({ kind: 'metadataItem', id, path: file, md })
        } catch (err) {
          post({ kind: 'metadataItem', id, path: file, md: null, error: errMessage(err) })
        }
      }),
    )
    post({ kind: 'progress', id, done: Math.min(i + METADATA_CONCURRENCY, total), total })
  }
  post({ kind: 'done', id })
}

async function handleScanLyrics(req: Extract<WorkerRequest, { kind: 'scanLyrics' }>): Promise<void> {
  const { id, tracks } = req
  const total = tracks.length
  let done = 0
  for (const t of tracks) {
    let entry
    try {
      const sidecar = readSidecarLrc(t.path)
      const embedded = sidecar ? null : readEmbeddedLyrics(t.path)
      entry = lyricsViewToIndexEntry(viewFromDiskReads(t.trackId, sidecar, embedded))
    } catch {
      // A read failure resolves the track to an empty 'none' entry rather than
      // aborting the whole scan.
      entry = lyricsViewToIndexEntry(viewFromDiskReads(t.trackId, null, null))
    }
    post({ kind: 'lyricsItem', id, trackId: t.trackId, entry })
    if (++done % YIELD_EVERY === 0) {
      post({ kind: 'progress', id, done, total })
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  }
  post({ kind: 'done', id })
}

parentPort.on('message', (event: { data: WorkerRequest }) => {
  const req = event.data
  switch (req.kind) {
    case 'init':
      setArtworkDir(req.artworkDir)
      post({ kind: 'ready', id: req.id })
      return
    case 'parseMetadata':
      void handleParseMetadata(req).catch(err => post({ kind: 'error', id: req.id, message: errMessage(err) }))
      return
    case 'scanLyrics':
      void handleScanLyrics(req).catch(err => post({ kind: 'error', id: req.id, message: errMessage(err) }))
      return
  }
})

// Last-resort logging so a stray throw doesn't take the worker down silently.
process.on('uncaughtException', err => console.error('[library-worker] uncaughtException:', err))
process.on('unhandledRejection', reason => console.error('[library-worker] unhandledRejection:', reason))
