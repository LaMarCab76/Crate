// Per-folder lyrics presence index. Mirrors LibraryBackup's on-disk machinery
// (atomic writes, debounced per-folder flush, read-only/unmounted tolerance) but
// for a derived performance cache rather than user data.
//
// Why: the lyrics library overview used to read every `.lrc` sidecar — and open
// every audio file for embedded tags — on each open. This service caches the
// resolved per-track state in `.crate/lyrics-index.json` inside each folder, so
// the overview becomes a near-instant in-memory join. The cache is authoritative
// only as a cache: if it's deleted or stale-versioned it is rebuilt from disk.
//
// Source of truth is the in-memory `cache`, mutated incrementally by set/remove
// as lyrics change; doWrite just serializes it (no folder rescan per write).

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, relative, sep } from 'node:path'
import { getRepos, type Repos } from '../db/repositories'
import { isLibraryLocationMigrationLocked } from '../library-migration/locationLocks'
import type { DbTrack } from '@shared/types/db'
import type { LyricsIndexEntry, LyricsIndexFile } from '@shared/types/lyrics-index'
import {
  LYRICS_INDEX_DIRNAME,
  LYRICS_INDEX_FILENAME,
  LYRICS_INDEX_VERSION,
} from '@shared/types/lyrics-index'

const DEBOUNCE_MS = 2000
const APP_NAME = 'Crate'

function toPosixRelative(folderPath: string, absPath: string): string {
  return relative(folderPath, absPath).split(sep).join('/')
}

function indexPathForFolder(folderPath: string): string {
  return join(folderPath, LYRICS_INDEX_DIRNAME, LYRICS_INDEX_FILENAME)
}

function writeJsonAtomic(target: string, payload: LyricsIndexFile): void {
  const tmp = `${target}.tmp-${randomUUID()}`
  mkdirSync(dirname(target), { recursive: true })
  try {
    writeFileSync(tmp, JSON.stringify(payload), { encoding: 'utf8', flag: 'wx' })
    renameSync(tmp, target)
  } finally {
    rmSync(tmp, { force: true })
  }
}

function entriesEqual(a: LyricsIndexEntry, b: LyricsIndexEntry): boolean {
  return (
    a.status === b.status &&
    a.source === b.source &&
    a.hasLyrics === b.hasLyrics &&
    a.embeddedInFile === b.embeddedInFile &&
    a.sidecarWritten === b.sidecarWritten
  )
}

class LyricsIndexService {
  private cache = new Map<number, LyricsIndexFile>()
  private timers = new Map<number, NodeJS.Timeout>()

  private get repos(): Repos {
    return getRepos()
  }

  // ----- READ -----

  // Lazily load (and cache) a folder's index. Missing file, unreadable file, or
  // a stale schema version all yield a fresh empty index, which forces a rebuild
  // on the next overview.
  private loadFolder(folderId: number, folderPath: string): LyricsIndexFile {
    const cached = this.cache.get(folderId)
    if (cached) return cached
    const fresh = this.readFromDisk(folderPath) ?? this.freshFile()
    this.cache.set(folderId, fresh)
    return fresh
  }

  private readFromDisk(folderPath: string): LyricsIndexFile | null {
    const target = indexPathForFolder(folderPath)
    if (!existsSync(target)) return null
    try {
      const parsed = JSON.parse(readFileSync(target, 'utf8')) as LyricsIndexFile
      if (parsed.version !== LYRICS_INDEX_VERSION) return null
      if (!parsed.entries || typeof parsed.entries !== 'object') return null
      return parsed
    } catch (err) {
      console.warn(`[lyrics-index] failed to read ${target}: ${(err as Error).message}`)
      return null
    }
  }

  private freshFile(): LyricsIndexFile {
    const now = new Date().toISOString()
    return { version: LYRICS_INDEX_VERSION, appName: APP_NAME, createdAt: now, updatedAt: now, entries: {} }
  }

