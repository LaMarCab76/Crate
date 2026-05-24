// Portable library metadata. Each imported folder gets a hidden
// `.crate/library.yaml` file that mirrors the user-modifiable
// pieces of state from the SQLite DB (plays, favorites, ratings, EQ
// overrides). When the folder is reconnected on another machine the file is
// read first and its values are merged into the freshly-scanned DB rows.
//
// Sync vs async: every DB call here is sync (better-sqlite3), and the YAML
// payload is small (~tens of KB for thousands of tracks), so the writes are
// also sync. That lets `flushAll()` run reliably from `app.on('before-quit')`.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { Repos } from '../db/repositories'
import { getDatabase } from '../db/database'
import { getRepos } from '../db/repositories'
import type {
  BackupArtist,
  BackupAlbum,
  BackupFile,
  BackupTrack,
} from '@shared/types/library-backup'
import { BACKUP_DIRNAME, BACKUP_FILENAME, BACKUP_VERSION } from '@shared/types/library-backup'

const DEBOUNCE_MS = 2000
const APP_NAME = 'Crate'

function toPosixRelative(folderPath: string, absPath: string): string {
  return relative(folderPath, absPath).split(sep).join('/')
}

function backupPathForFolder(folderPath: string): string {
  return join(folderPath, BACKUP_DIRNAME, BACKUP_FILENAME)
}

// Lexicographic max of two ISO-8601 timestamps (or null). Used to merge
// `last_played_date` without parsing it — ISO 8601 sorts correctly as text.
function pickMaxIso(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return a > b ? a : b
}

function writeYamlAtomic(target: string, payload: BackupFile): void {
  const tmp = target + '.tmp'
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(tmp, stringifyYaml(payload), 'utf8')
  renameSync(tmp, target)
}

class LibraryBackupService {
  private enabled = true
  private timers = new Map<number, NodeJS.Timeout>()

  private get db(): BetterSqliteDatabase {
    return getDatabase()
  }

