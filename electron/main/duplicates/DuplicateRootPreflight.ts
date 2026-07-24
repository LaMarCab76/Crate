import { resolve } from 'node:path'
import type {
  DuplicateAnalysisBlockedFolder,
  DuplicateAnalysisBlocker,
} from '@shared/types/duplicates'
import type { DbFolder } from '@shared/types/db'
import type { LocalAccessStatus } from '@shared/types/library-locations'
import type { DuplicateAnalysisPreflight } from './DuplicateDetectionService.ts'

export interface DuplicateRootPreflightDependencies {
  getFolder(folderId: number): DbFolder | undefined
  inspect(rootPath: string): Promise<LocalAccessStatus>
  platform?: string
}

interface LocalRoot {
  path: string
  folders: DbFolder[]
}

function comparableRoot(path: string, platform: string): string {
  const normalized = resolve(path).normalize('NFC')
  return platform === 'darwin' || platform === 'win32'
    ? normalized.toLocaleLowerCase('en-US')
    : normalized
}

function quotedNames(folders: readonly DuplicateAnalysisBlockedFolder[]): string {
  return folders.map(folder => `“${folder.name}”`).join(', ')
}

function blockerFor(folders: DuplicateAnalysisBlockedFolder[]): DuplicateAnalysisBlocker {
  const unavailable = folders.filter(folder => folder.state === 'unavailable')
  const permissionRequired = folders.filter(folder => folder.state === 'permission_required')
  const multiple = folders.length > 1
  const code = unavailable.length > 0
    ? 'local_library_unavailable'
    : 'local_library_permission_required'
  const message = unavailable.length > 0
    ? multiple
      ? `${folders.length} bibliotecas necesarias para el análisis no están conectadas o accesibles: ${quotedNames(folders)}. Conectalas y volvé a analizar. No se marcó ninguna pista como dañada.`
      : `La biblioteca ${quotedNames(folders)} no está conectada o accesible. Conectala y volvé a analizar. No se marcó ninguna pista como dañada.`
    : multiple
      ? `Crate necesita acceso de lectura a ${permissionRequired.length} bibliotecas: ${quotedNames(permissionRequired)}. Concedé acceso y volvé a analizar. No se marcó ninguna pista como dañada.`
      : `Crate necesita acceso de lectura a la biblioteca ${quotedNames(permissionRequired)}. Concedé acceso y volvé a analizar. No se marcó ninguna pista como dañada.`
  return {
    code,
    message,
    retryable: true,
    requiresRestart: false,
    affectedFolders: folders,
    detail: folders.map(folder => `${folder.path}: ${folder.state}`).join('\n'),
  }
}

/**
 * Checks each involved local root once. It deliberately receives all tracks so
 * grouping happens before any per-track fingerprint row can be started.
 */
export function createDuplicateRootPreflight(
  dependencies: DuplicateRootPreflightDependencies,
): DuplicateAnalysisPreflight {
  const platform = dependencies.platform ?? process.platform
  return async ({ tracks, signal }) => {
    const roots = new Map<string, LocalRoot>()
    const seenFolderIds = new Set<number>()
    for (const track of tracks) {
      if (track.provider !== 'local' || seenFolderIds.has(track.folderId)) continue
      seenFolderIds.add(track.folderId)
      const folder = dependencies.getFolder(track.folderId)
      if (!folder || folder.provider !== 'local' || folder.role !== 'library') continue
      const key = comparableRoot(folder.path, platform)
      const root = roots.get(key)
      if (root) root.folders.push(folder)
      else roots.set(key, { path: folder.path, folders: [folder] })
    }

    const blocked: DuplicateAnalysisBlockedFolder[] = []
    for (const root of roots.values()) {
      signal?.throwIfAborted()
      const status = await dependencies.inspect(root.path)
      signal?.throwIfAborted()
      if (status.canRead) continue
      if (status.state !== 'unavailable' && status.state !== 'permission_required') continue
      for (const folder of root.folders) {
        blocked.push({
          folderId: folder.id,
          name: folder.name,
          path: folder.path,
          state: status.state,
        })
      }
    }
    return blocked.length > 0 ? blockerFor(blocked) : null
  }
}
