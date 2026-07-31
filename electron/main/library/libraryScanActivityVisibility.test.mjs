import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('./LibraryReconciler.ts', import.meta.url), 'utf8')

test('reconciler progress identifies why every library scan is running', () => {
  const broadcasts = [...source.matchAll(
    /broadcast\('library:import:(?:progress|complete)',\s*\{(?<payload>[\s\S]*?)\}\)/g,
  )]

  assert.equal(broadcasts.length, 3)
  for (const broadcast of broadcasts) {
    assert.match(broadcast.groups.payload, /scanReason:\s*reason/)
  }
})
