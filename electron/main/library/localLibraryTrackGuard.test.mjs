import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { requireLocalLibraryTrackPath } from './localLibraryTrackGuard.ts'

const track = { id: 7, folder_id: 1, path: '/Music/Album/track.flac', provider: 'local' }
const folder = { id: 1, path: '/Music', provider: 'local', role: 'library' }

test('filesystem track guard accepts only an unchanged track inside a local library', () => {
  assert.equal(requireLocalLibraryTrackPath({ track, folder, expectedPath: track.path }), track.path)
  assert.throws(
    () => requireLocalLibraryTrackPath({ track: { ...track, path: '/Music/other.flac' }, folder, expectedPath: track.path }),
    /path changed/,
  )
  assert.throws(
    () => requireLocalLibraryTrackPath({ track: { ...track, path: '/Outside/track.flac' }, folder }),
    /outside/,
  )
})

test('filesystem track guard rejects cloud tracks and backup folders', () => {
  assert.throws(
    () => requireLocalLibraryTrackPath({
      track: { ...track, provider: 'onedrive', path: 'onedrive://drive/item' },
      folder: { ...folder, provider: 'onedrive', path: 'onedrive://drive/root' },
    }),
    /not a local track/,
  )
  assert.throws(
    () => requireLocalLibraryTrackPath({ track, folder: { ...folder, role: 'backup' } }),
    /local library/,
  )
})
