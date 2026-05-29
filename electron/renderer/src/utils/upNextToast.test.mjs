import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  normalizeUpNextToastWindow,
  shouldShowUpNextToast,
} from './upNextToast.ts'

test('normalizes the up-next toast timing window', () => {
  assert.deepEqual(normalizeUpNextToastWindow(45.9, 3.2), {
    upNextToastStartSec: 45,
    upNextToastEndSec: 3,
  })

  assert.deepEqual(normalizeUpNextToastWindow(2, 90), {
    upNextToastStartSec: 3,
    upNextToastEndSec: 2,
  })

  assert.deepEqual(normalizeUpNextToastWindow(240, -8), {
    upNextToastStartSec: 120,
    upNextToastEndSec: 0,
  })
})

test('shows the up-next toast only inside the configured remaining-time window', () => {
  const base = {
    enabled: true,
    hasTrack: true,
    hasUpNext: true,
    status: 'playing',
    durationSec: 180,
    startSec: 30,
    endSec: 4,
  }

  assert.equal(shouldShowUpNextToast({ ...base, remainingSec: 30 }), true)
  assert.equal(shouldShowUpNextToast({ ...base, remainingSec: 4 }), true)
  assert.equal(shouldShowUpNextToast({ ...base, remainingSec: 31 }), false)
  assert.equal(shouldShowUpNextToast({ ...base, remainingSec: 3 }), false)
})

test('does not show the up-next toast without playable context', () => {
  const base = {
    enabled: true,
    hasTrack: true,
    hasUpNext: true,
    status: 'playing',
    durationSec: 180,
    remainingSec: 20,
    startSec: 30,
    endSec: 1,
  }

  assert.equal(shouldShowUpNextToast({ ...base, enabled: false }), false)
  assert.equal(shouldShowUpNextToast({ ...base, hasTrack: false }), false)
  assert.equal(shouldShowUpNextToast({ ...base, hasUpNext: false }), false)
  assert.equal(shouldShowUpNextToast({ ...base, status: 'paused' }), false)
  assert.equal(shouldShowUpNextToast({ ...base, durationSec: 0 }), false)
  assert.equal(shouldShowUpNextToast({ ...base, remainingSec: 0 }), false)
})
