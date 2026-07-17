import { isAbsolute, relative, resolve } from 'node:path'
import type { DbFolder, DbTrack } from '@shared/types/db'

function isCloudIdentity(value: string): boolean {
  return /^onedrive:\/\//i.test(value)
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Final DB boundary before a service gives a track path to the filesystem.
 * Provider/scheme checks deliberately happen before node:path resolution.
 */
export function requireLocalLibraryTrackPath(args: {
  track: Pick<DbTrack, 'id' | 'path' | 'provider' | 'folder_id'>
  folder: Pick<DbFolder, 'id' | 'path' | 'provider' | 'role'> | null | undefined
  expectedPath?: string
  label?: string
}): string {
  const label = args.label ?? 'Track'
  if (args.track.provider !== 'local' || isCloudIdentity(args.track.path)) {
    throw new Error(`${label} is not a local track`)
  }
  if (args.expectedPath !== undefined && args.track.path !== args.expectedPath) {
    throw new Error(`${label} path changed after preview`)
  }

  const folder = args.folder
  if (
    !folder ||
    folder.id !== args.track.folder_id ||
    folder.provider !== 'local' ||
    folder.role !== 'library' ||
    isCloudIdentity(folder.path)
  ) {
    throw new Error(`${label} no longer belongs to a local library`)
  }

  const root = resolve(folder.path)
  const path = resolve(args.track.path)
  if (!isInside(root, path)) throw new Error(`${label} path is outside its registered library`)
  return path
}
