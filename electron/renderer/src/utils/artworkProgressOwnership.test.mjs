import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { artworkOptimizationOwnsSyncProgress } from './artworkProgressOwnership.ts'

test('artwork optimization owns matching optimizing_artwork sync progress', () => {
  assert.equal(
    artworkOptimizationOwnsSyncProgress({
      optimizing: true,
      deviceId: 'device-1',
      syncProgressDeviceId: 'device-1',
      syncProgressPhase: 'optimizing_artwork',
    }),
    true,
  )
})

test('artwork optimization does not own progress from another device', () => {
  assert.equal(
    artworkOptimizationOwnsSyncProgress({
      optimizing: true,
      deviceId: 'device-1',
      syncProgressDeviceId: 'device-2',
      syncProgressPhase: 'optimizing_artwork',
    }),
    false,
  )
})

test('artwork optimization does not own unrelated sync phases', () => {
  assert.equal(
    artworkOptimizationOwnsSyncProgress({
      optimizing: true,
      deviceId: 'device-1',
      syncProgressDeviceId: 'device-1',
      syncProgressPhase: 'copying',
    }),
    false,
  )
})

test('idle optimize panel leaves header progress visible', () => {
  assert.equal(
    artworkOptimizationOwnsSyncProgress({
      optimizing: false,
      deviceId: 'device-1',
      syncProgressDeviceId: 'device-1',
      syncProgressPhase: 'optimizing_artwork',
    }),
    false,
  )
})
