import { randomUUID } from 'node:crypto'
import { existsSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { sidecarPathFor } from '../providers/SidecarLrcProvider.ts'

// Atomic write (tmp + rename), UTF-8, next to the audio file. Same atomic
// pattern as LibraryBackup.writeJsonAtomic.
export function writeSidecarLrc(audioPath: string, content: string): string {
  const target = sidecarPathFor(audioPath)
  const tmp = `${target}.tmp-${randomUUID()}`
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx' })
    try {
      renameSync(tmp, target)
    } catch (err) {
      // Windows may reject rename-over-existing. Keep the previous sidecar in
      // a reversible staging path until the new file is published.
      if (!existsSync(target)) throw err
      const previous = `${target}.previous-${randomUUID()}`
      renameSync(target, previous)
      try {
        renameSync(tmp, target)
      } catch (publishErr) {
        if (!existsSync(target)) renameSync(previous, target)
        throw publishErr
      }
      try { unlinkSync(previous) } catch { /* published target is authoritative */ }
    }
  } catch (err) {
    try { unlinkSync(tmp) } catch { /* best-effort temp cleanup */ }
    throw err
  }
  return target
}

export function removeSidecarLrc(audioPath: string): void {
  const target = sidecarPathFor(audioPath)
  if (existsSync(target)) unlinkSync(target)
}
