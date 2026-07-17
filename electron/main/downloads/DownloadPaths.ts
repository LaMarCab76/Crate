import { isAbsolute, relative, resolve } from 'node:path'
import type { DbFolder } from '@shared/types/db'

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const MAX_PATH_PART_LENGTH = 80

export function sanitizePathPart(value: string, fallback: string): string {
  let cleaned = value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .slice(0, MAX_PATH_PART_LENGTH)
    .trim()
  if (WINDOWS_RESERVED_NAME.test(cleaned)) cleaned = `_${cleaned}`
  return cleaned || fallback
}

export function downloadPartPath(finalPath: string, jobId: string): string {
  return `${finalPath}.part.${sanitizePathPart(jobId, 'job')}`
}

/**
 * Final authority check before a download path is handed to the filesystem.
 * The folder is expected to have been fetched from the DB at the boundary,
 * rather than retained from when the download started.
 */
export function requireLocalLibraryDownloadPath(
  folder: Pick<DbFolder, 'path' | 'provider' | 'role'> | null | undefined,
  filePath: string,
): string {
  if (!folder || folder.provider !== 'local' || folder.role !== 'library') {
    throw new Error('Downloads require a local library destination.')
  }
  if (/^onedrive:\/\//i.test(folder.path) || /^onedrive:\/\//i.test(filePath)) {
    throw new Error('Downloads require a local filesystem destination.')
  }

  const root = resolve(folder.path)
  const target = resolve(filePath)
  const rel = relative(root, target)
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
    throw new Error('Download path is outside its registered destination library.')
  }
  return target
}
