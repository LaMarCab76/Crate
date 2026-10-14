import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, parse } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

// Files deleted from a device are not unlinked right away: they are moved to
// `.crate/trash/<batch>/<relative path>` on the device itself. Each batch keeps
// a log with the time every file was moved there, and syncs permanently delete
// batches older than the retention period.

export const DEVICE_TRASH_RETENTION_DAYS = 15
export const DEVICE_TRASH_RETENTION_MS = DEVICE_TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000
export const DEVICE_TRASH_LOG_NAME = 'crate-trash-log.yaml'
const DEVICE_TRASH_LOG_VERSION = 1
const MAX_LOG_BYTES = 16 * 1024 * 1024
const BATCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export type DeviceTrashReason = 'sync-delete' | 'folder-cleanup' | 'discovered'

export interface DeviceTrashLogEntry {
  /** POSIX path relative to the device music root, as it was before the move. */
  path: string
  movedAt: string
  reason: DeviceTrashReason
}

export interface DeviceTrashLog {
  version: number
  batchId: string
  createdAt: string
  /** Time of the most recent move into this batch. */
  updatedAt: string
  /** The batch is permanently deleted by the first sync after this time. */
  purgeAfter: string
  entries: DeviceTrashLogEntry[]
}

function assertBatchId(batchId: string): void {
  if (!BATCH_ID_PATTERN.test(batchId)) throw new Error(`Invalid device trash batch id: ${batchId}`)
}

function isoAfterRetention(iso: string, retentionMs: number): string {
  return new Date(Date.parse(iso) + retentionMs).toISOString()
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

export async function readDeviceTrashLog(batchDir: string): Promise<DeviceTrashLog | null> {
  const path = join(batchDir, DEVICE_TRASH_LOG_NAME)
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.size > MAX_LOG_BYTES) return null
    const parsed = parseYaml(await readFile(path, 'utf8')) as Partial<DeviceTrashLog> | null
    if (!parsed || typeof parsed.updatedAt !== 'string' || !Number.isFinite(Date.parse(parsed.updatedAt))) return null
    return {
      version: typeof parsed.version === 'number' ? parsed.version : DEVICE_TRASH_LOG_VERSION,
      batchId: typeof parsed.batchId === 'string' ? parsed.batchId : '',
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : parsed.updatedAt,
      updatedAt: parsed.updatedAt,
      purgeAfter: typeof parsed.purgeAfter === 'string' ? parsed.purgeAfter : parsed.updatedAt,
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
    }
  } catch {
    return null
  }
}

async function writeDeviceTrashLog(batchDir: string, log: DeviceTrashLog): Promise<void> {
  const path = join(batchDir, DEVICE_TRASH_LOG_NAME)
  const tmp = `${path}.${randomUUID()}.tmp`
  await mkdir(batchDir, { recursive: true })
  try {
    await writeFile(tmp, stringifyYaml(log), 'utf8')
    await rename(tmp, path)
  } catch (err) {
    await unlink(tmp).catch(() => undefined)
    throw err
  }
}

function buildLog(
  batchId: string,
  createdAt: string,
  entries: DeviceTrashLogEntry[],
  retentionMs: number,
): DeviceTrashLog {
  const updatedAt = entries.reduce(
    (latest, entry) => (Date.parse(entry.movedAt) > Date.parse(latest) ? entry.movedAt : latest),
    createdAt,
  )
  return {
    version: DEVICE_TRASH_LOG_VERSION,
    batchId,
    createdAt,
    updatedAt,
    purgeAfter: isoAfterRetention(updatedAt, retentionMs),
    entries,
  }
}

/**
 * One batch of the device trash (a sync run or a folder cleanup). Moves are
 * recorded in memory and written to the batch log; the first record writes the
 * log immediately so the batch is dated even if the app stops mid-run.
 */
export class DeviceTrashBatch {
  readonly batchId: string
  readonly dir: string
  private readonly now: () => Date
  private readonly retentionMs: number
  private pending: DeviceTrashLogEntry[] = []
  private logged = false

  constructor(
    trashRoot: string,
    batchId: string,
    now: () => Date = () => new Date(),
    retentionMs = DEVICE_TRASH_RETENTION_MS,
  ) {
    assertBatchId(batchId)
    this.batchId = batchId
    this.dir = join(trashRoot, batchId)
    this.now = now
    this.retentionMs = retentionMs
  }

  /** Destination inside the batch for a POSIX path relative to the music root. */
  destinationFor(relativePath: string): string {
    return join(this.dir, ...relativePath.split('/').filter(Boolean))
  }

