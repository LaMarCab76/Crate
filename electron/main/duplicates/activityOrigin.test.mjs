import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mergeDuplicateActivityOrigin } from './activityOrigin.ts'

test('startup activity visibility wins when duplicate work is coalesced', () => {
  assert.equal(mergeDuplicateActivityOrigin('background', 'background'), 'background')
  assert.equal(mergeDuplicateActivityOrigin('background', 'startup'), 'startup')
  assert.equal(mergeDuplicateActivityOrigin('startup', 'background'), 'startup')
  assert.equal(mergeDuplicateActivityOrigin('startup', 'startup'), 'startup')
})
