import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { MirrorEntry, MirrorInventory } from '../library-mirror/types.ts'
import { planLibraryMigration } from './planner.ts'

function file(relativePath: string, sha256: string, quickXorHash = `qx-${sha256}`): MirrorEntry {
  return {
    relativePath,
    kind: 'file',
    size: 10,
    modifiedAtMs: 1,
    sha256,
    quickXorHash,
    etag: null,
  }
}

function directory(relativePath: string): MirrorEntry {
  return { relativePath, kind: 'directory', size: 0, modifiedAtMs: 1, sha256: null, quickXorHash: null, etag: null }
}

function inventory(entries: MirrorEntry[]): MirrorInventory {
  return { rootIdentity: 'root', entries, warnings: [] }
}

test('migration planner deduplicates identical local files and deterministically renames different content', () => {
  const plan = planLibraryMigration({
    source: inventory([file('same.flac', 'same'), file('collision.flac', 'incoming')]),
    target: inventory([file('same.flac', 'same'), file('collision.flac', 'existing')]),
    sourceProvider: 'local',
    targetProvider: 'local',
    sourceName: 'Colección principal',
    mode: 'merge',
  })
  assert.deepEqual(plan.entries.map(entry => ({
    source: entry.sourceRelativePath,
    destination: entry.destinationRelativePath,
    conflict: entry.conflict,
    transfer: entry.needsTransfer,
  })), [
    { source: 'collision.flac', destination: 'collision (desde Colección principal).flac', conflict: 'renamed', transfer: true },
    { source: 'same.flac', destination: 'same.flac', conflict: 'identical', transfer: false },
  ])
})

test('directory collisions map their complete subtree to one renamed root', () => {
  const plan = planLibraryMigration({
    source: inventory([directory('Album'), file('Album/song.flac', 'song')]),
    target: inventory([file('Album', 'occupied')]),
    sourceProvider: 'local',
    targetProvider: 'local',
    sourceName: 'Local',
    mode: 'relocate',
  })
  assert.equal(plan.entries[0].destinationRelativePath, 'Album (desde Local)')
  assert.equal(plan.entries[1].destinationRelativePath, 'Album (desde Local)/song.flac')
})

test('merge excludes only the portable manifest so it can be regenerated after commit', () => {
  const plan = planLibraryMigration({
    source: inventory([directory('.crate'), file('.crate/library.yaml', 'manifest'), file('song.flac', 'song')]),
    target: inventory([]),
    sourceProvider: 'local',
    targetProvider: 'onedrive',
    sourceName: 'Local',
    mode: 'merge',
  })
  assert.deepEqual(plan.entries.map(entry => entry.sourceRelativePath), ['.crate', 'song.flac'])
})
