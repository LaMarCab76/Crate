import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { canRestoreQueueSnapshot, recoverEngineTrack } from './queueHydration.ts'

const first = { id: 'first', path: '/Music/first.flac' }
const active = { id: 'active', path: '/Music/canción-音.flac' }
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function harness() {
  const pending = deferred()
  const state = { token: 0, track: null, transitioning: false, reads: 0, adopted: [] }
  const recovery = {
    availableTracks: [first, active],
    readEngineStatus: () => { state.reads++; return pending.promise },
    currentTrack: () => state.track,
    transitionToken: () => state.token,
    isTransitioning: () => state.transitioning,
    adopt: track => { state.adopted.push(track); state.track = track },
  }
  return { state, recovery, pending }
}

test('renderer recovery adopts exact library metadata for the stream surviving reload', async () => {
  const { state, recovery, pending } = harness()
  const result = recoverEngineTrack(recovery)
  pending.resolve({ currentPath: active.path, status: 'playing', positionSec: 123, volume: 0.4 })
  assert.equal(await result, true)
  assert.equal(state.track, active)
  assert.deepEqual(state.adopted, [active])
  assert.equal(state.reads, 1)
  // The injected bridge offers only a status read and metadata adoption;
  // recovering a renderer cannot restart or seek the native stream.
})

test('a newer transition invalidates a status reply even if it already finished', async () => {
  const { state, recovery, pending } = harness()
  const result = recoverEngineTrack(recovery)
  state.token += 1
  state.transitioning = true
  state.transitioning = false
  pending.resolve({ currentPath: active.path, status: 'playing' })
  assert.equal(await result, false)
  assert.equal(state.track, null)
  assert.deepEqual(state.adopted, [])
})

test('a track adopted while IPC was pending remains authoritative', async () => {
  const { state, recovery, pending } = harness()
  const result = recoverEngineTrack(recovery)
  state.track = first
  pending.resolve({ currentPath: active.path, status: 'playing' })
  assert.equal(await result, false)
  assert.equal(state.track, first)
  assert.deepEqual(state.adopted, [])
})

test('recovery does not query an engine when identity exists or a transition is active', async () => {
  for (const existing of ['track', 'transition']) {
    const { state, recovery } = harness()
    if (existing === 'track') state.track = first
    else state.transitioning = true
    assert.equal(await recoverEngineTrack(recovery), false)
    assert.equal(state.reads, 0)
  }
})

test('a pending transition blocks adoption even when its token is unchanged', async () => {
  const { state, recovery, pending } = harness()
  const result = recoverEngineTrack(recovery)
  state.transitioning = true
  pending.resolve({ currentPath: active.path, status: 'playing' })
  assert.equal(await result, false)
  assert.deepEqual(state.adopted, [])
})

test('unknown paths, an empty engine and partially loaded streams do not invent a track', async () => {
  for (const status of [
    { currentPath: '/Music/not-in-library.flac', status: 'playing' },
    { currentPath: null, status: 'stopped' },
    { currentPath: active.path, status: 'loading' },
  ]) {
    const { state, recovery, pending } = harness()
    const result = recoverEngineTrack(recovery)
    pending.resolve(status)
    assert.equal(await result, false)
    assert.deepEqual(state.adopted, [])
  }
})

test('paused engine streams recover identity without changing their playback state', async () => {
  const { state, recovery, pending } = harness()
  const result = recoverEngineTrack(recovery)
  const status = Object.freeze({ currentPath: active.path, status: 'paused', positionSec: 27 })
  pending.resolve(status)
  assert.equal(await result, true)
  assert.equal(state.track, active)
  assert.equal(status.status, 'paused')
  assert.equal(status.positionSec, 27)
})

test('a failed engine read does not fabricate or replace a current track', async () => {
  const { state, recovery, pending } = harness()
  const result = recoverEngineTrack(recovery)
  pending.reject(new Error('engine unavailable'))
  await assert.rejects(result, /engine unavailable/)
  assert.deepEqual(state.adopted, [])
})

const initial = { tracks: [], currentIndex: -1, repeat: 'off', shuffle: false, isTrackTransitioning: false, transitionTarget: null }
test('an untouched initial queue can accept its persisted snapshot', () => {
  assert.equal(canRestoreQueueSnapshot(initial, initial, null, 2, 2), true)
})
test('a slow queue snapshot cannot overwrite edits, playback or an in-flight transition', () => {
  for (const current of [
    { ...initial, tracks: [first] },
    { ...initial, currentIndex: 0 },
    { ...initial, repeat: 'all' },
    { ...initial, shuffle: true },
    { ...initial, isTrackTransitioning: true },
    { ...initial, transitionTarget: first },
  ]) assert.equal(canRestoreQueueSnapshot(initial, current, null, 2, 2), false)
  assert.equal(canRestoreQueueSnapshot(initial, initial, first, 2, 2), false)
  assert.equal(canRestoreQueueSnapshot(initial, initial, null, 2, 3), false)
})
