import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { isExpectedAuditionCancellation } from './duplicateAuditionErrors.ts'

const store = readFileSync(new URL('../stores/duplicateStore.ts', import.meta.url), 'utf8')

test('recognizes native and Electron-wrapped audition cancellations', () => {
  const native = new Error('Audición cancelada.')
  native.name = 'AbortError'
  assert.equal(isExpectedAuditionCancellation(native), true)

  assert.equal(
    isExpectedAuditionCancellation(
      new Error("Error invoking remote method 'duplicates:audition:open': AbortError: Audición cancelada."),
    ),
    true,
  )
  assert.equal(isExpectedAuditionCancellation(new Error('No se pudo abrir el archivo.')), false)
  assert.equal(isExpectedAuditionCancellation('AbortError: Audición cancelada.'), false)
})

test('resolution events do not race the explicit post-resolution refresh', () => {
  assert.match(
    store,
    /if \(useDuplicateStore\.getState\(\)\.resolving\) return/,
  )
  assert.match(
    store,
    /if \(state\.resolving\) return false[\s\S]{0,320}\+\+viewGeneration\s+useDuplicateStore\.setState\(\{[\s\S]{0,80}resolving: true/,
  )
  assert.match(store, /isExpectedAuditionCancellation\(error\)/)
})
