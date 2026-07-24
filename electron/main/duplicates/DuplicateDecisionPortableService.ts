import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import { stringify as stringifyYaml } from 'yaml'
import type { DbFolder } from '@shared/types/db'
import { getDatabase } from '../db/database.ts'
import { getRepos } from '../db/repositories/index.ts'
import { CloudHttpError, getOneDriveClient, type DriveItem, type OneDriveClient } from '../cloud/OneDriveClient.ts'
import { cloudRelativePath, isSafePortablePath } from '../cloud/cloudPortableManifest.ts'
import { getLibraryBackup } from '../services/LibraryBackup.ts'
import { getLocalFileAccessService } from '../security/localFileAccessRuntime.ts'
import {
  DUPLICATE_DECISIONS_MAX_BYTES as MAX_BYTES,
  DUPLICATE_DECISIONS_VERSION as VERSION,
  parseDuplicateDecisionPortable,
  type PortableBinding,
  type PortableDecision,
  type PortableDuplicateDecisionFile as PortableFile,
} from './duplicateDecisionPortableFormat.ts'

const STATE_DIR = '.crate'
const FILE_NAME = 'duplicate-decisions.yaml'
const WRITE_DELAY_MS = 2_000

interface IdentityRow {
  id: string
  track_id: number
  acoustic_digest: string
  algorithm: string
  algorithm_version: string
}

interface DecisionRow {
  id: string
  pair_key: string
  low_identity_id: string
  high_identity_id: string
  low_acoustic_digest: string
  high_acoustic_digest: string
  algorithm: string
  algorithm_version: string
  reason: 'different_versions' | 'not_duplicates'
  created_at: string
  updated_at: string
}

function toPortableReason(reason: DecisionRow['reason']): PortableDecision['reason'] {
  return reason === 'different_versions' ? 'versiones_distintas' : 'no_son_duplicados'
}

function fromPortableReason(reason: PortableDecision['reason']): DecisionRow['reason'] {
  return reason === 'versiones_distintas' ? 'different_versions' : 'not_duplicates'
}

type PortableRead =
  | { status: 'missing'; stateFolder?: DriveItem | null; item?: DriveItem | null }
  | { status: 'invalid'; stateFolder?: DriveItem | null; item?: DriveItem | null }
  | { status: 'ready'; file: PortableFile; stateFolder?: DriveItem | null; item?: DriveItem | null }

function localRelative(folder: DbFolder, path: string): string | null {
  const value = relative(resolve(folder.path), resolve(path)).split(sep).join('/')
  return isSafePortablePath(value) ? value : null
}

function sourceRelative(folder: DbFolder, path: string, remotePath: string | null): string | null {
  if (folder.provider === 'local') return localRelative(folder, path)
  if (!remotePath) return null
  const value = cloudRelativePath(folder.remote_path ?? '/', remotePath)
  return value && isSafePortablePath(value) ? value : null
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    try {
      await rename(temporary, path)
    } catch (error) {
      if (!existsSync(path)) throw error
      const previous = `${path}.${randomUUID()}.previous`
      await rename(path, previous)
      try {
        await rename(temporary, path)
      } catch (publishError) {
        if (!existsSync(path)) await rename(previous, path)
        throw publishError
      }
      await rm(previous, { force: true })
    }
  } finally {
    await rm(temporary, { force: true })
  }
}

export class DuplicateDecisionPortableService {
  private readonly client: OneDriveClient
  private readonly timers = new Map<number, NodeJS.Timeout>()
  private readonly writes = new Map<number, Promise<boolean>>()
  private enabled = true

  constructor(client = getOneDriveClient()) {
    this.client = client
  }

