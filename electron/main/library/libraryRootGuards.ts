import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { DbFolder } from '@shared/types/db'

function comparable(path: string): string {
  const normalized = resolve(path).normalize('NFC').replace(/[\\/]+$/, '') || sep
  return process.platform === 'win32' || process.platform === 'darwin'
    ? normalized.toLocaleLowerCase('en-US')
    : normalized
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

export async function canonicalLibraryRoot(path: string): Promise<string> {
  return resolve(await realpath(path))
}

export function findOverlappingLibraryRoot(
  candidatePath: string,
  folders: Pick<DbFolder, 'id' | 'path' | 'name'>[],
): { folder: Pick<DbFolder, 'id' | 'path' | 'name'>; exact: boolean } | null {
  const candidate = comparable(candidatePath)
  for (const folder of folders) {
    const registered = comparable(folder.path)
    if (candidate === registered) return { folder, exact: true }
    if (within(candidate, registered) || within(registered, candidate)) {
      return { folder, exact: false }
    }
  }
  return null
}

/**
 * Revalidates a folder captured before asynchronous filesystem work against
 * the current DB row. A changed root is as unsafe as a changed role: results
 * collected from the old root must not be applied to the new location.
 */
export function requireCurrentLocalLibraryFolder(
  expected: Pick<DbFolder, 'id' | 'path'>,
  current: Pick<DbFolder, 'id' | 'path' | 'provider' | 'role'> | null | undefined,
): void {
  if (
    !current ||
    current.id !== expected.id ||
    current.provider !== 'local' ||
    current.role !== 'library'
  ) {
    throw new Error(`Folder ${expected.id} is no longer a local library`)
  }
  if (current.path !== expected.path || /^onedrive:\/\//i.test(current.path)) {
    throw new Error(`Folder ${expected.id} root changed during the library scan`)
  }
}

export function requirePathInsideLocalLibrary(
  folder: Pick<DbFolder, 'path' | 'provider' | 'role'> | null | undefined,
  filePath: string,
): string {
  if (!folder || folder.provider !== 'local' || folder.role !== 'library') {
    throw new Error('Path no longer belongs to a local library')
  }
  if (/^onedrive:\/\//i.test(folder.path) || /^onedrive:\/\//i.test(filePath)) {
    throw new Error('A synthetic OneDrive URI is not a local library path')
  }
  const root = resolve(folder.path)
  const target = resolve(filePath)
  const rel = relative(root, target)
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
    throw new Error('Path is outside its registered local library')
  }
  return target
}
