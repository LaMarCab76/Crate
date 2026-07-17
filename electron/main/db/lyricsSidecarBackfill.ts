import { createHash, randomUUID } from 'node:crypto'
import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { sidecarPathFor } from '../lyrics/providers/SidecarLrcProvider.ts'
import { writeSidecarLrc } from '../lyrics/writers/SidecarLrcWriter.ts'

interface BackfillRow {
  trackId: number
  path: string
  synced: string | null
  plain: string | null
  source: string
  sourceId: string | null
  sourceUrl: string | null
  confidence: number
  instrumental: number
  isUserEdited: number
  fetchedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface LyricsRecoveryPayload {
  version: 1
  createdAt: string
  rowCount: number
  entriesSha256: string
  entries: BackfillRow[]
}

function checksum(entries: BackfillRow[]): string {
  return createHash('sha256').update(JSON.stringify(entries), 'utf8').digest('hex')
}

export function requireLocalLyricsSidecarSource(path: string): string {
  if (/^onedrive:\/\//i.test(path)) {
    throw new Error('OneDrive tracks cannot be materialized as local lyrics sidecars')
  }
  return path
}

export function createLyricsRecoveryPayload(
  entries: BackfillRow[],
  createdAt = new Date().toISOString(),
): LyricsRecoveryPayload {
  return {
    version: 1,
    createdAt,
    rowCount: entries.length,
    entriesSha256: checksum(entries),
    entries,
  }
}

export function verifyLyricsRecoveryPayload(payload: LyricsRecoveryPayload): void {
  if (payload.version !== 1 || !Array.isArray(payload.entries)) {
    throw new Error('invalid lyrics recovery payload')
  }
  if (payload.rowCount !== payload.entries.length) {
    throw new Error('lyrics recovery row count mismatch')
  }
  if (payload.entriesSha256 !== checksum(payload.entries)) {
    throw new Error('lyrics recovery checksum mismatch')
  }
}

function writeRecoveryArchive(userDataPath: string, rows: BackfillRow[]): string {
  const dir = join(userDataPath, 'lyrics-recovery')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = join(dir, `track-lyrics-before-0019-${stamp}-${randomUUID()}.json`)
  const tmp = `${target}.tmp-${randomUUID()}`
  const payload = createLyricsRecoveryPayload(rows)
  try {
    writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', flag: 'wx' })
    renameSync(tmp, target)
  } catch (err) {
    try { unlinkSync(tmp) } catch { /* best-effort temp cleanup */ }
    throw err
  }

  const verified = JSON.parse(readFileSync(target, 'utf8')) as LyricsRecoveryPayload
  verifyLyricsRecoveryPayload(verified)
  return target
}

export function retryLyricsRecoveryArchives(
  userDataPath: string,
): { recovered: number; failed: number } {
  const dir = join(userDataPath, 'lyrics-recovery')
  if (!existsSync(dir)) return { recovered: 0, failed: 0 }

  let recovered = 0
  let failed = 0
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const archivePath = join(dir, name)
    let payload: LyricsRecoveryPayload
    try {
      payload = JSON.parse(readFileSync(archivePath, 'utf8')) as LyricsRecoveryPayload
      verifyLyricsRecoveryPayload(payload)
    } catch (err) {
      console.warn(`[db] ignoring invalid lyrics recovery ${archivePath}:`, err)
      continue
    }

    for (const row of payload.entries) {
      const content = row.synced ?? row.plain
      if (!content || !row.path) continue
      try {
        requireLocalLyricsSidecarSource(row.path)
        const target = sidecarPathFor(row.path)
        if (existsSync(target)) continue
        // Recovery files are local but still treated as untrusted input. Only
        // write beside a real, non-symlink audio file from the archived DB row.
        const audio = lstatSync(row.path)
        if (!audio.isFile() || audio.isSymbolicLink()) throw new Error('audio path is not a regular file')
        writeSidecarLrc(row.path, content)
        if (readFileSync(target, 'utf8') !== content) throw new Error('sidecar verification failed')
        recovered++
      } catch {
        failed++
      }
    }
  }
  return { recovered, failed }
}

// Preflight for migration 0019. Every legacy row is first copied to a verified,
// checksummed recovery archive under userData. Only after that durable copy
// exists do we attempt sidecars. A sidecar failure is reported but cannot lose
// data because the archive remains available for a later retry/import.
export function materializeLyricsSidecars(
  db: BetterSqliteDatabase,
  userDataPath: string,
): { archived: number; written: number; failed: number; recoveryPath: string | null } {
  const retried = retryLyricsRecoveryArchives(userDataPath)
  if (retried.recovered > 0) {
    console.log(`[db] recovered ${retried.recovered} lyrics sidecar(s) from retained archives`)
  }
  const tableExists = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'track_lyrics'`)
    .get()
  if (!tableExists) return { archived: 0, written: 0, failed: 0, recoveryPath: null }

  // Do not swallow a schema mismatch: allowing migrations to continue would
  // drop data we failed to understand.
  const rows = db
    .prepare(
      `SELECT l.track_id AS trackId, t.path AS path,
              l.synced_lyrics_lrc AS synced, l.plain_lyrics AS plain,
              l.source AS source, l.source_id AS sourceId, l.source_url AS sourceUrl,
              l.confidence AS confidence, l.instrumental AS instrumental,
              l.is_user_edited AS isUserEdited, l.fetched_at AS fetchedAt,
              l.created_at AS createdAt, l.updated_at AS updatedAt
         FROM track_lyrics l
         JOIN tracks t ON t.id = l.track_id
        ORDER BY l.track_id ASC`,
    )
    .all() as BackfillRow[]

  if (rows.length === 0) return { archived: 0, written: 0, failed: 0, recoveryPath: null }
  const recoveryPath = writeRecoveryArchive(userDataPath, rows)

  let written = 0
  let failed = 0
  for (const row of rows) {
    const content = row.synced ?? row.plain
    if (!content || !row.path) continue
    try {
      requireLocalLyricsSidecarSource(row.path)
      const target = sidecarPathFor(row.path)
      if (existsSync(target)) {
        // A readable existing sidecar is authoritative and must not be replaced.
        readFileSync(target, 'utf8')
        continue
      }
      writeSidecarLrc(row.path, content)
      if (readFileSync(target, 'utf8') !== content) {
        throw new Error(`sidecar verification failed for ${target}`)
      }
      written++
    } catch (err) {
      failed++
      console.warn(
        `[db] could not materialize lyrics for track ${row.trackId}; recovery retained at ${recoveryPath}:`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }
  console.log(
    `[db] archived ${rows.length} legacy lyrics row(s), materialized ${written}, failed ${failed}`,
  )
  return { archived: rows.length, written, failed, recoveryPath }
}
