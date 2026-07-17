import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { DbFolder } from '@shared/types/db'
import { CloudHttpError, type DriveItem, type OneDriveClient, type UploadedItem } from '../cloud/OneDriveClient.ts'
import { OneDriveMirrorAdapter } from './OneDriveMirrorAdapter.ts'
import { MirrorPreconditionError, type MirrorEntry } from './types.ts'

function location(): DbFolder {
  return {
    id: 2,
    name: 'Backup',
    path: 'onedrive://drive/root',
    track_count: 0,
    date_added: '2026-01-01',
    date_updated: '2026-01-01',
    bookmark_data: null,
    provider: 'onedrive',
    role: 'backup',
    backup_source_folder_id: 1,
    account_id: 'account',
    drive_id: 'drive',
    item_id: 'root',
    remote_path: '/Music',
    delta_cursor: null,
    display_icon: null,
  }
}

function root(name = 'Music'): DriveItem {
  return { id: 'root', name, folder: { childCount: 2 }, parentReference: { driveId: 'drive', path: '/drive/root:' } }
}

function file(
  id: string,
  name: string,
  hash: string,
  etag: string,
  size = 6,
  parentPath = '/drive/root:/Music',
): DriveItem {
  return {
    id,
    name,
    size,
    eTag: etag,
    file: { hashes: { quickXorHash: hash } },
    parentReference: { driveId: 'drive', id: 'root', path: parentPath },
  }
}

test('OneDrive inventory includes empty directories and stable provider identities', async () => {
  const fake = {
    getItem: async () => root(),
    async *listDelta() {
      yield {
        items: [
          { id: 'empty', name: 'Empty', folder: { childCount: 0 }, parentReference: { path: '/drive/root:/Music' } },
          file('song', 'song.flac', 'quick', 'etag'),
        ],
        deltaLink: 'https://graph.microsoft.com/v1.0/delta-token',
        reset: false,
      }
    },
  }
  const adapter = new OneDriveMirrorAdapter(fake as unknown as OneDriveClient)
  const inventory = await adapter.inventory(location())
  assert.deepEqual(inventory.entries.map(entry => [entry.relativePath, entry.kind, entry.providerItemId]), [
    ['Empty', 'directory', 'empty'],
    ['song.flac', 'file', 'song'],
  ])
  assert.equal(inventory.entries[1].quickXorHash, 'quick')
  assert.equal(inventory.rootIdentity, 'onedrive:drive:root')
})

test('OneDrive inventory follows the live root path after a remote rename', async () => {
  const renamed = file('song', 'song.flac', 'quick', 'etag', 6, '/drive/root:/Renamed')
  const fake = {
    getItem: async () => root('Renamed'),
    async *listDelta() {
      yield { items: [renamed], deltaLink: 'https://graph.microsoft.com/v1.0/delta-token', reset: false }
    },
  }
  const inventory = await new OneDriveMirrorAdapter(fake as unknown as OneDriveClient).inventory(location())
  assert.deepEqual(inventory.entries.map(entry => entry.relativePath), ['song.flac'])
})

test('OneDrive inventory fails closed when Graph returns a live item outside the root', async () => {
  const outside = file('song', 'song.flac', 'quick', 'etag', 6, '/drive/root:/Elsewhere')
  const fake = {
    getItem: async () => root(),
    async *listDelta() {
      yield { items: [outside], deltaLink: 'https://graph.microsoft.com/v1.0/delta-token', reset: false }
    },
  }
  await assert.rejects(
    () => new OneDriveMirrorAdapter(fake as unknown as OneDriveClient).inventory(location()),
    /outside the configured root/i,
  )
})

