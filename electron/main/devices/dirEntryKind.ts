// Resolving a directory entry's type. fs.Dirent and fs.Stats both expose the
// same isDirectory()/isFile()/isSymbolicLink() probes, so we classify either.
//
// FAT/exFAT volumes mounted via macOS fskit can return Dirents whose type is
// unknown — every probe returns false. The walker must detect that ('unknown')
// and stat the path to get the real type, otherwise the whole subtree is
// silently skipped (the root cause of "0 temas indexados" with a full device).
export interface TypeProbe {
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
}

export type EntryKind = 'dir' | 'file' | 'link' | 'unknown'

export function probeKind(probe: TypeProbe): EntryKind {
  if (probe.isSymbolicLink()) return 'link'
  if (probe.isDirectory()) return 'dir'
  if (probe.isFile()) return 'file'
  return 'unknown'
}
