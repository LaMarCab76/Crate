import { existsSync } from 'node:fs'
import { extname } from 'node:path'
import { File, FlacTag } from 'node-taglib-sharp'

// Removes the lyrics Xiph fields from a FLAC file. Best-effort; used by
// LyricsService.remove when the caller asks to also strip embedded tags.
export function stripFlacLyrics(path: string): boolean {
  if (!existsSync(path) || extname(path).toLowerCase() !== '.flac') return false
  let file: File | undefined
  try {
    file = File.createFromPath(path)
    if (!file.isWritable || !(file.tag instanceof FlacTag)) return false
    const x = file.tag.xiphComment
    for (const f of ['UNSYNCEDLYRICS', 'LYRICS', 'SYNCEDLYRICS', 'LYRICS_SOURCE']) {
      x.removeField(f)
    }
    file.save()
    return true
  } catch {
    return false
  } finally {
    file?.dispose()
  }
}
