import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { applyPendingTrackAlbumMovesToPlan } from './albumMoveSyncPlan.ts'

function pcTrack(patch = {}) {
  return {
    trackId: patch.trackId ?? 42,
    key: patch.key ?? 'artist/destination/02 - borrowed.flac',
    relativePath: patch.relativePath ?? 'Artist/Destination/02 - Borrowed.flac',
    absolutePath: patch.absolutePath ?? '/pc/Artist/Destination/02 - Borrowed.flac',
    title: patch.title ?? 'Borrowed',
    artist: patch.artist ?? 'Artist',
    album: patch.album ?? 'Destination',
    albumArtist: patch.albumArtist ?? 'Artist',
    duration: patch.duration ?? 180,
    format: patch.format ?? 'FLAC',
    fileSize: patch.fileSize ?? 123,
    dateModified: patch.dateModified ?? null,
    fingerprint: patch.fingerprint ?? 'pc-new',
    folderId: 1,
    folderName: 'Library',
    folderPath: '/pc',
    sourceRelativePath: patch.sourceRelativePath ?? 'Artist/Destination/02 - Borrowed.flac',
  }
}

function deviceTrack(patch = {}) {
  return {
    key: patch.key,
    relativePath: patch.relativePath,
    absolutePath: patch.absolutePath ?? `/dap/${patch.relativePath}`,
    title: patch.title ?? 'Borrowed',
    artist: patch.artist ?? 'Artist',
    album: patch.album ?? 'Source',
    albumArtist: patch.albumArtist ?? 'Artist',
    duration: patch.duration ?? 180,
    format: patch.format ?? 'FLAC',
    fileSize: patch.fileSize ?? 120,
    dateModified: patch.dateModified ?? null,
    fingerprint: patch.fingerprint ?? 'old-device',
  }
}

function action(kind, key, relativePath) {
  return {
    id: `${kind}:${key}`,
    kind,
    key,
    relativePath,
    title: relativePath,
    artist: '',
    album: '',
    pcPath: null,
    pcRelativePath: null,
    pcBytes: null,
    devicePath: null,
    deviceRelativePath: null,
    deviceBytes: null,
    sourcePath: null,
    destinationPath: null,
    bytes: 0,
    reason: 'existing planner action',
  }
}

function makeAction(kind, key, pc, device, reason) {
  const track = pc ?? device
  return {
    ...action(kind, key, track?.relativePath ?? key),
    title: track?.title ?? key,
    artist: track?.artist ?? '',
    album: track?.album ?? '',
    pcPath: pc?.absolutePath ?? null,
    pcRelativePath: pc?.relativePath ?? null,
    pcBytes: pc?.fileSize ?? null,
    devicePath: device?.absolutePath ?? null,
    deviceRelativePath: device?.relativePath ?? null,
    deviceBytes: device?.fileSize ?? null,
    bytes: kind.startsWith('delete') ? 0 : track?.fileSize ?? 0,
    reason,
  }
}

const move = {
  id: 'move-1',
  track_id: 42,
  old_path: '/pc/Artist/Source/07 - Borrowed.flac',
  new_path: '/pc/Artist/Destination/02 - Borrowed.flac',
  old_sync_key: 'artist/source/07 - borrowed.flac',
  old_device_relative_path: 'Artist/Source/07 - Borrowed.flac',
  new_sync_key: 'artist/destination/02 - borrowed.flac',
  new_device_relative_path: 'Artist/Destination/02 - Borrowed.flac',
  created_at: '2026-06-03T00:00:00.000Z',
}

test('pc_to_device turns a local album move into delete old path plus copy new path', () => {
  const result = applyPendingTrackAlbumMovesToPlan({
    actions: [
      action('copy_device_to_pc', move.old_sync_key, move.old_device_relative_path),
      action('copy_pc_to_device', move.new_sync_key, move.new_device_relative_path),
    ],
    mode: 'pc_to_device',
    pcTracks: [pcTrack()],
    deviceTracks: [deviceTrack({ key: move.old_sync_key, relativePath: move.old_device_relative_path })],
    moves: [move],
    makeAction,
  })

  assert.deepEqual(result.map(item => [item.kind, item.key]), [
    ['copy_pc_to_device', move.new_sync_key],
    ['delete_device', move.old_sync_key],
  ])
  assert.equal(result.find(item => item.kind === 'delete_device')?.reason, 'Moved locally to another album')
  assert.equal(result.find(item => item.kind === 'copy_pc_to_device')?.pcRelativePath, move.new_device_relative_path)
})

test('bidirectional without baseline removes device-to-PC copy of the old moved path', () => {
  const result = applyPendingTrackAlbumMovesToPlan({
    actions: [
      action('copy_device_to_pc', move.old_sync_key, move.old_device_relative_path),
    ],
    mode: 'bidirectional_safe',
    pcTracks: [pcTrack()],
    deviceTracks: [deviceTrack({ key: move.old_sync_key, relativePath: move.old_device_relative_path })],
    moves: [move],
    makeAction,
  })

  assert.equal(result.some(item => item.kind === 'copy_device_to_pc' && item.key === move.old_sync_key), false)
  assert.equal(result.some(item => item.kind === 'delete_device' && item.key === move.old_sync_key), true)
  assert.equal(result.some(item => item.kind === 'copy_pc_to_device' && item.key === move.new_sync_key), true)
})

test('device_to_pc leaves the plan unchanged so local album moves are only warned at plan level', () => {
  const original = [action('copy_device_to_pc', move.old_sync_key, move.old_device_relative_path)]
  const result = applyPendingTrackAlbumMovesToPlan({
    actions: original,
    mode: 'device_to_pc',
    pcTracks: [pcTrack()],
    deviceTracks: [deviceTrack({ key: move.old_sync_key, relativePath: move.old_device_relative_path })],
    moves: [move],
    makeAction,
  })

  assert.equal(result, original)
  assert.equal(result[0].kind, 'copy_device_to_pc')
})
