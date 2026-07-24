import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { DuplicateSegment } from '@shared/types/duplicates'
import { classifyDuplicatePair } from './classification.ts'
import type { DuplicateTrackFacts } from './domain.ts'
import { duplicateReleaseClass, recommendDuplicateKeeper } from './recommendation.ts'

function facts(id: number, overrides: Partial<DuplicateTrackFacts> = {}): DuplicateTrackFacts {
  return {
    id,
    folderId: 1,
    provider: 'local',
    libraryRole: 'library',
    libraryName: 'Music',
    path: `/music/${id}.mp3`,
    filename: `${id}.mp3`,
    title: 'Song',
    artist: 'Artist',
    primaryArtist: 'Artist',
    album: 'Artist Album',
    albumArtist: 'Artist',
    year: '2020',
    duration: 200,
    trackNumber: 1,
    discNumber: 1,
    format: 'MP3',
    codec: 'MPEG Layer 3',
    bitrate: 320_000,
    sampleRate: 44_100,
    bitDepth: 16,
    channels: 2,
    fileSize: 10_000,
    dateModified: '2026-01-01T00:00:00.000Z',
    artworkPath: null,
    dateAdded: `2026-01-0${id}T00:00:00.000Z`,
    compilation: false,
    albumCompilation: false,
    releaseType: 'album',
    mediaType: null,
    musicBrainzRecordingId: null,
    musicBrainzReleaseId: null,
    musicBrainzReleaseGroupId: null,
    driveId: null,
    itemId: null,
    etag: null,
    ...overrides,
  }
}

function segment(
  kind: DuplicateSegment['kind'],
  startSec: number,
  endSec: number,
  score: number,
): DuplicateSegment {
  return {
    id: `${kind}-${startSec}`,
    kind,
    startSec,
    endSec,
    leftStartSec: startSec,
    rightStartSec: startSec,
    score,
  }
}

test('prefers an artist album over a higher-quality compilation copy', () => {
  const album = facts(1)
  const compilation = facts(2, {
    album: 'Greatest Collection',
    albumArtist: 'Various Artists',
    compilation: true,
    releaseType: 'compilation',
    format: 'FLAC',
    codec: 'FLAC',
    sampleRate: 96_000,
    bitDepth: 24,
  })
  const result = recommendDuplicateKeeper(album, compilation)
  assert.equal(result.recommendedTrackId, album.id)
  assert.match(result.reasons[0], /álbum propio/i)
})

test('does not infer an artist release from missing or contradictory album-artist tags', () => {
  const missingAlbumArtist = facts(1, { albumArtist: null, releaseType: 'album' })
  const contradictoryAlbumArtist = facts(2, { albumArtist: 'Another Artist', releaseType: 'album' })
  const explicitArtistRelease = facts(3, { albumArtist: 'Artist', releaseType: null })

  assert.equal(duplicateReleaseClass(missingAlbumArtist), 'unknown')
  assert.equal(duplicateReleaseClass(contradictoryAlbumArtist), 'unknown')
  assert.equal(duplicateReleaseClass(explicitArtistRelease), 'artist_release')
  assert.equal(
    recommendDuplicateKeeper(missingAlbumArtist, explicitArtistRelease).recommendedTrackId,
    explicitArtistRelease.id,
  )
})

test('keeps an explicit single or EP in its own class when album artist is merely absent', () => {
  assert.equal(duplicateReleaseClass(facts(1, {
    album: 'Song - Single',
    albumArtist: null,
    releaseType: 'single',
  })), 'single_ep')
  assert.equal(duplicateReleaseClass(facts(2, {
    album: 'Song - EP',
    albumArtist: 'Another Artist',
    releaseType: 'ep',
  })), 'unknown')
})

test('uses lossless, sample rate, bit depth and lossy bitrate within a release class', () => {
  assert.equal(recommendDuplicateKeeper(
    facts(1),
    facts(2, { format: 'FLAC', codec: 'FLAC', bitrate: 800_000 }),
  ).recommendedTrackId, 2)
  assert.equal(recommendDuplicateKeeper(
    facts(1, { sampleRate: 44_100 }),
    facts(2, { sampleRate: 48_000 }),
  ).recommendedTrackId, 2)
  assert.equal(recommendDuplicateKeeper(
    facts(1, { bitrate: 256_000 }),
    facts(2, { bitrate: 320_000 }),
  ).recommendedTrackId, 2)
})

test('classifies sustained differences and album-versus-single evidence', () => {
  const result = classifyDuplicatePair({
    left: facts(1, { title: 'Song (Album Version)', duration: 205 }),
    right: facts(2, {
      title: 'Song (Radio Edit)',
      album: 'Song - Single',
      releaseType: 'single',
      duration: 200,
    }),
    similarity: 0.8,
    segments: [segment('match', 0, 190, 0.95), segment('difference', 190, 205, 0.1)],
  })
  assert.equal(result.acousticRelation, 'possible_different_edition')
  assert.equal(result.editorialRelation, 'album_vs_single_ep')
  assert.equal(result.needsMetadataEnrichment, false)
  assert.ok(result.evidence.some(item => item.kind === 'audio_difference'))
  assert.ok(result.evidence.some(item => item.kind === 'title_qualifier'))
})

test('keeps high-similarity same-release copies separate from editorial inference', () => {
  const result = classifyDuplicatePair({
    left: facts(1, { musicBrainzReleaseId: 'release-1' }),
    right: facts(2, { musicBrainzReleaseId: 'release-1' }),
    similarity: 0.9,
    segments: [segment('match', 0, 200, 0.9)],
  })
  assert.equal(result.acousticRelation, 'near_identical')
  assert.equal(result.editorialRelation, 'same_release')
  assert.equal(result.needsMetadataEnrichment, false)
})

test('treats incompatible MusicBrainz release IDs as different releases before album heuristics', () => {
  const result = classifyDuplicatePair({
    left: facts(1, { musicBrainzReleaseId: 'release-1' }),
    right: facts(2, { musicBrainzReleaseId: 'release-2' }),
    similarity: 0.9,
    segments: [segment('match', 0, 200, 0.9)],
  })
  assert.equal(result.editorialRelation, 'different_releases')
  assert.equal(result.needsMetadataEnrichment, false)
  assert.ok(result.evidence.some(item => item.kind === 'release_type'))
})
