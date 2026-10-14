import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { isLocalLibraryDestination } from './libraryDestinations.ts'

const syncSource = readFileSync(new URL('../views/DeviceSyncView.tsx', import.meta.url), 'utf8')
const connectSource = readFileSync(new URL('../components/DeviceConnectModal.tsx', import.meta.url), 'utf8')

test('only normal local libraries qualify as filesystem destinations', () => {
  assert.equal(isLocalLibraryDestination({ provider: 'local', role: 'library' }), true)
  assert.equal(isLocalLibraryDestination({ provider: 'local', role: 'backup' }), false)
  assert.equal(isLocalLibraryDestination({ provider: 'onedrive', role: 'library' }), false)
  assert.equal(isLocalLibraryDestination({ provider: 'onedrive', role: 'backup' }), false)
})

test('device destination selectors use the local-library guard', () => {
  assert.match(syncSource, /selectedSourceFolders\.filter\(isLocalLibraryDestination\)/)
  assert.match(connectSource, /folders\.filter\(isLocalLibraryDestination\)/)
})
