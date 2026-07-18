import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { OneDriveClient } from './OneDriveClient.ts'

function json(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

function client(fetchImpl, extras = {}) {
  return new OneDriveClient({
    getAccessToken: async () => 'token',
    fetch: fetchImpl,
    delay: async () => {},
    ...extras,
  })
}

test('retries one 401 with a force-refreshed token', async () => {
  const forceRefreshValues = []
  const authHeaders = []
  let calls = 0
  const graph = new OneDriveClient({
    getAccessToken: async forceRefresh => {
      forceRefreshValues.push(forceRefresh)
      return forceRefresh ? 'fresh' : 'stale'
    },
    fetch: async (_url, init) => {
      authHeaders.push(new Headers(init.headers).get('Authorization'))
      calls += 1
      return calls === 1 ? new Response(null, { status: 401 }) : json({ id: 'drive-1' })
    },
    delay: async () => {},
  })

  assert.equal(await graph.getDefaultDriveId(), 'drive-1')
  assert.deepEqual(forceRefreshValues, [false, true])
  assert.deepEqual(authHeaders, ['Bearer stale', 'Bearer fresh'])
})

test('paginates folder browsing and filters out files', async () => {
  const requested = []
  const graph = client(async url => {
    requested.push(String(url))
    if (requested.length === 1) {
      return json({
        value: [
          { id: 'folder-a', name: 'A', folder: { childCount: 1 } },
          { id: 'file-a', name: 'song.flac', file: { mimeType: 'audio/flac' } },
        ],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next-page',
      })
    }
    return json({ value: [{ id: 'folder-b', name: 'B', folder: { childCount: 0 } }] })
  })

  const folders = await graph.listChildFolders('drive', null)
  assert.deepEqual(folders.map(item => item.id), ['folder-a', 'folder-b'])
  assert.equal(requested.length, 2)
})

test('an expired delta cursor restarts a full inventory and marks reset', async () => {
  const requested = []
  const graph = client(async url => {
    requested.push(String(url))
    if (requested.length === 1) return new Response(null, { status: 410 })
    return json({
      value: [{ id: 'fresh-item', name: 'song.flac', file: { mimeType: 'audio/flac' } }],
      '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/new-delta',
    })
  })

  const pages = []
  for await (const page of graph.listDelta(
    'drive-1',
    'folder-1',
    'https://graph.microsoft.com/v1.0/old-delta',
  )) pages.push(page)

  assert.equal(pages.length, 1)
  assert.equal(pages[0].reset, true)
  assert.equal(pages[0].items[0].id, 'fresh-item')
  assert.match(requested[1], /\/drives\/drive-1\/items\/folder-1\/delta/)
})

test('a 410 during initial inventory is an error, never an empty library', async () => {
  const graph = client(async () => new Response(null, { status: 410 }))
  await assert.rejects(async () => {
    for await (const _page of graph.listDelta('drive', 'folder')) {
      // no-op
    }
  }, error => error.status === 410)
})

test('creates a replace upload session with If-Match and uploads resumable chunks', async () => {
  const requests = []
  const uploadUrl = 'https://uploads.example.test/session'
  const graph = client(async (url, init = {}) => {
    requests.push({ url: String(url), init })
    if (String(url).includes('createUploadSession')) {
      return json({ uploadUrl, expirationDateTime: '2030-01-01T00:00:00Z' })
    }
    const range = new Headers(init.headers).get('Content-Range')
    if (range.startsWith('bytes 0-')) return json({ nextExpectedRanges: ['10485760-'] }, { status: 202 })
    return json({
      id: 'uploaded',
      name: 'song.flac',
      size: 10 * 1024 * 1024 + 3,
      eTag: 'etag-new',
      file: { hashes: { quickXorHash: 'qx' } },
    }, { status: 201 })
  })

  const session = await graph.createUploadSession({
    driveId: 'drive',
    parentItemId: 'parent',
    itemId: 'existing-song',
    filename: 'song.flac',
    ifMatch: 'etag-old',
  })
  const create = requests[0]
  assert.match(create.url, /\/items\/existing-song\/createUploadSession/)
  assert.equal(new Headers(create.init.headers).get('If-Match'), 'etag-old')
  assert.equal(JSON.parse(create.init.body).item['@microsoft.graph.conflictBehavior'], 'replace')

  const size = 10 * 1024 * 1024 + 3
  const uploaded = await graph.uploadResumable({
    uploadUrl: session.uploadUrl,
    sizeBytes: size,
    readChunk: async (_offset, length) => new Uint8Array(length),
  })
  assert.equal(uploaded.id, 'uploaded')
  assert.equal(uploaded.quickXorHash, 'qx')
  assert.equal(requests.length, 3)
  assert.equal(new Headers(requests[1].init.headers).get('Content-Range'), `bytes 0-${10 * 1024 * 1024 - 1}/${size}`)
  assert.equal(new Headers(requests[2].init.headers).get('Content-Range'), `bytes ${10 * 1024 * 1024}-${size - 1}/${size}`)
})

test('uploads a small manifest with replace semantics and If-Match', async () => {
  let captured
  const graph = client(async (url, init) => {
    captured = { url: String(url), init }
    return json({ id: 'manifest', name: 'library.yaml', size: 3, eTag: 'new' }, { status: 201 })
  })
  const result = await graph.uploadBuffer({
    driveId: 'drive',
    parentItemId: 'folder',
    itemId: 'existing-manifest',
    filename: 'library.yaml',
    buffer: Buffer.from('abc'),
    ifMatch: 'old',
  })
  assert.equal(result.id, 'manifest')
  assert.match(captured.url, /\/items\/existing-manifest\/content/)
  assert.equal(captured.init.method, 'PUT')
  assert.equal(new Headers(captured.init.headers).get('If-Match'), 'old')
})

test('creates folders and deletes items through the recycle-bin API with preconditions', async () => {
  const requests = []
  const graph = client(async (url, init) => {
    requests.push({ url: String(url), init })
    if (init.method === 'POST') return json({ id: 'new-folder', name: 'Backup', folder: {} }, { status: 201 })
    return new Response(null, { status: 204 })
  })
  const folder = await graph.createFolder({
    driveId: 'drive',
    parentItemId: 'parent',
    name: 'Backup',
  })
  await graph.deleteItemToRecycleBin({ driveId: 'drive', itemId: folder.id, ifMatch: 'etag' })

  assert.equal(JSON.parse(requests[0].init.body)['@microsoft.graph.conflictBehavior'], 'fail')
  assert.equal(requests[1].init.method, 'DELETE')
  assert.equal(new Headers(requests[1].init.headers).get('If-Match'), 'etag')
})

test('fetches a bounded prefix and rejects a server that ignores Range', async () => {
  const bytes = Buffer.alloc(32, 7)
  const ranges = []
  const graph = client(async (url, init = {}) => {
    if (String(url).startsWith('https://graph.microsoft.com/')) {
      return json({
        id: 'item',
        size: bytes.length,
        '@microsoft.graph.downloadUrl': 'https://download.example.test/item',
      })
    }
    ranges.push(new Headers(init.headers).get('Range'))
    return new Response(bytes.subarray(0, 8), { status: 206 })
  })

  const prefix = await graph.fetchPrefix('drive', 'item', 8)
  assert.equal(prefix.buffer.length, 8)
  assert.deepEqual(ranges, ['bytes=0-7'])

  const unbounded = client(async (url, init = {}) => {
    if (String(url).startsWith('https://graph.microsoft.com/')) {
      return json({
        id: 'item',
        size: bytes.length,
        '@microsoft.graph.downloadUrl': 'https://download.example.test/item',
      })
    }
    return new Response(bytes, { status: 200 })
  })
  await assert.rejects(unbounded.fetchPrefix('drive', 'item', 8), /ignored the bounded prefix/)
})

test('streams downloads as bounded verified ranges', async () => {
  const size = 700_000
  const bytes = Uint8Array.from({ length: size }, (_value, index) => index % 251)
  const ranges = []
  const graph = client(async (url, init = {}) => {
    if (String(url).startsWith('https://graph.microsoft.com/')) {
      return json({
        id: 'item',
        size,
        '@microsoft.graph.downloadUrl': 'https://download.example.test/item',
      })
    }
    const range = new Headers(init.headers).get('Range')
    ranges.push(range)
    const match = /^bytes=(\d+)-(\d+)$/.exec(range)
    const start = Number(match[1])
    const end = Number(match[2])
    return new Response(bytes.slice(start, end + 1), { status: 206 })
  })

  const chunks = []
  for await (const chunk of graph.downloadChunks({
    driveId: 'drive',
    itemId: 'item',
    sizeBytes: size,
    chunkBytes: 320 * 1024,
  })) chunks.push(chunk)

  assert.deepEqual(ranges, [
    'bytes=0-327679',
    'bytes=327680-655359',
    'bytes=655360-699999',
  ])
  assert.equal(chunks.reduce((total, chunk) => total + chunk.byteLength, 0), size)
  assert.ok(chunks.every(chunk => chunk.byteLength <= 320 * 1024))
  assert.deepEqual(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))), Buffer.from(bytes))
})

