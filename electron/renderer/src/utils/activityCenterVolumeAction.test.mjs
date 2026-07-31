import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

test('activity center volume actions renew their short-lived authorization', () => {
  assert.match(appSource, /const currentUnknownVolume = async \(\) =>/)
  assert.match(appSource, /await refreshUnknownVolume\(rootPath\)/)
  assert.match(appSource, /await ignoreVolume\(volume\.token\)/)
  assert.doesNotMatch(appSource, /item\.metadata\.pathToken/)
})
