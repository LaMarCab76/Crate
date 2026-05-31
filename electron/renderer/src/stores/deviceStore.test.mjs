import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mergeDeviceRecord } from './deviceStore.ts'

function device(id, trackCount) {
  return {
    id,
    name: id,
    rootPath: `/Volumes/${id}`,
    musicRoot: '.',
    defaultMode: 'bidirectional_safe',
    syncBase: 'review',
    pcTargetPath: `/Music/${id}`,
    artworkMaxEdge: 600,
    fetchMissingLyrics: true,
    optimizeArtworkOnSync: true,
    hasRockbox: true,
    isAvailable: true,
    trackCount,
    sourceLibraryIds: [],
    versions: {
      crateStateVersion: 1,
      machineStateVersion: 1,
      rockboxVersion: null,
      firmwareVersion: null,
    },
    portableState: {
      writable: true,
      error: null,
      lastCheckedAt: '2026-05-31T00:00:00.000Z',
    },
    lastSeenAt: '2026-05-31T00:00:00.000Z',
    lastScanAt: null,
    lastSyncAt: null,
  }
}

test('mergeDeviceRecord replaces stale track counts from a fresh DeviceRecord', () => {
  const merged = mergeDeviceRecord([device('dap', 12), device('other', 4)], device('dap', 18))

  assert.equal(merged.length, 2)
  assert.equal(merged.find(item => item.id === 'dap')?.trackCount, 18)
  assert.equal(merged.find(item => item.id === 'other')?.trackCount, 4)
})

test('mergeDeviceRecord prepends a newly seen device', () => {
  const merged = mergeDeviceRecord([device('old', 1)], device('new', 9))

  assert.deepEqual(merged.map(item => item.id), ['new', 'old'])
})
