import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { probeKind } from './dirEntryKind.ts'

function probe({ dir = false, file = false, link = false } = {}) {
  return {
    isDirectory: () => dir,
    isFile: () => file,
    isSymbolicLink: () => link,
  }
}

test('classifies a normal directory, file and symlink', () => {
  assert.equal(probeKind(probe({ dir: true })), 'dir')
  assert.equal(probeKind(probe({ file: true })), 'file')
  assert.equal(probeKind(probe({ link: true })), 'link')
})

test('symlink wins over other flags (never followed)', () => {
  assert.equal(probeKind(probe({ link: true, file: true })), 'link')
})

test('a FAT/fskit Dirent with no known type is "unknown" (triggers stat fallback)', () => {
  assert.equal(probeKind(probe()), 'unknown')
})

test('the stat fallback result re-classifies an unknown entry', () => {
  // The walker stats the path when the Dirent is unknown; fs.Stats exposes the
  // same probes, so the resolved kind comes straight from probeKind.
  assert.equal(probeKind(probe({ dir: true })), 'dir')
  assert.equal(probeKind(probe({ file: true })), 'file')
})
