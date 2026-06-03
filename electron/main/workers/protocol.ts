// Message protocol between the main process (LibraryWorkerClient) and the
// library worker (utilityProcess). Both peers are main-process bundles, so this
// lives under electron/main rather than shared/ — TrackMetadata is defined in
// main and a shared→main import would invert the dependency direction.
//
// Every payload must be structured-clone friendly (primitives, arrays, plain
// objects). Notably the artwork Buffer never crosses the channel: the worker
// saves it to disk and only the resulting filename (inside TrackMetadata) is
// returned.

import type { TrackMetadata } from '../library/MetadataExtractor'
import type { LyricsIndexEntry } from '@shared/types/lyrics-index'

export interface LyricsScanTask {
  trackId: number
  path: string
}

// main → worker. Each request carries a monotonic `id` the worker echoes back on
// every response so the client can multiplex concurrent requests over one channel.
export type WorkerRequest =
  | { kind: 'init'; id: number; artworkDir: string }
  | { kind: 'parseMetadata'; id: number; files: string[] }
  | { kind: 'scanLyrics'; id: number; tracks: LyricsScanTask[] }

// worker → main. A request produces zero or more streamed items + periodic
// progress, then exactly one terminal `done` (or `error`). `init` replies `ready`.
export type WorkerResponse =
  | { kind: 'ready'; id: number }
  | { kind: 'progress'; id: number; done: number; total: number }
  | { kind: 'metadataItem'; id: number; path: string; md: TrackMetadata | null; error?: string }
  | { kind: 'lyricsItem'; id: number; trackId: number; entry: LyricsIndexEntry }
  | { kind: 'done'; id: number }
  | { kind: 'error'; id: number; message: string }
