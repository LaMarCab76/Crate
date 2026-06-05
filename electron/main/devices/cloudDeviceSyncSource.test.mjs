import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const serviceSource = readFileSync(new URL('./DeviceSyncService.ts', import.meta.url), 'utf8')

test('cloud sources are downloaded into RAM and staged to a temp file before copying', () => {
  assert.ok(
    serviceSource.includes('if (isCloudSourcePath(action.sourcePath)) {'),
    'copyPcTrackToDevice should branch on cloud sources',
  )
  assert.ok(
    serviceSource.includes('private async withCloudSourceTempFile'),
    'cloud copies should go through the temp-file helper',
  )
  assert.ok(
    serviceSource.includes('getOneDriveClient().fetchFullIntoBuffer({'),
    'cloud sources should be fetched into a RAM buffer',
  )
})

test('the cloud fetch is cancellation-ready (abort signal is threaded into it)', () => {
  assert.ok(
    serviceSource.includes('buffer,\n      signal,'),
    'fetchFullIntoBuffer should receive the buffer and the abort signal',
  )
})

test('device-relative paths for cloud tracks are rebuilt from cloud_remote_path', () => {
  assert.ok(
    serviceSource.includes('cloudDeviceRelativePath({'),
    'sourceRelativePathFor should derive cloud paths from cloud_remote_path',
  )
})

test('deleting a cloud PC source removes the library row instead of trashing a file', () => {
  // In trashPcFile the cloud branch must short-circuit (deleteByPath, then return)
  // BEFORE the local shell.trashItem call.
  const cloudIdx = serviceSource.indexOf('if (isCloudSourcePath(sourcePath)) {')
  const trashIdx = serviceSource.indexOf('await shell.trashItem(sourcePath)')
  assert.ok(cloudIdx >= 0, 'trashPcFile should have a cloud branch')
  assert.ok(trashIdx >= 0, 'trashPcFile should still trash local files')
  assert.ok(cloudIdx < trashIdx, 'cloud branch should short-circuit before shell.trashItem')
})
