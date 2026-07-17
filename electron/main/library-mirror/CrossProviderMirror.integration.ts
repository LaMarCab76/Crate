import { strict as assert } from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import {
  CloudHttpError,
  type DriveItem,
  type OneDriveClient,
  type ResumableUploadSession,
  type UploadedItem,
} from '../cloud/OneDriveClient.ts'
import { driveItemRemotePath } from '../cloud/cloudMetadata.ts'
import { applyMigrationPlan, buildMigrationCatalog, planMigrations } from '../db/migrationCore.ts'
import { FolderRepo } from '../db/repositories/FolderRepo.ts'
import { LibraryMirrorService } from './LibraryMirrorService.ts'
import { LocalMirrorAdapter } from './LocalMirrorAdapter.ts'
import { OneDriveMirrorAdapter } from './OneDriveMirrorAdapter.ts'
import { QuickXorHasher } from './hashes.ts'

function migrate(db: Database.Database): void {
  const directory = new URL('../db/migrations/', import.meta.url)
  const catalog = buildMigrationCatalog(Object.fromEntries(
    readdirSync(directory)
      .filter(name => name.endsWith('.sql'))
      .map(name => [`./migrations/${name}`, readFileSync(new URL(name, directory), 'utf8')]),
  ))
  db.pragma('foreign_keys = ON')
  applyMigrationPlan(db, planMigrations(catalog, 0))
}

interface StoredItem {
  item: DriveItem
  bytes: Buffer | null
}

interface PendingUpload {
  driveId: string
  parentItemId: string
  itemId?: string
  filename: string
}

class FakeOneDrive {
  private readonly items = new Map<string, StoredItem>()
  private readonly sessions = new Map<string, PendingUpload>()
  private sequence = 0
  readonly driveId = 'drive'
  readonly rootItemId = 'root'
  uploadFailureStatus: number | null = null

  constructor() {
    this.items.set(this.rootItemId, {
      item: {
        id: this.rootItemId,
        name: 'Cloud',
        folder: { childCount: 0 },
        parentReference: { driveId: this.driveId, path: '/drive/root:' },
      },
      bytes: null,
    })
  }

  seedRootFile(name: string, bytes: Buffer): DriveItem {
    return this.seedFile(this.rootItemId, name, bytes)
  }

  seedFile(parentItemId: string, name: string, bytes: Buffer): DriveItem {
    const existing = this.children(parentItemId).find(item => item.item.name === name)
    return this.storeFile(existing?.item.id ?? this.nextId(), parentItemId, name, bytes)
  }

  seedRootFolder(name: string): DriveItem {
    const existing = this.children(this.rootItemId).find(item => item.item.name === name)
    if (existing) return existing.item
    const parent = this.require(this.rootItemId).item
    const item: DriveItem = {
      id: this.nextId(),
      name,
      eTag: this.etag(),
      folder: { childCount: 0 },
      parentReference: {
        driveId: this.driveId,
        id: parent.id,
        path: `/drive/root:${driveItemRemotePath(parent)}`,
      },
    }
    this.items.set(item.id, { item, bytes: null })
    return item
  }

  removeRootItem(name: string): void {
    const found = this.children(this.rootItemId).find(item => item.item.name === name)
    if (found) this.items.delete(found.item.id)
  }

  rootBytes(name: string): Buffer | null {
    return this.childBytes(this.rootItemId, name)
  }

  childBytes(parentItemId: string, name: string): Buffer | null {
    return this.children(parentItemId).find(item => item.item.name === name)?.bytes ?? null
  }

  async getItem(_driveId: string, itemId: string): Promise<DriveItem> {
    return structuredClone(this.require(itemId).item)
  }

  async listChildren(_driveId: string, parentItemId: string): Promise<DriveItem[]> {
    return this.children(parentItemId).map(value => structuredClone(value.item))
  }

  async *listDelta(_driveId: string, rootItemId: string): AsyncGenerator<{
    items: DriveItem[]
    deltaLink: string
    reset: boolean
  }> {
    yield {
      items: [...this.items.values()]
        .filter(value => value.item.id !== rootItemId && this.isDescendantOf(value.item.id, rootItemId))
        .map(value => structuredClone(value.item)),
      deltaLink: 'https://graph.microsoft.com/v1.0/fake-delta',
      reset: false,
    }
  }

  async *downloadChunks(options: { itemId: string; sizeBytes: number }): AsyncGenerator<Uint8Array> {
    const bytes = this.require(options.itemId).bytes
    if (!bytes || bytes.byteLength !== options.sizeBytes) throw new Error('fake download size mismatch')
    for (let offset = 0; offset < bytes.byteLength; offset += 2) yield bytes.subarray(offset, offset + 2)
  }

  async createFolder(options: {
    parentItemId: string
    name: string
  }): Promise<DriveItem> {
    const parent = this.require(options.parentItemId).item
    const item: DriveItem = {
      id: this.nextId(),
      name: options.name,
      eTag: this.etag(),
      folder: { childCount: 0 },
      parentReference: {
        driveId: this.driveId,
        id: parent.id,
        path: `/drive/root:${driveItemRemotePath(parent)}`,
      },
    }
    this.items.set(item.id, { item, bytes: null })
    return structuredClone(item)
  }

