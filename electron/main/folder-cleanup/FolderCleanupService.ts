import { app, shell, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { getRepos } from '../db/repositories'
import { broadcast } from '../ipc/events'
import { AUDIO_EXTENSIONS } from '../library/ImportService'
import { getLocalFileAccessService } from '../security/localFileAccessRuntime'
import {
  confirmFolderRemoval,
  createTrashFolderRemover,
  pruneEmptyFolders,
  toPosixRelative,
  type ConfirmFolderRemovalResult,
  type PendingFolderConfirmation,
  type PruneEmptyFoldersResult,
} from './emptyFolders'
import type { DbFolder } from '@shared/types/db'
import type {
  FolderCleanupConfirmResult,
  FolderCleanupEvent,
  FolderCleanupOrigin,
  FolderCleanupProposal,
  FolderCleanupProposalFolder,
  FolderCleanupResolution,
  FolderCleanupScope,
} from '@shared/types/folder-cleanup'

export const FOLDER_CLEANUP_EVENT_CHANNEL = 'folder-cleanup:event'
const PROPOSAL_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MAX_PROPOSALS = 200
const STORE_FILE = 'folder-cleanup-proposals.json'

export interface FolderCleanupReport {
  scope: FolderCleanupScope
  origin: FolderCleanupOrigin
  /** Library root or device music root the result paths belong to. */
  root: string
  rootLabel: string
  folderId: number | null
  deviceId: string | null
  result: PruneEmptyFoldersResult
}

/** Runs a confirmed proposal against its root (PC library or device). */
export type FolderCleanupExecutor = (
  proposal: FolderCleanupProposal,
) => Promise<ConfirmFolderRemovalResult & { root: string }>

function proposalFolder(root: string, item: PendingFolderConfirmation): FolderCleanupProposalFolder {
  return {
    relativePath: toPosixRelative(root, item.dir),
    images: item.contents.images,
    playlists: item.contents.playlists,
    lyrics: item.contents.lyrics,
    otherCount: item.contents.other.length,
  }
}

function isInsideOrEqual(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Owns the "folder left without playable files" flow: removes what can go
 * automatically, keeps proposals for folders that still hold images, playlists
 * or lyrics until the user answers from the activity center, and announces
 * every removal there.
 */
export class FolderCleanupService {
  private proposals: Map<string, FolderCleanupProposal> | null = null
  private saveChain: Promise<void> = Promise.resolve()
  private confirming = new Set<string>()
  private readonly storePath: string

  constructor(storePath = join(app.getPath('userData'), STORE_FILE)) {
    this.storePath = storePath
  }

  /**
   * Cleans up the folders of tracks just deleted from a local library. Never
   * throws: a cleanup problem must not turn a successful deletion into an error.
   */
  async cleanupLocalAfterDeletion(input: {
    rootPath: string
    deletedPaths: readonly string[]
    origin: FolderCleanupOrigin
  }): Promise<void> {
    try {
      const folder = this.localLibraryFor(input.rootPath)
      if (!folder) return
      const root = resolve(folder.path)
      const result = await pruneEmptyFolders({
        root,
        startDirs: input.deletedPaths.map(path => dirname(resolve(path))),
        playableExtensions: AUDIO_EXTENSIONS,
        removeFolder: createTrashFolderRemover(path => shell.trashItem(path)),
        onError: (dir, error) => console.warn(`[folder-cleanup] could not remove ${dir}:`, errorMessage(error)),
      })
      await this.report({
        scope: 'library',
        origin: input.origin,
        root,
        rootLabel: folder.name,
        folderId: folder.id,
        deviceId: null,
        result,
      })
    } catch (err) {
      console.warn(`[folder-cleanup] cleanup failed for ${input.rootPath}:`, errorMessage(err))
    }
  }

  /** Announces removed folders and stores a proposal for those needing confirmation. */
  async report(report: FolderCleanupReport): Promise<void> {
    const removed = report.result.removed.map(dir => toPosixRelative(report.root, dir))
    if (removed.length > 0) {
      this.emit({
        kind: 'removed',
        id: randomUUID(),
        scope: report.scope,
        origin: report.origin,
        rootLabel: report.rootLabel,
        deviceId: report.deviceId,
        folderId: report.folderId,
        folders: removed,
      })
    }
    if (report.result.needsConfirmation.length === 0) return
    const proposal: FolderCleanupProposal = {
      id: randomUUID(),
      scope: report.scope,
      origin: report.origin,
      rootLabel: report.rootLabel,
      folderId: report.folderId,
      deviceId: report.deviceId,
      folders: report.result.needsConfirmation.map(item => proposalFolder(report.root, item)),
      createdAt: new Date().toISOString(),
    }
    await this.addProposal(proposal)
    this.emit({ kind: 'proposed', proposal })
  }

  emitDeviceTrashPurged(input: { deviceId: string; deviceName: string; files: number; bytes: number; retentionDays: number }): void {
    this.emit({ kind: 'device-trash-purged', id: randomUUID(), ...input })
  }

  async pending(): Promise<FolderCleanupProposal[]> {
    const proposals = await this.load()
    return [...proposals.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async requirePending(proposalId: string): Promise<FolderCleanupProposal> {
    const proposal = (await this.load()).get(proposalId)
    if (!proposal) throw new Error('Esta consulta ya no está disponible.')
    return proposal
  }

  /** Executor for proposals on local libraries. */
  localExecutor(owner?: BrowserWindow): FolderCleanupExecutor {
    return async proposal => {
      const folder = proposal.folderId != null ? getRepos().folders.getById(proposal.folderId) : undefined
      if (!folder || folder.provider !== 'local' || folder.role !== 'library') {
        throw new Error('La biblioteca de estas carpetas ya no existe.')
      }
      const root = resolve(folder.path)
      const outcome = await getLocalFileAccessService().runWithAccess(
        root,
        'write',
        () => confirmFolderRemoval({
          root,
          relativePaths: proposal.folders.map(item => item.relativePath),
          playableExtensions: AUDIO_EXTENSIONS,
          removeFolder: createTrashFolderRemover(path => shell.trashItem(path)),
          onError: (dir, error) => console.warn(`[folder-cleanup] could not remove ${dir}:`, errorMessage(error)),
        }),
        { owner },
      )
      return { ...outcome, root }
    }
  }

  /**
   * Deletes the folders of a proposal. On error the proposal stays pending so
   * the user can retry (already removed folders are skipped next time).
   */
  async confirm(proposalId: string, executor: FolderCleanupExecutor): Promise<FolderCleanupConfirmResult> {
    if (this.confirming.has(proposalId)) throw new Error('Ya se están borrando estas carpetas.')
    this.confirming.add(proposalId)
    try {
      return await this.runConfirmation(proposalId, executor)
    } finally {
      this.confirming.delete(proposalId)
    }
  }

  private async runConfirmation(proposalId: string, executor: FolderCleanupExecutor): Promise<FolderCleanupConfirmResult> {
    const proposal = await this.requirePending(proposalId)
    const outcome = await executor(proposal)
    const removed = outcome.removed.map(dir => toPosixRelative(outcome.root, dir))
    const kept = outcome.kept.map(item => ({
      relativePath: toPosixRelative(outcome.root, item.dir),
      reason: item.reason === 'playable'
        ? 'Ahora tiene archivos reproducibles.'
        : 'Cambió desde la consulta.',
    }))
    const resolution: FolderCleanupResolution = kept.length === 0
      ? 'deleted'
      : removed.length === 0 ? 'kept' : 'partial'
    const message = this.confirmationMessage(resolution, removed, kept.map(item => item.relativePath))

    await this.removeProposal(proposalId)
    this.emit({ kind: 'resolved', proposalId, scope: proposal.scope, resolution, message })
    if (outcome.needsConfirmation.length > 0) {
      await this.report({
        scope: proposal.scope,
        origin: 'folder-cleanup',
        root: outcome.root,
        rootLabel: proposal.rootLabel,
        folderId: proposal.folderId,
        deviceId: proposal.deviceId,
        result: { removed: [], needsConfirmation: outcome.needsConfirmation },
      })
    }
    return { proposalId, resolution, removed, kept, message }
  }

  async dismiss(proposalId: string): Promise<void> {
    const proposal = (await this.load()).get(proposalId)
    if (!proposal) return
    await this.removeProposal(proposalId)
    this.emit({
      kind: 'resolved',
      proposalId,
      scope: proposal.scope,
      resolution: 'kept',
      message: proposal.folders.length === 1
        ? `Se conservó ${proposal.folders[0].relativePath}.`
        : `Se conservaron ${proposal.folders.length} carpetas.`,
    })
  }

  private confirmationMessage(resolution: FolderCleanupResolution, removed: string[], kept: string[]): string {
    if (resolution === 'kept') {
      return `No se borró nada: ${plural(kept.length, 'la carpeta cambió', 'las carpetas cambiaron')} desde la consulta.`
    }
    const removedText = removed.length === 0
      ? 'Las carpetas ya no existían.'
      : `${plural(removed.length, 'Se borró', 'Se borraron')} ${removed.join(', ')}.`
    if (resolution === 'partial') {
      return `${removedText} ${plural(kept.length, 'Se conservó', 'Se conservaron')} ${kept.join(', ')} porque cambió.`
    }
    return removedText
  }

  // The registered local library containing `rootPath` (the deepest one, if
  // libraries are nested).
  private localLibraryFor(rootPath: string): DbFolder | undefined {
    const target = resolve(rootPath)
    return getRepos().folders.list()
      .filter(folder =>
        folder.provider === 'local'
        && folder.role === 'library'
        && isInsideOrEqual(resolve(folder.path), target),
      )
      .sort((a, b) => resolve(b.path).length - resolve(a.path).length)[0]
  }

  private emit(event: FolderCleanupEvent): void {
    broadcast(FOLDER_CLEANUP_EVENT_CHANNEL, event)
  }

  private async addProposal(proposal: FolderCleanupProposal): Promise<void> {
    const proposals = await this.load()
    // A newer proposal for the same folders (or their parent) supersedes the
    // older one; drop the overlapping folders so the user is asked once.
    for (const existing of [...proposals.values()]) {
      if (existing.scope !== proposal.scope) continue
      if (existing.folderId !== proposal.folderId || existing.deviceId !== proposal.deviceId) continue
      const remaining = existing.folders.filter(old => !proposal.folders.some(item =>
        old.relativePath === item.relativePath || old.relativePath.startsWith(`${item.relativePath}/`),
      ))
      if (remaining.length === existing.folders.length) continue
      if (remaining.length === 0) {
        proposals.delete(existing.id)
        this.emit({
          kind: 'resolved',
          proposalId: existing.id,
          scope: existing.scope,
          resolution: 'expired',
          message: 'Reemplazada por una consulta más reciente.',
        })
      } else {
        proposals.set(existing.id, { ...existing, folders: remaining })
        this.emit({ kind: 'proposed', proposal: { ...existing, folders: remaining } })
      }
    }
    proposals.set(proposal.id, proposal)
    const overflow = [...proposals.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(MAX_PROPOSALS)
    for (const old of overflow) proposals.delete(old.id)
    await this.save()
  }

  private async removeProposal(proposalId: string): Promise<void> {
    const proposals = await this.load()
    if (proposals.delete(proposalId)) await this.save()
  }

  private async load(): Promise<Map<string, FolderCleanupProposal>> {
    if (this.proposals) return this.proposals
    const proposals = new Map<string, FolderCleanupProposal>()
    try {
      const parsed = JSON.parse(await readFile(this.storePath, 'utf8')) as { proposals?: FolderCleanupProposal[] }
      const cutoff = Date.now() - PROPOSAL_TTL_MS
      for (const proposal of parsed.proposals ?? []) {
        if (!proposal?.id || !Array.isArray(proposal.folders) || proposal.folders.length === 0) continue
        if (!(Date.parse(proposal.createdAt) >= cutoff)) continue
        proposals.set(proposal.id, proposal)
      }
    } catch {
      // Missing or unreadable store: start empty.
    }
    this.proposals ??= proposals
    return this.proposals
  }

  private save(): Promise<void> {
    const snapshot = JSON.stringify({ version: 1, proposals: [...(this.proposals?.values() ?? [])] }, null, 2)
    this.saveChain = this.saveChain.then(async () => {
      const tmp = `${this.storePath}.${randomUUID()}.tmp`
      try {
        await mkdir(dirname(this.storePath), { recursive: true })
        await writeFile(tmp, snapshot, 'utf8')
        await rename(tmp, this.storePath)
      } catch (err) {
        await unlink(tmp).catch(() => undefined)
        console.warn('[folder-cleanup] could not save pending proposals:', errorMessage(err))
      }
    })
    return this.saveChain
  }
}

let instance: FolderCleanupService | null = null

export function getFolderCleanupService(): FolderCleanupService {
  instance ??= new FolderCleanupService()
  return instance
}
