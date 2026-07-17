import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('./LibraryReconciler.ts', import.meta.url), 'utf8')

test('library reconciliation revalidates DB authority after collection and before orphan deletion', () => {
  assert.match(
    source,
    /const files = await collectAudioFiles\(folder\.path\)[\s\S]*?this\.requireCurrentFolder\(folder\)[\s\S]*?const filesOnDisk/,
  )
  assert.match(
    source,
    /const lrcFiles = await collectLrcFiles\(folder\.path\)[\s\S]*?this\.requireCurrentFolder\(folder\)[\s\S]*?unlinkSync\(lrc\)/,
  )
  assert.match(
    source,
    /const applyItem[\s\S]*?this\.requireCurrentFolder\(folder\)/,
  )
})
