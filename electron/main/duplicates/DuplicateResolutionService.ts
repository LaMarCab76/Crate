import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import { BrowserWindow, shell } from 'electron'
import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import type { DbFolder, DbTrack } from '@shared/types/db'
import type {
  DuplicateCandidateDetail,
  DuplicateResolutionRequest,
  DuplicateResolutionResult,
} from '@shared/types/duplicates'
import { getOneDriveClient, CloudHttpError, type OneDriveClient } from '../cloud/OneDriveClient'
import { getOneDriveLibraryService } from '../cloud/OneDriveLibraryService'
import { getCloudManifestService } from '../cloud/CloudManifestService'
import { getDatabase } from '../db/database'
import { getRepos } from '../db/repositories'
import {
  getDeviceSyncService,
  type PreparedDuplicateDeviceIntent,
} from '../devices/DeviceSyncService'
import { broadcast } from '../ipc/events'
import { getLyricsIndexService } from '../lyrics/LyricsIndexService'
import { getLocalFileAccessService } from '../security/localFileAccessRuntime'
import { getLibraryBackup } from '../services/LibraryBackup'
import { getDuplicateDecisionPortableService } from './DuplicateDecisionPortableService'
import { sourceSignature } from './fingerprint'
import {
  confirmLocalTrashAbsence,
  LocalTrashConfirmationError,
} from './localTrashVerification'
import {
  DuplicateRepository,
  type DuplicateIdentity,
  type DuplicateResolutionRunRow,
} from './DuplicateRepository'

interface CandidateRow {
  id: string
  track_low_id: number
  track_high_id: number
  recommended_track_id: number | null
  low_fingerprint_digest: string
  high_fingerprint_digest: string
  revision: number
  status: 'pending' | 'dismissed' | 'stale'
}

interface AnalysisSourceRow {
  track_id: number
  source_provider: 'local' | 'onedrive'
  source_locator: string
  source_file_size: number | null
  source_modified: string | null
  source_etag: string | null
  source_signature: string
  fingerprint_digest: string | null
  algorithm: string
  algorithm_version: string
  status: 'pending' | 'running' | 'ready' | 'error'
}

interface TrackSnapshot {
  track: DbTrack
  folder: DbFolder
  analysis: AnalysisSourceRow
  identity: DuplicateIdentity
}

interface ResolutionSnapshot {
  candidate: CandidateRow
  kept: TrackSnapshot
  removed: TrackSnapshot
}

interface StorageReceipt {
  provider: 'local' | 'onedrive'
  locator: string
  completedAt: string
  sidecarWarning?: string
}

export class DuplicateCandidateChangedError extends Error {
  constructor(message = 'El caso cambió; actualizá la revisión antes de resolverlo.') {
    super(message)
    this.name = 'DuplicateCandidateChangedError'
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T } catch { return fallback }
}

function sidecarPath(audioPath: string): string {
  const extension = extname(audioPath)
  return extension ? `${audioPath.slice(0, -extension.length)}.lrc` : `${audioPath}.lrc`
}

function expectedEtagMatches(expected: string | null | undefined, actual: string | null | undefined): boolean {
  return !expected || expected === actual
}

function indexedModifiedMatches(indexed: string | null | undefined, modifiedMs: number): boolean {
  if (!indexed) return true
  const parsed = Date.parse(indexed)
  return !Number.isFinite(parsed) || Math.abs(parsed - modifiedMs) <= 1_000
}

/**
 * Owns the two-phase, never-automatic resolution path. The physical storage
 * operation is deliberately outside SQLite; only a confirmed Trash/recycle-bin
 * move advances the journal to storage_done and permits the catalog commit.
 */
export class DuplicateResolutionService {
  private readonly db: BetterSqliteDatabase
  private readonly repo: DuplicateRepository
  private readonly oneDrive: OneDriveClient
  private readonly activeCandidates = new Set<string>()

  constructor(
    db = getDatabase(),
    repo = new DuplicateRepository(db),
    oneDrive = getOneDriveClient(),
  ) {
    this.db = db
    this.repo = repo
    this.oneDrive = oneDrive
  }

