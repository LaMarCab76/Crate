import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { PathAuthorizationService } from './PathAuthorizationService.ts'

test('path tokens are scoped and each purpose is single-use', () => {
  const service = new PathAuthorizationService()
  const token = service.issue('/tmp/music', ['library:add', 'device:ignore'])

  assert.equal(service.resolve(token, 'library:add', { consume: true }), resolve('/tmp/music'))
  assert.throws(() => service.resolve(token, 'library:add'), /not valid/)
  assert.equal(service.resolve(token, 'device:ignore', { consume: true }), resolve('/tmp/music'))
  assert.throws(() => service.resolve(token, 'device:ignore'), /expired/)
})

test('path tokens reject a different purpose and invalid TTLs', () => {
  const service = new PathAuthorizationService()
  const token = service.issue('/tmp/device', ['device:connect'])
  assert.throws(() => service.resolve(token, 'library:add'), /not valid/)
  assert.throws(() => service.issue('/tmp/device', ['device:connect'], 0), /TTL/)
  assert.throws(() => service.issue('/tmp/device', ['device:connect'], 5 * 60 * 1000 + 1), /TTL/)
})

test('library location tokens are scoped separately from legacy add tokens', () => {
  const service = new PathAuthorizationService()
  const token = service.issue('/tmp/backup', ['library:location'])
  assert.throws(() => service.resolve(token, 'library:add'), /not valid/)
  assert.equal(service.resolve(token, 'library:location', { consume: true }), resolve('/tmp/backup'))
})
