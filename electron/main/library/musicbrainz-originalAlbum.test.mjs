import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { parseReleaseDetail } from './MusicBrainzMetadata.ts'
import { coverUrlFromArchive } from './CoverArtArchive.ts'

const releaseJson = {
  id: 'rel-album',
  title: 'Original Album',
  status: 'Official',
  date: '2009-05-01',
  country: 'GB',
  'artist-credit': [
    { name: 'The Band', joinphrase: ' & ', artist: { id: 'artist-band', name: 'The Band' } },
    { name: 'Guest', joinphrase: '', artist: { id: 'artist-guest', name: 'Guest' } },
  ],
  'release-group': { id: 'rg-album', 'primary-type': 'Album', 'secondary-types': ['Soundtrack'] },
  genres: [{ name: 'indie rock', count: 4 }, { name: 'rock', count: 9 }],
  media: [
    {
      position: 1,
      'track-count': 2,
      tracks: [
        { id: 't1', position: 1, number: '1', title: 'Intro', recording: { id: 'rec-intro', title: 'Intro' } },
        { id: 't2', position: 2, number: '2', title: 'Borrowed Song', recording: { id: 'rec-studio', title: 'Borrowed Song (album version)' } },
      ],
    },
    {
      position: 2,
      'track-count': 1,
      tracks: [{ id: 't3', position: 1, number: 'B1', title: 'Outro', recording: { id: 'rec-outro', title: 'Outro' } }],
    },
  ],
}

test('parseReleaseDetail extracts identity, credit and per-disc tracklist', () => {
  const detail = parseReleaseDetail(releaseJson)
  assert.ok(detail)
  assert.equal(detail.releaseId, 'rel-album')
  assert.equal(detail.releaseGroupId, 'rg-album')
  assert.equal(detail.title, 'Original Album')
  assert.equal(detail.albumArtist, 'The Band & Guest')
  assert.deepEqual(detail.albumArtistIds, ['artist-band', 'artist-guest'])
  assert.equal(detail.year, '2009')
  assert.equal(detail.country, 'GB')
  assert.equal(detail.status, 'Official')
  assert.equal(detail.primaryType, 'Album')
  assert.deepEqual(detail.secondaryTypes, ['Soundtrack'])
  assert.equal(detail.genre, 'rock', 'the most-voted genre wins')
  assert.equal(detail.totalDiscs, 2)
  assert.deepEqual(detail.discTrackCounts, { 1: 2, 2: 1 })
  assert.deepEqual(detail.tracklist, [
    { discNumber: 1, trackNumber: 1, title: 'Intro', recordingId: 'rec-intro' },
    { discNumber: 1, trackNumber: 2, title: 'Borrowed Song', recordingId: 'rec-studio' },
    { discNumber: 2, trackNumber: 1, title: 'Outro', recordingId: 'rec-outro' },
  ])
})

test('parseReleaseDetail rejects non-release input', () => {
  assert.equal(parseReleaseDetail(null), null)
  assert.equal(parseReleaseDetail({ title: 'No id' }), null)
})

test('coverUrlFromArchive prefers the front cover 1200px thumbnail', () => {
  assert.equal(coverUrlFromArchive({
    images: [
      { front: false, approved: true, image: 'https://caa/back.jpg', thumbnails: { 1200: 'https://caa/back-1200.jpg' } },
      { front: true, image: 'https://caa/front.jpg', thumbnails: { 500: 'https://caa/front-500.jpg', 1200: 'https://caa/front-1200.jpg' } },
    ],
  }), 'https://caa/front-1200.jpg')
  assert.equal(coverUrlFromArchive({ images: [{ image: 'https://caa/only.jpg' }] }), 'https://caa/only.jpg')
  assert.equal(coverUrlFromArchive({ images: [] }), null)
  assert.equal(coverUrlFromArchive(null), null)
})
