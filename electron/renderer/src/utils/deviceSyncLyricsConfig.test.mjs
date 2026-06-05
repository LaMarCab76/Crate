import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const syncSource = readFileSync(new URL('../views/DeviceSyncView.tsx', import.meta.url), 'utf8')

test('device sync settings do not expose or send the legacy fetchMissingLyrics flag', () => {
  assert.ok(
    syncSource.includes('Device Sync no copia ni descarga letras.'),
    'Device settings should tell users that MP3 sync does not propagate lyrics',
  )
  assert.ok(!syncSource.includes('setFetchMissingLyrics'), 'DeviceSyncView should not keep local state for the legacy flag')
  assert.ok(!syncSource.includes('selectedDevice?.fetchMissingLyrics'), 'DeviceSyncView should not treat the legacy flag as editable config')
  assert.ok(!syncSource.includes('fetchMissingLyrics,'), 'Device settings payload should not send fetchMissingLyrics')
  assert.ok(!syncSource.includes('fetchMissingLyrics ?'), 'Device config signature should not depend on fetchMissingLyrics')
})

test('device sync progress labels do not expose lyrics synchronization', () => {
  assert.ok(!syncSource.includes('fetching_lyrics'), 'DeviceSyncView should not expose a lyrics sync phase')
  assert.ok(!syncSource.includes('Sincronizando letras'), 'DeviceSyncView should not render a lyrics sync label')
})