test('OneDrive writes resume at the server offset with replace and If-Match', async () => {
  let uploaded = false
  let createOptions: Record<string, unknown> | null = null
  let resumedBytes: Uint8Array | null = null
  const old = file('song', 'song.flac', 'old-hash', 'old-etag')
  const fresh = file('song', 'song.flac', 'new-hash', 'new-etag')
  const fake = {
    getItem: async (_driveId: string, itemId: string) => itemId === 'root' ? root() : uploaded ? fresh : old,
    async *listDelta() {
      yield { items: [old], deltaLink: 'https://graph.microsoft.com/v1.0/delta-token', reset: false }
    },
    getUploadSession: async () => ({
      uploadUrl: 'https://uploads.example.test/session',
      expirationDateTime: null,
      nextExpectedRanges: ['3-'],
    }),
    createUploadSession: async (options: Record<string, unknown>) => {
      createOptions = options
      return { uploadUrl: 'https://uploads.example.test/new', expirationDateTime: null, nextExpectedRanges: ['0-'] }
    },
    uploadResumable: async (options: {
      startOffset: number
      readChunk(offset: number, length: number): Promise<Uint8Array>
      onProgress?(completed: number, total: number): void
    }): Promise<UploadedItem> => {
      assert.equal(options.startOffset, 3)
      resumedBytes = await options.readChunk(3, 3)
      options.onProgress?.(6, 6)
      uploaded = true
      return { id: 'song', name: 'song.flac', size: 6, etag: 'new-etag', quickXorHash: 'new-hash' }
    },
  }
  const adapter = new OneDriveMirrorAdapter(fake as unknown as OneDriveClient)
  const inventory = await adapter.inventory(location())
  const destinationBefore = inventory.entries[0]
  const expected: MirrorEntry = {
    relativePath: 'song.flac',
    kind: 'file',
    size: 6,
    modifiedAtMs: null,
    sha256: null,
    quickXorHash: 'new-hash',
    etag: null,
  }
  const progress: number[] = []
  const resumeStates: unknown[] = []
  const result = await adapter.writeFile({
    location: location(),
    relativePath: 'song.flac',
    source: (async function *() { yield Buffer.from('abcdef') })(),
    expectedSource: expected,
    destinationBefore,
    resumeState: { provider: 'onedrive', uploadUrl: 'https://uploads.example.test/session', expirationDateTime: null },
    onProgress: value => progress.push(value),
    onResumeState: value => resumeStates.push(value),
  })
  assert.equal(Buffer.from(resumedBytes!).toString(), 'def')
  assert.equal(createOptions, null, 'the valid persisted upload session should be reused')
  assert.deepEqual(progress, [3, 6])
  assert.deepEqual(resumeStates, [
    { provider: 'onedrive', uploadUrl: 'https://uploads.example.test/session', expirationDateTime: null },
    null,
  ])
  assert.equal(result.quickXorHash, 'new-hash')
})

test('OneDrive never recycles a directory that gained an unplanned child', async () => {
  let deleted = false
  const directory: DriveItem = {
    id: 'album',
    name: 'Album',
    eTag: 'etag-dir',
    folder: { childCount: 0 },
    parentReference: { path: '/drive/root:/Music' },
  }
  const fake = {
    getItem: async (_driveId: string, itemId: string) => itemId === 'root' ? root() : directory,
    async *listDelta() {
      yield { items: [directory], deltaLink: 'https://graph.microsoft.com/v1.0/delta-token', reset: false }
    },
    listChildren: async () => [file('late', 'late.flac', 'late', 'etag-late')],
    deleteItemToRecycleBin: async () => { deleted = true },
  }
  const adapter = new OneDriveMirrorAdapter(fake as unknown as OneDriveClient)
  const inventory = await adapter.inventory(location())
  await assert.rejects(
    adapter.deleteEntry({
      location: location(),
      relativePath: 'Album',
      kind: 'directory',
      destinationBefore: inventory.entries[0],
      recursive: true,
    }),
    MirrorPreconditionError,
  )
  assert.equal(deleted, false)
})

test('OneDrive refuses a planned source item that moved outside the root', async () => {
  let moved = false
  let downloaded = false
  const original = file('song', 'song.flac', 'quick', 'etag')
  const outside = file('song', 'song.flac', 'quick', 'etag', 6, '/drive/root:/Elsewhere')
  const fake = {
    getItem: async (_driveId: string, itemId: string) => itemId === 'root' ? root() : moved ? outside : original,
    async *listDelta() {
      yield { items: [original], deltaLink: 'https://graph.microsoft.com/v1.0/delta-token', reset: false }
    },
    async *downloadChunks() {
      downloaded = true
      yield Buffer.from('audio')
    },
  }
  const adapter = new OneDriveMirrorAdapter(fake as unknown as OneDriveClient)
  const entry = (await adapter.inventory(location())).entries[0]
  moved = true
  await assert.rejects(async () => {
    for await (const _chunk of adapter.readFile(location(), entry)) {
      // Consume the lazy source so all preconditions run.
    }
  }, MirrorPreconditionError)
  assert.equal(downloaded, false)
})

test('an ambiguous OneDrive DELETE 404 is idempotent only when no replacement exists', async () => {
  const original = file('song', 'song.flac', 'quick', 'etag')
  const replacement = file('replacement', 'song.flac', 'other', 'etag-new')
  let deleteAttempted = false
  const fake = {
    getItem: async (_driveId: string, itemId: string) => itemId === 'root' ? root() : original,
    async *listDelta() {
      yield { items: [original], deltaLink: 'https://graph.microsoft.com/v1.0/delta-token', reset: false }
    },
    listChildren: async () => deleteAttempted ? [replacement] : [original],
    deleteItemToRecycleBin: async () => {
      deleteAttempted = true
      throw new CloudHttpError(404, 'gone')
    },
  }
  const adapter = new OneDriveMirrorAdapter(fake as unknown as OneDriveClient)
  const planned = (await adapter.inventory(location())).entries[0]
  await assert.rejects(
    adapter.deleteEntry({
      location: location(),
      relativePath: 'song.flac',
      kind: 'file',
      destinationBefore: planned,
      recursive: false,
    }),
    MirrorPreconditionError,
  )
})
