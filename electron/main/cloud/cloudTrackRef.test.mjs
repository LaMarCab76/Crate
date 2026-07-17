import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { resolveCloudLoadOptions, resolveCloudTrackRef } from './cloudTrackRef.ts'

function track(patch = {}) {
  return {
    provider: 'onedrive',
    drive_id: 'drive-1',
    item_id: 'item-1',
    file_size: 1024,
    ...patch,
  }
}

test('resolves only complete OneDrive references', () => {
  assert.deepEqual(resolveCloudTrackRef(track()), { driveId: 'drive-1', itemId: 'item-1' })
  assert.equal(resolveCloudTrackRef(track({ provider: 'local' })), null)
  assert.equal(resolveCloudTrackRef(track({ drive_id: null })), null)
  assert.equal(resolveCloudTrackRef(track({ item_id: null })), null)
})

test('uses the indexed byte size without a network lookup', async () => {
  let calls = 0
  const result = await resolveCloudLoadOptions(track({ file_size: 4096 }), {
    getDownloadUrl: async () => {
      calls += 1
      return { url: 'https://example.test', size: 1, etag: null, quickXorHash: null }
    },
  })
  assert.deepEqual(result, {
    cloudRef: { driveId: 'drive-1', itemId: 'item-1' },
    cloudSizeBytes: 4096,
  })
  assert.equal(calls, 0)
})

test('falls back to Graph when the indexed size is unavailable', async () => {
  const calls = []
  const client = {
    getDownloadUrl: async (driveId, itemId) => {
      calls.push([driveId, itemId])
      return { url: 'https://example.test', size: 777, etag: null, quickXorHash: null }
    },
  }
  for (const file_size of [0, null]) {
    const result = await resolveCloudLoadOptions(track({ file_size }), client)
    assert.equal(result.cloudSizeBytes, 777)
  }
  assert.deepEqual(calls, [['drive-1', 'item-1'], ['drive-1', 'item-1']])
})

test('does not touch Graph for a local track', async () => {
  const result = await resolveCloudLoadOptions(track({ provider: 'local' }), {
    getDownloadUrl: async () => { throw new Error('must not be called') },
  })
  assert.equal(result, null)
})
