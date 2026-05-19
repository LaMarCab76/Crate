import chokidar, { type FSWatcher } from 'chokidar'
import { basename, extname } from 'node:path'
import { getRepos } from '../db/repositories'
import { readTrackMetadata } from './MetadataExtractor'
import { parseArtistName } from './ArtistNameParser'
import { broadcast } from '../ipc/events'
import type { DbTrackInsert } from '@shared/types/db'

const AUDIO_EXTENSIONS = new Set([
  '.flac', '.m4a', '.mp3', '.wav', '.aiff', '.aif',
  '.ogg', '.opus', '.ape', '.wv', '.tta',
  '.dsf', '.dff', '.webm', '.mpc', '.spx',
])

function isAudio(filePath: string): boolean {
  return AUDIO_EXTENSIONS.has(extname(filePath).toLowerCase())
}

export class FolderWatcher {
  private watchers = new Map<number, FSWatcher>()

  startAll(): void {
    const repos = getRepos()
    for (const folder of repos.folders.list()) {
      this.start(folder.id, folder.path)
    }
  }

  start(folderId: number, folderPath: string): void {
    if (this.watchers.has(folderId)) return
    const watcher = chokidar.watch(folderPath, {
      ignoreInitial: true,
      persistent: true,
      depth: 99,
      awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 200 },
      ignored: /(^|[\/\\])\../, // dotfiles
    })

    watcher.on('add', path => {
      if (isAudio(path)) this.handleAdd(folderId, path)
    })
    watcher.on('unlink', path => {
      if (isAudio(path)) this.handleUnlink(path)
    })
    watcher.on('error', err => {
      console.warn(`[watcher] folder ${folderId} error:`, err)
    })

    this.watchers.set(folderId, watcher)
  }

  stop(folderId: number): void {
    const w = this.watchers.get(folderId)
    if (w) {
      w.close()
      this.watchers.delete(folderId)
    }
  }

  stopAll(): void {
    for (const id of [...this.watchers.keys()]) this.stop(id)
  }

  private async handleAdd(folderId: number, path: string): Promise<void> {
    const repos = getRepos()
    if (repos.tracks.getByPath(path)) return

    try {
      const md = await readTrackMetadata(path)
      const parsed = parseArtistName(md.artist)
      const artist = repos.artists.getOrCreate(parsed.primary || md.artist)
      const album = repos.albums.getOrCreate(md.album, md.albumArtist ?? null, md.year || null)
      const genre = md.genre ? repos.genres.getOrCreate(md.genre) : null

      const row: DbTrackInsert = {
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
        album_id: album.id,
        artist_id: artist.id,
        genre_id: genre?.id ?? null,
        r128_integrated_loudness: null,
        state_updated_at: null,
      }

      repos.tracks.insert(row)
      broadcast('library:track:added', { path })
      broadcast('library:changed', { reason: 'watch-add' })
    } catch (err) {
      console.warn(`[watcher] failed to import ${path}:`, (err as Error).message)
    }
  }

  private handleUnlink(path: string): void {
    const repos = getRepos()
    repos.tracks.deleteByPath(path)
    broadcast('library:track:removed', { path })
    broadcast('library:changed', { reason: 'watch-remove' })
  }
}

let instance: FolderWatcher | null = null
export function getFolderWatcher(): FolderWatcher {
  if (!instance) instance = new FolderWatcher()
  return instance
}
