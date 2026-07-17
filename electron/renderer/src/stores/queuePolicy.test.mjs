import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { selectQueueNextIndex } from './queuePolicy.ts'

const tracks = ['a', 'b', 'c', 'd']
const base = { tracks, currentIndex: 1, repeat: 'off', shuffle: false, history: [], key: value => value }

test('linear repeat modes advance, stop, wrap and repeat one', () => {
  assert.equal(selectQueueNextIndex(base), 2)
  assert.equal(selectQueueNextIndex({ ...base, currentIndex: 3 }), null)
  assert.equal(selectQueueNextIndex({ ...base, currentIndex: 3, repeat: 'all' }), 0)
  assert.equal(selectQueueNextIndex({ ...base, repeat: 'one' }), 1)
})

test('shuffle selects an unvisited index without mutating the canonical queue', () => {
  const canonical = [...tracks]
  const next = selectQueueNextIndex({ ...base, shuffle: true, history: ['c'], random: () => 0.99 })
  assert.equal(next, 3)
  assert.deepEqual(tracks, canonical)
})

test('shuffle without repeat can continue to an earlier unvisited index', () => {
  const next = selectQueueNextIndex({
    ...base,
    currentIndex: 3,
    shuffle: true,
    history: ['b', 'c'],
    random: () => 0,
  })
  assert.equal(next, 0)
})

test('shuffle repeat-all resets after every other track is exhausted', () => {
  const next = selectQueueNextIndex({
    ...base,
    currentIndex: 3,
    repeat: 'all',
    shuffle: true,
    history: ['a', 'b', 'c'],
    random: () => 0,
  })
  assert.equal(next, 0)
})
