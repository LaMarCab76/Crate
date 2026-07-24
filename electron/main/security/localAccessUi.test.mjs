import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parse } from 'yaml'

const panelSource = readFileSync(
  new URL('../../renderer/src/components/LibraryLocationsPanel.tsx', import.meta.url),
  'utf8',
)
const storeSource = readFileSync(
  new URL('../../renderer/src/stores/libraryLocationsStore.ts', import.meta.url),
  'utf8',
)

test('library cards expose actionable macOS access states', () => {
  for (const label of ['Necesita acceso', 'Sin conexión', 'Solo lectura', 'Dar acceso']) {
    assert.ok(panelSource.includes(label), `missing local access UI label: ${label}`)
  }
  assert.ok(panelSource.includes("window.api.meta.platform !== 'macos'"))
  assert.ok(panelSource.includes('openFilePrivacySettings()'))
  assert.ok(panelSource.includes("window.addEventListener('focus', refreshAccessState)"))
  assert.ok(storeSource.includes('requestLocalAccess(folderId)'))
})

test('macOS packaging declares all protected folder descriptions without App Sandbox', () => {
  const config = parse(readFileSync(new URL('../../../electron-builder.yml', import.meta.url), 'utf8'))
  const privacy = config.mac?.extendInfo ?? {}
  for (const key of [
    'NSDesktopFolderUsageDescription',
    'NSDocumentsFolderUsageDescription',
    'NSDownloadsFolderUsageDescription',
    'NSNetworkVolumesUsageDescription',
    'NSRemovableVolumesUsageDescription',
  ]) {
    assert.equal(typeof privacy[key], 'string', `${key} must be present`)
    assert.ok(privacy[key].includes('leer y modificar'), `${key} must explain read/write access`)
  }

  const entitlements = readFileSync(
    new URL('../../../electron-build/entitlements.mac.plist', import.meta.url),
    'utf8',
  )
  assert.ok(!entitlements.includes('com.apple.security.app-sandbox'))
})