test('queries a resumable session after an ambiguous server failure', async () => {
  const size = 10 * 1024 * 1024 + 3
  const uploadUrl = 'https://uploads.example.test/ambiguous'
  const reads = []
  let firstPut = true
  const graph = client(async (url, init = {}) => {
    if (init.method === 'GET' || init.method == null) {
      return json({ nextExpectedRanges: [`${10 * 1024 * 1024}-`] })
    }
    if (firstPut) {
      firstPut = false
      return new Response(null, { status: 503 })
    }
    return json({ id: 'done', name: 'song.flac', size, eTag: 'new' }, { status: 201 })
  })

  const result = await graph.uploadResumable({
    uploadUrl,
    sizeBytes: size,
    readChunk: async (offset, length) => {
      reads.push(offset)
      return new Uint8Array(length)
    },
  })
  assert.equal(result.id, 'done')
  assert.deepEqual(reads, [0, 10 * 1024 * 1024])
})

test('refuses an untrusted Graph pagination URL before sending a bearer token', async () => {
  let calls = 0
  const graph = client(async () => {
    calls += 1
    return json({
      value: [],
      '@odata.nextLink': 'https://attacker.example/collect',
    })
  })
  await assert.rejects(graph.listChildren('drive', null), /untrusted URL/)
  assert.equal(calls, 1)
})