  // The move already happened when this runs, so a log write failure must not
  // fail the caller; the next record (or the final flush) retries it.
  async record(relativePath: string, reason: DeviceTrashReason): Promise<void> {
    this.pending.push({ path: relativePath, movedAt: this.now().toISOString(), reason })
    if (this.logged) return
    await this.flush().catch(err => {
      console.warn(`[devices] could not write trash log for ${this.batchId}:`, err instanceof Error ? err.message : String(err))
    })
  }

  /** Moves a device file into the batch, keeping both if the name is taken. */
  async moveInto(source: string, relativePath: string, reason: DeviceTrashReason): Promise<string> {
    let destination = this.destinationFor(relativePath)
    await mkdir(dirname(destination), { recursive: true })
    if (await pathExists(destination)) {
      const parsed = parse(destination)
      destination = join(parsed.dir, `${parsed.name} (${randomUUID().slice(0, 8)})${parsed.ext}`)
    }
    await rename(source, destination)
    await this.record(relativePath, reason)
    return destination
  }

  async flush(): Promise<void> {
    if (this.pending.length === 0) return
    const existing = await readDeviceTrashLog(this.dir)
    const createdAt = existing?.createdAt ?? this.pending[0].movedAt
    const log = buildLog(this.batchId, createdAt, [...(existing?.entries ?? []), ...this.pending], this.retentionMs)
    await writeDeviceTrashLog(this.dir, log)
    this.pending = []
    this.logged = true
  }
}

interface BatchStats {
  files: number
  bytes: number
  paths: string[]
}

async function collectBatchStats(batchDir: string): Promise<BatchStats> {
  const stats: BatchStats = { files: 0, bytes: 0, paths: [] }
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (!prefix && entry.name === DEVICE_TRASH_LOG_NAME) continue
      let info
      try {
        info = await lstat(full)
      } catch {
        continue
      }
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) {
        await walk(full, rel)
      } else if (info.isFile()) {
        stats.files += 1
        stats.bytes += info.size
        stats.paths.push(rel)
      }
    }
  }
  await walk(batchDir, '')
  return stats
}

export interface DeviceTrashPurgeOptions {
  /** `<device>/.crate/trash`. */
  trashRoot: string
  now?: Date
  retentionMs?: number
  /**
   * Time a batch without log was created, when known (e.g. its sync run start).
   * Batches with no log and no known time are dated now and kept.
   */
  batchTimestamp?: (batchId: string) => string | null
  skipBatchIds?: ReadonlySet<string>
}

export interface DeviceTrashPurgeResult {
  purgedBatches: string[]
  files: number
  bytes: number
  /** Legacy batches that got a log written during this pass. */
  datedBatches: string[]
}

/** Permanently deletes trash batches older than the retention period. */
export async function purgeExpiredDeviceTrash(options: DeviceTrashPurgeOptions): Promise<DeviceTrashPurgeResult> {
  const result: DeviceTrashPurgeResult = { purgedBatches: [], files: 0, bytes: 0, datedBatches: [] }
  const now = options.now ?? new Date()
  const retentionMs = options.retentionMs ?? DEVICE_TRASH_RETENTION_MS
  try {
    const rootInfo = await lstat(options.trashRoot)
    if (!rootInfo.isDirectory()) return result
  } catch {
    return result
  }

  const entries = await readdir(options.trashRoot, { withFileTypes: true })
  for (const entry of entries) {
    const batchId = entry.name
    if (!BATCH_ID_PATTERN.test(batchId) || options.skipBatchIds?.has(batchId)) continue
    const batchDir = join(options.trashRoot, batchId)
    const info = await lstat(batchDir).catch(() => null)
    if (!info || !info.isDirectory()) continue

    const log = await readDeviceTrashLog(batchDir)
    let movedAt = log?.updatedAt ?? null
    if (!movedAt) {
      const known = options.batchTimestamp?.(batchId) ?? null
      movedAt = known && Number.isFinite(Date.parse(known)) ? new Date(Date.parse(known)).toISOString() : null
    }

    const expired = movedAt != null && now.getTime() - Date.parse(movedAt) >= retentionMs
    if (log && !expired) continue
    const stats = await collectBatchStats(batchDir)
    if (expired) {
      await rm(batchDir, { recursive: true, force: true })
      result.purgedBatches.push(batchId)
      result.files += stats.files
      result.bytes += stats.bytes
      continue
    }

    // Batch from before trash logs existed: write one so its age is visible
    // and stable from now on.
    const datedAt = movedAt ?? now.toISOString()
    const reason: DeviceTrashReason = movedAt ? 'sync-delete' : 'discovered'
    const logEntries = stats.paths.map(path => ({ path, movedAt: datedAt, reason }))
    await writeDeviceTrashLog(batchDir, buildLog(batchId, datedAt, logEntries, retentionMs))
    result.datedBatches.push(batchId)
  }
  return result
}

