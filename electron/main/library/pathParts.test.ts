import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { sanitizePathPart } from './pathParts.ts'

test('path parts remove unsafe characters, trailing dots and Windows reserved names', () => {
  assert.equal(sanitizePathPart('  A/B:C*  ', 'fallback'), 'A B C')
  assert.equal(sanitizePathPart('CON', 'fallback'), '_CON')
  assert.equal(sanitizePathPart('lpt9.txt', 'fallback'), '_lpt9.txt')
  assert.equal(sanitizePathPart('... ', 'fallback'), 'fallback')
})

test('path parts are bounded to a safe length', () => {
  assert.equal(sanitizePathPart('x'.repeat(200), 'fallback').length, 80)
})
