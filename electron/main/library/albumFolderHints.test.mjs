import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { resolveAlbumFromFolderHints } from './albumFolderHints.ts'

function row(album_id, album, artist, album_artist = null) {
  return { album_id, album, artist, album_artist }
}

// A library root where one big album dominates, plus a compilation.
const library = [
  ...Array.from({ length: 14 }, () => row(1, 'Biggest Album', 'Big Artist', 'Big Artist')),
  row(2, 'Now Hits 42', 'The Band', 'Various Artists'),
  row(2, 'Now Hits 42', 'Other Act', 'Various Artists'),
]

test('a track renamed to an album that is not in the library is not dropped into the biggest album', () => {
  const edited = row(2, 'Original Album', 'The Band', 'The Band')
  assert.equal(resolveAlbumFromFolderHints(edited, library), null)
})

test('a minor edit keeps the track in the album it shares with its siblings', () => {
  // e.g. the user only fixed the year: getOrCreate would otherwise split it.
  assert.equal(resolveAlbumFromFolderHints(row(2, 'Now Hits 42', 'The Band', 'Various Artists'), library), 2)
  assert.equal(resolveAlbumFromFolderHints(row(1, 'biggest album ', 'Big Artist', 'big artist'), library), 1)
})

test('a same-named album by another album artist is not reused', () => {
  const candidates = [row(7, 'Greatest Hits', 'Queen', 'Queen')]
  assert.equal(resolveAlbumFromFolderHints(row(8, 'Greatest Hits', 'ABBA', 'ABBA'), candidates), null)
})

test('falls back to the track artist when there is no album artist', () => {
  const candidates = [row(5, 'Album', 'Solo'), row(5, 'Album', 'Solo')]
  assert.equal(resolveAlbumFromFolderHints(row(5, 'Album', 'Solo'), candidates), 5)
})

test('ambiguous or empty hints resolve to null', () => {
  const candidates = [row(3, 'Album', 'X', 'X'), row(4, 'Album', 'X', 'X')]
  assert.equal(resolveAlbumFromFolderHints(row(3, 'Album', 'X', 'X'), candidates), null)
  assert.equal(resolveAlbumFromFolderHints(row(3, '', 'X', 'X'), candidates), null)
  assert.equal(resolveAlbumFromFolderHints(row(3, 'Album', 'X', 'X'), []), null)
})
