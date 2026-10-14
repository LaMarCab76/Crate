import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { parse as parseYaml } from 'yaml'
import {
  DEVICE_TRASH_LOG_NAME,
  DEVICE_TRASH_RETENTION_MS,
  DeviceTrashBatch,
  purgeExpiredDeviceTrash,
  readDeviceTrashLog,
} from './deviceTrash.ts'

const DAY_MS = 24 * 60 * 60 * 1000

async function tempDevice(): Promise<{ musicRoot: string; trashRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), 'crate-device-trash-'))
  return { musicRoot: join(root, 'Music'), trashRoot: join(root, '.crate', 'trash') }
}

async function touch(path: string, content = 'x'): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

test('logs when each file was moved into a trash batch', async () => {
  const { musicRoot, trashRoot } = await tempDevice()
  const movedAt = new Date('2026-10-01T10:00:00.000Z')
  const batch = new DeviceTrashBatch(trashRoot, 'run-1', () => movedAt)
  await touch(join(musicRoot, 'Artist', 'Album', 'cover.jpg'))

  await batch.record('Artist/Album/01 - Song.flac', 'sync-delete')
  await batch.moveInto(join(musicRoot, 'Artist', 'Album', 'cover.jpg'), 'Artist/Album/cover.jpg', 'folder-cleanup')
  await batch.flush()

  assert.equal(existsSync(join(trashRoot, 'run-1', 'Artist', 'Album', 'cover.jpg')), true)
  const log = parseYaml(await readFile(join(trashRoot, 'run-1', DEVICE_TRASH_LOG_NAME), 'utf8'))
  assert.equal(log.createdAt, movedAt.toISOString())
  assert.equal(log.purgeAfter, new Date(movedAt.getTime() + DEVICE_TRASH_RETENTION_MS).toISOString())
  assert.deepEqual(log.entries.map((entry: { path: string; reason: string }) => [entry.path, entry.reason]), [
    ['Artist/Album/01 - Song.flac', 'sync-delete'],
    ['Artist/Album/cover.jpg', 'folder-cleanup'],
  ])
})

test('a resumed batch appends to the existing log', async () => {
  const { trashRoot } = await tempDevice()
  await new DeviceTrashBatch(trashRoot, 'run-1', () => new Date('2026-10-01T00:00:00.000Z')).record('a.flac', 'sync-delete')
  const later = new DeviceTrashBatch(trashRoot, 'run-1', () => new Date('2026-10-03T00:00:00.000Z'))
  await later.record('b.flac', 'sync-delete')

  const log = await readDeviceTrashLog(join(trashRoot, 'run-1'))
  assert.equal(log?.createdAt, '2026-10-01T00:00:00.000Z')
  assert.equal(log?.updatedAt, '2026-10-03T00:00:00.000Z')
  assert.deepEqual(log?.entries.map(entry => entry.path), ['a.flac', 'b.flac'])
})

test('purges only batches older than the retention period', async () => {
  const { trashRoot } = await tempDevice()
  const now = new Date('2026-10-20T00:00:00.000Z')
  const old = new DeviceTrashBatch(trashRoot, 'old', () => new Date(now.getTime() - 16 * DAY_MS))
  await touch(old.destinationFor('Artist/Album/01.flac'), '12345')
  await old.record('Artist/Album/01.flac', 'sync-delete')
  const recent = new DeviceTrashBatch(trashRoot, 'recent', () => new Date(now.getTime() - 14 * DAY_MS))
  await touch(recent.destinationFor('Artist/Album/02.flac'))
  await recent.record('Artist/Album/02.flac', 'sync-delete')

  const result = await purgeExpiredDeviceTrash({ trashRoot, now })

  assert.deepEqual(result.purgedBatches, ['old'])
  assert.equal(result.files, 1)
  assert.equal(result.bytes, 5)
  assert.equal(existsSync(join(trashRoot, 'old')), false)
  assert.equal(existsSync(join(trashRoot, 'recent', 'Artist', 'Album', '02.flac')), true)
})

test('dates legacy batches from their sync run, or from first sight when unknown', async () => {
  const { trashRoot } = await tempDevice()
  const now = new Date('2026-10-20T00:00:00.000Z')
  await touch(join(trashRoot, 'expired-run', 'Artist', '01.flac'))
  await touch(join(trashRoot, 'recent-run', 'Artist', '02.flac'))
  await touch(join(trashRoot, 'unknown-run', 'Artist', '03.flac'))
  const runs: Record<string, string> = {
    'expired-run': new Date(now.getTime() - 20 * DAY_MS).toISOString(),
    'recent-run': new Date(now.getTime() - 2 * DAY_MS).toISOString(),
  }

  const result = await purgeExpiredDeviceTrash({ trashRoot, now, batchTimestamp: id => runs[id] ?? null })

  assert.deepEqual(result.purgedBatches, ['expired-run'])
  assert.deepEqual(result.datedBatches.sort(), ['recent-run', 'unknown-run'])
  assert.equal((await readDeviceTrashLog(join(trashRoot, 'recent-run')))?.updatedAt, runs['recent-run'])
  const unknown = await readDeviceTrashLog(join(trashRoot, 'unknown-run'))
  assert.equal(unknown?.updatedAt, now.toISOString())
  assert.deepEqual(unknown?.entries.map(entry => [entry.path, entry.reason]), [['Artist/03.flac', 'discovered']])

  // Fifteen days after first sight, the unknown batch goes too.
  const later = await purgeExpiredDeviceTrash({ trashRoot, now: new Date(now.getTime() + 15 * DAY_MS) })
  assert.deepEqual(later.purgedBatches.sort(), ['recent-run', 'unknown-run'])
})

test('missing trash root is a no-op', async () => {
  const { trashRoot } = await tempDevice()
  const result = await purgeExpiredDeviceTrash({ trashRoot })
  assert.deepEqual(result, { purgedBatches: [], files: 0, bytes: 0, datedBatches: [] })
})
