import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { FolderRepo } from '../db/repositories/FolderRepo.ts'
import { applyMigrationPlan, buildMigrationCatalog, planMigrations } from '../db/migrationCore.ts'
import { LibraryMirrorService } from './LibraryMirrorService.ts'
import { LocalMirrorAdapter } from './LocalMirrorAdapter.ts'
import type { MirrorEntry, MirrorInventory, MirrorWriteRequest } from './types.ts'
import type { DbFolder } from '@shared/types/db'

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

test('local mirror copies a complete tree, applies source changes, and gates destination divergence', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'crate-service-source-'))
  const backupRoot = await mkdtemp(join(tmpdir(), 'crate-service-backup-'))
  const db = new Database(':memory:')
  try {
    migrate(db)
    await mkdir(join(sourceRoot, 'Album', 'Empty'), { recursive: true })
    await mkdir(join(sourceRoot, '.crate'), { recursive: true })
    await writeFile(join(sourceRoot, 'Album', 'song.flac'), 'v1')
    await writeFile(join(sourceRoot, 'Album', 'obsolete.flac'), 'remove me')
    await writeFile(join(sourceRoot, '.crate', 'library.yaml'), 'version: 1')
    await writeFile(join(sourceRoot, '.DS_Store'), 'ignored')

    const folders = new FolderRepo(db)
    const source = folders.add(sourceRoot, 'Source')
    const backup = folders.add(backupRoot, 'Backup')
    folders.assignBackup(source.id, backup.id)
    assert.deepEqual(folders.list().map(folder => folder.id), [source.id])
    assert.deepEqual(folders.listAll().map(folder => folder.id), [source.id, backup.id])

    const service = new LibraryMirrorService({ db })
    const first = await service.sync(backup.id, { trigger: 'link' })
    assert.equal(first.status, 'completed')
    assert.equal(await readFile(join(backupRoot, 'Album', 'song.flac'), 'utf8'), 'v1')
    assert.equal(await readFile(join(backupRoot, '.crate', 'library.yaml'), 'utf8'), 'version: 1')
    assert.equal((await stat(join(backupRoot, 'Album', 'Empty'))).isDirectory(), true)
    await assert.rejects(() => stat(join(backupRoot, '.DS_Store')), /ENOENT/)
    assert.ok((db.prepare(`SELECT COUNT(*) AS count FROM library_mirror_snapshots`).get() as { count: number }).count > 0)

    await writeFile(join(sourceRoot, 'Album', 'song.flac'), 'v2')
    await writeFile(join(sourceRoot, 'Album', 'new.flac'), 'new')
    await rm(join(sourceRoot, 'Album', 'obsolete.flac'))
    const second = await service.sync(backup.id, { trigger: 'source_change' })
    assert.equal(second.status, 'completed')
    assert.equal(await readFile(join(backupRoot, 'Album', 'song.flac'), 'utf8'), 'v2')
    assert.equal(await readFile(join(backupRoot, 'Album', 'new.flac'), 'utf8'), 'new')
    await assert.rejects(() => stat(join(backupRoot, 'Album', 'obsolete.flac')), /ENOENT/)

    await writeFile(join(backupRoot, 'Album', 'song.flac'), 'outside edit')
    const divergent = await service.sync(backup.id, { trigger: 'manual' })
    assert.equal(divergent.status, 'awaiting_approval')
    assert.equal(divergent.divergenceCount, 1)
    assert.equal(await readFile(join(backupRoot, 'Album', 'song.flac'), 'utf8'), 'outside edit')
    assert.equal(service.getDivergences(divergent.runId)[0].reason, 'destination_modified')

    await writeFile(join(backupRoot, 'Album', 'song.flac'), 'newer outside edit')
    const refreshed = await service.sync(backup.id, { trigger: 'source_change' })
    assert.equal(refreshed.runId, divergent.runId)
    assert.equal(refreshed.status, 'awaiting_approval')
    assert.equal(refreshed.divergenceCount, 1)
    assert.equal(await readFile(join(backupRoot, 'Album', 'song.flac'), 'utf8'), 'newer outside edit')

    const approved = await service.approve(divergent.runId)
    assert.equal(approved.status, 'completed')
    assert.equal(await readFile(join(backupRoot, 'Album', 'song.flac'), 'utf8'), 'v2')

    const promoted = await service.promoteBackup(backup.id)
    assert.equal(promoted.role, 'library')
    assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM library_mirror_runs`).get() as { count: number }).count, 0)
  } finally {
    db.close()
    await rm(sourceRoot, { recursive: true, force: true })
    await rm(backupRoot, { recursive: true, force: true })
  }
})

test('first non-empty destination pauses before any mutation and unavailable roots are never treated as empty', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'crate-service-source-'))
  const backupRoot = await mkdtemp(join(tmpdir(), 'crate-service-backup-'))
  const db = new Database(':memory:')
  try {
    migrate(db)
    await writeFile(join(sourceRoot, 'source.flac'), 'source')
    await writeFile(join(backupRoot, 'existing.flac'), 'existing')
    const folders = new FolderRepo(db)
    const source = folders.add(sourceRoot, 'Source')
    const backup = folders.add(backupRoot, 'Backup')
    folders.assignBackup(source.id, backup.id)
    const service = new LibraryMirrorService({ db })

    const first = await service.sync(backup.id, { trigger: 'link' })
    assert.equal(first.status, 'awaiting_approval')
    assert.equal(await readFile(join(backupRoot, 'existing.flac'), 'utf8'), 'existing')
    await service.approve(first.runId)
    await assert.rejects(() => stat(join(backupRoot, 'existing.flac')), /ENOENT/)

    await rm(sourceRoot, { recursive: true, force: true })
    await writeFile(join(backupRoot, 'sentinel.flac'), 'keep')
    await assert.rejects(() => service.sync(backup.id), /root is unavailable/i)
    assert.equal(await readFile(join(backupRoot, 'sentinel.flac'), 'utf8'), 'keep')
    assert.equal(service.getLatestSummary(backup.id)?.status, 'failed')
  } finally {
    db.close()
    await rm(sourceRoot, { recursive: true, force: true })
    await rm(backupRoot, { recursive: true, force: true })
  }
})

test('a running local copy can pause and resume from its persistent action journal', async () => {
  class SlowLocalAdapter extends LocalMirrorAdapter {
    override async *readFile(location: DbFolder, entry: MirrorEntry, signal?: AbortSignal): AsyncIterable<Uint8Array> {
      for await (const chunk of super.readFile(location, entry, signal)) {
        await new Promise(resolve => setTimeout(resolve, 5))
        signal?.throwIfAborted()
        yield chunk
      }
    }
  }

  const sourceRoot = await mkdtemp(join(tmpdir(), 'crate-service-source-'))
  const backupRoot = await mkdtemp(join(tmpdir(), 'crate-service-backup-'))
  const db = new Database(':memory:')
  try {
    migrate(db)
    await writeFile(join(sourceRoot, 'large.flac'), Buffer.alloc(4_500_000, 23))
    const folders = new FolderRepo(db)
    const source = folders.add(sourceRoot, 'Source')
    const backup = folders.add(backupRoot, 'Backup')
    folders.assignBackup(source.id, backup.id)
    const service = new LibraryMirrorService({ db, adapters: [new SlowLocalAdapter()] })
    let pauseRequested = false
    service.onProgress(event => {
      if (!pauseRequested && event.phase === 'copying' && event.completedBytes > 0) {
        pauseRequested = true
        service.pause(event.runId)
      }
    })

    const paused = await service.sync(backup.id)
    assert.equal(paused.status, 'paused')
    const action = db.prepare(`SELECT status, bytes_completed FROM library_mirror_actions`).get() as {
      status: string
      bytes_completed: number
    }
    assert.equal(action.status, 'paused')
    assert.ok(action.bytes_completed > 0)

    const resumed = await service.resume(paused.runId)
    assert.equal(resumed.status, 'completed')
    assert.deepEqual(await readFile(join(backupRoot, 'large.flac')), await readFile(join(sourceRoot, 'large.flac')))
  } finally {
    db.close()
    await rm(sourceRoot, { recursive: true, force: true })
    await rm(backupRoot, { recursive: true, force: true })
  }
})

test('concurrent triggers share one planning operation and never retire its live run', async () => {
  class SlowInventoryAdapter extends LocalMirrorAdapter {
    override async inventory(location: DbFolder, signal?: AbortSignal): Promise<MirrorInventory> {
      await new Promise(resolve => setTimeout(resolve, 20))
      return super.inventory(location, signal)
    }
  }

  const sourceRoot = await mkdtemp(join(tmpdir(), 'crate-service-source-'))
  const backupRoot = await mkdtemp(join(tmpdir(), 'crate-service-backup-'))
  const db = new Database(':memory:')
  try {
    migrate(db)
    await writeFile(join(sourceRoot, 'song.flac'), 'audio')
    const folders = new FolderRepo(db)
    const source = folders.add(sourceRoot, 'Source')
    const backup = folders.add(backupRoot, 'Backup')
    folders.assignBackup(source.id, backup.id)
    const service = new LibraryMirrorService({ db, adapters: [new SlowInventoryAdapter()] })

    const first = service.sync(backup.id, { trigger: 'startup' })
    const second = service.sync(backup.id, { trigger: 'source_change' })
    assert.equal(first, second)
    const [left, right] = await Promise.all([first, second])
    assert.equal(left.runId, right.runId)
    assert.equal(left.status, 'completed')
    assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM library_mirror_runs`).get() as { count: number }).count, 1)
  } finally {
    db.close()
    await rm(sourceRoot, { recursive: true, force: true })
    await rm(backupRoot, { recursive: true, force: true })
  }
})