  async resolve(
    request: DuplicateResolutionRequest,
    owner?: BrowserWindow,
  ): Promise<DuplicateResolutionResult> {
    if (this.activeCandidates.has(request.candidateId)) {
      throw new Error('Este caso ya se está resolviendo.')
    }
    this.activeCandidates.add(request.candidateId)
    try {
      if (request.action === 'keep_both') return await this.keepBoth(request, owner)
      return await this.trashOne(request, owner)
    } finally {
      this.activeCandidates.delete(request.candidateId)
    }
  }

  private candidateRow(candidateId: string): CandidateRow | null {
    return this.db.prepare<[string], CandidateRow>(`
      SELECT id, track_low_id, track_high_id, recommended_track_id,
             low_fingerprint_digest, high_fingerprint_digest, revision, status
      FROM duplicate_candidates WHERE id = ?
    `).get(candidateId) ?? null
  }

  private requireCandidate(candidateId: string, expectedRevision: number): {
    row: CandidateRow
    detail: DuplicateCandidateDetail
  } {
    const row = this.candidateRow(candidateId)
    const detail = this.repo.getCandidate(candidateId)
    if (!row || !detail || row.status !== 'pending' || row.revision !== expectedRevision) {
      throw new DuplicateCandidateChangedError()
    }
    return { row, detail }
  }

  private async keepBoth(
    request: Extract<DuplicateResolutionRequest, { action: 'keep_both' }>,
    owner?: BrowserWindow,
  ): Promise<DuplicateResolutionResult> {
    const { row, detail } = this.requireCandidate(request.candidateId, request.expectedRevision)
    const leftIdentity = this.repo.getIdentity(detail.left.id)
    const rightIdentity = this.repo.getIdentity(detail.right.id)
    if (!leftIdentity || !rightIdentity) throw new DuplicateCandidateChangedError('Las huellas del caso ya no están vigentes.')
    if (
      leftIdentity.acousticDigest !== detail.leftFingerprintDigest
      || rightIdentity.acousticDigest !== detail.rightFingerprintDigest
    ) throw new DuplicateCandidateChangedError('El audio cambió desde que se creó este caso.')

    const runId = randomUUID()
    const now = new Date().toISOString()
    const transaction = this.db.transaction(() => {
      this.repo.createResolutionRun({
        id: runId,
        candidateId: row.id,
        action: 'keep_both',
        keptTrackId: null,
        removedTrackId: null,
        expectedRevision: row.revision,
        sourceSnapshot: {
          leftTrackId: detail.left.id,
          rightTrackId: detail.right.id,
          leftDigest: detail.leftFingerprintDigest,
          rightDigest: detail.rightFingerprintDigest,
        },
      })
      this.repo.saveKeepBothDecision({
        lowIdentity: leftIdentity,
        highIdentity: rightIdentity,
        reason: request.reason,
      })
      this.repo.markResolutionStorageDone(runId, { provider: 'none', completedAt: now })
      this.repo.dismissCandidate(row.id, row.revision)
      this.repo.markResolutionCommitted(runId)
    })
    transaction()

    const warnings = await getDuplicateDecisionPortableService().writeCandidateNow(row.id, owner)
    this.notifyChanged('keep-both')
    return {
      candidateId: row.id,
      action: 'keep_both',
      keptTrackId: null,
      deletedTrackId: null,
      warnings,
    }
  }

  private snapshotForTrash(
    request: Extract<DuplicateResolutionRequest, { action: 'trash_left' | 'trash_right' }>,
  ): ResolutionSnapshot {
    const { row, detail } = this.requireCandidate(request.candidateId, request.expectedRevision)
    const removedId = request.action === 'trash_left' ? detail.left.id : detail.right.id
    const keptId = request.action === 'trash_left' ? detail.right.id : detail.left.id
    return {
      candidate: row,
      kept: this.trackSnapshot(keptId, row),
      removed: this.trackSnapshot(removedId, row),
    }
  }

