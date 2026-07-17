import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  cloudRelativePath,
  isSafePortablePath,
  parsePortableLibraryManifest,
  stringifyPortableLibraryManifest,
} from './cloudPortableManifest.ts'

const manifest = {
  version: 1,
  appName: 'Crate',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  tracks: { 'Album/Song.flac': { favorite: true } },
  artists: {},
  albums: {},
}

test('portable manifest round-trips through YAML', () => {
  assert.deepEqual(parsePortableLibraryManifest(stringifyPortableLibraryManifest(manifest)), manifest)
})

test('rejects malformed or incompatible portable manifests', () => {
  assert.equal(parsePortableLibraryManifest('not: [valid'), null)
  assert.equal(parsePortableLibraryManifest('version: 2\ntracks: {}\nartists: {}\nalbums: {}'), null)
  assert.equal(parsePortableLibraryManifest('version: 1\ntracks: []\nartists: {}\nalbums: {}'), null)
})

test('builds safe paths relative to the configured OneDrive root', () => {
  assert.equal(cloudRelativePath('/Music', '/Music/Artist/Album/Song.flac'), 'Artist/Album/Song.flac')
  assert.equal(cloudRelativePath('/', '/Artist/Song.flac'), 'Artist/Song.flac')
  assert.equal(cloudRelativePath('/Music', '/Elsewhere/Song.flac'), null)
  assert.equal(cloudRelativePath('/Music', '/Music'), null)
})

test('validates untrusted track keys before DB matching', () => {
  assert.equal(isSafePortablePath('Artist/Album/Song.flac'), true)
  for (const value of ['', '/absolute', '../escape', 'A/../../escape', 'windows\\path']) {
    assert.equal(isSafePortablePath(value), false)
  }
})
