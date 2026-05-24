import { existsSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import type { DbFolder, DbTrack } from '@shared/types/db'
import type { LibraryScanReason, LibraryScanRun } from '@shared/types/ipc-contract'
import { getRepos, type Repos } from '../db/repositories'
import { broadcast } from '../ipc/events'
import { getLibraryBackup } from '../services/LibraryBackup'
import { parseArtistName } from './ArtistNameParser'
import { buildTrackInsert, collectAudioFiles, isAudioPath } from './ImportService'
import { getLibraryScanSettings } from './LibraryScanSettings'
import { readTrackMetadata, type TrackMetadata } from './MetadataExtractor'

const BACKGROUND_SCAN_INTERVAL_MS = 5 * 60 * 1000
const WATCH_DEBOUNCE_MS = 1000

interface ScanCounts {
  added: number
  updated: number
  removed: number
  skipped: number
}

function emptyCounts(): ScanCounts {
  return { added: 0, updated: 0, removed: 0, skipped: 0 }
}

function trackNeedsRefresh(track: DbTrack): boolean {
  try {
    const stats = statSync(track.path)
    if (track.file_size != null && track.file_size !== stats.size) return true
    if (!track.date_modified) return true
    const dbModified = Date.parse(track.date_modified)
    if (!Number.isFinite(dbModified)) return true
    return Math.abs(dbModified - stats.mtime.getTime()) > 1000
  } catch {
    return false
  }
}

class LibraryReconciler {
  private repos: Repos
  private running = new Map<number, Promise<LibraryScanRun>>()
  private timers = new Map<number, NodeJS.Timeout>()
  private backgroundTimer: NodeJS.Timeout | null = null

  constructor() {
    this.repos = getRepos()
  }

  startBackgroundSweep(): void {
    if (this.backgroundTimer) return
    this.backgroundTimer = setInterval(() => {
      void this.scanAll('background').catch(err => {
        console.warn('[library-scan] background sweep failed:', (err as Error).message)
      })
    }, BACKGROUND_SCAN_INTERVAL_MS)
  }

  dispose(): void {
    if (this.backgroundTimer) {
      clearInterval(this.backgroundTimer)
      this.backgroundTimer = null
    }
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  setRetentionDays(days: number | null): void {
    const next = getLibraryScanSettings().setRetentionDays(days)
    this.repos.libraryScanLog.purgeOlderThan(next)
  }

  scheduleFolderScan(folderId: number, reason: LibraryScanReason = 'watch', delayMs = WATCH_DEBOUNCE_MS): void {
    const existing = this.timers.get(folderId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.timers.delete(folderId)
      void this.scanFolder(folderId, reason).catch(err => {
        console.warn(`[library-scan] folder ${folderId} scan failed:`, (err as Error).message)
      })
    }, delayMs)
    this.timers.set(folderId, timer)
  }

  async scanAll(reason: LibraryScanReason): Promise<LibraryScanRun[]> {
    const runs: LibraryScanRun[] = []
    for (const folder of this.repos.folders.list()) {
      runs.push(await this.scanFolder(folder.id, reason))
    }
    this.purgeOldLogs()
    return runs
  }

  async scanFolder(folderId: number, reason: LibraryScanReason): Promise<LibraryScanRun> {
    const current = this.running.get(folderId)
    if (current) return current

    const task = this.scanFolderNow(folderId, reason)
      .finally(() => {
        this.running.delete(folderId)
      })
    this.running.set(folderId, task)
    return task
  }

  async scanLog(folderId: number | null, limit: number) {
    return {
      folders: this.repos.folders.list(),
      runs: this.repos.libraryScanLog.listRuns(folderId, limit),
      events: this.repos.libraryScanLog.listEvents(folderId, limit),
    }
  }

  private async scanFolderNow(folderId: number, reason: LibraryScanReason): Promise<LibraryScanRun> {
    const folder = this.repos.folders.getById(folderId)
    if (!folder) throw new Error(`Folder ${folderId} no longer exists`)

    const run = this.repos.libraryScanLog.startRun({ folderId: folder.id, reason })
    const counts = emptyCounts()

    try {
      if (!existsSync(folder.path)) {
        this.removeMissingRoot(folder, run.id, counts)
      } else {
        await this.reconcileExistingRoot(folder, run.id, counts)
      }

      const finished = this.repos.libraryScanLog.finishRun({
        id: run.id,
        status: 'completed',
        ...counts,
      })
      this.purgeOldLogs()
      if (counts.added > 0 || counts.updated > 0 || counts.removed > 0) {
        broadcast('library:changed', { reason: 'library-scan' })
      }
      return finished
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.repos.libraryScanLog.addEvent({
        runId: run.id,
        folderId: folder.id,
        type: 'error',
        path: folder.path,
        title: folder.name,
        detail: message,
      })
      const failed = this.repos.libraryScanLog.finishRun({
        id: run.id,
        status: 'failed',
        ...counts,
        error: message,
      })
      this.purgeOldLogs()
      throw Object.assign(new Error(message), { run: failed })
    }
  }

  private removeMissingRoot(folder: DbFolder, runId: number, counts: ScanCounts): void {
    const tracks = this.repos.tracks.getByFolder(folder.id)
    counts.removed = tracks.length
    if (tracks.length > 0) {
      this.repos.libraryScanLog.addEvents(tracks.slice(0, 1000).map(track => ({
        runId,
        folderId: folder.id,
        type: 'removed',
        path: track.path,
        title: track.title,
        detail: 'Library root is missing',
      })))
      this.repos.tracks.deleteByFolder(folder.id)
    }
    this.repos.folders.updateTrackCount(folder.id, 0)
    this.repos.libraryScanLog.addEvent({
      runId,
      folderId: folder.id,
      type: 'missing_root',
      path: folder.path,
      title: folder.name,
      detail: `${tracks.length} tracks removed from the local catalog`,
    })
    getLibraryBackup().cancelForFolder(folder.id)
  }

  private async reconcileExistingRoot(folder: DbFolder, runId: number, counts: ScanCounts): Promise<void> {
    broadcast('library:import:progress', {
      folderId: folder.id,
      scanned: 0,
      imported: 0,
      total: 0,
      phase: 'discovering',
    })
    const files = await collectAudioFiles(folder.path)
    const filesOnDisk = new Set(files)
    const tracks = this.repos.tracks.getByFolder(folder.id)
    const tracksByPath = new Map(tracks.map(track => [track.path, track]))
    const total = files.length

    const removed = tracks.filter(track => !filesOnDisk.has(track.path))
    if (removed.length > 0) {
      counts.removed += removed.length
      this.repos.libraryScanLog.addEvents(removed.map(track => ({
        runId,
        folderId: folder.id,
        type: 'removed',
        path: track.path,
        title: track.title,
        detail: 'File no longer exists',
      })))
      this.repos.tracks.deleteByIds(removed.map(track => track.id))
    }

    let scanned = 0
    for (const file of files) {
      const existing = tracksByPath.get(file)
      if (!existing) {
        await this.importNewTrack(folder.id, file, runId, counts)
      } else if (trackNeedsRefresh(existing)) {
        await this.refreshExistingTrack(existing, runId, counts)
      }
      scanned += 1
      if (scanned === total || scanned % 50 === 0) {
        broadcast('library:import:progress', {
          folderId: folder.id,
          scanned,
          imported: counts.added,
          total,
          phase: 'scanning',
        })
      }
    }

    this.repos.folders.updateTrackCount(folder.id, this.repos.tracks.countByFolder(folder.id))
    if (counts.added > 0 || counts.updated > 0 || counts.removed > 0) {
      getLibraryBackup().scheduleWriteForFolder(folder.id)
    }
    broadcast('library:import:complete', { folderId: folder.id, totalImported: counts.added, total })
  }

  private async importNewTrack(folderId: number, filePath: string, runId: number, counts: ScanCounts): Promise<void> {
    if (!isAudioPath(filePath)) return
    try {
      const md = await readTrackMetadata(filePath)
      const parsedArtist = parseArtistName(md.artist)
      const artist = this.repos.artists.getOrCreate(parsedArtist.primary || md.artist)
      const album = this.repos.albums.getOrCreate(md.album, md.albumArtist ?? null, md.year || null)
      const genre = md.genre ? this.repos.genres.getOrCreate(md.genre) : null
      const row = buildTrackInsert(md, filePath, folderId, album.id, artist.id, genre?.id ?? null)
      this.repos.tracks.insert(row)
      counts.added += 1
      this.repos.libraryScanLog.addEvent({
        runId,
        folderId,
        type: 'added',
        path: filePath,
        title: md.title,
      })
    } catch (err) {
      counts.skipped += 1
      this.repos.libraryScanLog.addEvent({
        runId,
        folderId,
        type: 'skipped',
        path: filePath,
        title: basename(filePath),
        detail: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private async refreshExistingTrack(track: DbTrack, runId: number, counts: ScanCounts): Promise<void> {
    try {
      const md = await readTrackMetadata(track.path)
      this.updateTrackMetadata(track, md)
      counts.updated += 1
      this.repos.libraryScanLog.addEvent({
        runId,
        folderId: track.folder_id,
        type: 'updated',
        path: track.path,
        title: md.title,
      })
    } catch (err) {
      counts.skipped += 1
      this.repos.libraryScanLog.addEvent({
        runId,
        folderId: track.folder_id,
        type: 'skipped',
        path: track.path,
        title: track.title,
        detail: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private updateTrackMetadata(track: DbTrack, md: TrackMetadata): void {
    const parsedArtist = parseArtistName(md.artist)
    const artist = this.repos.artists.getOrCreate(parsedArtist.primary || md.artist)
    const album = this.repos.albums.getOrCreate(md.album, md.albumArtist ?? null, md.year || null)
    const genre = md.genre ? this.repos.genres.getOrCreate(md.genre) : null

    this.repos.tracks.updateMetadata({
      id: track.id,
      title: md.title,
      artist: md.artist,
      album: md.album,
      albumArtist: md.albumArtist,
      composer: md.composer,
      genre: md.genre,
      year: md.year,
      trackNumber: md.trackNumber,
      totalTracks: md.totalTracks,
      discNumber: md.discNumber,
      totalDiscs: md.totalDiscs,
      compilation: md.isCompilation ? 1 : 0,
      duration: md.duration,
      format: md.format,
      codec: md.codec,
      bitrate: md.bitrate,
      sampleRate: md.sampleRate,
      channels: md.channels,
      bitDepth: md.bitDepth,
      fileSize: md.fileSize,
      bpm: md.bpm,
      musicalKey: md.musicalKey,
      dateModified: md.dateModified,
      artworkPath: md.artwork?.filename ?? track.artwork_path,
      filename: basename(track.path),
      artistId: artist.id,
      albumId: album.id,
      genreId: genre?.id ?? null,
    })
  }

  private purgeOldLogs(): void {
    this.repos.libraryScanLog.purgeOlderThan(getLibraryScanSettings().getRetentionDays())
  }
}

let instance: LibraryReconciler | null = null

export function getLibraryReconciler(): LibraryReconciler {
  if (!instance) instance = new LibraryReconciler()
  return instance
}
