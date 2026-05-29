import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  capacityFromStorage,
  isUsableDeviceCapacity,
  selectDeviceDashboardCapacity,
} from './deviceOverview.ts'

function capacity(patch = {}) {
  return {
    totalBytes: patch.totalBytes ?? 1000,
    usedBytes: patch.usedBytes ?? 400,
    freeBytes: patch.freeBytes ?? 600,
    scannedAt: patch.scannedAt ?? '2026-05-29T12:00:00.000Z',
    error: patch.error ?? null,
  }
}

function overview(deviceId, patch = {}) {
  return {
    device: { id: deviceId },
    capacity: capacity(patch),
  }
}

function scanResult(deviceId, patch = {}) {
  return {
    device: { id: deviceId },
    tracks: [],
    summary: { scanned: 0, imported: 0, skipped: 0, errors: 0 },
    storage: {
      ...capacity(patch),
      musicBytes: patch.musicBytes ?? 0,
      rockboxBytes: patch.rockboxBytes ?? 0,
      otherBytes: patch.otherBytes ?? 0,
    },
  }
}

test('dashboard capacity prefers the freshest usable device data', () => {
  const selected = selectDeviceDashboardCapacity({
    deviceId: 'h2',
    overview: overview('h2', { usedBytes: 300, scannedAt: '2026-05-29T12:00:00.000Z' }),
    scanResult: scanResult('h2', { usedBytes: 500, scannedAt: '2026-05-29T12:05:00.000Z' }),
  })

  assert.equal(selected.usedBytes, 500)
})

test('dashboard capacity falls back to overview when scan data is unavailable for the device', () => {
  const selected = selectDeviceDashboardCapacity({
    deviceId: 'h2',
    overview: overview('h2', { usedBytes: 300 }),
    scanResult: scanResult('other', { usedBytes: 900 }),
  })

  assert.equal(selected.usedBytes, 300)
})

test('dashboard capacity surfaces unavailable capacity instead of fabricating values', () => {
  const selected = selectDeviceDashboardCapacity({
    deviceId: 'h2',
    overview: overview('h2', { totalBytes: 0, usedBytes: 0, freeBytes: 0, error: 'Device is offline' }),
    scanResult: null,
  })

  assert.equal(isUsableDeviceCapacity(selected), false)
  assert.equal(selected.error, 'Device is offline')
})

test('capacity selection does not require a full device library payload', () => {
  const storage = scanResult('h2', { totalBytes: 2048, usedBytes: 1024, freeBytes: 1024 }).storage

  assert.deepEqual(capacityFromStorage(storage), {
    totalBytes: 2048,
    usedBytes: 1024,
    freeBytes: 1024,
    scannedAt: '2026-05-29T12:00:00.000Z',
    error: null,
  })
})
