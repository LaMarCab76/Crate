import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { DbFolder } from '@shared/types/db'
import type { DuplicateTrackFacts } from './domain.ts'
import { createDuplicateRootPreflight } from './DuplicateRootPreflight.ts'

function folder(id: number, path = '/Volumes/H2-SD/02 - Biblioteca'): DbFolder {
  return {
    id,
    name: '02 - Biblioteca',
    path,
    track_count: 203,
    date_added: '2026-01-01T00:00:00.000Z',
    date_updated: '2026-01-01T00:00:00.000Z',
    bookmark_data: null,
    provider: 'local',
    role: 'library',
    backup_source_folder_id: null,
    account_id: null,
    drive_id: null,
    item_id: null,
    remote_path: null,
    delta_cursor: null,
    display_icon: null,
  }
}

function track(id: number, folderId = 1, provider: 'local' | 'onedrive' = 'local'): DuplicateTrackFacts {
  return {
    id,
    folderId,
    provider,
  } as DuplicateTrackFacts
}

test('preflight checks one root for 203 involved tracks and returns one retryable blocker', async () => {
  const library = folder(1)
  let inspections = 0
  const preflight = createDuplicateRootPreflight({
    getFolder: id => id === library.id ? library : undefined,
    inspect: async path => {
      inspections += 1
      assert.equal(path, library.path)
      return {
        state: 'unavailable',
        canRead: false,
        canWrite: false,
        detail: 'La ubicación no está conectada o ya no existe.',
      }
    },
    platform: 'darwin',
  })

  const blocker = await preflight({
    tracks: Array.from({ length: 203 }, (_, index) => track(index + 1)),
  })

  assert.equal(inspections, 1, 'the preflight must inspect a root, never every track')
  assert.equal(blocker?.code, 'local_library_unavailable')
  assert.equal(blocker?.retryable, true)
  assert.equal(blocker?.requiresRestart, false)
  assert.deepEqual(blocker?.affectedFolders, [{
    folderId: 1,
    name: '02 - Biblioteca',
    path: '/Volumes/H2-SD/02 - Biblioteca',
    state: 'unavailable',
  }])
  assert.match(blocker?.message ?? '', /volvé a analizar/i)
  assert.match(blocker?.message ?? '', /ninguna pista como dañada/i)
})

test('preflight coalesces folders that resolve to the same local root and ignores cloud tracks', async () => {
  const first = folder(1, '/Volumes/Music')
  const second = { ...folder(2, '/volumes/music'), name: 'Same root alias' }
  let inspections = 0
  const preflight = createDuplicateRootPreflight({
    getFolder: id => id === 1 ? first : id === 2 ? second : undefined,
    inspect: async () => {
      inspections += 1
      return {
        state: 'permission_required',
        canRead: false,
        canWrite: false,
        detail: 'Crate necesita autorización.',
      }
    },
    platform: 'darwin',
  })

  const blocker = await preflight({
    tracks: [
      track(1, 1),
      track(2, 1),
      track(3, 2),
      track(4, 9, 'onedrive'),
    ],
  })

  assert.equal(inspections, 1)
  assert.equal(blocker?.code, 'local_library_permission_required')
  assert.equal(blocker?.affectedFolders?.length, 2)
})

test('preflight gates on readable capability rather than permission/read-only labels', async () => {
  const libraries = new Map([
    [1, folder(1, '/Volumes/Readable Permission')],
    [2, folder(2, '/Volumes/Read Only')],
  ])
  let inspections = 0
  const preflight = createDuplicateRootPreflight({
    getFolder: id => libraries.get(id),
    inspect: async path => {
      inspections += 1
      return path.endsWith('Read Only')
        ? { state: 'read_only', canRead: true, canWrite: false, detail: 'Solo lectura.' }
        : { state: 'permission_required', canRead: true, canWrite: false, detail: 'Escritura sin permiso.' }
    },
    platform: 'darwin',
  })

  const blocker = await preflight({ tracks: [track(1, 1), track(2, 2)] })
  assert.equal(inspections, 2)
  assert.equal(blocker, null)
})
