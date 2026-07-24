import assert from 'node:assert/strict'
import test from 'node:test'
import { trashTrackBatch, type TrackTrashBatchDependencies } from './TrackTrashBatch.ts'

function track(id: number, path: string) {
  return { id, title: `Track ${id}`, path, folder_id: 7, provider: 'local' as const }
}

function fixture(failingPaths: readonly string[] = []) {
  const tracks = new Map([
    [1, track(1, '/Music/one.flac')],
    [2, track(2, '/Music/two.flac')],
  ])
  const files = new Set(['/Music/one.flac', '/Music/two.flac'])
  const deletedRows: number[] = []
  const deps: TrackTrashBatchDependencies = {
    getTrack: id => tracks.get(id),
    getLocalRoot: () => '/Music',
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
  const value = fixture(['/Music/one.flac'])
  const result = await trashTrackBatch([1], value.deps)

  assert.deepEqual(result.trashedTrackIds, [])
  assert.deepEqual(result.failed.map(item => item.id), [1])
  assert.equal(value.files.has('/Music/one.flac'), true)
  assert.equal(value.tracks.has(1), true)
  assert.deepEqual(value.deletedRows, [])
})

test('a partial batch deletes and reports only the items actually processed', async () => {
  const value = fixture(['/Music/two.flac'])
  const result = await trashTrackBatch([1, 2], value.deps)

  assert.deepEqual(result.trashedTrackIds, [1])
  assert.deepEqual(result.failed.map(item => item.id), [2])
  assert.equal(value.files.has('/Music/one.flac'), false)
  assert.equal(value.tracks.has(1), false)
  assert.equal(value.files.has('/Music/two.flac'), true)
  assert.equal(value.tracks.has(2), true)
  assert.deepEqual(result.affectedFolderIds, [7])
})
