import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { audioFacetToMetadata } from './cloudMetadata.ts'

test('maps a full audio facet, converting duration ms → seconds', () => {
  const md = audioFacetToMetadata({
    id: 'i1',
    name: 'Song.flac',
    size: 30_000_000,
    lastModifiedDateTime: '2024-01-02T03:04:05Z',
    audio: {
      title: 'Song',
      artist: 'The Artist',
      album: 'The Album',
      albumArtist: 'The Album Artist',
      genre: 'Jazz',
      year: 2021,
      track: 3,
      trackCount: 12,
      disc: 1,
      discCount: 2,
      duration: 240_000, // 4 minutes in ms
    },
  })

  assert.equal(md.title, 'Song')
  assert.equal(md.artist, 'The Artist')
  assert.equal(md.album, 'The Album')
  assert.equal(md.albumArtist, 'The Album Artist')
  assert.equal(md.genre, 'Jazz')
  assert.equal(md.year, '2021')
  assert.equal(md.trackNumber, 3)
  assert.equal(md.totalTracks, 12)
  assert.equal(md.discNumber, 1)
  assert.equal(md.totalDiscs, 2)
  assert.equal(md.duration, 240, 'ms converted to seconds')
  assert.equal(md.format, 'FLAC')
  assert.equal(md.fileSize, 30_000_000)
  // size*8/duration overall bitrate estimate
  assert.equal(md.bitrate, Math.round((30_000_000 * 8) / 240))
})

test('falls back to filename for the title and uses defaults when the facet is empty', () => {
  const md = audioFacetToMetadata({ id: 'i2', name: 'Untitled Take.m4a' })
  assert.equal(md.title, 'Untitled Take')
  assert.equal(md.artist, 'Unknown Artist')
  assert.equal(md.album, 'Unknown Album')
  assert.equal(md.format, 'M4A')
  assert.equal(md.duration, 0)
  assert.equal(md.bitrate, null, 'no bitrate estimate without duration')
  assert.equal(md.fileSize, null)
  // Technical fields are unknown from the facet; enrichment fills them later.
  assert.equal(md.codec, null)
  assert.equal(md.sampleRate, null)
  assert.equal(md.bitDepth, null)
})

test('handles a missing name gracefully', () => {
  const md = audioFacetToMetadata({ id: 'i3' })
  assert.equal(md.format, 'AUDIO')
  assert.equal(typeof md.title, 'string')
})
