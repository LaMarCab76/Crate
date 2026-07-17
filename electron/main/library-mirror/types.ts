import type { DbFolder } from '@shared/types/db'
import type { LibraryProvider } from '@shared/types/library-locations'

export type MirrorEntryKind = 'file' | 'directory'

export interface MirrorEntry {
  relativePath: string
  kind: MirrorEntryKind
  size: number
  modifiedAtMs: number | null
  sha256: string | null
  quickXorHash: string | null
  etag: string | null
  /** Provider-native identity persisted with pending actions so a restarted
   * cloud transfer never has to infer an item from a display path. */
  providerItemId?: string | null
}

export interface MirrorWarning {
  code: 'symlink_skipped' | 'entry_excluded' | 'special_entry_skipped'
  relativePath: string
  message: string
}

export interface MirrorInventory {
  /** Stable identity for the configured root, independent of its contents.
   * A changed identity means a mountpoint/root was replaced and must never be
   * interpreted as an empty library. */
  rootIdentity: string
  entries: readonly MirrorEntry[]
  warnings: readonly MirrorWarning[]
}

export interface MirrorWriteRequest {
  location: DbFolder
  relativePath: string
  source: AsyncIterable<Uint8Array>
  expectedSource: MirrorEntry
  destinationBefore: MirrorEntry | null
  resumeState: unknown | null
  signal?: AbortSignal
  onProgress?: (bytesCompleted: number) => void
  onResumeState?: (state: unknown | null) => void
}

export interface MirrorDeleteRequest {
  location: DbFolder
  relativePath: string
  kind: MirrorEntryKind
  destinationBefore: MirrorEntry | null
  recursive: boolean
  signal?: AbortSignal
}

export interface MirrorMoveRequest {
  location: DbFolder
  sourceRelativePath: string
  destinationRelativePath: string
  sourceBefore: MirrorEntry
  destinationBefore: MirrorEntry | null
  signal?: AbortSignal
}

/**
 * Provider boundary used by LibraryMirrorService. The OneDrive implementation
 * lives in cloud/ and is injected at startup, keeping the planner and journal
 * independently testable.
 */
export interface MirrorAdapter {
  readonly provider: LibraryProvider
  inventory(location: DbFolder, signal?: AbortSignal): Promise<MirrorInventory>
  readFile(location: DbFolder, entry: MirrorEntry, signal?: AbortSignal): AsyncIterable<Uint8Array>
  createDirectory(location: DbFolder, relativePath: string, signal?: AbortSignal): Promise<void>
  writeFile(request: MirrorWriteRequest): Promise<MirrorEntry>
  /** Publish an already verified file inside the same provider root. Migration
   * staging uses this boundary so a merge never exposes partial bytes. */
  moveEntry?(request: MirrorMoveRequest): Promise<MirrorEntry>
  deleteEntry(request: MirrorDeleteRequest): Promise<void>
}

export interface MirrorSnapshotEntry extends MirrorEntry {
  sourceEtag: string | null
  destinationEtag: string | null
}

export interface MirrorDivergence {
  relativePath: string
  reason: 'initial_destination_not_empty' | 'destination_added' | 'destination_modified' | 'destination_deleted'
  source: MirrorEntry | null
  destination: MirrorEntry | null
  previous: MirrorSnapshotEntry | null
}

export type MirrorActionKind = 'create_directory' | 'copy_file' | 'delete_file' | 'delete_directory'

export interface MirrorPlannedAction {
  kind: MirrorActionKind
  relativePath: string
  source: MirrorEntry | null
  destinationBefore: MirrorEntry | null
  bytesTotal: number
  phase: 0 | 1 | 2 | 3 | 4
  requiresApproval: boolean
}

export interface MirrorPlan {
  actions: readonly MirrorPlannedAction[]
  divergences: readonly MirrorDivergence[]
}

export class MirrorRootUnavailableError extends Error {
  readonly code = 'MIRROR_ROOT_UNAVAILABLE'
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'MirrorRootUnavailableError'
  }
}

export class MirrorPreconditionError extends Error {
  readonly code = 'MIRROR_PRECONDITION_FAILED'
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'MirrorPreconditionError'
  }
}

export class MirrorVerificationError extends Error {
  readonly code = 'MIRROR_VERIFICATION_FAILED'
  constructor(message: string) {
    super(message)
    this.name = 'MirrorVerificationError'
  }
}
