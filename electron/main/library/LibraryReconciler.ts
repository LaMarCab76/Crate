import { existsSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, extname } from 'node:path'
import type { DbFolder, DbTrack } from '@shared/types/db'
import type { LibraryScanReason, LibraryScanRun } from '@shared/types/ipc-contract'
import { getRepos, type Repos } from '../db/repositories'
import { broadcast } from '../ipc/events'
import { getLyricsBackfillService } from '../lyrics/LyricsBackfillService'
import { getLyricsIndexService } from '../lyrics/LyricsIndexService'
import { getLyricsSettings } from '../lyrics/LyricsSettings'
import { getLibraryBackup } from '../services/LibraryBackup'
import { getLibraryWorkerClient } from '../workers/LibraryWorkerClient'
import { parseArtistName } from './ArtistNameParser'
import { buildTrackInsert, collectAudioFiles, collectLrcFiles, isAudioPath } from './ImportService'
import { getLibraryScanSettings } from './LibraryScanSettings'
import { readTrackMetadata, type TrackMetadata } from './MetadataExtractor'
import { isOrphanLrc } from './orphanLrc'
import { LibraryCollectionError } from './libraryFileCollector'
import { requireCurrentLocalLibraryFolder, requirePathInsideLocalLibrary } from './libraryRootGuards'
import { requireLocalLibraryTrackPath } from './localLibraryTrackGuard'
import { assertLibraryLocationMigrationUnlocked, isLibraryLocationMigrationLocked } from '../library-migration/locationLocks'