  private trackSnapshot(trackId: number, candidate: CandidateRow): TrackSnapshot {
    const track = getRepos().tracks.getById(trackId)
    const folder = track ? getRepos().folders.getById(track.folder_id) : undefined
    const analysis = this.db.prepare<[number], AnalysisSourceRow>(`
      SELECT track_id, source_provider, source_locator, source_file_size,
             source_modified, source_etag, source_signature, fingerprint_digest,
             algorithm, algorithm_version, status
      FROM duplicate_track_analyses WHERE track_id = ?
    `).get(trackId)
    const identity = this.repo.getIdentity(trackId)
    if (!track || !folder || !analysis || !identity || analysis.status !== 'ready') {
      throw new DuplicateCandidateChangedError('La pista o su análisis ya no están disponibles.')
    }
    if (folder.role !== 'library' || folder.provider !== track.provider) {
      throw new DuplicateCandidateChangedError('La pista ya no pertenece a una biblioteca principal.')
    }
    const expectedDigest = trackId === candidate.track_low_id
      ? candidate.low_fingerprint_digest
      : candidate.high_fingerprint_digest
    if (
      analysis.fingerprint_digest !== expectedDigest
      || identity.acousticDigest !== expectedDigest
      || identity.algorithm !== analysis.algorithm
      || identity.algorithmVersion !== analysis.algorithm_version
      || analysis.source_locator !== track.path
      || analysis.source_signature !== sourceSignature({
        trackId: track.id,
        provider: track.provider,
        locator: track.path,
        fileSize: track.file_size,
        dateModified: track.date_modified,
        etag: track.etag,
      })
    ) throw new DuplicateCandidateChangedError('El audio cambió desde que se creó este caso.')
    return { track, folder, analysis, identity }
  }

  private async trashOne(
    request: Extract<DuplicateResolutionRequest, { action: 'trash_left' | 'trash_right' }>,
    owner?: BrowserWindow,
  ): Promise<DuplicateResolutionResult> {
    const snapshot = this.snapshotForTrash(request)
    const deviceIntents = await getDeviceSyncService().prepareDuplicateDeletionIntents(
      snapshot.removed.track.id,
      snapshot.removed.identity.acousticDigest,
    )

    // Re-read after the async device snapshot so a concurrent scan cannot make
    // the preflight stale while we proceed to a physical deletion.
    const revalidated = this.snapshotForTrash(request)
    const current = revalidated.candidate
    if (
      current.track_low_id !== snapshot.candidate.track_low_id
      || current.track_high_id !== snapshot.candidate.track_high_id
    ) throw new DuplicateCandidateChangedError()
    snapshot.kept = revalidated.kept
    snapshot.removed = revalidated.removed
    snapshot.candidate = revalidated.candidate

    const runId = this.repo.createResolutionRun({
      candidateId: snapshot.candidate.id,
      action: request.action,
      keptTrackId: snapshot.kept.track.id,
      removedTrackId: snapshot.removed.track.id,
      expectedRevision: snapshot.candidate.revision,
      sourceSnapshot: this.journalSnapshot(snapshot),
      deviceIntents,
    })

    let physicalRemovalCompleted = false
    try {
      const receipt = await this.removePhysical(snapshot.removed, owner)
      // From this point on the journal must remain recoverable even if SQLite
      // cannot persist the storage_done transition. A planned run can prove the
      // file is absent during startup recovery; a failed run is intentionally
      // excluded from that recovery path.
      physicalRemovalCompleted = true
      this.repo.markResolutionStorageDone(runId, receipt)
      const catalogWarning = this.commitStorageDone(runId, snapshot, deviceIntents)
      this.afterCatalogChange(snapshot)
      const warnings = [receipt.sidecarWarning, catalogWarning]
        .filter((warning): warning is string => Boolean(warning))
      return {
        candidateId: snapshot.candidate.id,
        action: request.action,
        keptTrackId: snapshot.kept.track.id,
        deletedTrackId: snapshot.removed.track.id,
        warnings,
      }
    } catch (error) {
      // Once storage succeeded the row must remain planned/storage_done and
      // recoverable. Turning it into failed would strand a catalog entry whose
      // audio is already gone if the state transition itself was what failed.
      const storageOutcomeUnknown = error instanceof LocalTrashConfirmationError
        && error.keepJournalPlanned
      if (!physicalRemovalCompleted && !storageOutcomeUnknown) {
        this.repo.markResolutionFailed(runId, error)
      }
      throw error
    }
  }

