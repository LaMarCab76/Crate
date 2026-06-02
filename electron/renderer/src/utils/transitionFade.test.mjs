import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { shouldApplyTransitionFade } from './transitionFade.ts'

const base = {
  status: 'playing',
  fadeOutMs: 1000,
  isAutomatic: false,
}

test('fades on a manual change while playing with crossfade configured', () => {
  assert.equal(shouldApplyTransitionFade(base), true)
})

test('never fades on an automatic advance, even while playing with crossfade configured', () => {
  assert.equal(shouldApplyTransitionFade({ ...base, isAutomatic: true }), false)
})

test('does not fade unless playback is actively playing', () => {
  assert.equal(shouldApplyTransitionFade({ ...base, status: 'paused' }), false)
  assert.equal(shouldApplyTransitionFade({ ...base, status: 'stopped' }), false)
  assert.equal(shouldApplyTransitionFade({ ...base, status: 'loading' }), false)
})

test('does not fade when crossfade is disabled or invalid', () => {
  assert.equal(shouldApplyTransitionFade({ ...base, fadeOutMs: 0 }), false)
  assert.equal(shouldApplyTransitionFade({ ...base, fadeOutMs: -1 }), false)
  assert.equal(shouldApplyTransitionFade({ ...base, fadeOutMs: NaN }), false)
})
