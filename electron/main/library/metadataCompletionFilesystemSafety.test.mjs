import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('./MetadataCompletionService.ts', import.meta.url), 'utf8')

test('metadata completion revalidates current DB and folder authority immediately before writing', () => {
  assert.match(
    source,
    /const writableTrack = this\.repos\.tracks\.getById\(candidate\.trackId\)[\s\S]*?requireLocalLibraryTrackPath\(\{[\s\S]*?expectedPath: candidate\.path[\s\S]*?writeTrackMetadata\(writablePath/,
  )
  assert.doesNotMatch(source, /writeTrackMetadata\(track\.path, payload/)
})
