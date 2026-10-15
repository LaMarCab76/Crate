import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readyInterfaceLibrary } from './interfaceReadiness.ts'

test('a cold guest query waits for the in-flight library and reads its new snapshot', async () => {
  let finish
  const loading = new Promise(resolve => { finish = resolve })
  let state = { loaded: false, error: null, tracks: [], refresh: () => loading }
  let resolved = false
  const query = readyInterfaceLibrary(() => state).then(value => { resolved = true; return value })
  await Promise.resolve()
  assert.equal(resolved, false)
  state = { ...state, loaded: true, tracks: [{ id: 'song' }] }
  finish()
  assert.deepEqual((await query).tracks, [{ id: 'song' }])
})

test('an already loaded library serves guest queries without refreshing or replacing it', async () => {
  const state = { loaded: true, error: null, tracks: [{ id: 'song' }], refresh: async () => { throw new Error('unnecessary load') } }
  assert.equal(await readyInterfaceLibrary(() => state), state)
})

test('an unavailable library reports its load error instead of a false empty result', async () => {
  let state = { loaded: false, error: null, refresh: async () => { state = { ...state, error: 'Database unavailable' } } }
  await assert.rejects(readyInterfaceLibrary(() => state), /Database unavailable/)
})

test('a rejected startup load remains a failed guest query', async () => {
  const state = { loaded: false, error: null, refresh: async () => { throw new Error('Source unavailable') } }
  await assert.rejects(readyInterfaceLibrary(() => state), /Source unavailable/)
})
