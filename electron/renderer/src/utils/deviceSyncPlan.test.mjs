import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  bulkResolveSelection,
  conflictResolutionOptions,
  defaultDeviceSyncSelection,
  groupDeviceSyncActions,
  selectionPayload,
  summarizeDeviceSyncSelection,
} from './deviceSyncPlan.ts'

function action(id, kind, patch = {}) {
  return {
    id,
    kind,
    key: patch.key ?? id,
    relativePath: patch.relativePath ?? `${id}.flac`,
    title: patch.title ?? id,
    artist: patch.artist ?? 'Artist',
    album: patch.album ?? 'Album',
    pcPath: patch.pcPath === undefined ? `/pc/${id}.flac` : patch.pcPath,
    pcRelativePath: patch.pcRelativePath === undefined ? `${id}.flac` : patch.pcRelativePath,
    pcBytes: patch.pcBytes ?? 100,
    devicePath: patch.devicePath === undefined ? `/device/${id}.flac` : patch.devicePath,
    deviceRelativePath: patch.deviceRelativePath === undefined ? `${id}.flac` : patch.deviceRelativePath,
    deviceBytes: patch.deviceBytes ?? 90,
    sourcePath: patch.sourcePath ?? `/pc/${id}.flac`,
    destinationPath: patch.destinationPath ?? `/device/${id}.flac`,
    bytes: patch.bytes ?? 100,
    reason: patch.reason ?? 'test',
  }
}

function plan(actions) {
  return {
    id: 'plan',
    deviceId: 'device',
    deviceName: 'DAP',
    mode: 'bidirectional_safe',
    createdAt: '2026-05-29T00:00:00.000Z',
    pcTargetPath: '/pc/imports',
    actions,
    summary: {
      pcBefore: 10,
      deviceBefore: 8,
      pcAfter: 10,
      deviceAfter: 8,
      copyPcToDevice: 0,
      copyDeviceToPc: 0,
      replaceDevice: 0,
      replacePc: 0,
      deleteDevice: 0,
      deletePc: 0,
      conflicts: 0,
      bytesToCopy: 0,
    },
  }
}

test('default selection includes executable actions and skips conflicts', () => {
  const preview = plan([
    action('push', 'copy_pc_to_device'),
    action('conflict', 'skip_conflict'),
  ])

  assert.deepEqual(defaultDeviceSyncSelection(preview), {
    actionIds: ['push'],
    conflictResolutions: [],
  })
})

test('selection summary follows chosen actions and conflict resolutions', () => {
  const preview = plan([
    action('push', 'copy_pc_to_device', { pcBytes: 120, bytes: 120 }),
    action('pull', 'copy_device_to_pc', { deviceBytes: 80, bytes: 80 }),
    action('conflict', 'skip_conflict', { pcBytes: 200, deviceBytes: 180 }),
  ])
  const summary = summarizeDeviceSyncSelection(preview, {
    actionIds: ['push', 'conflict'],
    conflictResolutions: [{ actionId: 'conflict', kind: 'replace_pc' }],
  })

  assert.equal(summary.copyPcToDevice, 1)
  assert.equal(summary.copyDeviceToPc, 0)
  assert.equal(summary.replacePc, 1)
  assert.equal(summary.conflicts, 0)
  assert.equal(summary.pcAfter, 10)
  assert.equal(summary.deviceAfter, 9)
  assert.equal(summary.bytesToCopy, 300)
})

test('conflict options reflect which side still has a file', () => {
  assert.deepEqual(conflictResolutionOptions(action('both', 'skip_conflict')), [
    'replace_device',
    'replace_pc',
    'skip_conflict',
  ])
  assert.deepEqual(
    conflictResolutionOptions(action('pc-only', 'skip_conflict', { devicePath: null, deviceRelativePath: null })),
    ['copy_pc_to_device', 'delete_pc', 'skip_conflict'],
  )
  assert.deepEqual(
    conflictResolutionOptions(action('device-only', 'skip_conflict', { pcPath: null, pcRelativePath: null })),
    ['copy_device_to_pc', 'delete_device', 'skip_conflict'],
  )
})

test('groups actions by playlist memberships from pc and device libraries', () => {
  const actions = [
    action('a', 'copy_pc_to_device', { pcPath: '/pc/a.flac', key: 'a' }),
    action('b', 'copy_device_to_pc', { deviceRelativePath: 'b.flac', key: 'b' }),
  ]
  const pcPlaylists = [
    { id: 'p1', name: 'Favorites', count: 1, kind: 'manual', icon: 'queue', tracks: [{ path: '/pc/a.flac' }] },
  ]
  const devicePlaylists = [
    { id: 'm3u', name: 'Road', relativePath: 'Road.m3u', trackCount: 1, missingCount: 0, tracks: [{ key: 'b', relativePath: 'b.flac' }] },
  ]

  const groups = groupDeviceSyncActions(actions, 'playlist', pcPlaylists, devicePlaylists)

  assert.deepEqual(groups.map(group => group.label).sort(), ['Favorites', 'Road'])
})

function basePlan() {
  return plan([
    action('both', 'skip_conflict'),
    action('pcReplace', 'replace_device'),
    action('pcOnly', 'copy_pc_to_device', { devicePath: null, deviceRelativePath: null }),
    action('deviceOnly', 'copy_device_to_pc', { pcPath: null, pcRelativePath: null }),
  ])
}

test('bulkResolveSelection review keeps engine defaults', () => {
  const result = bulkResolveSelection(basePlan(), 'review')
  assert.deepEqual([...result.actionIds].sort(), ['deviceOnly', 'pcOnly', 'pcReplace'])
  assert.deepEqual(result.conflictResolutions, {})
})

test('bulkResolveSelection prefer-PC mirrors every difference toward PC', () => {
  const result = bulkResolveSelection(basePlan(), 'pc')
  assert.deepEqual([...result.actionIds].sort(), ['both', 'deviceOnly', 'pcOnly', 'pcReplace'])
  // Conflicts and overridden directions get a resolution; natural kinds do not.
  assert.deepEqual(result.conflictResolutions, {
    both: 'replace_device',
    deviceOnly: 'delete_device',
  })
})

test('bulkResolveSelection prefer-device mirrors every difference toward device', () => {
  const result = bulkResolveSelection(basePlan(), 'device')
  assert.deepEqual([...result.actionIds].sort(), ['both', 'deviceOnly', 'pcOnly', 'pcReplace'])
  assert.deepEqual(result.conflictResolutions, {
    both: 'replace_pc',
    pcReplace: 'replace_pc',
    pcOnly: 'delete_pc',
  })
})

test('selectionPayload serializes sets and omits skipped conflicts', () => {
  const payload = selectionPayload(
    new Set(['copy', 'conflict']),
    { conflict: 'replace_device', skipped: 'skip_conflict' },
  )

  assert.deepEqual(payload.actionIds, ['copy', 'conflict'])
  assert.deepEqual(payload.conflictResolutions, [{ actionId: 'conflict', kind: 'replace_device' }])
})
