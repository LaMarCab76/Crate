import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { enrichMatchFromRelease, parseReleaseTracklist } from './MusicBrainzMetadata.ts'

const baseMatch = {
  title: 'Borrowed Song',
  artist: 'The Band',
  album: 'Source Album',
  albumArtist: 'The Band',
  genre: null,
  year: null,
  trackNumber: null,
  totalTracks: null,
  discNumber: null,
  totalDiscs: null,
  releaseId: 'release-1',
  releaseGroupId: null,
  confidence: 0.92,
}

const releaseFixture = {
  title: 'Destination Album',
  date: '2003-10-14',
  'artist-credit': [{ name: 'The Band' }],
  genres: [{ name: 'indie rock', count: 10 }],
  'release-group': { id: 'rg-1' },
  media: [
    {
      position: 1,
      'track-count': 2,
      tracks: [
        { position: 1, recording: { title: 'Intro' } },
        { position: 2, recording: { title: 'Other Song' } },
      ],
    },
    {
      position: 2,
      'track-count': 3,
      tracks: [
        { position: 1, recording: { title: 'Bridge' } },
        { position: 2, recording: { title: 'Borrowed Song' } },
        { position: 3, recording: { title: 'Outro' } },
      ],
    },
  ],
}

test('MusicBrainz release enrichment returns album slot, disc and totals for a matched track', () => {
  const enriched = enrichMatchFromRelease(baseMatch, releaseFixture, {
    title: 'Borrowed Song',
    artist: 'The Band',
    album: 'Destination Album',
    durationSeconds: 182,
  })

  assert.equal(enriched.album, 'Destination Album')
  assert.equal(enriched.albumArtist, 'The Band')
  assert.equal(enriched.genre, 'indie rock')
  assert.equal(enriched.year, '2003')
  assert.equal(enriched.trackNumber, 2)
  assert.equal(enriched.totalTracks, 3)
  assert.equal(enriched.discNumber, 2)
  assert.equal(enriched.totalDiscs, 2)
  assert.equal(enriched.releaseGroupId, 'rg-1')
})

test('MusicBrainz release enrichment leaves track slot empty when the recording is not on the release', () => {
  const enriched = enrichMatchFromRelease(baseMatch, releaseFixture, {
    title: 'Missing Song',
    artist: 'The Band',
    album: 'Destination Album',
    durationSeconds: 182,
  })

  assert.equal(enriched.trackNumber, null)
  assert.equal(enriched.discNumber, null)
  assert.equal(enriched.totalDiscs, 2)
})

test('parseReleaseTracklist flattens every disc into disc/track/title rows', () => {
  const tracklist = parseReleaseTracklist(releaseFixture)
  assert.deepEqual(tracklist, [
    { discNumber: 1, trackNumber: 1, title: 'Intro' },
    { discNumber: 1, trackNumber: 2, title: 'Other Song' },
    { discNumber: 2, trackNumber: 1, title: 'Bridge' },
    { discNumber: 2, trackNumber: 2, title: 'Borrowed Song' },
    { discNumber: 2, trackNumber: 3, title: 'Outro' },
  ])
})

test('parseReleaseTracklist skips rows with no position or empty title and defaults disc to 1', () => {
  const tracklist = parseReleaseTracklist({
    media: [
      {
        tracks: [
          { position: 1, recording: { title: 'Kept' } },
          { recording: { title: 'No Position' } },
          { position: 3, recording: { title: '   ' } },
          { position: 4, title: 'Fallback Title' },
        ],
      },
    ],
  })
  assert.deepEqual(tracklist, [
    { discNumber: 1, trackNumber: 1, title: 'Kept' },
    { discNumber: 1, trackNumber: 4, title: 'Fallback Title' },
  ])
})

test('parseReleaseTracklist returns [] for non-release input', () => {
  assert.deepEqual(parseReleaseTracklist(null), [])
  assert.deepEqual(parseReleaseTracklist({}), [])
})
