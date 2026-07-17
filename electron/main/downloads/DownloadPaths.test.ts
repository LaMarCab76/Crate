import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  downloadPartPath,
  requireLocalLibraryDownloadPath,
  sanitizePathPart,
} from './DownloadPaths.ts'

test('path parts remove unsafe characters, trailing dots and Windows reserved names', () => {
  assert.equal(sanitizePathPart('  A/B:C*  ', 'fallback'), 'A B C')
  assert.equal(sanitizePathPart('CON', 'fallback'), '_CON')
  assert.equal(sanitizePathPart('lpt9.txt', 'fallback'), '_lpt9.txt')
  assert.equal(sanitizePathPart('... ', 'fallback'), 'fallback')
})

test('path parts are bounded and each job gets a distinct part file', () => {
  assert.equal(sanitizePathPart('x'.repeat(200), 'fallback').length, 80)
  assert.notEqual(
    downloadPartPath('/music/track.flac', 'job-one'),
    downloadPartPath('/music/track.flac', 'job-two'),
  )
})

test('download publish paths require a current local library destination', () => {
  const folder = { path: '/Music', provider: 'local', role: 'library' } as const
  assert.equal(
    requireLocalLibraryDownloadPath(folder, '/Music/Crate Downloads/song.flac'),
    '/Music/Crate Downloads/song.flac',
  )
  assert.throws(
    () => requireLocalLibraryDownloadPath({ ...folder, role: 'backup' }, '/Music/song.flac'),
    /local library destination/,
  )
  assert.throws(
    () => requireLocalLibraryDownloadPath({ ...folder, provider: 'onedrive' }, 'onedrive://drive/item'),
    /local library destination/,
  )
  assert.throws(
    () => requireLocalLibraryDownloadPath(folder, '/Other/song.flac'),
    /outside/,
  )
})
