import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { restoreExclusivePlaybackSnapshot } from './exclusivePlaybackSnapshot.ts'

test('exclusive-mode restore keeps OneDrive playback on the cloud RAM path', async () => {
  const calls = []
  const engine = {
    async load(path, options) { calls.push(['load', path, options]) },
    setVolume(value) { calls.push(['volume', value]) },
    getCurrentStream() { return 17 },
    seek(value) { calls.push(['seek', value]) },
    play() { calls.push(['play']) },
  }

  await restoreExclusivePlaybackSnapshot(engine, {
    path: 'onedrive://drive/item',
    positionSec: 42,
    estimatedDurationSec: 180,
    wasPlaying: true,
    volume: 0.75,
    cloudRef: { driveId: 'drive', itemId: 'item' },
    cloudSizeBytes: 123456,
  }, stream => calls.push(['effects', stream]))

  assert.deepEqual(calls, [
    ['load', 'onedrive://drive/item', {
      estimatedDurationSec: 180,
      cloudRef: { driveId: 'drive', itemId: 'item' },
      cloudSizeBytes: 123456,
    }],
    ['volume', 0.75],
    ['effects', 17],
    ['seek', 42],
    ['play'],
  ])
})

test('exclusive-mode restore refuses a synthetic OneDrive path without cloud metadata', async () => {
  let loaded = false
  await assert.rejects(
    restoreExclusivePlaybackSnapshot({
      async load() { loaded = true },
      setVolume() {},
      getCurrentStream() { return 0 },
      seek() {},
      play() {},
    }, {
      path: 'onedrive://drive/item',
      positionSec: 0,
      estimatedDurationSec: null,
      wasPlaying: false,
      volume: 1,
      cloudRef: null,
      cloudSizeBytes: null,
    }, () => {}),
    /without its cloud reference and size/,
  )
  assert.equal(loaded, false)
})
