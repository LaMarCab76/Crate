import { posix } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { BackupFile } from '@shared/types/library-backup'

const PORTABLE_VERSION = 1

function collection(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

export function parsePortableLibraryManifest(text: string): BackupFile | null {
  let value: unknown
  try {
    value = parseYaml(text)
  } catch {
    return null
  }
  if (!collection(value) || value.version !== PORTABLE_VERSION) return null
  if (!collection(value.tracks) || !collection(value.artists) || !collection(value.albums)) return null
  if (typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') return null
  return value as unknown as BackupFile
}

export function stringifyPortableLibraryManifest(manifest: BackupFile): string {
  return stringifyYaml(manifest)
}

function normalizedRemotePath(value: string): string {
  const withRoot = value.startsWith('/') ? value : `/${value}`
  return posix.normalize(withRoot)
}

/** Convert Graph's display path to the same safe POSIX-relative key used by
 * local `.crate/library.yaml` files. */
export function cloudRelativePath(rootRemotePath: string, itemRemotePath: string): string | null {
  const root = normalizedRemotePath(rootRemotePath)
  const item = normalizedRemotePath(itemRemotePath)
  const relative = posix.relative(root, item)
  if (!relative || relative.startsWith('../') || relative === '..' || posix.isAbsolute(relative)) return null
  const parts = relative.split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || part.includes('\0'))) return null
  return relative
}

export function isSafePortablePath(value: string): boolean {
  if (!value || value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false
  return value.split('/').every(part => Boolean(part) && part !== '.' && part !== '..')
}
