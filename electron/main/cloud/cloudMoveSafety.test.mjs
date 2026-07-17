import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { assertCloudMoveAuthority } from './cloudMoveSafety.ts'

const localTrack = { id: 7, path: '/Music/song.flac', folder_id: 1, provider: 'local' }
const localSource = {
  id: 1,
  provider: 'local',
  role: 'library',
  drive_id: null,
  item_id: null,
}
const cloudTarget = {
  id: 2,
  provider: 'onedrive',
  role: 'library',
  drive_id: 'drive',
  item_id: 'root',
}

function authority(overrides = {}) {
  return {
    originalTrack: localTrack,
    currentTrack: localTrack,
    currentSource: localSource,
    originalTarget: cloudTarget,
    currentTarget: cloudTarget,
    ...overrides,
  }
}

test('cloud move authority accepts only the unchanged local track and normal cloud target', () => {
  assert.doesNotThrow(() => assertCloudMoveAuthority(authority()))
  assert.throws(
    () => assertCloudMoveAuthority(authority({
      currentTrack: { ...localTrack, path: '/Music/replaced.flac' },
    })),
    /local track changed/,
  )
  assert.throws(
    () => assertCloudMoveAuthority(authority({
      currentSource: { ...localSource, role: 'backup' },
    })),
    /source is no longer/,
  )
})

test('cloud move authority rejects target reclassification and identity replacement', () => {
  assert.throws(
    () => assertCloudMoveAuthority(authority({
      currentTarget: { ...cloudTarget, role: 'backup' },
    })),
    /became a backup/,
  )
  assert.throws(
    () => assertCloudMoveAuthority(authority({
      currentTarget: { ...cloudTarget, item_id: 'different-root' },
    })),
    /destination changed/,
  )
})
