import { basename, extname } from 'node:path'

// A sidecar .lrc is orphaned when no audio file in the SAME directory shares its
// basename. This is the inverse of sidecarPathFor (audio -> <name>.lrc): here we
// derive the audio stem a .lrc would belong to and check whether it exists among
// its directory siblings. Matching is case-insensitive to stay correct on
// case-preserving filesystems (macOS/Windows). Pure: no fs access.
export function isOrphanLrc(lrcName: string, audioStemsLower: ReadonlySet<string>): boolean {
  if (extname(lrcName).toLowerCase() !== '.lrc') return false
  const stem = basename(lrcName, extname(lrcName)).toLowerCase()
  return !audioStemsLower.has(stem)
}