test('a destination edit that races execution is replanned into one approval batch', async () => {
  class RacingLocalAdapter extends LocalMirrorAdapter {
    backupToMutate: number | null = null

    override async writeFile(request: MirrorWriteRequest): Promise<MirrorEntry> {
      if (this.backupToMutate === request.location.id) {
        this.backupToMutate = null
        await writeFile(join(request.location.path, request.relativePath), 'outside edit')
      }
      return super.writeFile(request)
    }
  }

  const sourceRoot = await mkdtemp(join(tmpdir(), 'crate-service-source-'))
  const backupRoot = await mkdtemp(join(tmpdir(), 'crate-service-backup-'))
  const db = new Database(':memory:')
  try {
    migrate(db)
    await writeFile(join(sourceRoot, 'song.flac'), 'v1')
    const folders = new FolderRepo(db)
    const source = folders.add(sourceRoot, 'Source')
    const backup = folders.add(backupRoot, 'Backup')
    folders.assignBackup(source.id, backup.id)
    const adapter = new RacingLocalAdapter()
    const service = new LibraryMirrorService({ db, adapters: [adapter] })
    assert.equal((await service.sync(backup.id)).status, 'completed')

    await writeFile(join(sourceRoot, 'song.flac'), 'v2')
    adapter.backupToMutate = backup.id
    const raced = await service.sync(backup.id)
    assert.equal(raced.status, 'awaiting_approval')
    assert.equal(raced.divergenceCount, 1)
    assert.equal(service.getDivergences(raced.runId)[0].reason, 'destination_modified')
    assert.equal(await readFile(join(backupRoot, 'song.flac'), 'utf8'), 'outside edit')

    const approved = await service.approve(raced.runId)
    assert.equal(approved.status, 'completed')
    assert.equal(await readFile(join(backupRoot, 'song.flac'), 'utf8'), 'v2')
  } finally {
    db.close()
    await rm(sourceRoot, { recursive: true, force: true })
    await rm(backupRoot, { recursive: true, force: true })
  }
})