  private get db(): BetterSqliteDatabase {
    return getDatabase()
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) {
      for (const timer of this.timers.values()) clearTimeout(timer)
      this.timers.clear()
    }
  }

  isEnabled(): boolean {
    return this.enabled && getLibraryBackup().isEnabled()
  }

  scheduleForFolder(folderId: number): void {
    if (!this.enabled) return
    const previous = this.timers.get(folderId)
    if (previous) clearTimeout(previous)
    this.timers.set(folderId, setTimeout(() => {
      this.timers.delete(folderId)
      void this.enqueueWrite(folderId)
    }, WRITE_DELAY_MS))
  }

  scheduleForCandidate(candidateId: string): void {
    const rows = this.db.prepare<[string], { folder_id: number }>(`
      SELECT DISTINCT t.folder_id
      FROM duplicate_candidates c
      JOIN tracks t ON t.id IN (c.track_low_id, c.track_high_id)
      JOIN folders f ON f.id = t.folder_id
      WHERE c.id = ? AND f.role = 'library'
    `).all(candidateId)
    for (const row of rows) this.scheduleForFolder(row.folder_id)
  }


  async writeCandidateNow(candidateId: string, owner?: unknown): Promise<string[]> {
    const rows = this.db.prepare<[string], { folder_id: number; name: string }>(`
      SELECT DISTINCT f.id AS folder_id, f.name
      FROM duplicate_candidates c
      JOIN tracks t ON t.id IN (c.track_low_id, c.track_high_id)
      JOIN folders f ON f.id = t.folder_id
      WHERE c.id = ? AND f.role = 'library'
      ORDER BY f.id
    `).all(candidateId)
    if (!this.isEnabled()) {
      return ['La decisión quedó en SQLite, pero el estado portable está desactivado y no sobrevivirá a una reconstrucción completa de la base de datos.']
    }
    if (rows.length === 0) {
      return ['La decisión quedó en SQLite, pero no se encontraron bibliotecas donde guardar su copia portable.']
    }
    const warnings: string[] = []
    for (const row of rows) {
      try {
        const written = await this.writeForFolder(row.folder_id, { owner, interactive: true })
        if (!written) warnings.push(`No se pudo guardar la decisión portable en “${row.name}”.`)
      } catch (error) {
        warnings.push(`No se pudo guardar la decisión portable en “${row.name}”: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (warnings.length > 0) {
      warnings.push('La decisión sigue guardada en SQLite, pero podría no sobrevivir a una reconstrucción completa de la base de datos.')
    }
    return warnings
  }

  async importForFolder(folderId: number): Promise<'missing' | 'invalid' | 'imported'> {
    const folder = getRepos().folders.getById(folderId)
    if (!folder || folder.role !== 'library') return 'missing'
    const read = folder.provider === 'local'
      ? await this.readLocal(folder)
      : await this.readCloud(folder)
    if (read.status !== 'ready') return read.status
    this.merge(folder, read.file)
    return 'imported'
  }

  async flushAll(): Promise<void> {
    const folderIds = [...this.timers.keys()]
    for (const folderId of folderIds) {
      clearTimeout(this.timers.get(folderId)!)
      this.timers.delete(folderId)
      void this.enqueueWrite(folderId)
    }
    await Promise.allSettled([...this.writes.values()])
  }

  private enqueueWrite(folderId: number): Promise<boolean> {
    const previous = this.writes.get(folderId) ?? Promise.resolve(false)
    const next = previous.catch(() => false).then(() => this.writeForFolder(folderId)).finally(() => {
      if (this.writes.get(folderId) === next) this.writes.delete(folderId)
    })
    this.writes.set(folderId, next)
    return next
  }

  async writeForFolder(
    folderId: number,
    options: { owner?: unknown; interactive?: boolean } = {},
  ): Promise<boolean> {
    if (!this.isEnabled()) return false
    const folder = getRepos().folders.getById(folderId)
    if (!folder || folder.role !== 'library') return false
    const file = this.build(folder)
    const serialized = stringifyYaml(file)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_BYTES) return false
    if (folder.provider === 'local') {
      const current = await this.readLocal(folder)
      if (current.status === 'invalid') return false
      await getLocalFileAccessService().runWithAccess(
        folder.path,
        'write',
        () => writeAtomic(join(folder.path, STATE_DIR, FILE_NAME), serialized),
        { owner: options.owner, interactive: options.interactive === true, retryOnce: false },
      )
      return true
    }
    return this.writeCloud(folder, file, true, serialized)
  }

  private build(folder: DbFolder): PortableFile {
    const identities = this.db.prepare<[number], IdentityRow & { path: string; remote_path: string | null }>(`
      SELECT i.*, t.path, t.remote_path
      FROM duplicate_track_identities i
      JOIN tracks t ON t.id = i.track_id
      WHERE t.folder_id = ?
    `).all(folder.id)
    const bindings: Record<string, PortableBinding> = {}
    for (const identity of identities) {
      const relativePath = sourceRelative(folder, identity.path, identity.remote_path)
      if (!relativePath) continue
      bindings[identity.id] = {
        relativePath,
        algorithm: identity.algorithm,
        algorithmVersion: identity.algorithm_version,
        acousticDigest: identity.acoustic_digest,
      }
    }
    const identityIds = Object.keys(bindings)
    const decisions: Record<string, PortableDecision> = {}
    if (identityIds.length > 0) {
      const placeholders = identityIds.map(() => '?').join(',')
      const rows = this.db.prepare<string[], DecisionRow>(`
        SELECT * FROM duplicate_pair_decisions
        WHERE low_identity_id IN (${placeholders}) OR high_identity_id IN (${placeholders})
      `).all(...identityIds, ...identityIds)
      for (const row of rows) {
        decisions[row.pair_key] = {
          id: row.id,
          lowIdentityId: row.low_identity_id,
          highIdentityId: row.high_identity_id,
          lowAcousticDigest: row.low_acoustic_digest,
          highAcousticDigest: row.high_acoustic_digest,
          algorithm: row.algorithm,
          algorithmVersion: row.algorithm_version,
          reason: toPortableReason(row.reason),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      }
    }
    return { version: VERSION, appName: 'Crate', updatedAt: new Date().toISOString(), bindings, decisions }
  }

  private merge(folder: DbFolder, file: PortableFile): void {
    const trackByRelative = new Map<string, number>()
    for (const track of getRepos().tracks.getByFolder(folder.id)) {
      const rel = sourceRelative(folder, track.path, track.remote_path)
      if (rel) trackByRelative.set(rel, track.id)
    }
    const identityMap = new Map<string, string>()
    const claimedTrackIds = new Set<number>()
    const claimedIdentityIds = new Set<string>()
    const now = new Date().toISOString()
    const tx = this.db.transaction(() => {
      // A cross-root manifest only carries bindings for tracks in this root, but
      // its decisions reference both portable UUIDs. Seed mappings for UUIDs
      // already restored by another root, provided every immutable fingerprint
      // field still agrees.
      const referencedIdentities = new Map<string, {
        acousticDigest: string
        algorithm: string
        algorithmVersion: string
        compatible: boolean
      }>()
      const rememberReference = (
        id: string,
        acousticDigest: string,
        algorithm: string,
        algorithmVersion: string,
      ) => {
        const previous = referencedIdentities.get(id)
        if (!previous) {
          referencedIdentities.set(id, { acousticDigest, algorithm, algorithmVersion, compatible: true })
          return
        }
        if (
          previous.acousticDigest !== acousticDigest
          || previous.algorithm !== algorithm
          || previous.algorithmVersion !== algorithmVersion
        ) previous.compatible = false
      }
      for (const decision of Object.values(file.decisions)) {
        rememberReference(
          decision.lowIdentityId,
          decision.lowAcousticDigest,
          decision.algorithm,
          decision.algorithmVersion,
        )
        rememberReference(
          decision.highIdentityId,
          decision.highAcousticDigest,
          decision.algorithm,
          decision.algorithmVersion,
        )
      }
      for (const [portableId, expected] of referencedIdentities) {
        if (!expected.compatible) continue
        const current = this.db.prepare<[string], IdentityRow>(`
          SELECT * FROM duplicate_track_identities WHERE id = ?
        `).get(portableId)
        if (
          current
          && current.acoustic_digest === expected.acousticDigest
          && current.algorithm === expected.algorithm
          && current.algorithm_version === expected.algorithmVersion
        ) {
          identityMap.set(portableId, current.id)
          claimedTrackIds.add(current.track_id)
          claimedIdentityIds.add(current.id)
        }
      }

      // Prefer the stable relative-path binding. A pre-existing identity is only
      // accepted if its audio and algorithm still match; a changed file must
      // reopen the case instead of inheriting the old decision.
      for (const [portableId, binding] of Object.entries(file.bindings)) {
        const trackId = trackByRelative.get(binding.relativePath)
        if (!trackId) continue
        const existing = this.db.prepare<[number], IdentityRow>(
          `SELECT * FROM duplicate_track_identities WHERE track_id = ?`,
        ).get(trackId)
        if (existing) {
          if (
            existing.acoustic_digest === binding.acousticDigest
            && existing.algorithm === binding.algorithm
            && existing.algorithm_version === binding.algorithmVersion
          ) {
            identityMap.set(portableId, existing.id)
            claimedTrackIds.add(existing.track_id)
            claimedIdentityIds.add(existing.id)
          }
          continue
        }
        const occupied = this.db.prepare<[string], { track_id: number }>(
          `SELECT track_id FROM duplicate_track_identities WHERE id = ?`,
        ).get(portableId)
        if (occupied && occupied.track_id !== trackId) continue
        this.db.prepare(`
          INSERT INTO duplicate_track_identities (
            id, track_id, acoustic_digest, algorithm, algorithm_version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(portableId, trackId, binding.acousticDigest, binding.algorithm, binding.algorithmVersion, now, now)
        identityMap.set(portableId, portableId)
        claimedTrackIds.add(trackId)
        claimedIdentityIds.add(portableId)
      }

      // If the path or provider changed, re-bind by the acoustic tuple only when
      // it identifies exactly one unclaimed library track. Analyses are included
      // so a manifest imported after a DB rebuild can recover the portable UUID
      // once Chromaprint has recreated its cache. Multiple identical copies are
      // intentionally ambiguous and therefore reopen the case.
      for (const [portableId, binding] of Object.entries(file.bindings)) {
        if (identityMap.has(portableId)) continue
        const candidates = this.db.prepare<
          [string, string, string, string, string, string],
          { track_id: number; identity_id: string | null }>(`
          SELECT t.id AS track_id, i.id AS identity_id
          FROM tracks t
          JOIN folders f ON f.id = t.folder_id
          LEFT JOIN duplicate_track_identities i ON i.track_id = t.id
          LEFT JOIN duplicate_track_analyses a ON a.track_id = t.id
          WHERE f.role = 'library' AND (
            (i.id IS NOT NULL AND i.acoustic_digest = ?
              AND i.algorithm = ? AND i.algorithm_version = ?)
            OR
            (i.id IS NULL AND a.status = 'ready' AND a.fingerprint_digest = ?
              AND a.algorithm = ? AND a.algorithm_version = ?)
          )
          ORDER BY t.id
        `).all(
          binding.acousticDigest,
          binding.algorithm,
          binding.algorithmVersion,
          binding.acousticDigest,
          binding.algorithm,
          binding.algorithmVersion,
        ).filter(candidate =>
          !claimedTrackIds.has(candidate.track_id)
          && (!candidate.identity_id || !claimedIdentityIds.has(candidate.identity_id)))
        if (candidates.length !== 1) continue

        const [candidate] = candidates
        if (candidate.identity_id) {
          let resolvedIdentityId = candidate.identity_id
          const portableOccupied = this.db.prepare<[string], { track_id: number }>(`
            SELECT track_id FROM duplicate_track_identities WHERE id = ?
          `).get(portableId)
          const hasDecisionReferences = this.db.prepare<[string, string], { found: number }>(`
            SELECT 1 AS found FROM duplicate_pair_decisions
            WHERE low_identity_id = ? OR high_identity_id = ? LIMIT 1
          `).get(candidate.identity_id, candidate.identity_id)
          const hasDeviceReferences = this.db.prepare<[string], { found: number }>(`
            SELECT 1 AS found FROM device_duplicate_deletions
            WHERE track_identity_id = ? LIMIT 1
          `).get(candidate.identity_id)
          // Immediately after a DB rebuild the fresh analysis has a random UUID
          // and no dependants. Reclaim the portable UUID so manifests from two
          // independently moved roots can resolve each other's decision in the
          // same import cycle. Existing live identities with dependants keep
          // their UUID and use only this merge's in-memory alias.
          if (
            !portableOccupied
            && !hasDecisionReferences
            && !hasDeviceReferences
            && candidate.identity_id !== portableId
          ) {
            this.db.prepare(`
              UPDATE duplicate_track_identities SET id = ?, updated_at = ? WHERE id = ?
            `).run(portableId, now, candidate.identity_id)
            resolvedIdentityId = portableId
          }
          identityMap.set(portableId, resolvedIdentityId)
          claimedIdentityIds.add(resolvedIdentityId)
          claimedTrackIds.add(candidate.track_id)
          continue
        }
        const occupied = this.db.prepare<[string], { track_id: number }>(
          `SELECT track_id FROM duplicate_track_identities WHERE id = ?`,
        ).get(portableId)
        if (occupied) continue
        this.db.prepare(`
          INSERT INTO duplicate_track_identities (
            id, track_id, acoustic_digest, algorithm, algorithm_version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          portableId,
          candidate.track_id,
          binding.acousticDigest,
          binding.algorithm,
          binding.algorithmVersion,
          now,
          now,
        )
        identityMap.set(portableId, portableId)
        claimedIdentityIds.add(portableId)
        claimedTrackIds.add(candidate.track_id)
      }

      for (const decision of Object.values(file.decisions)) {
        const resolvedLowId = identityMap.get(decision.lowIdentityId) ?? decision.lowIdentityId
        const resolvedHighId = identityMap.get(decision.highIdentityId) ?? decision.highIdentityId
        const resolvedLow = this.db.prepare<[string], IdentityRow>(`
          SELECT * FROM duplicate_track_identities WHERE id = ?
        `).get(resolvedLowId)
        const resolvedHigh = this.db.prepare<[string], IdentityRow>(`
          SELECT * FROM duplicate_track_identities WHERE id = ?
        `).get(resolvedHighId)
        if (
          !resolvedLow || !resolvedHigh || resolvedLow.id === resolvedHigh.id
          || resolvedLow.acoustic_digest !== decision.lowAcousticDigest
          || resolvedHigh.acoustic_digest !== decision.highAcousticDigest
          || resolvedLow.algorithm !== decision.algorithm
          || resolvedHigh.algorithm !== decision.algorithm
          || resolvedLow.algorithm_version !== decision.algorithmVersion
          || resolvedHigh.algorithm_version !== decision.algorithmVersion
        ) continue

        let lowId = resolvedLow.id
        let highId = resolvedHigh.id
        let lowDigest = decision.lowAcousticDigest
        let highDigest = decision.highAcousticDigest
        if (lowId > highId) {
          ;[lowId, highId] = [highId, lowId]
          ;[lowDigest, highDigest] = [highDigest, lowDigest]
        }
        const pairKey = `${lowId}:${highId}`
        const idCollision = this.db.prepare<[string], { pair_key: string }>(`
          SELECT pair_key FROM duplicate_pair_decisions WHERE id = ?
        `).get(decision.id)
        const rowId = idCollision && idCollision.pair_key !== pairKey
          ? randomUUID()
          : decision.id
        this.db.prepare(`
          INSERT INTO duplicate_pair_decisions (
            id, pair_key, low_identity_id, high_identity_id,
            low_acoustic_digest, high_acoustic_digest, algorithm, algorithm_version,
            reason, source, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'portable', ?, ?)
          ON CONFLICT(pair_key) DO UPDATE SET
            low_acoustic_digest = CASE WHEN excluded.updated_at > updated_at THEN excluded.low_acoustic_digest ELSE low_acoustic_digest END,
            high_acoustic_digest = CASE WHEN excluded.updated_at > updated_at THEN excluded.high_acoustic_digest ELSE high_acoustic_digest END,
            algorithm = CASE WHEN excluded.updated_at > updated_at THEN excluded.algorithm ELSE algorithm END,
            algorithm_version = CASE WHEN excluded.updated_at > updated_at THEN excluded.algorithm_version ELSE algorithm_version END,
            reason = CASE WHEN excluded.updated_at > updated_at THEN excluded.reason ELSE reason END,
            source = CASE WHEN excluded.updated_at > updated_at THEN 'portable' ELSE source END,
            updated_at = MAX(updated_at, excluded.updated_at)
        `).run(
          rowId, pairKey, lowId, highId, lowDigest, highDigest,
          decision.algorithm, decision.algorithmVersion, fromPortableReason(decision.reason),
          decision.createdAt, decision.updatedAt,
        )
      }
    })
    tx()
  }

  private async readLocal(folder: DbFolder): Promise<PortableRead> {
    const path = join(folder.path, STATE_DIR, FILE_NAME)
    if (!existsSync(path)) return { status: 'missing' }
    try {
      if ((await stat(path)).size > MAX_BYTES) return { status: 'invalid' }
      const file = parseDuplicateDecisionPortable(await readFile(path, 'utf8'))
      return file ? { status: 'ready', file } : { status: 'invalid' }
    } catch {
      return { status: 'invalid' }
    }
  }

  private async readCloud(folder: DbFolder): Promise<PortableRead> {
    if (!folder.drive_id || !folder.item_id) return { status: 'missing' }
    const children = await this.client.listChildren(folder.drive_id, folder.item_id)
    const stateFolder = children.find(item => item.name === STATE_DIR && item.folder) ?? null
    if (!stateFolder) return { status: 'missing', stateFolder: null, item: null }
    const stateChildren = await this.client.listChildren(folder.drive_id, stateFolder.id)
    const item = stateChildren.find(child => child.name === FILE_NAME && child.file) ?? null
    if (!item) return { status: 'missing', stateFolder, item: null }
    if (typeof item.size === 'number' && item.size > MAX_BYTES) {
      return { status: 'invalid', stateFolder, item }
    }
    const text = await this.client.downloadChildText(folder.drive_id, stateFolder.id, FILE_NAME)
    const file = text == null ? null : parseDuplicateDecisionPortable(text)
    return file ? { status: 'ready', file, stateFolder, item } : { status: 'invalid', stateFolder, item }
  }

  private async ensureCloudStateFolder(folder: DbFolder): Promise<DriveItem> {
    try {
      return await this.client.createFolder({
        driveId: folder.drive_id!, parentItemId: folder.item_id!, name: STATE_DIR, conflictBehavior: 'fail',
      })
    } catch (error) {
      if (!(error instanceof CloudHttpError) || error.status !== 409) throw error
      const children = await this.client.listChildren(folder.drive_id!, folder.item_id!)
      const existing = children.find(item => item.name === STATE_DIR && item.folder)
      if (!existing) throw error
      return existing
    }
  }

  private async writeCloud(
    folder: DbFolder,
    file: PortableFile,
    retry = true,
    serialized = stringifyYaml(file),
  ): Promise<boolean> {
    if (!folder.drive_id || !folder.item_id) return false
    const buffer = Buffer.from(serialized, 'utf8')
    if (buffer.byteLength > MAX_BYTES) return false
    const current = await this.readCloud(folder)
    if (current.status === 'invalid') return false
    const stateFolder = current.stateFolder ?? await this.ensureCloudStateFolder(folder)
    try {
      await this.client.uploadBuffer({
        driveId: folder.drive_id,
        parentItemId: stateFolder.id,
        itemId: current.item?.id,
        filename: FILE_NAME,
        buffer,
        conflictBehavior: 'replace',
        ifMatch: current.item?.eTag ?? current.item?.cTag,
      })
      return true
    } catch (error) {
      if (retry && error instanceof CloudHttpError && error.status === 412) {
        const latest = await this.readCloud(folder)
        if (latest.status === 'ready') this.merge(folder, latest.file)
        const latestFile = this.build(folder)
        return this.writeCloud(folder, latestFile, false, stringifyYaml(latestFile))
      }
      throw error
    }
  }
}

let service: DuplicateDecisionPortableService | null = null

export function getDuplicateDecisionPortableService(): DuplicateDecisionPortableService {
  service ??= new DuplicateDecisionPortableService()
  return service
}
