import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { audioFacetToMetadata, driveItemRemotePath } from './cloudMetadata.ts'

test('maps OneDrive audio facets into local metadata', () => {
  const metadata = audioFacetToMetadata({
    id: 'item',
    name: 'Song.flac',
    size: 30_000_000,
    lastModifiedDateTime: '2026-01-02T03:04:05Z',
    audio: {
      title: 'Song',
      artist: 'Artist',
      album: 'Album',
      albumArtist: 'Album Artist',
      genre: 'Jazz',
      duration: 240_000,
      track: 3,
      trackCount: 12,
      disc: 1,
      discCount: 2,
      year: 2026,
    },
  })
  assert.equal(metadata.duration, 240)
  assert.equal(metadata.format, 'FLAC')
  assert.equal(metadata.bitrate, 1_000_000)
  assert.equal(metadata.albumArtist, 'Album Artist')
  assert.equal(metadata.trackNumber, 3)
})

test('falls back safely when Graph has no audio facet', () => {
  const metadata = audioFacetToMetadata({ id: 'item', name: 'Untitled.m4a' })
  assert.equal(metadata.title, 'Untitled')
  assert.equal(metadata.artist, 'Unknown Artist')
  assert.equal(metadata.album, 'Unknown Album')
  assert.equal(metadata.format, 'M4A')
  assert.equal(metadata.fileSize, null)
})

test('normalizes a Graph parent path for catalog display', () => {
  assert.equal(driveItemRemotePath({
    id: 'item',
    name: 'Song.flac',
    parentReference: { path: '/drives/drive/root:/Music/Album' },
  }), '/Music/Album/Song.flac')
})
