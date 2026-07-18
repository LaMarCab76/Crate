import { strict as assert } from 'node:assert'
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { withCloudSourceTempFile } from './cloudSourceTempFile.ts'

async function missing(path) {
  await assert.rejects(access(path), error => error.code === 'ENOENT')
}

test('downloads to RAM, materializes a temp file, preserves mtime, and returns callback result', async t => {
  const root = await mkdtemp(join(tmpdir(), 'crate-cloud-temp-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bytes = Buffer.from('cloud audio bytes')
  const modified = '2025-02-03T04:05:06.000Z'
  let observedPath = ''
  const events = []

  const result = await withCloudSourceTempFile({
    sizeBytes: bytes.length,
    filename: '../unsafe.flac',
    dateModified: modified,
    tempRoot: root,
    downloadInto: async buffer => {
      events.push('download')
      bytes.copy(buffer)
    },
  }, async path => {
    events.push('callback')
    observedPath = path
    assert.equal(await readFile(path, 'utf8'), bytes.toString())
    assert.equal((await stat(path)).mtime.toISOString(), modified)
    assert.equal(path.includes(`${join(root, 'crate-device-cloud-')}`), true)
    assert.equal(path.endsWith('unsafe.flac'), true)
    return 42
  })

  assert.equal(result, 42)
  assert.deepEqual(events, ['download', 'callback'])
  await missing(observedPath)
})

test('removes the temp file and directory when the callback fails', async t => {
  const root = await mkdtemp(join(tmpdir(), 'crate-cloud-temp-error-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let observedPath = ''

  await assert.rejects(withCloudSourceTempFile({
    sizeBytes: 3,
    filename: 'track.flac',
    dateModified: null,
    tempRoot: root,
    downloadInto: async buffer => buffer.set(Buffer.from('abc')),
  }, async path => {
    observedPath = path
    assert.equal(await readFile(path, 'utf8'), 'abc')
    throw new Error('callback failed')
  }), /callback failed/)

  await missing(observedPath)
  await missing(join(observedPath, '..'))
})

test('does not create a temp directory when the download fails', async t => {
  const root = await mkdtemp(join(tmpdir(), 'crate-cloud-download-error-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let callbackCalled = false

  await assert.rejects(withCloudSourceTempFile({
    sizeBytes: 3,
    filename: 'track.flac',
    dateModified: null,
    tempRoot: root,
    downloadInto: async () => { throw new Error('download failed') },
  }, async () => {
    callbackCalled = true
  }), /download failed/)

  assert.equal(callbackCalled, false)
  assert.deepEqual(await import('node:fs/promises').then(fs => fs.readdir(root)), [])
})
