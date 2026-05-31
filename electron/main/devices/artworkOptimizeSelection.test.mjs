import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  resolveArtworkOptimizationFiles,
  selectedArtworkRelativePaths,
} from './artworkOptimizeSelection.ts'

test('artwork optimization selection deduplicates relative paths by normalized key', () => {
  const relativePaths = selectedArtworkRelativePaths({
    relativePaths: [
      'Artist/Album/Track.mp3',
      'artist/album/track.mp3',
      'Other/Album/Track.mp3',
    ],
  })

  assert.deepEqual(relativePaths, [
    'Artist/Album/Track.mp3',
    'Other/Album/Track.mp3',
  ])
})

test('artwork optimization selection rejects absolute paths', () => {
  assert.throws(
    () => selectedArtworkRelativePaths({ relativePaths: ['/Volumes/DAP/Music/Track.mp3'] }),
    /Invalid artwork relative path/,
  )
})

test('artwork optimization selection rejects path traversal', () => {
  assert.throws(
    () => selectedArtworkRelativePaths({ relativePaths: ['../Track.mp3'] }),
    /Invalid artwork relative path/,
  )
  assert.throws(
    () => selectedArtworkRelativePaths({ relativePaths: ['Artist/../Track.mp3'] }),
    /Invalid artwork relative path/,
  )
})

test('artwork optimization selection resolves valid paths inside the music root', () => {
  const files = resolveArtworkOptimizationFiles('/Volumes/DAP/Music', {
    relativePaths: [
      'Artist/Album/Track.mp3',
      'Other/Album/Second.mp3',
    ],
  })

  assert.deepEqual(files, [
    '/Volumes/DAP/Music/Artist/Album/Track.mp3',
    '/Volumes/DAP/Music/Other/Album/Second.mp3',
  ])
})
