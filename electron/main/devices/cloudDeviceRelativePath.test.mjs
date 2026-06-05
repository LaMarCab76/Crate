import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { cloudDeviceRelativePath, sanitizeSegment, stripRemotePrefix } from './cloudDeviceRelativePath.ts'

test('stripRemotePrefix keeps the part after the drive root marker', () => {
  assert.deepEqual(
    stripRemotePrefix('/drives/b!xyz/root:/Music/Pink Floyd/The Wall/01 - Brick.flac'),
    ['Music', 'Pink Floyd', 'The Wall', '01 - Brick.flac'],
  )
})

test('stripRemotePrefix tolerates the /drive/root: variant and a single child', () => {
  assert.deepEqual(stripRemotePrefix('/drive/root:/Solo.flac'), ['Solo.flac'])
})

test('stripRemotePrefix falls back to the whole path when there is no root marker', () => {
  assert.deepEqual(stripRemotePrefix('Music/Artist/1.flac'), ['Music', 'Artist', '1.flac'])
})

test('cloudDeviceRelativePath preserves Artist/Album hierarchy below the folder name', () => {
  assert.equal(
    cloudDeviceRelativePath({
      remotePath: '/drives/b!xyz/root:/Music/Pink Floyd/The Wall/01 - Brick.flac',
      filename: '01 - Brick.flac',
      folderName: 'Music',
    }),
    'Pink Floyd/The Wall/01 - Brick.flac',
  )
})

test('cloudDeviceRelativePath places a track directly under the folder at the device root', () => {
  assert.equal(
    cloudDeviceRelativePath({
      remotePath: '/drive/root:/MyMusic/song.mp3',
      filename: 'song.mp3',
      folderName: 'MyMusic',
    }),
    'song.mp3',
  )
})

test('cloudDeviceRelativePath keeps the full subtree when the folder name is not found', () => {
  assert.equal(
    cloudDeviceRelativePath({
      remotePath: '/drives/x/root:/Music/Artist/1.flac',
      filename: '1.flac',
      folderName: 'Nonexistent',
    }),
    'Music/Artist/1.flac',
  )
})

test('cloudDeviceRelativePath falls back to a flat sanitized filename without a remote path', () => {
  assert.equal(
    cloudDeviceRelativePath({ remotePath: null, filename: 'AC/DC: Live?.flac', folderName: '' }),
    'AC-DC- Live-.flac',
  )
})

test('cloudDeviceRelativePath forces the canonical filename onto the last segment', () => {
  // The result must end in the DB filename (correct extension), not a re-derived
  // remote segment.
  assert.equal(
    cloudDeviceRelativePath({
      remotePath: '/drives/x/root:/Lib/Album/track.flac',
      filename: 'track.flac',
      folderName: 'Lib',
    }),
    'Album/track.flac',
  )
})

test('sanitizeSegment collapses reserved + control chars to "-", preserving spaces', () => {
  assert.equal(sanitizeSegment('A: B/C?'), 'A- B-C-')
  assert.equal(sanitizeSegment('tab\tname'), 'tab-name')
  assert.equal(sanitizeSegment('  ..dots..  '), 'dots')
})

test('sanitizeSegment normalizes decomposed unicode to NFC', () => {
  // Built from char codes so the source stays pure-ASCII and unambiguous.
  const combiningAcute = String.fromCharCode(0x301)
  const precomposedE = String.fromCharCode(0xe9)
  const decomposed = 'Cafe' + combiningAcute + '.flac'
  const precomposed = 'Caf' + precomposedE + '.flac'
  assert.notEqual(decomposed, precomposed) // the two literals really differ
  assert.equal(sanitizeSegment(decomposed), precomposed)
  assert.equal(
    cloudDeviceRelativePath({ remotePath: null, filename: decomposed, folderName: '' }),
    precomposed,
  )
})
