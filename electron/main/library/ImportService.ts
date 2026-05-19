import { readdir } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { Dirent } from 'node:fs'
import type { Repos } from '../db/repositories'
import { getRepos } from '../db/repositories'
import { readTrackMetadata, type TrackMetadata } from './MetadataExtractor'
import { parseArtistName } from './ArtistNameParser'
import { broadcast } from '../ipc/events'
import { getLibraryBackup } from '../services/LibraryBackup'
import type { DbFolder, DbTrackInsert } from '@shared/types/db'

const AUDIO_EXTENSIONS = new Set([
  '.flac', '.m4a', '.mp3', '.wav', '.aiff', '.aif',
  '.ogg', '.opus', '.ape', '.wv', '.tta',
  '.dsf', '.dff', '.webm', '.mpc', '.spx',
])

async function collectAudioFiles(root: string): Promise<string[]> {
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
      const full = join(dir, ent.name)
      if (ent.isDirectory()) {
        await walk(full)
      } else if (ent.isFile() && AUDIO_EXTENSIONS.has(extname(ent.name).toLowerCase())) {
        out.push(full)
      }
    }
  }
  await walk(root)
  return out
}

function buildTrackInsert(
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
    bpm: null,
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
    r128_integrated_loudness: null,
    state_updated_at: null,
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

  constructor() {
    this.repos = getRepos()
  }

  async addFolder(path: string): Promise<AddFolderResult> {
    const name = basename(path) || path
    const folder = this.repos.folders.add(path, name)
    if (this.scanning.has(folder.id)) {
      return { folder, startedScan: false }
    }
    // Kick off the scan asynchronously so the IPC call returns immediately
    // and the renderer can update its watched-folders list.
    setImmediate(() => {
      this.scan(folder.id, folder.path).catch(err => {
        console.error(`[import] folder ${folder.id} scan failed:`, err)
      })
    })
    return { folder, startedScan: true }
  }

  async scan(folderId: number, folderPath: string): Promise<void> {
    if (this.scanning.has(folderId)) return
    this.scanning.add(folderId)

    try {
      broadcast('library:import:progress', {
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
          broadcast('library:import:progress', {
            folderId, scanned, imported, total, phase: 'scanning',
          })
        },
      )

      for (const row of rows) {
        batchInserts.push(row)
        imported = imported + 1
        if (batchInserts.length >= 100) {
          flush()
          broadcast('library:import:progress', {
            folderId, scanned: fresh.length, imported, total, phase: 'writing',
          })
        }
      }
      flush()

      this.repos.folders.updateTrackCount(folderId, imported + (files.length - fresh.length))

      // After the scan is done, fold in any per-track state that lives in the
      // folder's portable `.hifidelity-library.json`, then refresh the file
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

      broadcast('library:import:complete', { folderId, totalImported: imported, total })
      broadcast('library:changed', { reason: 'import' })
    } finally {
      this.scanning.delete(folderId)
    }
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
