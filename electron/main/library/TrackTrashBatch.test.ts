import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { trashTrackBatch, type TrackTrashBatchDependencies } from './TrackTrashBatch.ts'

const MUSIC_ROOT = resolve('/Music')
const ONE_PATH = resolve(MUSIC_ROOT, 'one.flac')
const TWO_PATH = resolve(MUSIC_ROOT, 'two.flac')

function track(id: number, path: string) {
  return { id, title: `Track ${id}`, path, folder_id: 7, provider: 'local' as const }
}

function fixture(failingPaths: readonly string[] = []) {
  const tracks = new Map([
    [1, track(1, ONE_PATH)],
    [2, track(2, TWO_PATH)],
  ])
  const files = new Set([ONE_PATH, TWO_PATH])
  const deletedRows: number[] = []
  const deps: TrackTrashBatchDependencies = {
    getTrack: id => tracks.get(id),
    getLocalRoot: () => MUSIC_ROOT,
    runWithWriteAccess: async (_root, operation) => operation(),
    trashItem: async path => {
      if (failingPaths.includes(path)) throw Object.assign(new Error('permission denied'), { code: 'EPERM' })
      files.delete(path)
    },
    deleteTrack: id => {
      deletedRows.push(id)
      tracks.delete(id)
    },
    sidecarPath: path => `${path}.lrc`,
    sidecarExists: () => false,
    onSidecarError: () => undefined,
  }
  return { deps, tracks, files, deletedRows }
}

test('keeps the catalog row when the audio file could not be moved to Trash', async () => {
  const value = fixture([ONE_PATH])
  const result = await trashTrackBatch([1], value.deps)

  assert.deepEqual(result.trashedTrackIds, [])
  assert.deepEqual(result.failed.map(item => item.id), [1])
  assert.equal(value.files.has(ONE_PATH), true)
  assert.equal(value.tracks.has(1), true)
  assert.deepEqual(value.deletedRows, [])
})

test('a partial batch deletes and reports only the items actually processed', async () => {
  const value = fixture([TWO_PATH])
  const result = await trashTrackBatch([1, 2], value.deps)

  assert.deepEqual(result.trashedTrackIds, [1])
  assert.deepEqual(result.failed.map(item => item.id), [2])
  assert.equal(value.files.has(ONE_PATH), false)
  assert.equal(value.tracks.has(1), false)
  assert.equal(value.files.has(TWO_PATH), true)
  assert.equal(value.tracks.has(2), true)
  assert.deepEqual(result.affectedFolderIds, [7])
})

test('cleans up folders once per library, only with the tracks that reached the Trash', async () => {
  const value = fixture([TWO_PATH])
  const calls: Array<{ rootPath: string; deletedPaths: string[] }> = []
  const result = await trashTrackBatch([1, 2], {
    ...value.deps,
    cleanupEmptyFolders: async (rootPath, deletedPaths) => {
      calls.push({ rootPath, deletedPaths })
    },
  })

  assert.deepEqual(result.trashedTrackIds, [1])
  assert.deepEqual(calls, [{ rootPath: MUSIC_ROOT, deletedPaths: [ONE_PATH] }])
})

test('a folder cleanup failure does not change the batch result', async () => {
  const value = fixture()
  const errors: string[] = []
  const result = await trashTrackBatch([1, 2], {
    ...value.deps,
    cleanupEmptyFolders: async () => {
      throw new Error('cleanup exploded')
    },
    onCleanupError: (rootPath, error) => errors.push(`${rootPath}: ${(error as Error).message}`),
  })

  assert.deepEqual(result.trashedTrackIds, [1, 2])
  assert.deepEqual(result.failed, [])
  assert.deepEqual(errors, [`${MUSIC_ROOT}: cleanup exploded`])
})

test('skips folder cleanup when nothing reached the Trash', async () => {
  const value = fixture([ONE_PATH])
  let called = false
  await trashTrackBatch([1], {
    ...value.deps,
    cleanupEmptyFolders: async () => {
      called = true
    },
  })
  assert.equal(called, false)
})
