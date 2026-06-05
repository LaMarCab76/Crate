import { readdir } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { Dirent } from 'node:fs'
import type { Repos } from '../db/repositories'
import { getRepos } from '../db/repositories'
import { readTrackMetadata, type TrackMetadata } from './MetadataExtractor'
import { parseArtistName } from './ArtistNameParser'
import { broadcast } from '../ipc/events'
import { createThrottledBroadcaster } from '../ipc/throttle'
import { getLibraryBackup } from '../services/LibraryBackup'
import { lufsFromReplayGain } from '@shared/constants/leveler'
import type { DbFolder, DbTrackInsert } from '@shared/types/db'

export const AUDIO_EXTENSIONS = new Set([
  '.flac', '.m4a', '.mp3', '.wav', '.aiff', '.aif',
  '.ogg', '.opus', '.ape', '.wv', '.tta',
  '.dsf', '.dff', '.webm', '.mpc', '.spx',
])

export function isAudioPath(path: string): boolean {
  return AUDIO_EXTENSIONS.has(extname(path).toLowerCase())
}

export async function collectAudioFiles(root: string): Promise<string[]> {
  return collectFiles(root, name => isAudioPath(name))
}

// Same walk rules as collectAudioFiles (skip dotfiles + symlinks) but yields the
// .lrc sidecar files. Used by the orphan-lyrics cleanup pass.
export async function collectLrcFiles(root: string): Promise<string[]> {
  return collectFiles(root, name => extname(name).toLowerCase() === '.lrc')
}

async function collectFiles(root: string, accept: (name: string) => boolean): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      console.warn(`[import] skip unreadable dir ${dir}:`, (err as Error).message)
      return
    }
    for (const ent of entries) {
      // Skip dotfiles and macOS resource forks.
      if (ent.name.startsWith('.')) continue
      // Reject symlinks to avoid cycles and accidental escapes from the
      // library root — matches the device-sync collectAudioFiles behavior.
      if (ent.isSymbolicLink()) continue
      const full = join(dir, ent.name)
      if (ent.isDirectory()) {
        await walk(full)
      } else if (ent.isFile() && accept(ent.name)) {
        out.push(full)
      }
    }
  }
  await walk(root)
  return out
}

export function buildTrackInsert(
  md: TrackMetadata,
  path: string,
  folderId: number,
  albumId: number,
  artistId: number,
  genreId: number | null,
): DbTrackInsert {
  return {
    path,
    filename: basename(path),
    title: md.title,
    artist: md.artist,
    album: md.album,
    duration: md.duration,
    format: md.format,
    folder_id: folderId,
    file_size: md.fileSize ?? null,
    date_modified: md.dateModified,
    album_artist: md.albumArtist,
    composer: md.composer,
    genre: md.genre,
    year: md.year,
    is_favorite: 0,
    play_count: 0,
    last_played_date: null,
    rating: null,
    track_number: md.trackNumber,
    total_tracks: md.totalTracks,
    disc_number: md.discNumber,
    total_discs: md.totalDiscs,
    compilation: md.isCompilation ? 1 : 0,
    release_date: null,
    original_release_date: null,
    bpm: md.bpm,
    musical_key: md.musicalKey,
    media_type: null,
    sort_title: null,
    sort_artist: null,
    sort_album: null,
    sort_album_artist: null,
    bitrate: md.bitrate,
    sample_rate: md.sampleRate,
    channels: md.channels,
    codec: md.codec,
    bit_depth: md.bitDepth,
    artwork_data: null,
    artwork_path: md.artwork?.filename ?? null,
    date_added: new Date().toISOString(),
    is_duplicate: 0,
    primary_track_id: null,
    duplicate_group_id: null,
    extended_metadata: null,
    album_id: albumId,
    artist_id: artistId,
    genre_id: genreId,
    // Seed the volume-leveler loudness from the file's ReplayGain track tag
    // (gain to the -18 LUFS reference → absolute LUFS). Untagged files stay null
    // and get an estimate from the playback analysis at play time instead.
    r128_integrated_loudness: lufsFromReplayGain(md.replayGainTrack),
    state_updated_at: null,
    // Local-disk track: no cloud reference.
    source: 'local',
    cloud_drive_id: null,
    cloud_item_id: null,
    cloud_etag: null,
    cloud_remote_path: null,
  }
}

async function processMetadataInChunks<T>(
  items: string[],
  chunkSize: number,
  fn: (item: string) => Promise<T | null>,
  onProgress?: (done: number) => void,
): Promise<T[]> {
  const results: T[] = []
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize)
    const settled = await Promise.allSettled(chunk.map(fn))
    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value != null) results.push(s.value)
    }
    if (onProgress) onProgress(Math.min(i + chunkSize, items.length))
  }
  return results
}

