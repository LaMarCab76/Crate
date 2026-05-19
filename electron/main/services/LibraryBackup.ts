// Portable library metadata. Each imported folder gets a hidden
// `.hifidelity-library.json` at its root that mirrors the user-modifiable
// pieces of state from the SQLite DB (plays, favorites, ratings, lyrics, EQ
// overrides). When the folder is reconnected on another machine the file is
// read first and its values are merged into the freshly-scanned DB rows.
//
// Sync vs async: every DB call here is sync (better-sqlite3), and the JSON
// payload is small (~tens of KB for thousands of tracks), so the writes are
// also sync. That lets `flushAll()` run reliably from `app.on('before-quit')`.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import type { Repos } from '../db/repositories'
import { getDatabase } from '../db/database'
import { getRepos } from '../db/repositories'
import type {
  BackupArtist,
  BackupEqOverride,
  BackupFile,
  BackupTrack,
} from '@shared/types/library-backup'
import { BACKUP_FILENAME, BACKUP_VERSION } from '@shared/types/library-backup'
import { isSupportedEqBandCount, normalizeEqBands } from '@shared/constants/equalizer'

const DEBOUNCE_MS = 2000
const APP_NAME = 'HiFidelity2'

function toPosixRelative(folderPath: string, absPath: string): string {
  return relative(folderPath, absPath).split(sep).join('/')
}

// Lexicographic max of two ISO-8601 timestamps (or null). Used to merge
// `last_played_date` without parsing it — ISO 8601 sorts correctly as text.
function pickMaxIso(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return a > b ? a : b
}

function parseExtMetaEq(jsonStr: string | null): BackupEqOverride | null {
  if (!jsonStr) return null
  try {
    const blob = JSON.parse(jsonStr) as { eqOverride?: BackupEqOverride }
    const eq = blob.eqOverride
    if (eq && Array.isArray(eq.bands) && isSupportedEqBandCount(eq.bands.length)) {
      return { enabled: !!eq.enabled, bands: normalizeEqBands(eq.bands) }
    }
  } catch {
    /* malformed JSON in the column — treat as absent */
  }
  return null
}

