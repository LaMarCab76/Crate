import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  metadataParserOptions,
  shouldReadEmbeddedArtwork,
} from './MetadataExtractor.ts'

test('metadata reads embedded artwork by default', () => {
  assert.equal(shouldReadEmbeddedArtwork(), true)
  assert.deepEqual(metadataParserOptions(), {
    skipCovers: false,
    skipPostHeaders: false,
    includeChapters: false,
  })
})

test('metadata scan can skip embedded artwork without skipping local-file post headers', () => {
  assert.equal(shouldReadEmbeddedArtwork({ artwork: false }), false)
  assert.deepEqual(metadataParserOptions({ artwork: false }), {
    skipCovers: true,
    skipPostHeaders: false,
    includeChapters: false,
  })
})