  private async removePhysical(snapshot: TrackSnapshot, owner?: BrowserWindow): Promise<StorageReceipt> {
    return snapshot.track.provider === 'local'
      ? this.removeLocal(snapshot, owner)
      : this.removeOneDrive(snapshot)
  }

  private async removeLocal(snapshot: TrackSnapshot, owner?: BrowserWindow): Promise<StorageReceipt> {
    const path = resolve(snapshot.track.path)
    return getLocalFileAccessService().runWithAccess(
      snapshot.folder.path,
      'write',
      async () => {
        const file = await stat(path)
        if (
          (snapshot.analysis.source_file_size != null && file.size !== snapshot.analysis.source_file_size)
          || (snapshot.track.file_size != null && file.size !== snapshot.track.file_size)
          || !indexedModifiedMatches(snapshot.analysis.source_modified, file.mtimeMs)
          || !indexedModifiedMatches(snapshot.track.date_modified, file.mtimeMs)
        ) {
          this.markCandidateStale(snapshot.track.id)
          throw new DuplicateCandidateChangedError('El archivo cambió de tamaño; se reanalizará antes de borrarlo.')
        }
        if (resolve(snapshot.analysis.source_locator) !== path) {
          this.markCandidateStale(snapshot.track.id)
          throw new DuplicateCandidateChangedError('La ubicación del archivo cambió; se reanalizará antes de borrarlo.')
        }
        await shell.trashItem(path)
        await confirmLocalTrashAbsence(snapshot.folder.path, path)

        let sidecarWarning: string | undefined
        const lrc = sidecarPath(path)
        if (existsSync(lrc)) {
          try {
            await shell.trashItem(lrc)
          } catch (error) {
            sidecarWarning = `El audio se envió a la Papelera, pero no se pudo mover ${lrc}: ${errorMessage(error)}`
          }
        }
        return { provider: 'local', locator: path, completedAt: new Date().toISOString(), sidecarWarning }
      },
      { owner, retryOnce: false },
    )
  }

  private async removeOneDrive(snapshot: TrackSnapshot): Promise<StorageReceipt> {
    const driveId = snapshot.track.drive_id
    const itemId = snapshot.track.item_id
    if (!driveId || !itemId || snapshot.folder.drive_id !== driveId) {
      throw new DuplicateCandidateChangedError('La identidad remota de la pista cambió.')
    }
    let item
    try {
      item = await this.oneDrive.getItem(driveId, itemId)
    } catch (error) {
      if (
        error instanceof CloudHttpError
        && error.status === 404
        && !await this.oneDriveItemExists(driveId, itemId)
      ) {
        return {
          provider: 'onedrive',
          locator: `${driveId}:${itemId}`,
          completedAt: new Date().toISOString(),
        }
      }
      throw error
    }
    if (
      (snapshot.analysis.source_file_size != null && item.size !== snapshot.analysis.source_file_size)
      || !expectedEtagMatches(snapshot.analysis.source_etag, item.eTag ?? item.cTag)
      || !expectedEtagMatches(snapshot.track.etag, item.eTag ?? item.cTag)
    ) {
      this.markCandidateStale(snapshot.track.id)
      throw new DuplicateCandidateChangedError('La copia de OneDrive cambió; se sincronizará y analizará nuevamente.')
    }
    try {
      await this.oneDrive.deleteItemToRecycleBin({
        driveId,
        itemId,
        ifMatch: item.eTag ?? snapshot.track.etag ?? undefined,
      })
    } catch (error) {
      if (error instanceof CloudHttpError && error.status === 412) {
        this.markCandidateStale(snapshot.track.id)
        try {
          // Awaiting the delta makes the reanalysis trigger durable through the
          // normal cloud-sync library event. If it fails, the persisted stale
          // status still prevents this candidate from being resolved again.
          await getOneDriveLibraryService().resyncFolder(snapshot.folder.id)
        } catch (resyncError) {
          throw new DuplicateCandidateChangedError(
            `OneDrive informó un cambio concurrente; el caso quedó obsoleto. `
            + `La resincronización no pudo completarse: ${errorMessage(resyncError)}`,
          )
        }
        throw new DuplicateCandidateChangedError('OneDrive informó un cambio concurrente; el caso quedó obsoleto.')
      }
      if (!(error instanceof CloudHttpError) || error.status !== 404 || await this.oneDriveItemExists(driveId, itemId)) {
        throw error
      }
    }
    let sidecarWarning: string | undefined
    const parentId = item.parentReference?.id
    const name = item.name ?? basename(snapshot.track.remote_path ?? snapshot.track.path)
    if (parentId && name) {
      const lrcName = `${name.slice(0, Math.max(0, name.length - extname(name).length))}.lrc`
      try {
        const siblings = await this.oneDrive.listChildren(driveId, parentId)
        const sidecar = siblings.find(candidate =>
          candidate.file && candidate.name?.toLocaleLowerCase('en-US') === lrcName.toLocaleLowerCase('en-US'))
        if (sidecar) {
          await this.oneDrive.deleteItemToRecycleBin({
            driveId,
            itemId: sidecar.id,
            ifMatch: sidecar.eTag ?? sidecar.cTag,
          })
        }
      } catch (error) {
        sidecarWarning = `El audio se envió a la papelera de OneDrive, pero no se pudo retirar ${lrcName}: ${errorMessage(error)}`
      }
    }
    return {
      provider: 'onedrive',
      locator: `${driveId}:${itemId}`,
      completedAt: new Date().toISOString(),
      sidecarWarning,
    }
  }

