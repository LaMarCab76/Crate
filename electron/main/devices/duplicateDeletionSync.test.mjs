import assert from 'node:assert/strict'
import test from 'node:test'
import {
  duplicateDeletionVerificationTracks,
  encodeDuplicateDeletionFingerprint,
  reconcileDuplicateDeletionIntents,
} from './duplicateDeletionSync.ts'

const acousticDigest = 'a'.repeat(64)
const portableExpected = encodeDuplicateDeletionFingerprint('expected-metadata', acousticDigest)

const intent = (patch = {}) => ({
  id: 'intent-1',
  syncKey: 'artist/album/song.mp3',
  relativePath: 'Artist/Album/Song.mp3',
  expectedFingerprint: 'expected',
  ...patch,
})

test('a matching device copy becomes a reviewed duplicate deletion', () => {
  const [result] = reconcileDuplicateDeletionIntents(
    [intent()],
    [{ key: 'artist/album/song.mp3', relativePath: 'Artist/Album/Song.mp3', fingerprint: 'expected' }],
  )
  assert.equal(result.kind, 'delete')
})

test('a changed device copy stays as a conflict and is never deleted', () => {
  const [result] = reconcileDuplicateDeletionIntents(
    [intent()],
    [{ key: 'artist/album/song.mp3', relativePath: 'Artist/Album/Song.mp3', fingerprint: 'changed' }],
  )
  assert.equal(result.kind, 'conflict')
})

test('absence is settled only from the fresh scanned inventory', () => {
  const [result] = reconcileDuplicateDeletionIntents([intent()], [])
  assert.equal(result.kind, 'already_absent')
})

test('an intent never applies to a different key with identical audio metadata', () => {
  const [result] = reconcileDuplicateDeletionIntents(
    [intent()],
    [{ key: 'other-copy/song.mp3', relativePath: 'Other Copy/Song.mp3', fingerprint: 'expected' }],
  )
  assert.equal(result.kind, 'already_absent')
})

test('a changed key at the same device path remains a conflict instead of being copied back', () => {
  const [result] = reconcileDuplicateDeletionIntents(
    [intent()],
    [{ key: 'new-metadata-key', relativePath: 'artist/album/song.mp3', fingerprint: 'changed' }],
  )
  assert.equal(result.kind, 'conflict')
})

test('a renamed copy is found by metadata and deleted only after acoustic verification', () => {
  const renamed = {
    key: 'renamed/song.mp3',
    relativePath: 'Renamed/Song.mp3',
    fingerprint: 'expected-metadata',
    acousticDigest,
  }
  assert.deepEqual(
    duplicateDeletionVerificationTracks(
      [intent({ expectedFingerprint: portableExpected })],
      [renamed],
    ),
    [renamed],
  )
  const [result] = reconcileDuplicateDeletionIntents(
    [intent({ expectedFingerprint: portableExpected })],
    [renamed],
  )
  assert.equal(result.kind, 'delete')
  assert.equal(result.kind === 'delete' && result.device.key, 'renamed/song.mp3')
})

test('matching metadata is a conflict when the acoustic digest changed or is unavailable', () => {
  for (const changedDigest of ['b'.repeat(64), null]) {
    const [result] = reconcileDuplicateDeletionIntents(
      [intent({ expectedFingerprint: portableExpected })],
      [{
        key: 'renamed/song.mp3',
        relativePath: 'Renamed/Song.mp3',
        fingerprint: 'expected-metadata',
        acousticDigest: changedDigest,
      }],
    )
    assert.equal(result.kind, 'conflict')
  }
})

test('an exact path still requires the expected acoustic digest', () => {
  const [result] = reconcileDuplicateDeletionIntents(
    [intent({ expectedFingerprint: portableExpected })],
    [{
      key: 'artist/album/song.mp3',
      relativePath: 'Artist/Album/Song.mp3',
      fingerprint: 'expected-metadata',
      acousticDigest: 'c'.repeat(64),
    }],
  )
  assert.equal(result.kind, 'conflict')
})

test('a v2 intent is not settled absent until the acoustic inventory is complete', () => {
  const [pending] = reconcileDuplicateDeletionIntents(
    [intent({ expectedFingerprint: portableExpected })],
    [],
    { acousticInventoryComplete: false },
  )
  assert.equal(pending.kind, 'pending_absence')
  const [settled] = reconcileDuplicateDeletionIntents(
    [intent({ expectedFingerprint: portableExpected })],
    [],
    { acousticInventoryComplete: true },
  )
  assert.equal(settled.kind, 'already_absent')
})

test('a renamed and retagged copy is found acoustically among copy-back candidates', () => {
  const renamed = {
    key: 'new-tags/new-name.mp3',
    relativePath: 'New Tags/New Name.mp3',
    fingerprint: 'different-metadata',
    acousticDigest,
  }
  const selected = duplicateDeletionVerificationTracks(
    [intent({ expectedFingerprint: portableExpected })],
    [{ ...renamed, acousticDigest: undefined }],
    new Set([renamed.key]),
  )
  assert.equal(selected.length, 1)
  const [result] = reconcileDuplicateDeletionIntents(
    [intent({ expectedFingerprint: portableExpected })],
    [renamed],
    { acousticInventoryComplete: false },
  )
  assert.equal(result.kind, 'delete')
})
