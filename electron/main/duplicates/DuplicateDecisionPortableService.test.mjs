import assert from 'node:assert/strict'
import test from 'node:test'
import { stringify as stringifyYaml } from 'yaml'
import { parseDuplicateDecisionPortable } from './duplicateDecisionPortableFormat.ts'

const file = {
  version: 1,
  appName: 'Crate',
  updatedAt: '2026-07-22T00:00:00.000Z',
  bindings: {
    left: {
      relativePath: 'Artist/Album/01 Song.flac',
      algorithm: 'chromaprint',
      algorithmVersion: '1.6.0/default',
      acousticDigest: 'aaa',
    },
  },
  decisions: {
    'left:right': {
      id: 'decision',
      lowIdentityId: 'left',
      highIdentityId: 'right',
      lowAcousticDigest: 'aaa',
      highAcousticDigest: 'bbb',
      algorithm: 'chromaprint',
      algorithmVersion: '1.6.0/default',
      reason: 'versiones_distintas',
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    },
  },
}

test('portable duplicate decisions round-trip without absolute paths', () => {
  assert.deepEqual(parseDuplicateDecisionPortable(stringifyYaml(file)), file)
})

test('unsafe bindings are ignored without discarding valid decisions', () => {
  const parsed = parseDuplicateDecisionPortable(stringifyYaml({
    ...file,
    bindings: { left: { ...file.bindings.left, relativePath: '../outside.flac' } },
  }))
  assert.deepEqual(parsed?.bindings, {})
  assert.equal(parsed?.decisions['left:right']?.reason, 'versiones_distintas')
})

test('malformed and incompatible portable decision files are rejected', () => {
  assert.equal(parseDuplicateDecisionPortable('not: [yaml'), null)
  assert.equal(parseDuplicateDecisionPortable('version: 2\nbindings: {}\ndecisions: {}'), null)
})
