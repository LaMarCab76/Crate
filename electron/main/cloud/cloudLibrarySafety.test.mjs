import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const librarySource = readFileSync(new URL('./OneDriveLibraryService.ts', import.meta.url), 'utf8')
const manifestSource = readFileSync(new URL('./CloudManifestService.ts', import.meta.url), 'utf8')

test('cloud indexing and moves share the same per-folder serialization boundary', () => {
  assert.match(librarySource, /syncCloudFolder[\s\S]*?withFolderLock\(folderId, \(\) => this\.performSync/)
  assert.match(librarySource, /moveTrackToCloud[\s\S]*?withFolderLock\(targetFolderId/)
})

test('move commit revalidates DB authority and requires exactly one changed row', () => {
  assert.match(librarySource, /assertCloudMoveAuthority\([\s\S]*?const updateMove/)
  assert.match(librarySource, /WHERE id = \? AND provider = 'local' AND folder_id = \? AND path = \?/)
  assert.match(librarySource, /source\.provider = 'local' AND source\.role = 'library'/)
  assert.match(librarySource, /destination\.provider = 'onedrive'[\s\S]*?destination\.role = 'library'/)
  assert.match(librarySource, /if \(result\.changes !== 1\)/)
})

test('failed local disposal rolls back before recycling the uploaded item', () => {
  const disposalRecovery = librarySource.slice(
    librarySource.indexOf('await this.disposeLocalOriginal'),
    librarySource.indexOf('moveCommitted = true'),
  )
  assert.ok(disposalRecovery.indexOf('rollbackCloudMove') < disposalRecovery.indexOf('cleanupUploadedItem'))
  assert.doesNotMatch(
    librarySource.slice(
      librarySource.indexOf('private async disposeLocalOriginal'),
      librarySource.indexOf('private rollbackCloudMove'),
    ),
    /catch/,
  )
})

test('backup polling advances delta and schedules mirror comparison without indexing', () => {
  const poll = librarySource.slice(
    librarySource.indexOf('async pollBackupFolder'),
    librarySource.indexOf('private async refreshOneDriveRoot'),
  )
  assert.match(poll, /this\.client\.listDelta/)
  assert.match(poll, /UPDATE folders SET delta_cursor/)
  assert.match(poll, /scheduleMirrorForBackupDestination\(folderId, 'cloud_delta', 0\)/)
  assert.doesNotMatch(poll, /repos\.tracks|updateCloudTrack|cloudTrackInsert/)
})

test('manifest writes are cancellable, role-checked and skipped when state is unchanged', () => {
  assert.match(manifestSource, /async cancelAndWaitForFolder[\s\S]*?Promise\.allSettled/)
  assert.match(manifestSource, /writeControllers\.get\(folderId\)\?\.abort\(\)/)
  assert.match(manifestSource, /samePortableLibraryState\(existing, candidate\)/)
  assert.match(manifestSource, /!this\.cloudLibrary\(folderId\)[\s\S]*?uploadBuffer/)
  assert.match(manifestSource, /uploadBuffer\(\{[\s\S]*?signal,/)
})

test('poll resync only creates or upgrades a portable manifest', () => {
  assert.match(
    librarySource,
    /const manifest = await getCloudManifestService\(\)\.importManifest\(folderId\)[\s\S]*?manifest === 'missing' \|\| manifest === 'legacy'/,
  )
})