  private get repos(): Repos {
    return getRepos()
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) this.cancelAll()
  }

  isEnabled(): boolean {
    return this.enabled
  }

  // ----- READ -----

  readForFolder(folderPath: string): BackupFile | null {
    const target = backupPathForFolder(folderPath)
    if (!existsSync(target)) return null
    try {
      const raw = readFileSync(target, 'utf8')
      const parsed = parseYaml(raw) as BackupFile
      if (parsed.version !== BACKUP_VERSION) {
        console.warn(`[backup] ${target} has unsupported version ${parsed.version}, ignoring`)
        return null
      }
      return parsed
    } catch (err) {
      console.warn(`[backup] failed to read ${target}: ${(err as Error).message}`)
      return null
    }
  }

  // ----- MERGE -----

  mergeIntoDb(folderPath: string, backup: BackupFile): void {
    const tx = this.db.transaction(() => {
      this.mergeTracks(folderPath, backup.tracks ?? {})
      this.mergeArtists(backup.artists ?? {})
      this.mergeAlbums(backup.albums ?? {})
    })
    tx()
  }

  private mergeTracks(folderPath: string, tracks: Record<string, BackupTrack>): void {
    const update = this.db.prepare(`
      UPDATE tracks
      SET play_count = ?, last_played_date = ?, is_favorite = ?, rating = ?, state_updated_at = ?
      WHERE id = ?
    `)

    for (const [relPath, jt] of Object.entries(tracks)) {
      const absPath = join(folderPath, relPath)
      const dbTrack = this.repos.tracks.getByPath(absPath)
      if (!dbTrack) continue

      const backupTs = jt.stateUpdatedAt ? Date.parse(jt.stateUpdatedAt) || 0 : 0
      const dbTs = dbTrack.state_updated_at ?? 0
      const backupWins = backupTs > dbTs

      const nextPlayCount = Math.max(dbTrack.play_count ?? 0, jt.playCount ?? 0)
      const nextLastPlayed = pickMaxIso(dbTrack.last_played_date, jt.lastPlayedAt ?? null)
      const nextFavorite =
        backupWins && jt.favorite !== undefined ? (jt.favorite ? 1 : 0) : dbTrack.is_favorite
      const nextRating =
        backupWins && jt.rating !== undefined ? jt.rating : dbTrack.rating

      let nextExtMeta = dbTrack.extended_metadata
      // Keep existing extended_metadata untouched. Old eqOverride values are no
      // longer read anywhere, so we leave legacy values untouched for DB
      // compatibility.

      const nextStateTs = Math.max(dbTs, backupTs)
      update.run(
        nextPlayCount,
        nextLastPlayed,
        nextFavorite,
        nextRating,
        nextExtMeta,
        nextStateTs > 0 ? nextStateTs : null,
        dbTrack.id,
      )
    }
  }

  private mergeArtists(artists: Record<string, BackupArtist>): void {
    const findByName = this.db.prepare<
      [string],
      { id: number; is_favorite: number; state_updated_at: number | null }
    >(`SELECT id, is_favorite, state_updated_at FROM artists WHERE name = ?`)
    const update = this.db.prepare(
      `UPDATE artists SET is_favorite = ?, state_updated_at = ? WHERE id = ?`,
    )

    for (const [name, ja] of Object.entries(artists)) {
      const row = findByName.get(name)
      if (!row) continue
      const backupTs = ja.stateUpdatedAt ? Date.parse(ja.stateUpdatedAt) || 0 : 0
      const dbTs = row.state_updated_at ?? 0
      const backupWins = backupTs > dbTs
      if (backupWins && ja.favorite !== undefined) {
        update.run(ja.favorite ? 1 : 0, Math.max(dbTs, backupTs), row.id)
      }
    }
  }

  private mergeAlbums(albums: Record<string, BackupAlbum>): void {
    const findAlbum = (title: string, albumArtist: string | null, year: string | null): { id: number; is_favorite: number; state_updated_at: number | null } | undefined => {
      if (albumArtist === null && year === null) {
        return this.db
          .prepare<
            [string],
            { id: number; is_favorite: number; state_updated_at: number | null }
          >(
            `SELECT id, is_favorite, state_updated_at
             FROM albums
             WHERE title = ? AND album_artist IS NULL AND year IS NULL`,
          )
          .get(title)
      }

      if (albumArtist === null) {
        const safeYear = year as string
        return this.db
          .prepare<
            [string, string],
            { id: number; is_favorite: number; state_updated_at: number | null }
          >(
            `SELECT id, is_favorite, state_updated_at
             FROM albums
             WHERE title = ? AND album_artist IS NULL AND year = ?`,
          )
          .get(title, safeYear)
      }

      if (year === null) {
        return this.db
          .prepare<
            [string, string],
            { id: number; is_favorite: number; state_updated_at: number | null }
          >(
            `SELECT id, is_favorite, state_updated_at
             FROM albums
             WHERE title = ? AND album_artist = ? AND year IS NULL`,
          )
          .get(title, albumArtist)
      }

      return this.db
        .prepare<
          [string, string, string],
          { id: number; is_favorite: number; state_updated_at: number | null }
        >(
          `SELECT id, is_favorite, state_updated_at
           FROM albums
           WHERE title = ? AND album_artist = ? AND year = ?`,
        )
        .get(title, albumArtist, year)
    }

    const update = this.db.prepare(
      `UPDATE albums SET is_favorite = ?, state_updated_at = ? WHERE id = ?`,
    )

    for (const [key, ja] of Object.entries(albums)) {
      let album: { title: string; artist: string | null; year: string | null }
      try {
        const parsed = JSON.parse(key)
        if (!Array.isArray(parsed) || parsed.length < 1) continue
        album = {
          title: String(parsed[0]),
          artist: parsed[1] == null ? null : String(parsed[1]),
          year: parsed[2] == null ? null : String(parsed[2]),
        }
      } catch {
        continue
      }

      const row = findAlbum(album.title, album.artist, album.year)
      if (!row) continue

      const backupTs = ja.stateUpdatedAt ? Date.parse(ja.stateUpdatedAt) || 0 : 0
      const dbTs = row.state_updated_at ?? 0
      const backupWins = backupTs > dbTs
      if (backupWins && ja.favorite !== undefined) {
        update.run(ja.favorite ? 1 : 0, Math.max(dbTs, backupTs), row.id)
      }
    }
  }

  // ----- WRITE -----

  writeForFolderImmediate(folderId: number): void {
    if (!this.enabled) return
    const folder = this.repos.folders.getById(folderId)
    if (!folder) return
    this.cancelForFolder(folderId)
    this.doWrite(folder.id, folder.path)
  }

  scheduleWriteForFolder(folderId: number, delayMs = DEBOUNCE_MS): void {
    if (!this.enabled) return
    this.cancelForFolder(folderId)
    const timer = setTimeout(() => {
      this.timers.delete(folderId)
      const folder = this.repos.folders.getById(folderId)
      if (folder) this.doWrite(folder.id, folder.path)
    }, delayMs)
    this.timers.set(folderId, timer)
  }

  scheduleWriteForTrack(trackId: number): void {
    if (!this.enabled) return
    const track = this.repos.tracks.getById(trackId)
    if (track) this.scheduleWriteForFolder(track.folder_id)
  }

  scheduleWriteForArtist(artistId: number): void {
    if (!this.enabled) return
    const rows = this.db
      .prepare<[number], { folder_id: number }>(
        `SELECT DISTINCT folder_id FROM tracks WHERE artist_id = ? AND folder_id IS NOT NULL`,
      )
      .all(artistId)
    for (const { folder_id } of rows) this.scheduleWriteForFolder(folder_id)
  }

  scheduleWriteForAlbum(albumId: number): void {
    if (!this.enabled) return
    const rows = this.db
      .prepare<[number], { folder_id: number }>(
        `SELECT DISTINCT folder_id FROM tracks WHERE album_id = ? AND folder_id IS NOT NULL`,
      )
      .all(albumId)
    for (const { folder_id } of rows) this.scheduleWriteForFolder(folder_id)
  }

  scheduleWriteAll(): void {
    if (!this.enabled) return
    for (const folder of this.repos.folders.list()) {
      this.scheduleWriteForFolder(folder.id)
    }
  }

  flushAll(): void {
    // Drain any pending debounced writes. Runs even if the feature was
    // disabled mid-session so that the on-disk YAML reflects the last good
    // state before quit. If nothing is queued this is a no-op.
    for (const folderId of Array.from(this.timers.keys())) {
      const folder = this.repos.folders.getById(folderId)
      this.cancelForFolder(folderId)
      if (folder) this.doWrite(folder.id, folder.path)
    }
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

  // ----- INTERNAL -----

  private doWrite(folderId: number, folderPath: string): void {
    try {
      const payload = this.buildBackupFor(folderId, folderPath)
      const target = backupPathForFolder(folderPath)
      writeYamlAtomic(target, payload)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EACCES' || code === 'EROFS' || code === 'EPERM') {
        console.warn(`[backup] folder ${folderPath} is read-only, skipping backup`)
        return
      }
      if (code === 'ENOENT' || code === 'ENOTCONN' || code === 'ENXIO') {
        console.warn(`[backup] folder ${folderPath} appears unmounted, skipping`)
        return
      }
      console.error(`[backup] failed to write backup for ${folderPath}:`, err)
    }
  }

  private buildBackupFor(folderId: number, folderPath: string): BackupFile {
    // Preserve createdAt across writes so the file remembers its first birth.
    let createdAt = new Date().toISOString()
    const target = backupPathForFolder(folderPath)
    if (existsSync(target)) {
      try {
        const existing = parseYaml(readFileSync(target, 'utf8')) as BackupFile
        if (existing.createdAt) createdAt = existing.createdAt
      } catch {
        /* fall back to fresh createdAt */
      }
    }

    const trackRows = this.db
      .prepare<
        [number],
        {
          id: number
          path: string
          play_count: number
          last_played_date: string | null
          is_favorite: number
          rating: number | null
          state_updated_at: number | null
        }
      >(
        `SELECT id, path, play_count, last_played_date, is_favorite, rating,
                state_updated_at
         FROM tracks WHERE folder_id = ?`,
      )
      .all(folderId)

    const tracks: Record<string, BackupTrack> = {}
    for (const row of trackRows) {
      const isDefault =
        (row.play_count ?? 0) === 0 &&
        !row.last_played_date &&
        (row.is_favorite ?? 0) === 0 &&
        row.rating == null
      if (isDefault) continue
      const rel = toPosixRelative(folderPath, row.path)
      const entry: BackupTrack = {}
      if (row.play_count > 0) entry.playCount = row.play_count
      if (row.last_played_date) entry.lastPlayedAt = row.last_played_date
      if (row.is_favorite) entry.favorite = true
      if (row.rating != null) entry.rating = row.rating
      if (row.state_updated_at) entry.stateUpdatedAt = new Date(row.state_updated_at).toISOString()
      tracks[rel] = entry
    }

    const artistRows = this.db
      .prepare<
        [number],
        { name: string; is_favorite: number; state_updated_at: number | null }
      >(
        `SELECT DISTINCT a.name, a.is_favorite, a.state_updated_at
         FROM artists a JOIN tracks t ON t.artist_id = a.id
         WHERE t.folder_id = ?`,
      )
      .all(folderId)

    const artists: Record<string, BackupArtist> = {}
    for (const ar of artistRows) {
      if (!ar.is_favorite && !ar.state_updated_at) continue
      const entry: BackupArtist = {}
      if (ar.is_favorite) entry.favorite = true
      if (ar.state_updated_at) entry.stateUpdatedAt = new Date(ar.state_updated_at).toISOString()
      artists[ar.name] = entry
    }

    const albumRows = this.db
      .prepare<
        [number],
        {
          title: string
          album_artist: string | null
          year: string | null
          is_favorite: number
          state_updated_at: number | null
        }
      >(
        `SELECT DISTINCT a.title, a.album_artist, a.year, a.is_favorite, a.state_updated_at
         FROM albums a
         JOIN tracks t ON t.album_id = a.id
         WHERE t.folder_id = ?`,
      )
      .all(folderId)

    const albums: Record<string, BackupAlbum> = {}
    for (const a of albumRows) {
      if (!a.is_favorite && !a.state_updated_at) continue
      const key = JSON.stringify([a.title, a.album_artist, a.year])
      const entry: BackupAlbum = {}
      if (a.is_favorite) entry.favorite = true
      if (a.state_updated_at) entry.stateUpdatedAt = new Date(a.state_updated_at).toISOString()
      albums[key] = entry
    }

    return {
      version: BACKUP_VERSION,
      appName: APP_NAME,
      createdAt,
      updatedAt: new Date().toISOString(),
      tracks,
      artists,
      albums,
    }
  }
}

let instance: LibraryBackupService | null = null
export function getLibraryBackup(): LibraryBackupService {
  if (!instance) instance = new LibraryBackupService()
  return instance
}
