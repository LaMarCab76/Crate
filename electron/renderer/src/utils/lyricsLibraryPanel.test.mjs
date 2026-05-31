import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  filterLyricsLibraryItems,
  lyricsLibraryCounts,
  pruneLyricsSelection,
} from './lyricsLibraryPanel.ts'

function item(trackId, patch = {}) {
  return {
    trackId,
    title: `Song ${trackId}`,
    artist: 'Artist',
    album: 'Album',
    duration: 180,
    path: `/music/${trackId}.flac`,
    status: 'none',
    source: null,
    hasLyrics: false,
    sidecarWritten: false,
    embeddedInFile: false,
    ...patch,
  }
}

test('counts tracks with and without lyrics', () => {
  assert.deepEqual(lyricsLibraryCounts([
    item(1, { hasLyrics: true }),
    item(2),
    item(3, { hasLyrics: true }),
  ]), {
    total: 3,
    withLyrics: 2,
    missingLyrics: 1,
  })
})

test('filters by tab and text fields', () => {
  const items = [
    item(1, { title: 'Blue Train', artist: 'John Coltrane' }),
    item(2, { title: 'Naima', artist: 'John Coltrane', hasLyrics: true, status: 'found_plain' }),
    item(3, { title: 'So What', artist: 'Miles Davis', album: 'Kind of Blue' }),
  ]

  assert.deepEqual(filterLyricsLibraryItems(items, 'missing', 'blue').map(i => i.trackId), [1, 3])
  assert.deepEqual(filterLyricsLibraryItems(items, 'with', 'john').map(i => i.trackId), [2])
})

test('prunes selection to tracks still missing lyrics', () => {
  const next = pruneLyricsSelection(
    new Set([1, 2, 3]),
    [item(1), item(2, { hasLyrics: true, status: 'found_synced' }), item(4)],
  )

  assert.deepEqual([...next].sort(), [1])
})
