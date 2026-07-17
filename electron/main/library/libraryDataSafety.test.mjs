import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import {
  mergedPortableTrackState,
  portableTrackState,
  resolvePortableTrackPath,
} from '../services/libraryBackupSafety.ts'
import { collectLibraryFiles, LibraryCollectionError } from './libraryFileCollector.ts'
import {
  findOverlappingLibraryRoot,
  requireCurrentLocalLibraryFolder,
  requirePathInsideLocalLibrary,
} from './libraryRootGuards.ts'

test('portable backup track paths cannot escape their registered root', () => {
  const root = join(tmpdir(), 'crate-library')
  assert.equal(resolvePortableTrackPath(root, '../outside.flac'), null)
  assert.equal(resolvePortableTrackPath(root, 'Artist/../../outside.flac'), null)
  assert.equal(resolvePortableTrackPath(root, '/outside.flac'), null)
  assert.equal(resolvePortableTrackPath(root, 'C:/outside.flac'), null)
  assert.equal(resolvePortableTrackPath(root, 'Artist\\outside.flac'), null)
  assert.equal(
    resolvePortableTrackPath(root, 'Artist/Album/Track.flac'),
    join(root, 'Artist', 'Album', 'Track.flac'),
  )
})

test('portable state keeps explicit false and null changes', () => {
  const state = portableTrackState({
    play_count: 0,
    last_played_date: null,
    is_favorite: 0,
    rating: null,
    state_updated_at: Date.parse('2026-01-02T03:04:05.000Z'),
  })
  assert.deepEqual(state, {
    favorite: false,
    rating: null,
    stateUpdatedAt: '2026-01-02T03:04:05.000Z',
  })
})

test('portable merge yields exactly five SET binds and applies explicit clears', () => {
  const values = mergedPortableTrackState(
    {
      play_count: 2,
      last_played_date: '2025-01-01T00:00:00.000Z',
      is_favorite: 1,
      rating: 5,
      state_updated_at: 100,
    },
    {
      playCount: 3,
      lastPlayedAt: '2026-01-01T00:00:00.000Z',
      favorite: false,
      rating: null,
      stateUpdatedAt: '2026-01-02T00:00:00.000Z',
    },
  )
  assert.equal(values.length, 5)
  assert.deepEqual(values.slice(0, 4), [3, '2026-01-01T00:00:00.000Z', 0, null])
})

test('file collection distinguishes an empty complete scan from an unreadable/missing root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'crate-collector-'))
  assert.deepEqual(await collectLibraryFiles(root, name => name.endsWith('.flac')), [])

  await assert.rejects(
    collectLibraryFiles(join(root, 'not-mounted'), () => true),
    err => err instanceof LibraryCollectionError && err.path.endsWith('not-mounted'),
  )
})

test('file collection skips symlinks instead of leaving the library boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'crate-collector-'))
  const outside = await mkdtemp(join(tmpdir(), 'crate-outside-'))
  await writeFile(join(outside, 'escaped.flac'), 'audio')
  await mkdir(join(root, 'inside'))
  await writeFile(join(root, 'inside', 'ok.flac'), 'audio')
  await symlink(outside, join(root, 'outside-link'))

  assert.deepEqual(
    await collectLibraryFiles(root, name => name.endsWith('.flac')),
    [join(root, 'inside', 'ok.flac')],
  )
})

test('registered library roots reject parent/child overlap but allow siblings', () => {
  const folders = [{ id: 1, name: 'Music', path: '/Volumes/Music' }]
  assert.equal(findOverlappingLibraryRoot('/Volumes/Music', folders)?.exact, true)
  assert.equal(findOverlappingLibraryRoot('/Volumes/Music/Jazz', folders)?.exact, false)
  assert.equal(findOverlappingLibraryRoot('/Volumes', folders)?.exact, false)
  assert.equal(findOverlappingLibraryRoot('/Volumes/Music-Archive', folders), null)
})

test('an asynchronous scan must still target the same current local library', () => {
  const expected = { id: 1, path: '/Volumes/Music' }
  const current = { ...expected, provider: 'local', role: 'library' }
  assert.doesNotThrow(() => requireCurrentLocalLibraryFolder(expected, current))
  assert.throws(
    () => requireCurrentLocalLibraryFolder(expected, { ...current, role: 'backup' }),
    /no longer a local library/,
  )
  assert.throws(
    () => requireCurrentLocalLibraryFolder(expected, { ...current, path: '/Volumes/Other' }),
    /root changed/,
  )
})

test('single-file imports stay inside a current local library', () => {
  const folder = { path: '/Volumes/Music', provider: 'local', role: 'library' }
  assert.equal(
    requirePathInsideLocalLibrary(folder, '/Volumes/Music/Album/song.flac'),
    resolve('/Volumes/Music/Album/song.flac'),
  )
  assert.throws(
    () => requirePathInsideLocalLibrary({ ...folder, role: 'backup' }, '/Volumes/Music/song.flac'),
    /no longer belongs/,
  )
  assert.throws(
    () => requirePathInsideLocalLibrary(folder, '/Volumes/Other/song.flac'),
    /outside/,
  )
})