  private async oneDriveItemExists(driveId: string, itemId: string): Promise<boolean> {
    try {
      await this.oneDrive.getItem(driveId, itemId)
      return true
    } catch (error) {
      if (error instanceof CloudHttpError && error.status === 404) return false
      throw error
    }
  }

  private markCandidateStale(trackId: number): void {
    this.db.prepare(`
      UPDATE duplicate_candidates
      SET status = 'stale', revision = revision + 1, updated_at = ?
      WHERE status = 'pending' AND (track_low_id = ? OR track_high_id = ?)
    `).run(new Date().toISOString(), trackId, trackId)
    this.notifyChanged('stale')
  }

  private commitStorageDone(
    runId: string,
    snapshot: ResolutionSnapshot,
    deviceIntents: PreparedDuplicateDeviceIntent[],
  ): string | null {
    const transaction = this.db.transaction(() => {
      const run = this.db.prepare<[string], DuplicateResolutionRunRow>(`
        SELECT * FROM duplicate_resolution_runs WHERE id = ?
      `).get(runId)
      if (!run || run.state !== 'storage_done') throw new Error('La etapa física del borrado no está confirmada.')
      const removed = getRepos().tracks.getById(snapshot.removed.track.id)
      const kept = getRepos().tracks.getById(snapshot.kept.track.id)
      if (!removed || !kept) {
        // An already-absent removed row means the catalog half committed in an
        // older build; completing the journal is idempotent.
        if (!removed && kept) {
          this.repo.markResolutionCommitted(runId)
          return false
        }
        throw new Error('Las pistas del journal ya no permiten completar la resolución.')
      }
      this.insertDeviceIntents(runId, snapshot.removed.identity.id, deviceIntents)
      this.mergeCatalogState(removed, kept)
      this.db.prepare(`DELETE FROM tracks WHERE id = ?`).run(removed.id)
      this.db.prepare(`
        UPDATE folders SET track_count = (
          SELECT COUNT(*) FROM tracks WHERE folder_id = folders.id
        ), date_updated = ? WHERE id IN (?, ?)
      `).run(new Date().toISOString(), removed.folder_id, kept.folder_id)
      this.repo.markResolutionCommitted(runId)
      return true
    })
    const removedFromCatalog = transaction()
    if (!removedFromCatalog) return null

    // The lyrics index is external, debounced state. Mutating it inside the SQL
    // transaction could survive a later rollback and leave a live track without
    // its index entry.
    try {
      getLyricsIndexService().removeEntryForTrack(snapshot.removed.track)
      return null
    } catch (error) {
      const warning = `El catálogo se corrigió, pero no se pudo actualizar el índice de letras: ${errorMessage(error)}`
      console.warn(`[duplicates] ${warning}`)
      return warning
    }
  }

