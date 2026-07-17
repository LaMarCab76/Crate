import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { samePortableLibraryState } from './cloudManifestState.ts'

const manifest = {
  version: 1,
  appName: 'Crate',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  tracks: { 'Album/song.flac': { favorite: true, playCount: 2 } },
  artists: { Artist: { favorite: true } },
  albums: {},
}

test('portable manifest comparison ignores only updatedAt churn', () => {
  assert.equal(samePortableLibraryState(
    manifest,
    { ...manifest, updatedAt: '2030-01-01T00:00:00.000Z' },
  ), true)
  assert.equal(samePortableLibraryState(
    manifest,
    {
      ...manifest,
      updatedAt: '2030-01-01T00:00:00.000Z',
      tracks: { 'Album/song.flac': { favorite: false, playCount: 2 } },
    },
  ), false)
})

test('portable manifest comparison preserves creation identity', () => {
  assert.equal(samePortableLibraryState(
    manifest,
    { ...manifest, createdAt: '2030-01-01T00:00:00.000Z' },
  ), false)
})
