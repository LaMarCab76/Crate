import type { DbFolder } from '@shared/types/db'

export function isLocalLibraryDestination(
  folder: Pick<DbFolder, 'provider' | 'role'>,
): boolean {
  return folder.provider === 'local' && folder.role === 'library'
}
