import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const indexSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
const runtimeSource = readFileSync(new URL('./runtime.ts', import.meta.url), 'utf8')
const channelSource = readFileSync(new URL('../ipc/duplicate-channel.ts', import.meta.url), 'utf8')

test('only the app startup pass opts duplicate progress into activity notifications', () => {
  assert.match(indexSource, /scheduleAll\(\{\s*delayMs:\s*0,\s*activityOrigin:\s*'startup'\s*\}\)/)
  assert.doesNotMatch(channelSource, /activityOrigin:\s*'startup'/)
  assert.equal((runtimeSource.match(/activityOrigin:\s*'startup'/g) ?? []).length, 0)
  assert.match(runtimeSource, /queuedActivityOrigin\s*=\s*'background'/)
  assert.match(runtimeSource, /activityOrigin:\s*this\.activeActivityOrigin/)
})
