import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { HarCredentialExtractor } from './HarCredentialExtractor'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'crate-har-'))
}

function writeHar(dir: string, entries: unknown[], name = 'capture.har'): string {
  const path = join(dir, name)
  writeFileSync(path, JSON.stringify({ log: { entries } }))
  return path
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

test('extracts Qobuz credentials from query params', () => {
  const dir = tempDir()
  try {
    const path = writeHar(dir, [{
      request: {
        method: 'GET',
        url: 'https://www.qobuz.com/api.json/0.2/catalog/search?app_id=qz-app&app_secret=qz-secret&user_auth_token=qz-token',
      },
    }])

    const result = new HarCredentialExtractor().inspect('qobuz', [path])

    assert.equal(result.preview.provider, 'qobuz')
    assert.equal(result.preview.canApply, true)
    assert.deepEqual(result.preview.missingFields, [])
    assert.equal(result.payload.provider, 'qobuz')
    assert.equal(result.payload.appId, 'qz-app')
    assert.equal(result.payload.appSecret, 'qz-secret')
    assert.equal(result.payload.userAuthToken, 'qz-token')
  } finally {
    cleanup(dir)
  }
})

test('reports partial Qobuz credentials without failing', () => {
  const dir = tempDir()
  try {
    const path = writeHar(dir, [{
      request: {
        method: 'GET',
        url: 'https://play.qobuz.com/search?app_id=qz-app',
      },
    }])

    const result = new HarCredentialExtractor().inspect('qobuz', [path])

    assert.equal(result.preview.canApply, true)
    assert.deepEqual(result.preview.missingFields, ['appSecret', 'userAuthToken'])
    assert.equal(result.payload.provider, 'qobuz')
    assert.equal(result.payload.appId, 'qz-app')
    assert.equal(result.payload.appSecret, undefined)
  } finally {
    cleanup(dir)
  }
})

test('extracts TIDAL bearer token from request headers', () => {
  const dir = tempDir()
  try {
    const path = writeHar(dir, [{
      request: {
        method: 'GET',
        url: 'https://openapi.tidal.com/v2/searchResults/test/relationships/tracks',
        headers: [{ name: 'Authorization', value: 'Bearer tidal-access-token' }],
      },
    }])

    const result = new HarCredentialExtractor().inspect('tidal', [path])

    assert.equal(result.preview.provider, 'tidal')
    assert.equal(result.preview.canApply, true)
    assert.deepEqual(result.preview.missingFields, [])
    assert.equal(result.payload.provider, 'tidal')
    assert.equal(result.payload.accessToken, 'tidal-access-token')
  } finally {
    cleanup(dir)
  }
})

test('extracts TIDAL web token from request headers', () => {
  const dir = tempDir()
  try {
    const path = writeHar(dir, [{
      request: {
        method: 'GET',
        url: 'https://tidal.com/v1/country/context?countryCode=AR',
        headers: [{ name: 'X-Tidal-Token', value: 'tidal-web-token' }],
      },
    }])

    const result = new HarCredentialExtractor().inspect('tidal', [path])

    assert.equal(result.preview.provider, 'tidal')
    assert.equal(result.preview.canApply, true)
    assert.deepEqual(result.preview.missingFields, [])
    assert.equal(result.payload.provider, 'tidal')
    assert.equal(result.payload.webToken, 'tidal-web-token')
    assert.equal(result.payload.countryCode, 'AR')
  } finally {
    cleanup(dir)
  }
})

test('does not treat TIDAL media URL tokens as credentials', () => {
  const dir = tempDir()
  try {
    const path = writeHar(dir, [{
      request: {
        method: 'GET',
        url: 'https://sp-ad-fa.audio.tidal.com/mediatracks/example/0.mp4?token=media-delivery-token&info=segment',
      },
    }])

    const result = new HarCredentialExtractor().inspect('tidal', [path])

    assert.equal(result.preview.canApply, false)
    assert.equal(result.payload.provider, 'tidal')
    assert.equal(result.payload.webToken, undefined)
    assert.equal(result.payload.accessToken, undefined)
  } finally {
    cleanup(dir)
  }
})

test('extracts TIDAL OAuth response body', () => {
  const dir = tempDir()
  try {
    const path = writeHar(dir, [{
      request: {
        method: 'POST',
        url: 'https://auth.tidal.com/v1/oauth2/token',
      },
      response: {
        content: {
          mimeType: 'application/json',
          text: JSON.stringify({
            access_token: 'tidal-access-token',
            refresh_token: 'tidal-refresh-token',
            client_id: 'tidal-client',
            expires_in: 3600,
          }),
        },
      },
    }])

    const result = new HarCredentialExtractor().inspect('tidal', [path])

    assert.equal(result.preview.canApply, true)
    assert.equal(result.payload.provider, 'tidal')
    assert.equal(result.payload.clientId, 'tidal-client')
    assert.equal(result.payload.accessToken, 'tidal-access-token')
    assert.equal(result.payload.refreshToken, 'tidal-refresh-token')
    assert.equal(typeof result.payload.expiresAt, 'number')
  } finally {
    cleanup(dir)
  }
})

test('rejects invalid HAR input', () => {
  const dir = tempDir()
  try {
    const extractor = new HarCredentialExtractor()
    const txtPath = join(dir, 'capture.txt')
    const invalidJsonPath = join(dir, 'invalid.har')
    const invalidShapePath = join(dir, 'shape.har')
    const largePath = join(dir, 'large.har')

    writeFileSync(txtPath, '{}')
    writeFileSync(invalidJsonPath, '{')
    writeFileSync(invalidShapePath, JSON.stringify({ log: {} }))
    writeFileSync(largePath, Buffer.alloc(64 * 1024 * 1024 + 1))

    assert.throws(() => extractor.inspect('qobuz', [txtPath]), /Only \.har files/)
    assert.throws(() => extractor.inspect('qobuz', [invalidJsonPath]), /JSON could not be parsed/)
    assert.throws(() => extractor.inspect('qobuz', [invalidShapePath]), /missing log\.entries/)
    assert.throws(() => extractor.inspect('qobuz', [largePath]), /too large/)
  } finally {
    cleanup(dir)
  }
})

test('returns an unappliable preview when provider fields are absent', () => {
  const dir = tempDir()
  try {
    const path = writeHar(dir, [{
      request: {
        method: 'GET',
        url: 'https://example.test/search?query=album',
      },
    }])

    const result = new HarCredentialExtractor().inspect('qobuz', [path])

    assert.equal(result.preview.canApply, false)
    assert.deepEqual(result.preview.missingFields, ['appId', 'appSecret', 'userAuthToken'])
    assert.equal(result.payload.provider, 'qobuz')
    assert.equal(result.payload.appId, undefined)
  } finally {
    cleanup(dir)
  }
})
