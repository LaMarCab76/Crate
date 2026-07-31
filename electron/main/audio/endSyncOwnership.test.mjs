import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { isActiveEndSyncRegistration } from './endSyncOwnership.ts'

test('accepts only the callback that owns the active end-sync registration', () => {
  const endedTrackRegistration = { channel: 1 }
  const selectedTrackRegistration = { channel: 2 }

  assert.equal(
    isActiveEndSyncRegistration(endedTrackRegistration, endedTrackRegistration),
    true,
  )
  assert.equal(
    isActiveEndSyncRegistration(selectedTrackRegistration, endedTrackRegistration),
    false,
  )
  assert.equal(isActiveEndSyncRegistration(null, endedTrackRegistration), false)
})

test('guards a stale callback before clearing the current track registration', () => {
  const source = readFileSync(new URL('./GaplessController.ts', import.meta.url), 'utf8')
  const handlerStart = source.indexOf('registration = registerEndSync')
  const handlerEnd = source.indexOf('\n    })', handlerStart)
  const handler = source.slice(handlerStart, handlerEnd)

  const guardIndex = handler.indexOf('isActiveEndSyncRegistration')
  const clearIndex = handler.indexOf('this.currentTrackEndRegistration = null')
  const broadcastIndex = handler.indexOf("broadcast('audio:track-ended')")

  assert.ok(guardIndex >= 0, 'the native callback must validate registration ownership')
  assert.ok(clearIndex > guardIndex, 'ownership must be checked before clearing the active registration')
  assert.ok(broadcastIndex > guardIndex, 'ownership must be checked before requesting queue advancement')
})