  lookup(folderId: number, folderPath: string, absPath: string): LyricsIndexEntry | null {
    return this.loadFolder(folderId, folderPath).entries[toPosixRelative(folderPath, absPath)] ?? null
  }

  // ----- WRITE (in-memory + debounced flush) -----

  set(folderId: number, folderPath: string, absPath: string, entry: LyricsIndexEntry): void {
    const file = this.loadFolder(folderId, folderPath)
    const rel = toPosixRelative(folderPath, absPath)
    const prev = file.entries[rel]
    if (prev && entriesEqual(prev, entry)) return
    file.entries[rel] = entry
    this.scheduleWriteForFolder(folderId)
  }

  remove(folderId: number, folderPath: string, absPath: string): void {
    const file = this.loadFolder(folderId, folderPath)
    const rel = toPosixRelative(folderPath, absPath)
    if (!(rel in file.entries)) return
    delete file.entries[rel]
    this.scheduleWriteForFolder(folderId)
  }

  // Drop every entry for a folder. Used before a forced rebuild so that tracks
  // deleted from the library since the last scan are pruned from the file.
  clearFolder(folderId: number, folderPath: string): void {
    const file = this.loadFolder(folderId, folderPath)
    if (Object.keys(file.entries).length === 0) return
    file.entries = {}
    this.scheduleWriteForFolder(folderId)
  }

  // ----- single-track convenience (resolves the folder via the DB) -----

  setForTrack(track: DbTrack, entry: LyricsIndexEntry): void {
    const folder = this.repos.folders.getById(track.folder_id)
    if (!folder || folder.provider !== 'local' || folder.role !== 'library' || track.provider !== 'local') return
    this.set(track.folder_id, folder.path, track.path, entry)
  }

  removeEntryForTrack(track: DbTrack): void {
    const folder = this.repos.folders.getById(track.folder_id)
    if (!folder || folder.provider !== 'local' || folder.role !== 'library' || track.provider !== 'local') return
    this.remove(track.folder_id, folder.path, track.path)
  }

  // ----- scheduling / flush -----

  scheduleWriteForFolder(folderId: number, delayMs = DEBOUNCE_MS): void {
    this.cancelForFolder(folderId)
    const timer = setTimeout(() => {
      this.timers.delete(folderId)
      this.doWrite(folderId)
    }, delayMs)
    this.timers.set(folderId, timer)
  }

  cancelForFolder(folderId: number): void {
    const t = this.timers.get(folderId)
    if (t) {
      clearTimeout(t)
      this.timers.delete(folderId)
    }
  }

  cancelAll(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  // Drain pending writes synchronously. Safe to call from app.on('will-quit')
  // since doWrite is fully synchronous and doesn't touch the DB beyond a folder
  // path lookup.
  flushAll(): void {
    for (const folderId of Array.from(this.timers.keys())) {
      this.cancelForFolder(folderId)
      this.doWrite(folderId)
    }
  }

  private doWrite(folderId: number): void {
    if (isLibraryLocationMigrationLocked(folderId)) return
    const file = this.cache.get(folderId)
    if (!file) return
    const folder = this.repos.folders.getById(folderId)
    if (!folder || folder.provider !== 'local' || folder.role !== 'library') return
    try {
      file.updatedAt = new Date().toISOString()
      writeJsonAtomic(indexPathForFolder(folder.path), file)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EACCES' || code === 'EROFS' || code === 'EPERM') {
        console.warn(`[lyrics-index] folder ${folder.path} is read-only, skipping index`)
        return
      }
      if (code === 'ENOENT' || code === 'ENOTCONN' || code === 'ENXIO') {
        console.warn(`[lyrics-index] folder ${folder.path} appears unmounted, skipping`)
        return
      }
      console.error(`[lyrics-index] failed to write index for ${folder.path}:`, err)
    }
  }
}

let instance: LyricsIndexService | null = null
export function getLyricsIndexService(): LyricsIndexService {
  if (!instance) instance = new LyricsIndexService()
  return instance
}
