import { resolve } from 'node:path'
import type { LibraryProvider, LibraryRole } from '@shared/types/library-locations'
import { platform } from 'node:os'
import { computerTerms, desktopPlatform } from '../../../shared/utils/computerTerms.ts'

const COMPUTER = computerTerms(desktopPlatform(platform()))

interface PcTargetFolder {
  path: string
  provider: LibraryProvider
  role: LibraryRole
}

function isOneDriveUri(value: string): boolean {
  return /^onedrive:\/\//i.test(value)
}

/** Resolve only after proving the value is not a synthetic cloud identity. */
export function requireRegisteredLocalLibraryPath(
  rawPath: string,
  folders: readonly PcTargetFolder[],
): string {
  if (!rawPath || isOneDriveUri(rawPath)) {
    throw new Error(`${COMPUTER.short} destination must be a registered local library`)
  }

  const requested = resolve(rawPath)
  const folder = folders.find(item =>
    item.provider === 'local' &&
    item.role === 'library' &&
    !isOneDriveUri(item.path) &&
    resolve(item.path) === requested,
  )
  if (!folder) throw new Error(`${COMPUTER.short} destination must be a registered local library`)
  return resolve(folder.path)
}
