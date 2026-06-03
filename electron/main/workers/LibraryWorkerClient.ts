// Main-process client for the library worker (utilityProcess). Owns the worker's
// lifecycle and multiplexes request/response + streamed progress over the single
// built-in message channel (one peer, so MessageChannelMain isn't needed).
//
// Design notes:
// - Lazy spawn on first use; re-spawn on the next call after a crash.
// - Every heavy call degrades gracefully: on init timeout / crash / disabled the
//   returned promise rejects, and callers fall back to their in-main path.
// - The worker is DB-free; this client passes it only file paths and resolved
//   directories, and the main process does all DB writes from the streamed items.

import { app, utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TrackMetadata } from '../library/MetadataExtractor'
import type { LyricsIndexEntry } from '@shared/types/lyrics-index'
import type { LyricsScanTask, WorkerRequest, WorkerResponse } from './protocol'

// Bundled into out/main/index.js, so this resolves to out/main/ — the same dir
// the worker entry is emitted to (out/main/library-worker.js).
const dirname = fileURLToPath(new URL('.', import.meta.url))
const WORKER_PATH = join(dirname, 'library-worker.js')

const INIT_TIMEOUT_MS = 10_000
// After this many unexpected exits in a session, stop trying and let every
// caller fall back to the in-main path for the rest of the session.
const MAX_CRASHES = 3

interface Pending {
  resolve: () => void
  reject: (err: Error) => void
  onMessage: (msg: WorkerResponse) => void
}

export type MetadataItemHandler = (path: string, md: TrackMetadata | null, error?: string) => void
export type LyricsEntryHandler = (trackId: number, entry: LyricsIndexEntry) => void
export type ProgressHandler = (done: number, total: number) => void

class LibraryWorkerClient {
  private child: UtilityProcess | null = null
  private readyPromise: Promise<void> | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1
  private crashCount = 0
  private disposing = false

  // True once the worker has crashed too many times; callers should fall back.
  get disabled(): boolean {
    return this.crashCount >= MAX_CRASHES
  }

  // Parse music metadata for `files` off the main thread. Streams one item per
  // file (artwork already saved to disk by the worker) so the caller can write
  // each row to the DB as it arrives. Resolves when all files are processed.
  async parseMetadata(files: string[], onItem: MetadataItemHandler, onProgress?: ProgressHandler): Promise<void> {
    if (files.length === 0) return
    await this.send(
      id => ({ kind: 'parseMetadata', id, files }),
      msg => {
        if (msg.kind === 'metadataItem') onItem(msg.path, msg.md, msg.error)
        else if (msg.kind === 'progress') onProgress?.(msg.done, msg.total)
      },
    )
  }

  // Read lyrics presence (sidecar + embedded) for `tracks` off the main thread.
  async scanLyrics(tracks: LyricsScanTask[], onEntry: LyricsEntryHandler, onProgress?: ProgressHandler): Promise<void> {
    if (tracks.length === 0) return
    await this.send(
      id => ({ kind: 'scanLyrics', id, tracks }),
      msg => {
        if (msg.kind === 'lyricsItem') onEntry(msg.trackId, msg.entry)
        else if (msg.kind === 'progress') onProgress?.(msg.done, msg.total)
      },
    )
  }

  dispose(): void {
    this.disposing = true
    this.rejectAll(new Error('library worker disposed'))
    this.child?.kill()
    this.child = null
    this.readyPromise = null
  }

  // --- internals ----------------------------------------------------------

  private async send(build: (id: number) => WorkerRequest, onMessage: (msg: WorkerResponse) => void): Promise<void> {
    if (this.disabled) throw new Error('library worker disabled after repeated crashes')
    await this.ensureReady()
    const child = this.child
    if (!child) throw new Error('library worker is not running')
    const id = this.nextId++
    return new Promise<void>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onMessage })
      child.postMessage(build(id))
    })
  }

  private ensureReady(): Promise<void> {
    if (this.readyPromise) return this.readyPromise
    this.readyPromise = this.spawn()
    return this.readyPromise
  }

  private spawn(): Promise<void> {
    const child = utilityProcess.fork(WORKER_PATH, [], {
      serviceName: 'crate-library-worker',
      // Forward worker stdout/stderr to the main log; ignore stdin.
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    this.child = child
    this.disposing = false
    child.on('message', (msg: WorkerResponse) => this.dispatch(msg))
    child.on('exit', code => this.onExit(code))

    return new Promise<void>((resolve, reject) => {
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('library worker init timed out'))
      }, INIT_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: () => { clearTimeout(timer); resolve() },
        reject: err => { clearTimeout(timer); reject(err) },
        onMessage: () => {},
      })
      // Post init only once the child is up so the message isn't dropped.
      child.once('spawn', () => {
        child.postMessage({ kind: 'init', id, artworkDir: join(app.getPath('userData'), 'artwork') })
      })
    })
  }

  private dispatch(msg: WorkerResponse): void {
    const p = this.pending.get(msg.id)
    if (!p) return
    if (msg.kind === 'ready' || msg.kind === 'done') {
      this.pending.delete(msg.id)
      p.resolve()
    } else if (msg.kind === 'error') {
      this.pending.delete(msg.id)
      p.reject(new Error(msg.message))
    } else {
      p.onMessage(msg)
    }
  }

  private onExit(code: number | undefined): void {
    const wasDisposing = this.disposing
    this.child = null
    this.readyPromise = null
    this.rejectAll(new Error(`library worker exited (code ${code ?? 'unknown'})`))
    if (!wasDisposing) {
      this.crashCount += 1
      console.error(`[library-worker] exited unexpectedly (code ${code ?? 'unknown'}), crash #${this.crashCount}`)
    }
    this.disposing = false
  }

  private rejectAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }
}

let instance: LibraryWorkerClient | null = null
export function getLibraryWorkerClient(): LibraryWorkerClient {
  return (instance ??= new LibraryWorkerClient())
}
