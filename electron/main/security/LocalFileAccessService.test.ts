import test from 'node:test'
import assert from 'node:assert/strict'
import { constants as fsConstants } from 'node:fs'
import {
  LocalFileAccessError,
  LocalFileAccessService,
  type LocalFileAccessDependencies,
} from './LocalFileAccessService.ts'

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code })
}

function fixture(overrides: Partial<LocalFileAccessDependencies> = {}) {
  let readable = true
  let writable = true
  let pickedPath = '/Volumes/Music'
  let canceled = false
  let operationCalls = 0
  const deps: LocalFileAccessDependencies = {
    access: async (_path, mode) => {
      if (mode === fsConstants.R_OK && !readable) throw codedError('EACCES')
      if (mode === fsConstants.W_OK && !writable) throw codedError('EACCES')
    },
    realpath: async path => path,
    isDirectory: async () => true,
    showOpenDirectory: async () => ({ canceled, filePath: canceled ? null : pickedPath }),
    openPrivacySettings: async () => undefined,
    ...overrides,
  }
  return {
    service: new LocalFileAccessService(deps, 'darwin'),
    setReadable(value: boolean) { readable = value },
    setWritable(value: boolean) { writable = value },
    setPickedPath(value: string) { pickedPath = value },
    setCanceled(value: boolean) { canceled = value },
    operation: async () => { operationCalls += 1; return 'ok' },
    operationCalls: () => operationCalls,
  }
}

test('classifies ready, unavailable, permission and read-only roots', async () => {
  const ready = fixture()
  assert.equal((await ready.service.inspect('/Volumes/Music')).state, 'ready')

  const unavailable = fixture({ isDirectory: async () => { throw codedError('ENOENT') } })
  assert.equal((await unavailable.service.inspect('/Volumes/Music')).state, 'unavailable')

  const denied = fixture()
  denied.setReadable(false)
  assert.deepEqual(await denied.service.inspect('/Volumes/Music'), {
    state: 'permission_required', canRead: false, canWrite: false,
    detail: 'Crate necesita autorización para leer y modificar esta ubicación.',
  })

  const readOnly = fixture({
    access: async (_path, mode) => { if (mode === fsConstants.W_OK) throw codedError('EROFS') },
  })
  assert.equal((await readOnly.service.inspect('/Volumes/Music')).state, 'read_only')
})

test('canceled authorization never runs the operation', async () => {
  const value = fixture()
  value.setWritable(false)
  value.setCanceled(true)
  await assert.rejects(
    value.service.runWithAccess('/Volumes/Music', 'write', value.operation),
    (error: unknown) => error instanceof LocalFileAccessError && /cancelado/.test(error.message),
  )
  assert.equal(value.operationCalls(), 0)
})

test('rejects a different folder without running the operation', async () => {
  const value = fixture()
  value.setWritable(false)
  value.setPickedPath('/Volumes/Other')
  await assert.rejects(
    value.service.runWithAccess('/Volumes/Music', 'write', value.operation),
    /exactamente la ubicación registrada/,
  )
  assert.equal(value.operationCalls(), 0)
})

test('granted access rechecks and runs a simple operation once', async () => {
  let calls = 0
  let writable = false
  const value = fixture({
    access: async (_path, mode) => {
      if (mode === fsConstants.W_OK && !writable) throw codedError('EACCES')
    },
    showOpenDirectory: async () => {
      writable = true
      return { canceled: false, filePath: '/Volumes/Music' }
    },
  })
  const result = await value.service.runWithAccess('/Volumes/Music', 'write', async () => {
    calls += 1
    return 'done'
  })
  assert.equal(result, 'done')
  assert.equal(calls, 1)
})

test('does not show a permission picker for an unavailable root', async () => {
  let pickerCalls = 0
  const value = fixture({
    isDirectory: async () => { throw codedError('ENOENT') },
    showOpenDirectory: async () => { pickerCalls += 1; return { canceled: false, filePath: '/Volumes/Music' } },
  })
  await assert.rejects(
    value.service.runWithAccess('/Volumes/Music', 'write', value.operation),
    (error: unknown) => error instanceof LocalFileAccessError && error.accessStatus.state === 'unavailable',
  )
  assert.equal(pickerCalls, 0)
})

test('retries once when access is revoked during a simple operation', async () => {
  let operationCalls = 0
  let pickerCalls = 0
  const value = fixture({
    showOpenDirectory: async () => {
      pickerCalls += 1
      return { canceled: false, filePath: '/Volumes/Music' }
    },
  })
  const result = await value.service.runWithAccess('/Volumes/Music', 'write', async () => {
    operationCalls += 1
    if (operationCalls === 1) throw codedError('EPERM')
    return 'recovered'
  })
  assert.equal(result, 'recovered')
  assert.equal(operationCalls, 2)
  assert.equal(pickerCalls, 1)
})

test('reports a read-only transition without opening a permission picker', async () => {
  let pickerCalls = 0
  const value = fixture({
    showOpenDirectory: async () => {
      pickerCalls += 1
      return { canceled: false, filePath: '/Volumes/Music' }
    },
  })
  await assert.rejects(
    value.service.runWithAccess('/Volumes/Music', 'write', async () => {
      throw codedError('EROFS')
    }),
    (error: unknown) => error instanceof LocalFileAccessError
      && error.accessStatus.state === 'read_only',
  )
  assert.equal(pickerCalls, 0)
})
