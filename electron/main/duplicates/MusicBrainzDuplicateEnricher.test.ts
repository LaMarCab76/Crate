import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { MusicBrainzTrackMatch } from '../library/MusicBrainzMetadata.ts'
import type { DuplicateTrackFacts } from './domain.ts'
import { MusicBrainzDuplicateEnricher } from './MusicBrainzDuplicateEnricher.ts'

function track(id: number, album = `Album ${id}`): DuplicateTrackFacts {
  return {
    id,
    folderId: 1,
    provider: 'local',
    libraryRole: 'library',
    libraryName: 'Music',
    path: `/music/${id}.flac`,
    filename: `${id}.flac`,
    title: `Song ${id}`,
    artist: 'Artist',
    primaryArtist: 'Artist',
    album,
    albumArtist: 'Artist',
    year: '2020',
    duration: 200,
    trackNumber: 1,
    discNumber: 1,
    format: 'FLAC',
    codec: 'FLAC',
    bitrate: 900_000,
    sampleRate: 44_100,
    bitDepth: 16,
    channels: 2,
    fileSize: 10_000,
    dateModified: null,
    artworkPath: null,
    dateAdded: '2026-01-01T00:00:00.000Z',
    compilation: false,
    albumCompilation: false,
    releaseType: null,
    mediaType: null,
    musicBrainzRecordingId: null,
    musicBrainzReleaseId: null,
    musicBrainzReleaseGroupId: null,
    driveId: null,
    itemId: null,
    etag: null,
  }
}

function match(releaseId: string, confidence = 0.9): MusicBrainzTrackMatch {
  return {
    title: 'Song',
    artist: 'Artist',
    album: 'Album',
    albumArtist: 'Artist',
    genre: null,
    year: '2020',
    trackNumber: 1,
    totalTracks: 10,
    discNumber: 1,
    totalDiscs: 1,
    releaseId,
    releaseGroupId: `${releaseId}-group`,
    confidence,
  }
}

test('bounds uncached MusicBrainz pairs per run and reuses cached results', async () => {
  let calls = 0
  const client = {
    async lookupRecordingOnAlbum(query: { album: string | null }) {
      calls += 1
      return match(query.album ?? 'release')
    },
  }
  const enricher = new MusicBrainzDuplicateEnricher(client, 1)
  const first = await enricher.enrichPair(track(1), track(2))
  assert.equal(first?.left?.musicBrainzReleaseId, 'Album 1')
  assert.equal(calls, 2)
  assert.equal(await enricher.enrichPair(track(3), track(4)), null)
  assert.equal(calls, 2)

  // Cached pairs remain available without consuming online budget.
  assert.ok(await enricher.enrichPair(track(1), track(2)))
  assert.equal(calls, 2)
  enricher.beginRun()
  assert.ok(await enricher.enrichPair(track(3), track(4)))
  assert.equal(calls, 4)
})

test('does not use low-confidence MusicBrainz matches as classification facts', async () => {
  const enricher = new MusicBrainzDuplicateEnricher({
    async lookupRecordingOnAlbum() { return match('weak', 0.5) },
  }, 1)
  assert.equal(await enricher.enrichPair(track(1), track(2)), null)
})