  async createUploadSession(options: PendingUpload): Promise<ResumableUploadSession> {
    if (this.uploadFailureStatus != null) {
      throw new CloudHttpError(this.uploadFailureStatus, `fake upload failed (${this.uploadFailureStatus})`)
    }
    const uploadUrl = `https://uploads.example.test/${this.nextId()}`
    this.sessions.set(uploadUrl, options)
    return { uploadUrl, expirationDateTime: null, nextExpectedRanges: ['0-'] }
  }

  async uploadResumable(options: {
    uploadUrl: string
    sizeBytes: number
    startOffset?: number
    readChunk(offset: number, length: number): Promise<Uint8Array>
    onProgress?(completed: number, total: number): void
  }): Promise<UploadedItem> {
    const pending = this.sessions.get(options.uploadUrl)
    if (!pending) throw new Error('fake upload session is missing')
    const start = options.startOffset ?? 0
    const bytes = Buffer.alloc(options.sizeBytes)
    if (start !== 0) throw new Error('fake only supports fresh uploads')
    const chunk = await options.readChunk(0, options.sizeBytes)
    bytes.set(chunk)
    const item = this.storeFile(
      pending.itemId ?? this.nextId(),
      pending.parentItemId,
      pending.filename,
      bytes,
    )
    options.onProgress?.(bytes.byteLength, bytes.byteLength)
    this.sessions.delete(options.uploadUrl)
    return {
      id: item.id,
      name: item.name ?? '',
      size: item.size ?? 0,
      etag: item.eTag ?? null,
      quickXorHash: item.file?.hashes?.quickXorHash ?? null,
    }
  }

  async uploadBuffer(options: PendingUpload & { buffer: Buffer; onProgress?(completed: number, total: number): void }): Promise<UploadedItem> {
    const item = this.storeFile(
      options.itemId ?? this.nextId(),
      options.parentItemId,
      options.filename,
      options.buffer,
    )
    options.onProgress?.(options.buffer.byteLength, options.buffer.byteLength)
    return {
      id: item.id,
      name: item.name ?? '',
      size: item.size ?? 0,
      etag: item.eTag ?? null,
      quickXorHash: item.file?.hashes?.quickXorHash ?? null,
    }
  }

  async deleteItemToRecycleBin(options: { itemId: string }): Promise<void> {
    this.items.delete(options.itemId)
  }

  private storeFile(id: string, parentItemId: string, name: string, bytes: Buffer): DriveItem {
    const parent = this.require(parentItemId).item
    const item: DriveItem = {
      id,
      name,
      size: bytes.byteLength,
      eTag: this.etag(),
      lastModifiedDateTime: new Date(1_700_000_000_000 + this.sequence).toISOString(),
      file: { hashes: { quickXorHash: new QuickXorHasher().update(bytes).digest() } },
      parentReference: {
        driveId: this.driveId,
        id: parent.id,
        path: `/drive/root:${driveItemRemotePath(parent)}`,
      },
    }
    this.items.set(id, { item, bytes: Buffer.from(bytes) })
    return structuredClone(item)
  }

  private children(parentItemId: string): StoredItem[] {
    return [...this.items.values()].filter(value => value.item.parentReference?.id === parentItemId)
  }

  private isDescendantOf(itemId: string, rootItemId: string): boolean {
    let current = this.items.get(itemId)?.item
    const visited = new Set<string>()
    while (current?.parentReference?.id) {
      const parentId = current.parentReference.id
      if (parentId === rootItemId) return true
      if (visited.has(parentId)) return false
      visited.add(parentId)
      current = this.items.get(parentId)?.item
    }
    return false
  }

  private require(itemId: string): StoredItem {
    const value = this.items.get(itemId)
    if (!value) throw new Error(`fake item ${itemId} is missing`)
    return value
  }

  private nextId(): string {
    this.sequence += 1
    return `item-${this.sequence}`
  }

  private etag(): string {
    this.sequence += 1
    return `etag-${this.sequence}`
  }
}

function addCloudFolder(folders: FolderRepo, cloud: FakeOneDrive, name: string) {
  return folders.addOneDrive({
    accountId: 'account',
    driveId: cloud.driveId,
    itemId: cloud.rootItemId,
    name,
    remotePath: '/Cloud',
  })
}

function addCloudFolderAt(folders: FolderRepo, cloud: FakeOneDrive, root: DriveItem, name: string) {
  return folders.addOneDrive({
    accountId: 'account',
    driveId: cloud.driveId,
    itemId: root.id,
    name,
    remotePath: driveItemRemotePath(root),
  })
}