test('approval revalidates the complete destination before applying any persisted action', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'crate-service-source-'))
  const backupRoot = await mkdtemp(join(tmpdir(), 'crate-service-backup-'))
  const db = new Database(':memory:')
  try {
    migrate(db)
    await writeFile(join(sourceRoot, 'a.flac'), 'a-v1')
    await writeFile(join(sourceRoot, 'b.flac'), 'b-v1')
    const folders = new FolderRepo(db)
    const source = folders.add(sourceRoot, 'Source')
    const backup = folders.add(backupRoot, 'Backup')
    folders.assignBackup(source.id, backup.id)
    const service = new LibraryMirrorService({ db })
    assert.equal((await service.sync(backup.id)).status, 'completed')

    await writeFile(join(sourceRoot, 'a.flac'), 'a-v2')
    await writeFile(join(sourceRoot, 'b.flac'), 'b-v2')
    await writeFile(join(backupRoot, 'a.flac'), 'outside-a')
    const review = await service.sync(backup.id)
    assert.equal(review.status, 'awaiting_approval')

    // This path was not part of the reviewed plan. Approval must refresh the
    // entire destination and return a new batch before copying a.flac/b.flac.
    await writeFile(join(backupRoot, 'late-foreign.flac'), 'outside-late')
    const refreshed = await service.approve(review.runId)
    assert.equal(refreshed.status, 'awaiting_approval')
    assert.equal(refreshed.runId, review.runId)
    assert.equal(refreshed.divergenceCount, 2)
    assert.equal(await readFile(join(backupRoot, 'a.flac'), 'utf8'), 'outside-a')
    assert.equal(await readFile(join(backupRoot, 'b.flac'), 'utf8'), 'b-v1')
    assert.equal(await readFile(join(backupRoot, 'late-foreign.flac'), 'utf8'), 'outside-late')
  } finally {
    db.close()
    await rm(sourceRoot, { recursive: true, force: true })
    await rm(backupRoot, { recursive: true, force: true })
  }
})

