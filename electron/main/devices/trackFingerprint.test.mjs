import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { trackFingerprint } from './trackFingerprint.ts'

function track(patch = {}) {
  return {
    duration: 181,
    title: 'When You Believe',
    artist: 'Mariah Carey',
    album: "#1's",
    albumArtist: 'Mariah Carey',
    format: 'FLAC',
    ...patch,
  }
}

test('two copies of the same track match regardless of mtime/size', () => {
  // The volatile attributes (mtime, fileSize, relativePath) are not part of the
  // input at all, so a PC copy and a freshly-copied device copy are identical.
  assert.equal(trackFingerprint(track()), trackFingerprint(track()))
})

test('a different duration makes them different tracks', () => {
  assert.notEqual(trackFingerprint(track()), trackFingerprint(track({ duration: 181.4 + 1 })))
})

test('rounds duration so sub-second jitter still matches', () => {
  assert.equal(trackFingerprint(track({ duration: 181.1 })), trackFingerprint(track({ duration: 181.4 })))
})

test('differing tags (title/artist/album/albumArtist/format) are different', () => {
  const base = trackFingerprint(track())
  assert.notEqual(base, trackFingerprint(track({ title: 'Honey' })))
  assert.notEqual(base, trackFingerprint(track({ artist: 'Whitney Houston' })))
  assert.notEqual(base, trackFingerprint(track({ album: 'Butterfly' })))
  assert.notEqual(base, trackFingerprint(track({ albumArtist: 'Various' })))
  assert.notEqual(base, trackFingerprint(track({ format: 'MP3' })))
})

test('tag comparison is case- and whitespace-insensitive', () => {
  assert.equal(
    trackFingerprint(track({ title: 'When You Believe', artist: 'Mariah Carey' })),
    trackFingerprint(track({ title: '  when you believe ', artist: 'MARIAH CAREY' })),
  )
})

test('null albumArtist matches empty albumArtist', () => {
  assert.equal(trackFingerprint(track({ albumArtist: null })), trackFingerprint(track({ albumArtist: '' })))
})
