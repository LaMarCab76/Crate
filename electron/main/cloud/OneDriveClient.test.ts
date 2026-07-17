import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { OneDriveClient } from './OneDriveClient.ts'

test('OneDrive move publishes with PATCH, parentReference and If-Match', async () => {
  let observedUrl = ''
  let observedInit: RequestInit | undefined
  const client = new OneDriveClient({
    getAccessToken: async () => 'access-token',
    fetch: async (input, init) => {
      observedUrl = String(input)
      observedInit = init
      return new Response(JSON.stringify({
        id: 'staged-item',
        name: 'song.flac',
        eTag: 'etag-published',
        parentReference: { id: 'destination-parent', driveId: 'drive' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  })

  const moved = await client.moveItem({
    driveId: 'drive',
    itemId: 'staged-item',
    parentItemId: 'destination-parent',
    name: 'song.flac',
    ifMatch: 'etag-staged',
  })

  assert.match(observedUrl, /\/drives\/drive\/items\/staged-item$/)
  assert.equal(observedInit?.method, 'PATCH')
  const headers = new Headers(observedInit?.headers)
  assert.equal(headers.get('authorization'), 'Bearer access-token')
  assert.equal(headers.get('if-match'), 'etag-staged')
  assert.deepEqual(JSON.parse(String(observedInit?.body)), {
    name: 'song.flac',
    parentReference: { id: 'destination-parent' },
  })
  assert.equal(moved.eTag, 'etag-published')
})