  private insertDeviceIntents(
    runId: string,
    identityId: string,
    intents: PreparedDuplicateDeviceIntent[],
  ): void {
    const now = new Date().toISOString()
    for (const intent of intents) {
      const active = this.db.prepare<[string, string], { id: string }>(`
        SELECT id FROM device_duplicate_deletions
        WHERE device_id = ? AND sync_key = ? AND status IN ('pending', 'conflict')
      `).get(intent.deviceId, intent.syncKey)
      if (active) {
        this.db.prepare(`
          UPDATE device_duplicate_deletions
          SET resolution_run_id = ?, track_identity_id = ?, relative_path = ?,
              expected_fingerprint = ?, status = 'pending', reason = 'Corrección de duplicado',
              updated_at = ?, applied_at = NULL
          WHERE id = ?
        `).run(
          runId, identityId, intent.relativePath, intent.expectedFingerprint, now, active.id,
        )
      } else {
        this.db.prepare(`
          INSERT INTO device_duplicate_deletions (
            id, resolution_run_id, device_id, track_identity_id, sync_key,
            relative_path, expected_fingerprint, status, reason, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'Corrección de duplicado', ?, ?)
        `).run(
          randomUUID(), runId, intent.deviceId, identityId, intent.syncKey,
          intent.relativePath, intent.expectedFingerprint, now, now,
        )
      }
    }
  }

  private mergeCatalogState(source: DbTrack, canonical: DbTrack): void {
    const sourceIsNewer = (source.state_updated_at ?? 0) > (canonical.state_updated_at ?? 0)
    this.db.prepare(`
      UPDATE tracks
      SET is_favorite = ?, rating = ?, state_updated_at = ?,
          play_count = MAX(play_count, ?),
          last_played_date = CASE
            WHEN last_played_date IS NULL THEN ?
            WHEN ? IS NULL THEN last_played_date
            WHEN ? > last_played_date THEN ?
            ELSE last_played_date END
      WHERE id = ?
    `).run(
      sourceIsNewer ? source.is_favorite : canonical.is_favorite,
      sourceIsNewer ? source.rating : canonical.rating,
      Math.max(source.state_updated_at ?? 0, canonical.state_updated_at ?? 0) || null,
      source.play_count,
      source.last_played_date,
      source.last_played_date,
      source.last_played_date,
      source.last_played_date,
      canonical.id,
    )
    this.db.prepare(`UPDATE playlist_tracks SET track_id = ? WHERE track_id = ?`).run(canonical.id, source.id)
    this.db.prepare(`UPDATE queue SET track_id = ? WHERE track_id = ?`).run(canonical.id, source.id)
    this.db.prepare(`UPDATE tracks SET primary_track_id = ? WHERE primary_track_id = ?`).run(canonical.id, source.id)
    for (const table of ['song_features', 'playback_analysis_cache', 'playback_table_bars_cache']) {
      const canonicalPresent = this.db.prepare(`SELECT 1 FROM ${table} WHERE track_id = ?`).get(canonical.id)
      if (canonicalPresent) this.db.prepare(`DELETE FROM ${table} WHERE track_id = ?`).run(source.id)
      else this.db.prepare(`UPDATE ${table} SET track_id = ? WHERE track_id = ?`).run(canonical.id, source.id)
    }
    this.db.prepare(`UPDATE track_album_moves SET track_id = ? WHERE track_id = ?`).run(canonical.id, source.id)
  }

