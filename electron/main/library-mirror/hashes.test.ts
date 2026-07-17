import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { QuickXorHasher } from './hashes.ts'

test('QuickXorHash matches Microsoft layout for empty and one-byte inputs', () => {
  assert.equal(new QuickXorHasher().digest(), 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=')
  assert.equal(new QuickXorHasher().update(Buffer.from('a')).digest(), 'YQAAAAAAAAAAAAAAAQAAAAAAAAA=')
})

test('QuickXorHash is invariant across streaming chunk boundaries', () => {
  const bytes = Buffer.from(Array.from({ length: 1024 }, (_, index) => index % 251))
  const whole = new QuickXorHasher().update(bytes).digest()
  const chunked = new QuickXorHasher()
    .update(bytes.subarray(0, 13))
    .update(bytes.subarray(13, 700))
    .update(bytes.subarray(700))
    .digest()
  assert.equal(chunked, whole)
})
