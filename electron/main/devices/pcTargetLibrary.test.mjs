import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { requireRegisteredLocalLibraryPath } from './pcTargetLibrary.ts'

const folders = [
  { path: '/Music/Main', provider: 'local', role: 'library' },
  { path: '/Music/Backup', provider: 'local', role: 'backup' },
  { path: 'onedrive://drive/item', provider: 'onedrive', role: 'library' },
]

test('device PC target accepts only a registered local normal library', () => {
  assert.equal(requireRegisteredLocalLibraryPath('/Music/Main', folders), resolve('/Music/Main'))
  assert.throws(() => requireRegisteredLocalLibraryPath('/Music/Backup', folders), /registered local library/)
  assert.throws(() => requireRegisteredLocalLibraryPath('/Music/Other', folders), /registered local library/)
})

test('device PC target rejects OneDrive identities before treating them as paths', () => {
  assert.throws(
    () => requireRegisteredLocalLibraryPath('onedrive://drive/item', folders),
    /registered local library/,
  )
})

test('device sync revalidates persisted PC targets at connect, plan, apply and import boundaries', () => {
  const source = readFileSync(new URL('./DeviceSyncService.ts', import.meta.url), 'utf8')
  assert.match(source, /existingRootRow\?\.pc_target_path[\s\S]*?this\.registeredLibraryPath\(existingRootRow\.pc_target_path\)/)
  assert.match(source, /async planSync[\s\S]*?this\.registeredLibraryPath\(row\.pc_target_path\)/)
  assert.match(source, /async applySync[\s\S]*?pcTargetPath: this\.registeredLibraryPath\(plan\.pcTargetPath\)/)
  assert.match(source, /async importPcTarget[\s\S]*?const target = this\.registeredLibraryPath\(pcTargetPath\)/)
})
