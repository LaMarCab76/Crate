import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { planMirror } from './planner.ts'
import type { MirrorEntry, MirrorSnapshotEntry } from './types.ts'

function file(path: string, hash: string, size = 1): MirrorEntry {
  return { relativePath: path, kind: 'file', size, modifiedAtMs: 1, sha256: hash, quickXorHash: hash, etag: null }
}

function snapshot(entry: MirrorEntry): MirrorSnapshotEntry {
  return { ...entry, sourceEtag: null, destinationEtag: null }
}

test('first non-empty destination requires one batch approval', () => {
  const plan = planMirror({
    source: [file('album/song.flac', 'source')],
    destination: [file('old.flac', 'old')],
    snapshot: [],
    hasBaseline: false,
    sourceProvider: 'local',
    backupProvider: 'local',
  })
  assert.equal(plan.divergences.length, 1)
  assert.equal(plan.divergences[0].reason, 'initial_destination_not_empty')
  assert.deepEqual(plan.actions.map(action => action.kind), ['copy_file', 'delete_file'])
  assert.ok(plan.actions.every(action => action.requiresApproval))
})

test('source-only changes mirror automatically while destination changes diverge', () => {
  const previous = file('song.flac', 'old')
  const sourceChange = planMirror({
    source: [file('song.flac', 'new')],
    destination: [previous],
    snapshot: [snapshot(previous)],
    hasBaseline: true,
    sourceProvider: 'local',
    backupProvider: 'local',
  })
  assert.equal(sourceChange.divergences.length, 0)
  assert.deepEqual(sourceChange.actions.map(action => action.kind), ['copy_file'])

  const destinationChange = planMirror({
    source: [previous],
    destination: [file('song.flac', 'outside')],
    snapshot: [snapshot(previous)],
    hasBaseline: true,
    sourceProvider: 'local',
    backupProvider: 'local',
  })
  assert.equal(destinationChange.divergences[0].reason, 'destination_modified')
  assert.ok(destinationChange.actions.every(action => action.requiresApproval))
})

test('empty successful baseline detects later destination additions', () => {
  const plan = planMirror({
    source: [],
    destination: [file('outside.flac', 'outside')],
    snapshot: [],
    hasBaseline: true,
    sourceProvider: 'local',
    backupProvider: 'local',
  })
  assert.equal(plan.divergences[0].reason, 'destination_added')
  assert.equal(plan.actions[0].kind, 'delete_file')
})

test('directory-to-file replacement empties the subtree deepest-first before publishing', () => {
  const plan = planMirror({
    source: [file('Album', 'new-file')],
    destination: [
      { relativePath: 'Album', kind: 'directory', size: 0, modifiedAtMs: 1, sha256: null, quickXorHash: null, etag: null },
      { relativePath: 'Album/Disc', kind: 'directory', size: 0, modifiedAtMs: 1, sha256: null, quickXorHash: null, etag: null },
      file('Album/Disc/old.flac', 'old'),
    ],
    snapshot: [],
    hasBaseline: false,
    sourceProvider: 'local',
    backupProvider: 'local',
  })
  assert.deepEqual(plan.actions.map(action => [action.kind, action.relativePath, action.phase]), [
    ['delete_file', 'Album/Disc/old.flac', 0],
    ['delete_directory', 'Album/Disc', 0],
    ['delete_directory', 'Album', 0],
    ['copy_file', 'Album', 2],
  ])
})