function writeJsonAtomic(target: string, payload: BackupFile): void {
  const tmp = target + '.tmp'
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
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
    const target = join(folderPath, BACKUP_FILENAME)
    if (!existsSync(target)) return null
    try {
      const raw = readFileSync(target, 'utf8')
      const parsed = JSON.parse(raw) as BackupFile
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
    })
    tx()
  }

  private mergeTracks(folderPath: string, tracks: Record<string, BackupTrack>): void {
    const update = this.db.prepare(`
      UPDATE tracks
      SET play_count = ?, last_played_date = ?, is_favorite = ?, rating = ?,
          extended_metadata = ?, state_updated_at = ?
      WHERE id = ?
    `)

    for (const [relPath, jt] of Object.entries(tracks)) {
      const absPath = join(folderPath, relPath)
      const dbTrack = this.repos.tracks.getByPath(absPath)
      if (!dbTrack) continue

      const jsonTs = jt.stateUpdatedAt ? Date.parse(jt.stateUpdatedAt) || 0 : 0
      const dbTs = dbTrack.state_updated_at ?? 0
      const jsonWins = jsonTs > dbTs

      const nextPlayCount = Math.max(dbTrack.play_count ?? 0, jt.playCount ?? 0)
      const nextLastPlayed = pickMaxIso(dbTrack.last_played_date, jt.lastPlayedAt ?? null)
      const nextFavorite =
        jsonWins && jt.favorite !== undefined ? (jt.favorite ? 1 : 0) : dbTrack.is_favorite
      const nextRating =
        jsonWins && jt.rating !== undefined ? jt.rating : dbTrack.rating

      // EQ override lives inside extended_metadata JSON. JSON wins when newer,
      // and also fills in when DB has none (the "no risk of losing local
      // tweaks" case).
      let nextExtMeta = dbTrack.extended_metadata
      if (jt.eqOverride !== undefined) {
        const dbEq = parseExtMetaEq(dbTrack.extended_metadata)
        const takeJson = jsonWins || dbEq === null
        if (takeJson) {
          let blob: Record<string, unknown> = {}
          if (dbTrack.extended_metadata) {
            try {
              blob = (JSON.parse(dbTrack.extended_metadata) as Record<string, unknown>) ?? {}
            } catch {
              blob = {}
            }
          }
          if (jt.eqOverride === null) {
            delete blob.eqOverride
          } else if (Array.isArray(jt.eqOverride.bands) && isSupportedEqBandCount(jt.eqOverride.bands.length)) {
            blob.eqOverride = {
              enabled: !!jt.eqOverride.enabled,
              bands: normalizeEqBands(jt.eqOverride.bands),
            }
          }
          nextExtMeta = Object.keys(blob).length === 0 ? null : JSON.stringify(blob)
        }
      }

      const nextStateTs = Math.max(dbTs, jsonTs)
      update.run(
        nextPlayCount,
        nextLastPlayed,
        nextFavorite,
        nextRating,
        nextExtMeta,
        nextStateTs > 0 ? nextStateTs : null,
        dbTrack.id,
      )

      if (jt.lyrics?.lrc) {
        const existing = this.repos.lyrics.get(dbTrack.id)
        if (!existing) {
          this.repos.lyrics.set(
            dbTrack.id,
            jt.lyrics.lrc,
            jt.lyrics.source ?? null,
            jt.lyrics.language ?? null,
          )
        }
      }
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
      const jsonTs = ja.stateUpdatedAt ? Date.parse(ja.stateUpdatedAt) || 0 : 0
      const dbTs = row.state_updated_at ?? 0
      const jsonWins = jsonTs > dbTs
      if (jsonWins && ja.favorite !== undefined) {
        update.run(ja.favorite ? 1 : 0, Math.max(dbTs, jsonTs), row.id)
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

  scheduleWriteAll(): void {
    if (!this.enabled) return
    for (const folder of this.repos.folders.list()) {
      this.scheduleWriteForFolder(folder.id)
    }
  }

  flushAll(): void {
    // Drain any pending debounced writes. Runs even if the feature was
    // disabled mid-session so that the on-disk JSON reflects the last good
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
      const target = join(folderPath, BACKUP_FILENAME)
      writeJsonAtomic(target, payload)
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
    const target = join(folderPath, BACKUP_FILENAME)
    if (existsSync(target)) {
      try {
        const existing = JSON.parse(readFileSync(target, 'utf8')) as BackupFile
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
          extended_metadata: string | null
          state_updated_at: number | null
        }
      >(
        `SELECT id, path, play_count, last_played_date, is_favorite, rating,
                extended_metadata, state_updated_at
         FROM tracks WHERE folder_id = ?`,
      )
      .all(folderId)

    const lyricsByTrack = new Map<
      number,
      { lrc: string; language: string | null; source: string | null }
    >()
    const lyricsRows = this.db
      .prepare<
        [number],
        { track_id: number; lrc_content: string; language: string | null; source: string | null }
      >(
        `SELECT l.track_id, l.lrc_content, l.language, l.source
         FROM lyrics l JOIN tracks t ON t.id = l.track_id
         WHERE t.folder_id = ?`,
      )
      .all(folderId)
    for (const lr of lyricsRows) {
      lyricsByTrack.set(lr.track_id, { lrc: lr.lrc_content, language: lr.language, source: lr.source })
    }

    const tracks: Record<string, BackupTrack> = {}
    for (const row of trackRows) {
      const eq = parseExtMetaEq(row.extended_metadata)
      const lyrics = lyricsByTrack.get(row.id) ?? null
      const isDefault =
        (row.play_count ?? 0) === 0 &&
        !row.last_played_date &&
        (row.is_favorite ?? 0) === 0 &&
        row.rating == null &&
        eq == null &&
        !lyrics
      if (isDefault) continue
      const rel = toPosixRelative(folderPath, row.path)
      const entry: BackupTrack = {}
      if (row.play_count > 0) entry.playCount = row.play_count
      if (row.last_played_date) entry.lastPlayedAt = row.last_played_date
      if (row.is_favorite) entry.favorite = true
      if (row.rating != null) entry.rating = row.rating
      if (eq) entry.eqOverride = eq
      if (lyrics) entry.lyrics = lyrics
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

    return {
      version: BACKUP_VERSION,
      appName: APP_NAME,
      createdAt,
      updatedAt: new Date().toISOString(),
      tracks,
      artists,
    }
  }
}

let instance: LibraryBackupService | null = null
export function getLibraryBackup(): LibraryBackupService {
  if (!instance) instance = new LibraryBackupService()
  return instance
}