export interface AddFolderResult {
  folder: DbFolder
  startedScan: boolean
}

export class ImportService {
  private repos: Repos
  private scanning = new Set<number>()
  private throttle = createThrottledBroadcaster(120)

  constructor() {
    this.repos = getRepos()
  }

  async addFolder(path: string): Promise<AddFolderResult> {
    const name = basename(path) || path
    const folder = this.repos.folders.add(path, name)
    if (this.scanning.has(folder.id)) return { folder, startedScan: false }
    return { folder, startedScan: true }
  }

  async scan(folderId: number, folderPath: string): Promise<void> {
    if (this.scanning.has(folderId)) return
    this.scanning.add(folderId)

    try {
      this.throttle.emit('library:import:progress', true, {
        folderId, scanned: 0, imported: 0, total: 0, phase: 'discovering',
      })

      const files = await collectAudioFiles(folderPath)
      const total = files.length

      // Filter out paths already present in DB so we can rescan a folder
      // without duplicating rows.
      const fresh: string[] = []
      for (const f of files) {
        if (!this.repos.tracks.getByPath(f)) fresh.push(f)
      }

      let imported = 0
      const batchInserts: DbTrackInsert[] = []

      const flush = () => {
        if (batchInserts.length === 0) return
        const batch = batchInserts.splice(0)
        this.repos.tracks.insertBatch(batch)
      }

      const rows = await processMetadataInChunks(
        fresh,
        8,
        async file => {
          try {
            const md = await readTrackMetadata(file)
            const parsedArtist = parseArtistName(md.artist)
            const artist = this.repos.artists.getOrCreate(parsedArtist.primary || md.artist)
            const album = this.repos.albums.getOrCreate(
              md.album,
              md.albumArtist ?? null,
              md.year || null,
            )
            const genre = md.genre ? this.repos.genres.getOrCreate(md.genre) : null
            return buildTrackInsert(md, file, folderId, album.id, artist.id, genre?.id ?? null)
          } catch (err) {
            console.warn(`[import] skip ${file}:`, (err as Error).message)
            return null
          }
        },
        scanned => {
          this.throttle.emit('library:import:progress', false, {
            folderId, scanned, imported, total, phase: 'scanning',
          })
        },
      )

      for (const row of rows) {
        batchInserts.push(row)
        imported = imported + 1
        if (batchInserts.length >= 100) {
          flush()
          this.throttle.emit('library:import:progress', false, {
            folderId, scanned: fresh.length, imported, total, phase: 'writing',
          })
        }
      }
      flush()

      this.repos.folders.updateTrackCount(folderId, imported + (files.length - fresh.length))

      // After the scan is done, fold in any per-track state that lives in the
      // folder's portable `.crate/library.yaml`, then refresh the file
      // so it reflects the new ground truth.
      const backup = getLibraryBackup()
      const restore = backup.readForFolder(folderPath)
      if (restore) {
        try {
          backup.mergeIntoDb(folderPath, restore)
        } catch (err) {
          console.error(`[backup] merge failed for ${folderPath}:`, (err as Error).message)
        }
      }
      backup.writeForFolderImmediate(folderId)

      this.throttle.reset('library:import:progress')
      broadcast('library:import:complete', { folderId, totalImported: imported, total })
      broadcast('library:changed', { reason: 'import' })
    } finally {
      this.scanning.delete(folderId)
    }
  }

  async importFile(folderId: number, filePath: string): Promise<number | null> {
    if (this.repos.tracks.getByPath(filePath)) return null

    const md = await readTrackMetadata(filePath)
    const parsedArtist = parseArtistName(md.artist)
    const artist = this.repos.artists.getOrCreate(parsedArtist.primary || md.artist)
    const album = this.repos.albums.getOrCreate(md.album, md.albumArtist ?? null, md.year || null)
    const genre = md.genre ? this.repos.genres.getOrCreate(md.genre) : null
    const row = buildTrackInsert(md, filePath, folderId, album.id, artist.id, genre?.id ?? null)

    // Re-check inside the insert path: between getByPath above and here a
    // concurrent scan could have inserted the same row.
    const existing = this.repos.tracks.getByPath(filePath)
    if (existing) return null
    const trackId = this.repos.tracks.insert(row)
    if (trackId === 0) return null

    this.repos.folders.updateTrackCount(folderId, this.repos.tracks.countByFolder(folderId))
    getLibraryBackup().scheduleWriteForFolder(folderId)
    broadcast('library:track:added', { path: filePath })
    broadcast('library:changed', { reason: 'import-file' })
    return trackId
  }

  async rescanAll(): Promise<void> {
    for (const folder of this.repos.folders.list()) {
      await this.scan(folder.id, folder.path)
    }
  }
}

let instance: ImportService | null = null
export function getImportService(): ImportService {
  if (!instance) instance = new ImportService()
  return instance
}
