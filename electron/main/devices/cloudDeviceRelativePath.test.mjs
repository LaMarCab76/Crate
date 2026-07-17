import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { cloudDeviceRelativePath, sanitizeSegment, stripRemotePrefix } from './cloudDeviceRelativePath.ts'

test('cloud device paths preserve the hierarchy below the configured library', () => {
  assert.deepEqual(
    stripRemotePrefix('/drives/drive/root:/Music/Artist/Album/song.flac'),
    ['Music', 'Artist', 'Album', 'song.flac'],
  )
  assert.equal(cloudDeviceRelativePath({
    remotePath: '/drives/drive/root:/Music/Artist/Album/song.flac',
    filename: 'song.flac',
    folderName: 'Music',
  }), 'Artist/Album/song.flac')
})

test('cloud device paths sanitize reserved characters and have a safe flat fallback', () => {
  assert.equal(sanitizeSegment('AC/DC: Live?.flac'), 'AC-DC- Live-.flac')
  assert.equal(cloudDeviceRelativePath({
    remotePath: null,
    filename: 'AC/DC: Live?.flac',
    folderName: 'Music',
  }), 'AC-DC- Live-.flac')
})
