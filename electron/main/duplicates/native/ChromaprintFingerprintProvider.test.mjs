import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  CHROMAPRINT_PROVIDER_VERSION,
  ChromaprintFingerprintProvider,
} from './ChromaprintFingerprintProvider.ts'
import {
  DefaultChromaprintSourceResolver,
  parseOneDriveFingerprintLocator,
} from './ChromaprintSourceResolver.ts'

function source(overrides = {}) {
  return {
    trackId: 7,
    provider: 'local',
    locator: '/music/song.flac',
    fileSize: 8,
    dateModified: null,
    etag: null,
    ...overrides,
  }
}

function available() {
  return { available: true, version: '1.6.0', path: '/native/libchromaprint' }
}

test('streams PCM into a session and always cleans up the resolved source', async () => {
  const events = []
  const session = {
    feed(samples) { events.push(`feed:${samples.length}`) },
    finish() {
      events.push('finish')
      return {
        algorithm: 1,
        sampleRate: 8_000,
        itemDurationSamples: 1_000,
        delaySamples: 2_000,
        values: Uint32Array.from([1, 2, 3]),
      }
    },
    close() { events.push('close') },
  }
  const provider = new ChromaprintFingerprintProvider(
    {
      async resolve() {
        events.push('resolve')
        return {
          localPath: '/tmp/cloud-song.flac',
          verifyUnchanged: async () => { events.push('verify') },
          cleanup: async () => { events.push('cleanup') },
        }
      },
    },
    {
      async decode(path, sink) {
        assert.equal(path, '/tmp/cloud-song.flac')
        sink.start({ sampleRate: 8_000, channels: 2 })
        sink.write(Int16Array.from([1, 2, 3, 4]))
        return {}
      },
    },
    { availability: available, createSession: () => session },
  )

  const fingerprint = await provider.fingerprint(source())
  assert.equal(provider.algorithm, 'chromaprint')
  assert.equal(provider.algorithmVersion, CHROMAPRINT_PROVIDER_VERSION)
  assert.equal(fingerprint.framesPerSecond, 8)
  assert.equal(fingerprint.delaySeconds, 0.25)
  assert.equal(fingerprint.durationSeconds, 4 / (8_000 * 2))
  assert.deepEqual([...fingerprint.frames], [1, 2, 3])
  assert.deepEqual(events, ['resolve', 'feed:4', 'verify', 'finish', 'close', 'cleanup'])
})

test('closes the session and removes the temp source after decode failure', async () => {
  const events = []
  const provider = new ChromaprintFingerprintProvider(
    {
      async resolve() {
        return { localPath: '/tmp/song', cleanup: async () => { events.push('cleanup') } }
      },
    },
    {
      async decode(_path, sink) {
        sink.start({ sampleRate: 44_100, channels: 2 })
        sink.write(Int16Array.from([1, 2]))
        throw new Error('decode failed')
      },
    },
    {
      availability: available,
      createSession: () => ({
        feed() {},
        finish() { throw new Error('not reached') },
        close() { events.push('close') },
      }),
    },
  )
  await assert.rejects(provider.fingerprint(source()), /decode failed/)
  assert.deepEqual(events, ['close', 'cleanup'])
})

test('does not resolve or download when Chromaprint is unavailable', async () => {
  let resolved = false
  const provider = new ChromaprintFingerprintProvider(
    { async resolve() { resolved = true; throw new Error('not reached') } },
    { async decode() { throw new Error('not reached') } },
    {
      availability: () => ({
        available: false,
        reason: 'missing_binary',
        detail: 'native binary missing',
        path: '/missing',
      }),
    },
  )
  await assert.rejects(provider.fingerprint(source()), /native binary missing/)
  assert.equal(resolved, false)
})

test('parses strict OneDrive locators without changing identifier case', () => {
  assert.deepEqual(
    parseOneDriveFingerprintLocator('onedrive://Drive-ABC/item%21123'),
    { driveId: 'Drive-ABC', itemId: 'item!123' },
  )
  assert.throws(() => parseOneDriveFingerprintLocator('onedrive://drive/folder/item'), /Invalid OneDrive/)
  assert.throws(() => parseOneDriveFingerprintLocator('onedrive://drive/item%2Fchild'), /item id/)
})

test('streams OneDrive chunks to a bounded temp file and verifies source identity', async t => {
  const root = await mkdtemp(join(tmpdir(), 'crate-duplicate-resolver-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const expectedItem = { id: 'item', name: '../Song.flac', size: 8, eTag: 'etag-1', file: {} }
  let itemReads = 0
  const client = {
    async getItem() {
      itemReads += 1
      return { ...expectedItem }
    },
    async *downloadChunks(options) {
      assert.equal(options.sizeBytes, 8)
      yield Uint8Array.from([1, 2, 3])
      yield Uint8Array.from([4, 5, 6, 7, 8])
    },
  }
  const resolver = new DefaultChromaprintSourceResolver({ client, tempRoot: root, maxTempBytes: 16 })
  const resolved = await resolver.resolve(source({
    provider: 'onedrive',
    locator: 'onedrive://drive/item',
    etag: 'etag-1',
  }))
  assert.equal(resolved.localPath.startsWith(root), true)
  assert.equal(resolved.localPath.endsWith('Song.flac'), true)
  assert.deepEqual([...await readFile(resolved.localPath)], [1, 2, 3, 4, 5, 6, 7, 8])
  await resolved.verifyUnchanged()
  assert.equal(itemReads, 2)
  await resolved.cleanup()
  await assert.rejects(access(resolved.localPath), error => error.code === 'ENOENT')
})

test('rejects oversized OneDrive files before creating a temporary directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'crate-duplicate-resolver-limit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const resolver = new DefaultChromaprintSourceResolver({
    tempRoot: root,
    maxTempBytes: 7,
    client: {
      async getItem() { return { id: 'item', name: 'song.flac', size: 8, eTag: 'etag' } },
      async *downloadChunks() { throw new Error('not reached') },
    },
  })
  await assert.rejects(resolver.resolve(source({
    provider: 'onedrive',
    locator: 'onedrive://drive/item',
    fileSize: 8,
    etag: 'etag',
  })), /temporary analysis limit/)
  assert.deepEqual(await import('node:fs/promises').then(fs => fs.readdir(root)), [])
})