const BACKGROUND_SCAN_INTERVAL_MS = 5 * 60 * 1000
const WATCH_DEBOUNCE_MS = 1000
const EMPTY_STEMS: ReadonlySet<string> = new Set<string>()

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
      if (folder.provider !== 'local' || folder.role !== 'library') continue
      if (isLibraryLocationMigrationLocked(folder.id)) continue
      runs.push(await this.scanFolder(folder.id, reason))
    }
    this.purgeOldLogs()
    return runs
  }

  async scanFolder(folderId: number, reason: LibraryScanReason): Promise<LibraryScanRun> {
    assertLibraryLocationMigrationUnlocked(folderId, 'el indexado local')
    const current = this.running.get(folderId)
    if (current) return current

    const task = this.scanFolderNow(folderId, reason)
      .finally(() => {
        this.running.delete(folderId)
      })
    this.running.set(folderId, task)
    return task
  }

  async waitForFolderIdle(folderId: number): Promise<void> {
    const running = this.running.get(folderId)
    if (running) await Promise.allSettled([running])
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
    if (folder.provider !== 'local' || folder.role !== 'library') {
      throw new Error(`Folder ${folderId} is not a local library`)
    }

    const run = this.repos.libraryScanLog.startRun({ folderId: folder.id, reason })
    const counts = emptyCounts()

    try {
      if (!existsSync(folder.path)) {
        this.recordUnavailableRoot(folder, run.id)
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
      if (err instanceof LibraryCollectionError) {
        this.repos.libraryScanLog.addEvent({
          runId: run.id,
          folderId: folder.id,
          type: 'root_unavailable',
          path: err.path,
          title: folder.name,
          detail: 'Scan was incomplete; the existing catalog was preserved',
        })
      }
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

  private recordUnavailableRoot(folder: DbFolder, runId: number): void {
    const tracks = this.repos.tracks.getByFolder(folder.id)
    this.repos.libraryScanLog.addEvent({
      runId,
      folderId: folder.id,
      type: 'root_unavailable',
      path: folder.path,
      title: folder.name,
      detail: `${tracks.length} tracks preserved until the library root is available again`,
    })
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
    // Discovery yields to the event loop. Re-read the DB before the scan starts
    // its catalog-mutating phase so a newly assigned backup is never treated as
    // an empty/changed source library.
    this.requireCurrentFolder(folder)
    const filesOnDisk = new Set(files)
    const tracks = this.repos.tracks.getByFolder(folder.id)
    const tracksByPath = new Map(tracks.map(track => [track.path, track]))
    const total = files.length

    // Preserve track identity for case-only / Unicode-normalization renames.
    // We only accept an unambiguous normalized path and matching size; broader
    // content-based rename detection belongs in a fingerprinted scan.
    const normalized = (path: string): string => path.normalize('NFC').toLocaleLowerCase('en-US')
    const untrackedByNormalized = new Map<string, string[]>()
    for (const file of files) {
      if (tracksByPath.has(file)) continue
      const key = normalized(file)
      const bucket = untrackedByNormalized.get(key) ?? []
      bucket.push(file)
      untrackedByNormalized.set(key, bucket)
    }
    const renamedIds = new Set<number>()
    for (const track of tracks) {
      if (filesOnDisk.has(track.path)) continue
      const candidates = untrackedByNormalized.get(normalized(track.path)) ?? []
      if (candidates.length !== 1) continue
      const candidate = candidates[0]
      try {
        const stats = statSync(candidate)
        if (track.file_size != null && track.file_size !== stats.size) continue
      } catch {
        continue
      }
      const lyricsIndex = getLyricsIndexService()
      const indexedLyrics = lyricsIndex.lookup(folder.id, folder.path, track.path)
      this.repos.tracks.updatePath(track.id, candidate, basename(candidate))
      if (indexedLyrics) {
        lyricsIndex.remove(folder.id, folder.path, track.path)
        lyricsIndex.set(folder.id, folder.path, candidate, indexedLyrics)
      }
      tracksByPath.delete(track.path)
      tracksByPath.set(candidate, { ...track, path: candidate, filename: basename(candidate) })
      renamedIds.add(track.id)
      counts.updated += 1
      this.repos.libraryScanLog.addEvent({
        runId,
        folderId: folder.id,
        type: 'updated',
        path: candidate,
        title: track.title,
        detail: `Path rename detected from ${track.path}`,
      })
    }

    const removed = tracks.filter(track => !filesOnDisk.has(track.path) && !renamedIds.has(track.id))
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
      // Prune the per-folder lyrics index so entries for deleted tracks don't
      // linger (otherwise they're only cleared on a forced rebuild).
      const lyricsIndex = getLyricsIndexService()
      for (const track of removed) lyricsIndex.removeEntryForTrack(track)
    }

    // Phase 1: classify files into the ones that actually need a metadata read
    // (new imports + changed files). Unchanged files do no work.
    const toImport: string[] = []
    const refreshByPath = new Map<string, DbTrack>()
    for (const file of files) {
      const existing = tracksByPath.get(file)
      if (!existing) {
        if (isAudioPath(file)) toImport.push(file)
      } else if (trackNeedsRefresh(existing)) {
        refreshByPath.set(file, existing)
      }
    }
    const importSet = new Set(toImport)
    const work = [...toImport, ...refreshByPath.keys()]

    // Unchanged files count as already scanned so progress still reaches total.
    let scanned = total - work.length
    const emitProgress = (): void => {
      broadcast('library:import:progress', {
        folderId: folder.id,
        scanned,
        imported: counts.added,
        total,
        phase: 'scanning',
      })
    }
    emitProgress()

    // Phase 2: parse metadata in the library worker (off the main thread) and
    // apply each result to the DB here in main as it streams back. The DB stays
    // single-owner; only the heavy readTrackMetadata + artwork save move off-thread.
    const applyItem = (path: string, md: TrackMetadata | null, error?: string): void => {
      try {
        // Worker results can arrive after the destination was reclassified.
        this.requireCurrentFolder(folder)
        if (error || !md) {
          const existing = refreshByPath.get(path)
          if (existing) this.recordRefreshSkip(existing, runId, counts, error ?? 'metadata read failed')
          else if (importSet.has(path)) this.recordImportSkip(folder.id, path, runId, counts, error ?? 'metadata read failed')
        } else if (importSet.has(path)) {
          this.applyImportedMetadata(folder.id, path, md, runId, counts)
        } else {
          const existing = refreshByPath.get(path)
          if (existing) this.applyRefreshedMetadata(existing, md, runId, counts)
        }
      } catch (err) {
        // A DB write failure for one item must never abort the whole scan.
        const existing = refreshByPath.get(path)
        if (existing) this.recordRefreshSkip(existing, runId, counts, err)
        else this.recordImportSkip(folder.id, path, runId, counts, err)
      }
      scanned += 1
      if (scanned === total || scanned % 50 === 0) emitProgress()
    }

    try {
      await getLibraryWorkerClient().parseMetadata(work, applyItem)
    } catch (err) {
      // Worker unavailable / crashed: fall back to the original in-main serial
      // loop so the scan still completes (slower, but correct).
      console.warn(
        `[library-scan] worker parse failed for folder ${folder.id}, using in-main path: ${err instanceof Error ? err.message : String(err)}`,
      )
      // Reset progress so a partial worker stream before the crash doesn't make
      // `scanned` overshoot total as the in-main loop re-walks every work item.
      // applyImportedMetadata's getByPath guard makes the re-walk safe.
      scanned = total - work.length
      for (const file of work) {
        this.requireCurrentFolder(folder)
        const existing = refreshByPath.get(file)
        if (existing) await this.refreshExistingTrack(existing, runId, counts)
        else await this.importNewTrack(folder.id, file, runId, counts)
        scanned += 1
        if (scanned === total || scanned % 50 === 0) emitProgress()
      }
    }

    // Best-effort: never let lyrics cleanup abort a scan.
    try {
      this.requireCurrentFolder(folder)
      await this.cleanupOrphanLrc(folder, runId, files)
    } catch (err) {
      console.warn(`[lyrics-cleanup] folder ${folder.id} failed:`, (err as Error).message)
    }

    this.repos.folders.updateTrackCount(folder.id, this.repos.tracks.countByFolder(folder.id))
    if (counts.added > 0 || counts.updated > 0 || counts.removed > 0) {
      getLibraryBackup().scheduleWriteForFolder(folder.id)
    }
    broadcast('library:import:complete', { folderId: folder.id, totalImported: counts.added, total })
  }

  // Deletes .lrc sidecar files whose matching audio (same basename, any audio
  // extension) no longer exists. Disk-state driven, so it catches both sidecars
  // of removed songs and stray .lrc files that were never tracks. Gated by the
  // deleteOrphanLyrics setting; default off (destructive). Only operates inside
  // the library root and never touches a .lrc whose sibling audio is present.
  private async cleanupOrphanLrc(folder: DbFolder, runId: number, audioFiles: string[]): Promise<void> {
    if (!getLyricsSettings().get().deleteOrphanLyrics) return

    // Audio basenames present, grouped by directory (case-insensitive).
    const stemsByDir = new Map<string, Set<string>>()
    for (const file of audioFiles) {
      const dir = dirname(file)
      const stem = basename(file, extname(file)).toLowerCase()
      let set = stemsByDir.get(dir)
      if (!set) {
        set = new Set<string>()
        stemsByDir.set(dir, set)
      }
      set.add(stem)
    }

    const lrcFiles = await collectLrcFiles(folder.path)
    // Collection is asynchronous; revalidate immediately before the
    // destructive, synchronous unlink phase.
    this.requireCurrentFolder(folder)
    for (const lrc of lrcFiles) {
      const siblings = stemsByDir.get(dirname(lrc))
      if (!isOrphanLrc(basename(lrc), siblings ?? EMPTY_STEMS)) continue
      try {
        unlinkSync(lrc)
        this.repos.libraryScanLog.addEvent({
          runId,
          folderId: folder.id,
          type: 'orphan_lrc_removed',
          path: lrc,
          title: basename(lrc),
          detail: 'No matching audio file',
        })
      } catch (err) {
        this.repos.libraryScanLog.addEvent({
          runId,
          folderId: folder.id,
          type: 'error',
          path: lrc,
          title: basename(lrc),
          detail: `Failed to delete orphan .lrc: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    }
  }

  // In-main fallback: read metadata then apply. The worker path calls
  // applyImportedMetadata directly with worker-provided metadata.
  private async importNewTrack(folderId: number, filePath: string, runId: number, counts: ScanCounts): Promise<void> {
    if (!isAudioPath(filePath)) return
    try {
      const md = await readTrackMetadata(filePath)
      this.applyImportedMetadata(folderId, filePath, md, runId, counts)
    } catch (err) {
      this.recordImportSkip(folderId, filePath, runId, counts, err)
    }
  }

  // DB write for a newly-imported track (synchronous; main-process only). May
  // throw — callers wrap in try/catch and record a skip.
  private applyImportedMetadata(
    folderId: number,
    filePath: string,
    md: TrackMetadata,
    runId: number,
    counts: ScanCounts,
  ): void {
    const folder = this.repos.folders.getById(folderId)
    if (!folder) throw new Error(`Folder ${folderId} no longer exists`)
    requirePathInsideLocalLibrary(folder, filePath)
    // Idempotency guard: if the worker crashes mid-stream the in-main fallback
    // re-processes the whole work list, including files it already imported.
    // Never insert the same (UNIQUE) path twice.
    if (this.repos.tracks.getByPath(filePath)) return
    const parsedArtist = parseArtistName(md.artist)
    const artist = this.repos.artists.getOrCreate(parsedArtist.primary || md.artist)
    const album = this.repos.albums.getOrCreate(md.album, md.albumArtist ?? null, md.year || null)
    const genre = md.genre ? this.repos.genres.getOrCreate(md.genre) : null
    const row = buildTrackInsert(md, filePath, folderId, album.id, artist.id, genre?.id ?? null)
    const trackId = this.repos.tracks.insert(row)
    counts.added += 1
    // Kick off a background lyrics fetch for the freshly-added track. No-op
    // unless the user enabled background fetch; never blocks the scan.
    if (trackId > 0) {
      try { getLyricsBackfillService().enqueue(trackId) } catch { /* best-effort */ }
    }
    this.repos.libraryScanLog.addEvent({
      runId,
      folderId,
      type: 'added',
      path: filePath,
      title: md.title,
    })
  }

  private recordImportSkip(folderId: number, filePath: string, runId: number, counts: ScanCounts, err: unknown): void {
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

  private async refreshExistingTrack(track: DbTrack, runId: number, counts: ScanCounts): Promise<void> {
    try {
      const md = await readTrackMetadata(track.path)
      this.applyRefreshedMetadata(track, md, runId, counts)
    } catch (err) {
      this.recordRefreshSkip(track, runId, counts, err)
    }
  }

  private applyRefreshedMetadata(track: DbTrack, md: TrackMetadata, runId: number, counts: ScanCounts): void {
    const current = this.repos.tracks.getById(track.id)
    if (!current) throw new Error(`Track ${track.id} no longer exists`)
    requireLocalLibraryTrackPath({
      track: current,
      folder: this.repos.folders.getById(current.folder_id),
      expectedPath: track.path,
      label: 'Library scan track',
    })
    this.updateTrackMetadata(current, md)
    counts.updated += 1
    this.repos.libraryScanLog.addEvent({
      runId,
      folderId: current.folder_id,
      type: 'updated',
      path: current.path,
      title: md.title,
    })
  }

  private recordRefreshSkip(track: DbTrack, runId: number, counts: ScanCounts, err: unknown): void {
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

  private requireCurrentFolder(expected: DbFolder): void {
    requireCurrentLocalLibraryFolder(expected, this.repos.folders.getById(expected.id))
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
