import { strict as assert } from 'node:assert'
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { DbFolder } from '../../../shared/types/db.ts'
import { LocalMirrorAdapter } from './LocalMirrorAdapter.ts'

function folder(id: number, path: string): DbFolder {
  const now = new Date().toISOString()
  return {
    id,
    name: `Folder ${id}`,
    path,
    track_count: 0,
    date_added: now,
    date_updated: now,
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

test('local adapter inventories full trees, includes portable state, and skips symlinks/temporary files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'crate-mirror-adapter-'))
  try {
    await mkdir(join(root, 'Album', 'Empty'), { recursive: true })
    await mkdir(join(root, '.crate'), { recursive: true })
    await writeFile(join(root, 'Album', 'song.flac'), 'audio')
    await writeFile(join(root, '.crate', 'library.yaml'), 'version: 1')
    await writeFile(join(root, '.DS_Store'), 'ignored')
    await writeFile(join(root, 'song.flac.part.job'), 'partial')
    await symlink(join(root, 'Album', 'song.flac'), join(root, 'linked.flac'))

    const inventory = await new LocalMirrorAdapter().inventory(folder(1, root))
    assert.deepEqual(inventory.entries.map(entry => entry.relativePath), [
      '.crate',
      '.crate/library.yaml',
      'Album',
      'Album/Empty',
      'Album/song.flac',
    ])
    assert.deepEqual(
      inventory.warnings.filter(warning => warning.code === 'symlink_skipped').map(warning => warning.relativePath),
      ['linked.flac'],
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('local adapter copies in chunks and verifies the written bytes', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'crate-mirror-source-'))
  const backupRoot = await mkdtemp(join(tmpdir(), 'crate-mirror-backup-'))
  try {
    await writeFile(join(sourceRoot, 'song.flac'), Buffer.alloc(2_500_000, 17))
    const adapter = new LocalMirrorAdapter()
    const sourceFolder = folder(1, sourceRoot)
    const backupFolder = folder(2, backupRoot)
    const entry = (await adapter.inventory(sourceFolder)).entries[0]
    let progress = 0
    await adapter.writeFile({
      location: backupFolder,
      relativePath: entry.relativePath,
      source: adapter.readFile(sourceFolder, entry),
      expectedSource: entry,
      destinationBefore: null,
      resumeState: null,
      onProgress: bytes => { progress = bytes },
    })
    assert.equal(progress, entry.size)
    assert.deepEqual(await readFile(join(backupRoot, 'song.flac')), await readFile(join(sourceRoot, 'song.flac')))
  } finally {
    await rm(sourceRoot, { recursive: true, force: true })
    await rm(backupRoot, { recursive: true, force: true })
  }
})

test('local adapter refuses to recursively delete a directory with a late foreign child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'crate-mirror-delete-guard-'))
  try {
    await mkdir(join(root, 'Album'))
    const adapter = new LocalMirrorAdapter()
    const destination = folder(2, root)
    const planned = (await adapter.inventory(destination)).entries[0]
    await writeFile(join(root, 'Album', 'late.flac'), 'foreign')
    await assert.rejects(adapter.deleteEntry({
      location: destination,
      relativePath: 'Album',
      kind: 'directory',
      destinationBefore: planned,
      recursive: true,
    }))
    await access(join(root, 'Album', 'late.flac'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('local adapter accepts already-published planned bytes after a journal crash', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'crate-mirror-idempotent-source-'))
  const backupRoot = await mkdtemp(join(tmpdir(), 'crate-mirror-idempotent-backup-'))
  try {
    await writeFile(join(sourceRoot, 'song.flac'), 'new bytes')
    await writeFile(join(backupRoot, 'song.flac'), 'old bytes')
    const adapter = new LocalMirrorAdapter()
    const source = folder(1, sourceRoot)
    const backup = folder(2, backupRoot)
    const expected = (await adapter.inventory(source)).entries[0]
    const previous = (await adapter.inventory(backup)).entries[0]
    // Simulate atomic publish succeeding immediately before the completed
    // action update was durably written.
    await writeFile(join(backupRoot, 'song.flac'), 'new bytes')
    let sourceRead = false
    const result = await adapter.writeFile({
      location: backup,
      relativePath: 'song.flac',
      source: (async function *() { sourceRead = true; yield Buffer.from('new bytes') })(),
      expectedSource: expected,
      destinationBefore: previous,
      resumeState: null,
    })
    assert.equal(result.sha256, expected.sha256)
    assert.equal(sourceRead, false)
  } finally {
    await rm(sourceRoot, { recursive: true, force: true })
    await rm(backupRoot, { recursive: true, force: true })
  }
})
