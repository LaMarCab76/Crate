import { accessSync, constants as fsConstants, copyFileSync, existsSync } from 'node:fs'
import { extname } from 'node:path'
import { File, FlacTag } from 'node-taglib-sharp'
import type { LyricsFailureReason } from '@shared/types/lyrics'
import { hasEmbeddedLyrics } from '../providers/EmbeddedLyricsProvider'

export interface FlacWriteInput {
  path: string
  plainLyrics: string | null
  syncedLyricsLrc: string | null
  sourceId: string | null // -> LYRICS_SOURCE = LRCLIB:{id}
  overwriteExisting: boolean
  createBackup: boolean
}

export interface FlacWriteResult {
  ok: boolean
  reason?: LyricsFailureReason
  verified: boolean
  backupPath?: string
}

const PLAIN_FIELD = 'UNSYNCEDLYRICS'
const SYNCED_FIELDS = ['LYRICS', 'SYNCEDLYRICS'] as const
const SOURCE_FIELD = 'LYRICS_SOURCE'

function fail(reason: LyricsFailureReason): FlacWriteResult {
  return { ok: false, reason, verified: false }
}

// Backup the original once (skip if a .cratebak already exists). .cratebak is
// neither a dotfile nor an audio extension, so the FolderWatcher ignores it.
function backupOnce(path: string): string | null {
  const bak = `${path}.cratebak`
  if (existsSync(bak)) return bak
  copyFileSync(path, bak)
  return bak
}

// Writes lyrics into a FLAC's Xiph comment following the spec's "no romper
// archivos" sequence: validate, detect-existing, backup, write, reopen+verify.
export function writeFlacLyrics(input: FlacWriteInput): FlacWriteResult {
  const { path } = input

  if (!existsSync(path)) return fail('file_not_found')
  if (extname(path).toLowerCase() !== '.flac') return fail('not_flac')

  try {
    accessSync(path, fsConstants.W_OK)
  } catch {
    return fail('file_not_writable')
  }

  // Existing-lyrics guard (uses its own short-lived File handle).
  const existing = hasEmbeddedLyrics(path)
  if ((existing.synced || existing.plain) && !input.overwriteExisting) {
    return fail('existing_lyrics')
  }

  // Backup before any mutation.
  let backupPath: string | undefined
  if (input.createBackup) {
    try {
      backupPath = backupOnce(path) ?? undefined
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EACCES' || code === 'EROFS' || code === 'EPERM') return fail('backup_failed')
      return fail('backup_failed')
    }
  }

  let file: File | undefined
  try {
    file = File.createFromPath(path)
    if (file.isPossiblyCorrupt) return fail('write_failed')
    if (!file.isWritable) return fail('file_not_writable')
    if (!(file.tag instanceof FlacTag)) return fail('not_flac')

    const x = file.tag.xiphComment
    if (input.overwriteExisting) {
      x.removeField(PLAIN_FIELD)
      for (const f of SYNCED_FIELDS) x.removeField(f)
    }
    if (input.plainLyrics) x.setFieldAsStrings(PLAIN_FIELD, input.plainLyrics)
    if (input.syncedLyricsLrc) {
      for (const f of SYNCED_FIELDS) x.setFieldAsStrings(f, input.syncedLyricsLrc)
    }
    if (input.sourceId) x.setFieldAsStrings(SOURCE_FIELD, `LRCLIB:${input.sourceId}`)

    file.save()
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EBUSY') return fail('file_locked')
    return fail('write_failed')
  } finally {
    file?.dispose()
  }

  // Reopen and verify the fields landed.
  let verify: File | undefined
  try {
    verify = File.createFromPath(path)
    if (!(verify.tag instanceof FlacTag)) return { ok: false, reason: 'verification_failed', verified: false, backupPath }
    const x = verify.tag.xiphComment
    const okPlain = !input.plainLyrics || x.getFieldFirstValue(PLAIN_FIELD) === input.plainLyrics
    const okSynced = !input.syncedLyricsLrc || x.getFieldFirstValue('SYNCEDLYRICS') === input.syncedLyricsLrc
    if (!okPlain || !okSynced) {
      return { ok: false, reason: 'verification_failed', verified: false, backupPath }
    }
  } catch {
    return { ok: false, reason: 'verification_failed', verified: false, backupPath }
  } finally {
    verify?.dispose()
  }

  return { ok: true, verified: true, backupPath }
}
