import { extname } from 'node:path'
import { File, FlacTag } from 'node-taglib-sharp'
import type { LyricsResult } from '@shared/types/lyrics'
import { isSyncedLrc } from '../../../../shared/lyrics/lrc.ts'

function firstNonEmpty(...values: Array<string | undefined | null>): string | null {
  for (const v of values) {
    if (v && v.trim()) return v
  }
  return null
}

// Reads embedded lyrics. For FLAC, inspects the Xiph fields the spec writes
// (SYNCEDLYRICS / LYRICS / UNSYNCEDLYRICS); for any format, falls back to the
// generic Tag.lyrics. Synced vs plain is decided by presence of [mm:ss] tags.
export function readEmbeddedLyrics(path: string): LyricsResult | null {
  let file: File | undefined
  try {
    file = File.createFromPath(path)
    const tag = file.tag

    let synced: string | null = null
    let plain: string | null = null

    if (tag instanceof FlacTag) {
      const x = tag.xiphComment
      const lyricsField = firstNonEmpty(x.getFieldFirstValue('LYRICS'))
      synced = firstNonEmpty(
        x.getFieldFirstValue('SYNCEDLYRICS'),
        lyricsField && isSyncedLrc(lyricsField) ? lyricsField : null,
      )
      plain = firstNonEmpty(
        x.getFieldFirstValue('UNSYNCEDLYRICS'),
        lyricsField && !isSyncedLrc(lyricsField) ? lyricsField : null,
      )
    }

    // Generic fallback (covers non-FLAC, e.g. ID3 USLT).
    const generic = firstNonEmpty(tag.lyrics)
    if (generic) {
      if (isSyncedLrc(generic)) synced = synced ?? generic
      else plain = plain ?? generic
    }

    if (!synced && !plain) return null

    return {
      source: 'embedded',
      plainLyrics: plain ?? undefined,
      syncedLyricsLrc: synced ?? undefined,
      instrumental: false,
      confidence: 1,
    }
  } catch {
    return null
  } finally {
    file?.dispose()
  }
}

// Light check used by the embed overwrite-guard / dry-run (FLAC only).
export function hasEmbeddedLyrics(path: string): { synced: boolean; plain: boolean } {
  if (extname(path).toLowerCase() !== '.flac') return { synced: false, plain: false }
  let file: File | undefined
  try {
    file = File.createFromPath(path)
    if (!(file.tag instanceof FlacTag)) return { synced: false, plain: false }
    const x = file.tag.xiphComment
    const lyricsField = firstNonEmpty(x.getFieldFirstValue('LYRICS'))
    const synced = Boolean(
      firstNonEmpty(x.getFieldFirstValue('SYNCEDLYRICS')) ||
        (lyricsField && isSyncedLrc(lyricsField)),
    )
    const plain = Boolean(
      firstNonEmpty(x.getFieldFirstValue('UNSYNCEDLYRICS')) ||
        (lyricsField && !isSyncedLrc(lyricsField)),
    )
    return { synced, plain }
  } catch {
    return { synced: false, plain: false }
  } finally {
    file?.dispose()
  }
}
