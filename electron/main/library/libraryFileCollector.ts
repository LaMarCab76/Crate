import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

export class LibraryCollectionError extends Error {
  readonly path: string

  constructor(path: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(`Could not completely scan ${path}: ${detail}`, { cause })
    this.name = 'LibraryCollectionError'
    this.path = path
  }
}

// A returned array always represents a complete traversal. Any unreadable
// directory rejects the scan so callers cannot confuse partial results with
// files that were actually removed.
export async function collectLibraryFiles(
  root: string,
  accept: (name: string) => boolean,
): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      throw new LibraryCollectionError(dir, err)
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue
      if (ent.isSymbolicLink()) continue
      const full = join(dir, ent.name)
      if (ent.isDirectory()) await walk(full)
      else if (ent.isFile() && accept(ent.name)) out.push(full)
    }
  }
  await walk(root)
  return out
}
