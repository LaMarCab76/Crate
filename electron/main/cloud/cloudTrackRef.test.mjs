import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { resolveCloudLoadOptions, resolveCloudTrackRef } from './cloudTrackRef.ts'

function track(patch = {}) {
  return {
    source: 'onedrive',
    cloud_drive_id: 'drive-1',
    cloud_item_id: 'item-1',
    file_size: 1024,
    ...patch,
  }
}

test('resolveCloudTrackRef returns null for local tracks', () => {
  assert.equal(resolveCloudTrackRef(track({ source: 'local' })), null)
})

test('resolveCloudTrackRef returns null when cloud ids are missing', () => {
  assert.equal(resolveCloudTrackRef(track({ cloud_item_id: null })), null)
  assert.equal(resolveCloudTrackRef(track({ cloud_drive_id: null })), null)
})

test('resolveCloudTrackRef returns the drive/item ref for cloud tracks', () => {
  assert.deepEqual(resolveCloudTrackRef(track()), { driveId: 'drive-1', itemId: 'item-1' })
})

test('resolveCloudLoadOptions returns null for non-cloud tracks without touching the client', async () => {
  let called = false
  const client = { getDownloadUrl: async () => { called = true; return { url: 'u', size: 1, etag: null } } }
  const result = await resolveCloudLoadOptions(track({ source: 'local' }), client)
  assert.equal(result, null)
  assert.equal(called, false)
})

test('resolveCloudLoadOptions uses the stored file_size when positive', async () => {
  let called = false
  const client = { getDownloadUrl: async () => { called = true; return { url: 'u', size: 999, etag: null } } }
  const result = await resolveCloudLoadOptions(track({ file_size: 4096 }), client)
  assert.deepEqual(result, { cloudRef: { driveId: 'drive-1', itemId: 'item-1' }, cloudSizeBytes: 4096 })
  assert.equal(called, false)
})

test('resolveCloudLoadOptions falls back to a Graph lookup when file_size is missing or zero', async () => {
  const calls = []
  const client = {
    getDownloadUrl: async (driveId, itemId) => {
      calls.push([driveId, itemId])
      return { url: 'u', size: 7777, etag: null }
    },
  }
  for (const badSize of [0, null, undefined]) {
    const result = await resolveCloudLoadOptions(track({ file_size: badSize }), client)
    assert.equal(result.cloudSizeBytes, 7777)
  }
  assert.deepEqual(calls, [['drive-1', 'item-1'], ['drive-1', 'item-1'], ['drive-1', 'item-1']])
})