test('a source edit that races execution is replanned without touching the source', async () => {
  class SourceRacingAdapter extends LocalMirrorAdapter {
    sourceToMutate: number | null = null

    override async *readFile(location: DbFolder, entry: MirrorEntry, signal?: AbortSignal): AsyncIterable<Uint8Array> {
      if (this.sourceToMutate === location.id) {
        this.sourceToMutate = null
        await writeFile(join(location.path, entry.relativePath), 'v3')
      }
      yield *super.readFile(location, entry, signal)
    }
  }

  const sourceRoot = await mkdtemp(join(tmpdir(), 'crate-service-source-'))
  const backupRoot = await mkdtemp(join(tmpdir(), 'crate-service-backup-'))
  const db = new Database(':memory:')
  try {
    migrate(db)
    await writeFile(join(sourceRoot, 'song.flac'), 'v1')
    const folders = new FolderRepo(db)
    const source = folders.add(sourceRoot, 'Source')
    const backup = folders.add(backupRoot, 'Backup')
    folders.assignBackup(source.id, backup.id)
    const adapter = new SourceRacingAdapter()
    const service = new LibraryMirrorService({ db, adapters: [adapter] })
    assert.equal((await service.sync(backup.id)).status, 'completed')

    await writeFile(join(sourceRoot, 'song.flac'), 'v2')
    adapter.sourceToMutate = source.id
    const result = await service.sync(backup.id)
    assert.equal(result.status, 'completed')
    assert.equal(await readFile(join(sourceRoot, 'song.flac'), 'utf8'), 'v3')
    assert.equal(await readFile(join(backupRoot, 'song.flac'), 'utf8'), 'v3')
  } finally {
    db.close()
    await rm(sourceRoot, { recursive: true, force: true })
    await rm(backupRoot, { recursive: true, force: true })
  }
})

test('a replacement local root is never interpreted as the configured empty library', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'crate-service-source-'))
  const displacedSource = `${sourceRoot}-original`
  const backupRoot = await mkdtemp(join(tmpdir(), 'crate-service-backup-'))
  const db = new Database(':memory:')
  try {
    migrate(db)
    await writeFile(join(sourceRoot, 'song.flac'), 'source')
    const folders = new FolderRepo(db)
    const source = folders.add(sourceRoot, 'Source')
    const backup = folders.add(backupRoot, 'Backup')
    folders.assignBackup(source.id, backup.id)
    const service = new LibraryMirrorService({ db })
    assert.equal((await service.sync(backup.id)).status, 'completed')

    await rename(sourceRoot, displacedSource)
    await mkdir(sourceRoot)
    await writeFile(join(backupRoot, 'sentinel.flac'), 'keep')
    await assert.rejects(() => service.sync(backup.id), /root identity changed/i)
    assert.equal(await readFile(join(backupRoot, 'song.flac'), 'utf8'), 'source')
    assert.equal(await readFile(join(backupRoot, 'sentinel.flac'), 'utf8'), 'keep')
  } finally {
    db.close()
    await rm(sourceRoot, { recursive: true, force: true })
    await rm(displacedSource, { recursive: true, force: true })
    await rm(backupRoot, { recursive: true, force: true })
  }
})

test('a persisted approved plan refuses a replacement destination after restart', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'crate-service-source-'))
  const backupRoot = await mkdtemp(join(tmpdir(), 'crate-service-backup-'))
  const displacedBackup = `${backupRoot}-original`
  const db = new Database(':memory:')
  try {
    migrate(db)
    await writeFile(join(sourceRoot, 'source.flac'), 'source')
    await writeFile(join(backupRoot, 'foreign.flac'), 'foreign')
    const folders = new FolderRepo(db)
    const source = folders.add(sourceRoot, 'Source')
    const backup = folders.add(backupRoot, 'Backup')
    folders.assignBackup(source.id, backup.id)
    const initialService = new LibraryMirrorService({ db })
    const pending = await initialService.sync(backup.id)
    assert.equal(pending.status, 'awaiting_approval')

    await rename(backupRoot, displacedBackup)
    await mkdir(backupRoot)
    await writeFile(join(backupRoot, 'replacement.flac'), 'replacement')
    const restartedService = new LibraryMirrorService({ db })
    await assert.rejects(() => restartedService.approve(pending.runId), /backup root changed/i)
    assert.equal(await readFile(join(backupRoot, 'replacement.flac'), 'utf8'), 'replacement')
    await assert.rejects(() => stat(join(backupRoot, 'source.flac')), /ENOENT/)
  } finally {
    db.close()
    await rm(sourceRoot, { recursive: true, force: true })
    await rm(backupRoot, { recursive: true, force: true })
    await rm(displacedBackup, { recursive: true, force: true })
  }
})