  async recover(): Promise<void> {
    const runs = this.db.prepare(`
      SELECT * FROM duplicate_resolution_runs
      WHERE state IN ('planned', 'storage_done')
      ORDER BY created_at, id
    `).all() as DuplicateResolutionRunRow[]
    for (const run of runs) {
      const snapshot = parseJson<ResolutionSnapshot | null>(run.source_snapshot_json, null)
      const intents = parseJson<PreparedDuplicateDeviceIntent[]>(run.device_intents_json, [])
      if (!snapshot || !run.removed_track_id || !run.kept_track_id) {
        this.repo.markResolutionFailed(run.id, 'El journal no contiene una instantánea recuperable.')
        continue
      }
      let storageConfirmed = run.state === 'storage_done'
      try {
        if (run.state === 'planned') {
          const absent = await this.confirmPhysicalAbsence(snapshot.removed)
          if (!absent) {
            this.repo.markResolutionFailed(run.id, 'La aplicación se cerró antes de completar el borrado físico.')
            continue
          }
          this.repo.markResolutionStorageDone(run.id, {
            provider: snapshot.removed.track.provider,
            locator: snapshot.removed.track.provider === 'local'
              ? snapshot.removed.track.path
              : `${snapshot.removed.track.drive_id}:${snapshot.removed.track.item_id}`,
            completedAt: new Date().toISOString(),
            recovered: true,
          })
          storageConfirmed = true
        }
        const warning = this.commitStorageDone(run.id, snapshot, intents)
        if (warning) console.warn(`[duplicates] recovered resolution ${run.id}: ${warning}`)
        this.afterCatalogChange(snapshot)
      } catch (error) {
        // Keep confirmed storage work recoverable. If a planned remote/root
        // check is temporarily unavailable, retain it for the next startup too.
        if (!storageConfirmed && run.state !== 'planned') this.repo.markResolutionFailed(run.id, error)
        console.error(`[duplicates] failed to recover resolution ${run.id}:`, error)
      }
    }
  }

  private async confirmPhysicalAbsence(snapshot: TrackSnapshot): Promise<boolean> {
    if (snapshot.track.provider === 'local') {
      return getLocalFileAccessService().runWithAccess(
        snapshot.folder.path,
        'read',
        async () => {
          // A disconnected root and an absent file are not equivalent. Confirm
          // the authorized root before accepting absence of the audio itself.
          const root = await stat(snapshot.folder.path)
          if (!root.isDirectory()) throw new Error('La raíz local del journal no es una carpeta.')
          try {
            await stat(snapshot.track.path)
            return false
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
            throw error
          }
        },
        { interactive: false, retryOnce: false },
      )
    }
    if (!snapshot.track.drive_id || !snapshot.track.item_id) return false
    if (await this.oneDriveItemExists(snapshot.track.drive_id, snapshot.track.item_id)) return false
    // A second lookup is the explicit absence confirmation required before a
    // remote 404 can be treated as a completed recycle-bin operation.
    return !await this.oneDriveItemExists(snapshot.track.drive_id, snapshot.track.item_id)
  }

  private journalSnapshot(snapshot: ResolutionSnapshot): ResolutionSnapshot {
    return {
      candidate: snapshot.candidate,
      kept: {
        ...snapshot.kept,
        track: { ...snapshot.kept.track, artwork_data: null },
        folder: { ...snapshot.kept.folder, bookmark_data: null },
      },
      removed: {
        ...snapshot.removed,
        track: { ...snapshot.removed.track, artwork_data: null },
        folder: { ...snapshot.removed.folder, bookmark_data: null },
      },
    }
  }

  private afterCatalogChange(snapshot: ResolutionSnapshot): void {
    const folderIds = new Set([snapshot.removed.folder.id, snapshot.kept.folder.id])
    for (const folderId of folderIds) {
      getLibraryBackup().scheduleWriteForFolder(folderId)
      getCloudManifestService().scheduleWriteForFolder(folderId)
      getDuplicateDecisionPortableService().scheduleForFolder(folderId)
    }
    this.notifyChanged('resolved')
    broadcast('library:changed', { reason: 'duplicate-resolution' })
  }

  private notifyChanged(reason: string): void {
    broadcast('duplicates:changed', { reason, summary: this.repo.summary() })
  }
}

let service: DuplicateResolutionService | null = null

export function getDuplicateResolutionService(): DuplicateResolutionService {
  service ??= new DuplicateResolutionService()
  return service
}
