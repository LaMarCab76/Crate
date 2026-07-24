import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  duplicateResolutionActionForKeptSide,
  duplicateSegmentWidth,
  duplicateSimilarityPercent,
  duplicateTimelineDuration,
  duplicateTrackEdition,
  duplicateTrackQuality,
  filterDuplicateSegments,
} from './duplicateReview.ts'

const segments = [
  { id: 'a', kind: 'match', startSec: 0, endSec: 10, leftStartSec: 0, rightStartSec: 1, score: 0.92 },
  { id: 'b', kind: 'difference', startSec: 10, endSec: 15, leftStartSec: 10, rightStartSec: 11, score: 0.2 },
  { id: 'c', kind: 'match', startSec: 15, endSec: 30, leftStartSec: 15, rightStartSec: 16, score: 0.88 },
]

const track = {
  id: 1,
  folderId: 1,
  provider: 'local',
  title: 'Track',
  artist: 'Artist',
  album: 'Album',
  albumArtist: 'Artist',
  year: '2025',
  duration: 180,
  trackNumber: 1,
  discNumber: 1,
  format: 'flac',
  codec: 'FLAC',
  bitrate: 1000000,
  sampleRate: 44100,
  bitDepth: 24,
  channels: 2,
  fileSize: 123,
  libraryName: 'Principal',
  path: '/Music/Track.flac',
  artworkPath: null,
  releaseType: 'Album',
  isCompilation: false,
  dateAdded: '2025-01-01',
}

test('normalizes fractional and percentage duplicate scores', () => {
  assert.equal(duplicateSimilarityPercent(0.604), 60)
  assert.equal(duplicateSimilarityPercent(81.2), 81)
  assert.equal(duplicateSimilarityPercent(4), 4)
  assert.equal(duplicateSimilarityPercent(125), 100)
})

test('maps direct keep choices to the opposite destructive action', () => {
  assert.equal(duplicateResolutionActionForKeptSide('left'), 'trash_right')
  assert.equal(duplicateResolutionActionForKeptSide('right'), 'trash_left')
})

test('filters segments without losing their backend indexes', () => {
  assert.deepEqual(filterDuplicateSegments(segments, 'difference').map(item => item.index), [1])
  assert.deepEqual(filterDuplicateSegments(segments, 'match').map(item => item.index), [0, 2])
  assert.deepEqual(filterDuplicateSegments(segments, 'all').map(item => item.index), [0, 1, 2])
})

test('derives timeline duration and proportional segment widths', () => {
  assert.equal(duplicateTimelineDuration(segments), 30)
  assert.equal(Math.round(duplicateSegmentWidth(segments[0], 30)), 33)
  assert.equal(duplicateSegmentWidth({ ...segments[0], endSec: 0.01 }, 30), 0.75)
})

test('describes track quality and edition without hiding compilation context', () => {
  assert.equal(duplicateTrackQuality(track), 'FLAC · 1000 kbps · 44.1 kHz · 24 bit · Estéreo')
  assert.equal(duplicateTrackEdition(track), 'Album')
  assert.equal(duplicateTrackEdition({ ...track, releaseType: null, isCompilation: true }), 'Recopilación')
})
