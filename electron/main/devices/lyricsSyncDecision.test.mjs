import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { decideLyricsSync } from './lyricsSyncDecision.ts'

function state(patch = {}) {
  return {
    mode: 'pc_to_device',
    fetchEnabled: true,
    isMatched: true,
    pcHasLrc: false,
    deviceHasLrc: false,
    ...patch,
  }
}

test('push: PC has lyrics, device missing -> write device sidecar', () => {
  const d = decideLyricsSync(state({ pcHasLrc: true }))
  assert.deepEqual(d, { writeDeviceSidecar: true, importToPc: false, fetchOnline: false, skip: false })
})

test('push: neither side has lyrics -> fetch online (toggle on)', () => {
  const d = decideLyricsSync(state({ pcHasLrc: false }))
  assert.equal(d.fetchOnline, true)
  assert.equal(d.writeDeviceSidecar, false)
})

test('push: toggle off and nothing local -> skip (no online fetch)', () => {
  const d = decideLyricsSync(state({ fetchEnabled: false }))
  assert.deepEqual(d, { writeDeviceSidecar: false, importToPc: false, fetchOnline: false, skip: true })
})

test('push: PC already has lyrics -> never fetch online (file detected)', () => {
  const d = decideLyricsSync(state({ pcHasLrc: true, deviceHasLrc: true }))
  assert.equal(d.fetchOnline, false)
  assert.equal(d.skip, true)
})

test('push: pc-only (unmatched) with no content -> fetch online, no device write yet', () => {
  const d = decideLyricsSync(state({ isMatched: false }))
  assert.equal(d.fetchOnline, true)
  assert.equal(d.writeDeviceSidecar, false)
})

test('pull: device has lrc, PC empty -> import to PC', () => {
  const d = decideLyricsSync(state({ mode: 'device_to_pc', deviceHasLrc: true }))
  assert.deepEqual(d, { writeDeviceSidecar: false, importToPc: true, fetchOnline: false, skip: false })
})

test('pull: device has lrc but PC already has lyrics -> skip (do not clobber)', () => {
  const d = decideLyricsSync(state({ mode: 'device_to_pc', deviceHasLrc: true, pcHasLrc: true }))
  assert.equal(d.importToPc, false)
  assert.equal(d.skip, true)
})

test('pull: never fetches online even when both sides empty', () => {
  const d = decideLyricsSync(state({ mode: 'device_to_pc' }))
  assert.equal(d.fetchOnline, false)
  assert.equal(d.skip, true)
})

test('pull: PC has lyrics but device lacks -> skip (pull does not push to device)', () => {
  const d = decideLyricsSync(state({ mode: 'device_to_pc', pcHasLrc: true, deviceHasLrc: false }))
  assert.equal(d.writeDeviceSidecar, false)
  assert.equal(d.skip, true)
})

test('bidirectional: PC has lyrics, device missing -> write device sidecar', () => {
  const d = decideLyricsSync(state({ mode: 'bidirectional_safe', pcHasLrc: true }))
  assert.equal(d.writeDeviceSidecar, true)
})

test('bidirectional: device has lrc, PC empty -> import to PC', () => {
  const d = decideLyricsSync(state({ mode: 'bidirectional_safe', deviceHasLrc: true }))
  assert.equal(d.importToPc, true)
})

test('bidirectional: both sides already have lyrics -> skip (no clobber)', () => {
  const d = decideLyricsSync(state({ mode: 'bidirectional_safe', pcHasLrc: true, deviceHasLrc: true }))
  assert.deepEqual(d, { writeDeviceSidecar: false, importToPc: false, fetchOnline: false, skip: true })
})

test('bidirectional: neither side -> fetch online toward device', () => {
  const d = decideLyricsSync(state({ mode: 'bidirectional_safe' }))
  assert.equal(d.fetchOnline, true)
})
