import { test } from 'node:test'
import assert from 'node:assert/strict'

import { mergeLibraryStateBaseline } from './libraryStateBaseline.ts'

const track = (fingerprint, extra = {}) => ({ fingerprint, ...extra })

test('drops a track deleted from both sides (the reported bug: stays deleted)', () => {
  // User deleted the track from the PC, sync applied delete_device → gone on both
  // sides. The previous baseline still had it on both. It must NOT survive.
  const merged = mergeLibraryStateBaseline({
    currentPc: {},
    currentDevice: {},
    previousPc: { 'song.flac': track('fp1') },
    previousDevice: { 'song.flac': track('fp1') },
  })
  assert.deepEqual(merged.pc, {})
  assert.deepEqual(merged.device, {})
})

test('keeps previous baseline when a delete is still pending (deselected delete_device)', () => {
  // PC deleted it, but the device still has it (delete_device was deselected).
  // Out of sync → keep the previous "both present" baseline so delete_device is
  // re-proposed next sync, NOT reverted into a copy_device_to_pc.
  const merged = mergeLibraryStateBaseline({
    currentPc: {},
    currentDevice: { 'song.flac': track('fp1') },
    previousPc: { 'song.flac': track('fp1') },
    previousDevice: { 'song.flac': track('fp1') },
  })
  assert.deepEqual(merged.pc, { 'song.flac': track('fp1') })
  assert.deepEqual(merged.device, { 'song.flac': track('fp1') })
})

test('advances the baseline for a freshly synced in-sync track', () => {
  const merged = mergeLibraryStateBaseline({
    currentPc: { 'new.flac': track('fpNew') },
    currentDevice: { 'new.flac': track('fpNew') },
    previousPc: {},
    previousDevice: {},
  })
  assert.deepEqual(merged.pc, { 'new.flac': track('fpNew') })
  assert.deepEqual(merged.device, { 'new.flac': track('fpNew') })
})

test('records updated fingerprints after a replace', () => {
  const merged = mergeLibraryStateBaseline({
    currentPc: { 'song.flac': track('fp2') },
    currentDevice: { 'song.flac': track('fp2') },
    previousPc: { 'song.flac': track('fp1') },
    previousDevice: { 'song.flac': track('fp1') },
  })
  assert.equal(merged.pc['song.flac'].fingerprint, 'fp2')
  assert.equal(merged.device['song.flac'].fingerprint, 'fp2')
})

test('keeps previous baseline for an unresolved conflict (differing fingerprints)', () => {
  const merged = mergeLibraryStateBaseline({
    currentPc: { 'song.flac': track('fpPc') },
    currentDevice: { 'song.flac': track('fpDevice') },
    previousPc: { 'song.flac': track('fpBase') },
    previousDevice: { 'song.flac': track('fpBase') },
  })
  assert.equal(merged.pc['song.flac'].fingerprint, 'fpBase')
  assert.equal(merged.device['song.flac'].fingerprint, 'fpBase')
})

test('leaves a never-synced new-on-PC track out when its copy was deselected', () => {
  // PC has it, device does not, no previous baseline → still out of sync, nothing
  // to preserve. Next sync re-detects it as "New on PC".
  const merged = mergeLibraryStateBaseline({
    currentPc: { 'song.flac': track('fp1') },
    currentDevice: {},
    previousPc: {},
    previousDevice: {},
  })
  assert.deepEqual(merged.pc, {})
  assert.deepEqual(merged.device, {})
})

test('does not mutate the input maps', () => {
  const currentPc = { 'a.flac': track('fpA') }
  const previousPc = { 'b.flac': track('fpB') }
  mergeLibraryStateBaseline({
    currentPc,
    currentDevice: { 'a.flac': track('fpA') },
    previousPc,
    previousDevice: { 'b.flac': track('fpB') },
  })
  assert.deepEqual(Object.keys(currentPc), ['a.flac'])
  assert.deepEqual(Object.keys(previousPc), ['b.flac'])
})
