import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  allowedDurationDifference,
  buildDuplicatePrefilterPairs,
  isDuplicatePrefilterPair,
  type DuplicatePrefilterTrack,
} from './candidatePrefilter.ts'

function track(
  id: number,
  overrides: Partial<DuplicatePrefilterTrack> = {},
): DuplicatePrefilterTrack {
  return {
    id,
    artist: 'Beyoncé',
    title: 'Blue Song',
    duration: 200,
    provider: 'local',
    libraryRole: 'library',
    ...overrides,
  }
}

test('uses the balanced duration threshold with inclusive boundaries', () => {
  assert.equal(allowedDurationDifference(100, 106), 6)
  assert.equal(allowedDurationDifference(200, 210), 10.5)
  assert.equal(allowedDurationDifference(1000, 1030), 30)
  assert.ok(isDuplicatePrefilterPair(track(1), track(2, { duration: 210 })))
  assert.equal(isDuplicatePrefilterPair(track(1), track(2, { duration: 211 })), null)
})

test('accepts exact bases and the 80 percent Dice boundary', () => {
  const edition = isDuplicatePrefilterPair(
    track(1, { title: 'Blue Song (2011 Remastered)' }),
    track(2, { title: 'Blue Song - Live' }),
  )
  assert.equal(edition?.titleSimilarity, 1)

  const boundary = isDuplicatePrefilterPair(
    track(3, { title: 'Blue Song' }),
    track(4, { title: 'Blue Song Extended' }),
  )
  assert.equal(boundary?.titleSimilarity, 0.8)
  assert.equal(isDuplicatePrefilterPair(
    track(5, { title: 'Blue Song' }),
    track(6, { title: 'Blue Night Extended' }),
  ), null)
})

test('uses the strict unknown-artist rule and excludes backup locations', () => {
  assert.ok(isDuplicatePrefilterPair(
    track(1, { artist: 'Unknown Artist', title: 'Same', duration: 100 }),
    track(2, { artist: 'Artista desconocido', title: 'Same', duration: 103 }),
  ))
  assert.equal(isDuplicatePrefilterPair(
    track(1, { artist: 'Unknown Artist', title: 'Same', duration: 100 }),
    track(2, { artist: 'Unknown Artist', title: 'Same Extended', duration: 100 }),
  ), null)
  assert.equal(isDuplicatePrefilterPair(
    track(1),
    track(2, { libraryRole: 'backup' }),
  ), null)
})

test('builds only same-artist pairs inside the duration window', () => {
  const pairs = buildDuplicatePrefilterPairs([
    track(1),
    track(2, { artist: 'Beyonce feat. Guest', duration: 205 }),
    track(3, { artist: 'Other Artist' }),
    track(4, { duration: 250 }),
    track(5, { libraryRole: 'backup' }),
  ])
  assert.deepEqual(pairs.map(pair => [pair.lowTrack.id, pair.highTrack.id]), [[1, 2]])
})

test('uses the catalog primary artist when the original tag includes guests', () => {
  const pair = isDuplicatePrefilterPair(
    track(1, { artist: 'Artist feat. Guest A', primaryArtist: 'Artist' }),
    track(2, { artist: 'Artist & Guest B', primaryArtist: 'Artist' }),
  )
  assert.ok(pair)
  assert.equal(pair.normalizedArtist, 'artist')
})

test('keeps three similar copies as three independent pair decisions', () => {
  const pairs = buildDuplicatePrefilterPairs([track(1), track(2), track(3)])
  assert.deepEqual(pairs.map(pair => [pair.lowTrack.id, pair.highTrack.id]), [
    [1, 2],
    [1, 3],
    [2, 3],
  ])
})

test('uses an inverted title index instead of scanning a large artist bucket quadratically', { timeout: 3_000 }, () => {
  const library = Array.from({ length: 10_000 }, (_, index) => track(index + 1, {
    title: `Song ${index + 1}`,
    duration: 200 + (index % 20) / 10,
  }))
  assert.equal(buildDuplicatePrefilterPairs(library).length, 0)
})
