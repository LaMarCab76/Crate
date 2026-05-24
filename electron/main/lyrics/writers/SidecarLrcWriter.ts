import { existsSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { sidecarPathFor } from '../providers/SidecarLrcProvider'

// Atomic write (tmp + rename), UTF-8, next to the audio file. Same atomic
// pattern as LibraryBackup.writeJsonAtomic.
export function writeSidecarLrc(audioPath: string, content: string): string {
  const target = sidecarPathFor(audioPath)
  const tmp = `${target}.tmp`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, target)
  return target
}

export function removeSidecarLrc(audioPath: string): void {
  const target = sidecarPathFor(audioPath)
  try {
    if (existsSync(target)) unlinkSync(target)
  } catch {
    // best-effort cleanup; ignore
  }
}