test('local to OneDrive mirrors bytes, empty folders, updates and recycle-bin deletions', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'crate-cross-source-'))
  const db = new Database(':memory:')
  try {
    migrate(db)
    await writeFile(join(sourceRoot, 'song.flac'), 'v1')
    await mkdir(join(sourceRoot, 'Empty'))
    const folders = new FolderRepo(db)
    const source = folders.add(sourceRoot, 'Local source')
    const cloud = new FakeOneDrive()
    const backup = addCloudFolder(folders, cloud, 'Cloud backup')
    folders.assignBackup(source.id, backup.id)
    const service = new LibraryMirrorService({
      db,
      adapters: [new LocalMirrorAdapter(), new OneDriveMirrorAdapter(cloud as unknown as OneDriveClient)],
    })

    cloud.uploadFailureStatus = 507
    await assert.rejects(() => service.sync(backup.id), /fake upload failed \(507\)/)
    assert.equal(await readFile(join(sourceRoot, 'song.flac'), 'utf8'), 'v1')
    assert.equal(cloud.rootBytes('song.flac'), null)
    const failed = service.getLatestSummary(backup.id)
    assert.equal(failed?.status, 'failed')
    cloud.uploadFailureStatus = null
    const restartedService = new LibraryMirrorService({
      db,
      adapters: [new LocalMirrorAdapter(), new OneDriveMirrorAdapter(cloud as unknown as OneDriveClient)],
    })
    const preserved = await restartedService.sync(backup.id, { trigger: 'startup' })
    assert.equal(preserved.runId, failed!.runId)
    assert.equal(preserved.status, 'failed')
    assert.equal((await restartedService.resume(failed!.runId)).status, 'completed')
    assert.equal(cloud.rootBytes('song.flac')?.toString(), 'v1')
    assert.ok((await cloud.listChildren(cloud.driveId, cloud.rootItemId)).some(item => item.name === 'Empty' && item.folder))

    await writeFile(join(sourceRoot, 'song.flac'), 'v2')
    assert.equal((await service.sync(backup.id)).status, 'completed')
    assert.equal(cloud.rootBytes('song.flac')?.toString(), 'v2')
    await rm(join(sourceRoot, 'song.flac'))
    assert.equal((await service.sync(backup.id)).status, 'completed')
    assert.equal(cloud.rootBytes('song.flac'), null)
  } finally {
    db.close()
    await rm(sourceRoot, { recursive: true, force: true })
  }
})

test('OneDrive to local mirrors through bounded downloads without indexing the backup', async () => {
  const backupRoot = await mkdtemp(join(tmpdir(), 'crate-cross-backup-'))
  const db = new Database(':memory:')
  try {
    migrate(db)
    const folders = new FolderRepo(db)
    const cloud = new FakeOneDrive()
    cloud.seedRootFile('song.flac', Buffer.from('cloud-v1'))
    cloud.seedRootFolder('Empty')
    const source = addCloudFolder(folders, cloud, 'Cloud source')
    const backup = folders.add(backupRoot, 'Local backup')
    folders.assignBackup(source.id, backup.id)
    const service = new LibraryMirrorService({
      db,
      adapters: [new LocalMirrorAdapter(), new OneDriveMirrorAdapter(cloud as unknown as OneDriveClient)],
    })

    assert.equal((await service.sync(backup.id)).status, 'completed')
    assert.equal(await readFile(join(backupRoot, 'song.flac'), 'utf8'), 'cloud-v1')
    assert.equal((await stat(join(backupRoot, 'Empty'))).isDirectory(), true)
    assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM tracks WHERE folder_id = ?`).get(backup.id) as { count: number }).count, 0)

    cloud.seedRootFile('song.flac', Buffer.from('cloud-v2'))
    assert.equal((await service.sync(backup.id)).status, 'completed')
    assert.equal(await readFile(join(backupRoot, 'song.flac'), 'utf8'), 'cloud-v2')
    cloud.removeRootItem('song.flac')
    assert.equal((await service.sync(backup.id)).status, 'completed')
    await assert.rejects(() => stat(join(backupRoot, 'song.flac')), /ENOENT/)
  } finally {
    db.close()
    await rm(backupRoot, { recursive: true, force: true })
  }
})

test('OneDrive to OneDrive mirrors through bounded download and resumable upload in the connected account', async () => {
  const db = new Database(':memory:')
  try {
    migrate(db)
    const folders = new FolderRepo(db)
    const cloud = new FakeOneDrive()
    const sourceRoot = cloud.seedRootFolder('Source')
    const backupRoot = cloud.seedRootFolder('Backup')
    cloud.seedFile(sourceRoot.id, 'song.flac', Buffer.from('cloud-copy'))
    const source = addCloudFolderAt(folders, cloud, sourceRoot, 'Cloud source')
    const backup = addCloudFolderAt(folders, cloud, backupRoot, 'Cloud backup')
    folders.assignBackup(source.id, backup.id)
    const service = new LibraryMirrorService({
      db,
      adapters: [new OneDriveMirrorAdapter(cloud as unknown as OneDriveClient)],
    })

    assert.equal((await service.sync(backup.id)).status, 'completed')
    assert.equal(cloud.childBytes(sourceRoot.id, 'song.flac')?.toString(), 'cloud-copy')
    assert.equal(cloud.childBytes(backupRoot.id, 'song.flac')?.toString(), 'cloud-copy')
    assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM tracks WHERE folder_id = ?`).get(backup.id) as { count: number }).count, 0)
  } finally {
    db.close()
  }
})
