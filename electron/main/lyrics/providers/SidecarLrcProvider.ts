import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'
import type { LyricsResult } from '@shared/types/lyrics'
import { isSyncedLrc } from '../../../../shared/lyrics/lrc.ts'

// The conventional sidecar path: <dir>/<name>.lrc next to the audio file.
export function sidecarPathFor(audioPath: string): string {
  const p = parse(audioPath)
  return join(dirname(audioPath), `${p.name}.lrc`)
}

export function readSidecarLrc(audioPath: string): LyricsResult | null {
  const lrcPath = sidecarPathFor(audioPath)
  if (!existsSync(lrcPath)) return null
  let content: string
  try {
    content = readFileSync(lrcPath, 'utf8')
  } catch {
    return null
  }
  if (!content.trim()) return null

  const synced = isSyncedLrc(content)
  return {
    source: 'sidecar',
    plainLyrics: synced ? undefined : content,
    syncedLyricsLrc: synced ? content : undefined,
    instrumental: false,
    confidence: 1,
  }
}
