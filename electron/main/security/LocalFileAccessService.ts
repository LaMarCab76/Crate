import { constants as fsConstants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type {
  LocalAccessRequestResult,
  LocalAccessState,
  LocalAccessStatus,
} from '@shared/types/library-locations'

export interface LocalAccessDialogResult {
  canceled: boolean
  filePath: string | null
}

export interface LocalFileAccessDependencies {
  access(path: string, mode: number): Promise<void>
  realpath(path: string): Promise<string>
  isDirectory(path: string): Promise<boolean>
  showOpenDirectory(rootPath: string, owner?: unknown): Promise<LocalAccessDialogResult>
  openPrivacySettings(): Promise<void>
}

export interface LocalAccessRunOptions {
  owner?: unknown
  interactive?: boolean
  retryOnce?: boolean
}

function errorCode(error: unknown): string | null {
  return typeof error === 'object' && error != null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '') || null
    : null
}

function stateForError(error: unknown): Exclude<LocalAccessState, 'ready'> | null {
  const code = errorCode(error)
  if (code === 'ENOENT' || code === 'ENODEV' || code === 'ENXIO') return 'unavailable'
  if (code === 'EROFS') return 'read_only'
  if (code === 'EACCES' || code === 'EPERM') return 'permission_required'
  return null
}

function detailFor(state: LocalAccessState): string | null {
  switch (state) {
    case 'ready': return null
    case 'permission_required': return 'Crate necesita autorización para leer y modificar esta ubicación.'
    case 'unavailable': return 'La ubicación no está conectada o ya no existe.'
    case 'read_only': return 'El volumen está montado como solo lectura.'
  }
}

function status(
  state: LocalAccessState,
  canRead: boolean,
  canWrite: boolean,
  detail = detailFor(state),
): LocalAccessStatus {
  return { state, canRead, canWrite, detail }
}

function statusForOperationError(
  state: Exclude<LocalAccessState, 'ready'>,
  mode: 'read' | 'write',
): LocalAccessStatus {
  if (state === 'unavailable') return status(state, false, false)
  if (state === 'read_only') return status(state, true, false)
  return status(state, mode === 'write', false)
}

function comparablePath(value: string): string {
  return resolve(value).normalize('NFC')
}

export class LocalFileAccessError extends Error {
  readonly accessStatus: LocalAccessStatus

  constructor(
    accessStatus: LocalAccessStatus,
    message = accessStatus.detail ?? 'No se pudo acceder a la ubicación local.',
  ) {
    super(message)
    this.name = 'LocalFileAccessError'
    this.accessStatus = accessStatus
  }
}

export class LocalFileAccessService {
  private readonly deps: LocalFileAccessDependencies
  private readonly platform: string

  constructor(
    deps: LocalFileAccessDependencies,
    platform = process.platform,
  ) {
    this.deps = deps
    this.platform = platform
  }

  async inspect(rootPath: string): Promise<LocalAccessStatus> {
    const root = resolve(rootPath)
    try {
      if (!await this.deps.isDirectory(root)) {
        return status('unavailable', false, false, 'La ubicación registrada ya no es una carpeta.')
      }
    } catch (error) {
      const state = stateForError(error)
      if (state) return status(state, false, false)
      throw error
    }

    try {
      await this.deps.access(root, fsConstants.R_OK)
    } catch (error) {
      const state = stateForError(error)
      if (state) return status(state, false, false)
      throw error
    }

    try {
      await this.deps.access(root, fsConstants.W_OK)
      return status('ready', true, true)
    } catch (error) {
      const state = stateForError(error)
      if (state) return status(state, true, false)
      throw error
    }
  }

  async requestAccess(rootPath: string, owner?: unknown): Promise<LocalAccessRequestResult> {
    const before = await this.inspect(rootPath)
    if (this.platform !== 'darwin' || before.state === 'unavailable' || before.state === 'read_only') {
      return { canceled: false, status: before }
    }

    const result = await this.deps.showOpenDirectory(resolve(rootPath), owner)
    if (result.canceled || !result.filePath) return { canceled: true, status: before }

    const [registered, selected] = await Promise.all([
      this.deps.realpath(resolve(rootPath)),
      this.deps.realpath(resolve(result.filePath)),
    ])
    if (comparablePath(registered) !== comparablePath(selected)) {
      throw new Error('Seleccioná exactamente la ubicación registrada para conceder acceso.')
    }

    return { canceled: false, status: await this.inspect(rootPath) }
  }

  async openPrivacySettings(): Promise<void> {
    if (this.platform === 'darwin') await this.deps.openPrivacySettings()
  }

  async runWithAccess<T>(
    rootPath: string,
    mode: 'read' | 'write',
    operation: () => Promise<T>,
    options: LocalAccessRunOptions = {},
  ): Promise<T> {
    const interactive = options.interactive !== false
    const retryOnce = options.retryOnce !== false
    let current = await this.inspect(rootPath)
    const permitted = () => mode === 'read' ? current.canRead : current.canWrite

    if (!permitted() && interactive && current.state === 'permission_required') {
      const request = await this.requestAccess(rootPath, options.owner)
      if (request.canceled) {
        throw new LocalFileAccessError(request.status, 'Acceso cancelado. No se modificó ningún archivo.')
      }
      current = request.status
    }
    if (!permitted()) throw new LocalFileAccessError(current)

    try {
      return await operation()
    } catch (error) {
      const failedState = stateForError(error)
      if (!failedState) throw error
      if (!interactive || !retryOnce || failedState !== 'permission_required') {
        throw new LocalFileAccessError(statusForOperationError(failedState, mode))
      }
      const request = await this.requestAccess(rootPath, options.owner)
      if (request.canceled || (mode === 'read' ? !request.status.canRead : !request.status.canWrite)) {
        throw new LocalFileAccessError(request.status, 'No se concedió acceso. La operación no pudo completarse.')
      }
      try {
        return await operation()
      } catch (retryError) {
        const retryState = stateForError(retryError)
        if (!retryState) throw retryError
        throw new LocalFileAccessError(statusForOperationError(retryState, mode))
      }
    }
  }
}

export function defaultLocalFileAccessDependencies(
  showOpenDirectory: LocalFileAccessDependencies['showOpenDirectory'],
  openPrivacySettings: LocalFileAccessDependencies['openPrivacySettings'],
): LocalFileAccessDependencies {
  return {
    access,
    realpath,
    isDirectory: async path => (await stat(path)).isDirectory(),
    showOpenDirectory,
    openPrivacySettings,
  }
}
