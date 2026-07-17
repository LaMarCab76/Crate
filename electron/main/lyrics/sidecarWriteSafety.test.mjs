import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { sidecarPathFor } from './providers/SidecarLrcProvider.ts'
import { removeSidecarLrc, writeSidecarLrc } from './writers/SidecarLrcWriter.ts'

test('sidecar writes are atomic and leave the complete new content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'crate-lyrics-write-'))
  const audio = join(root, 'song.flac')
  await writeFile(audio, 'audio')
  writeSidecarLrc(audio, 'old')
  writeSidecarLrc(audio, '[00:01.00]new')
  assert.equal(await readFile(sidecarPathFor(audio), 'utf8'), '[00:01.00]new')
})

test('sidecar save and remove propagate filesystem errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'crate-lyrics-write-'))
  const missingParentAudio = join(root, 'missing', 'song.flac')
  assert.throws(() => writeSidecarLrc(missingParentAudio, 'lyrics'), /ENOENT/)

  const audio = join(root, 'song.flac')
  await mkdir(sidecarPathFor(audio))
  assert.throws(() => removeSidecarLrc(audio))
})

test('lyrics service revalidates the current track and folder immediately before sidecar writes', () => {
  const source = readFileSync(new URL('./LyricsService.ts', import.meta.url), 'utf8')
  assert.match(
    source,
    /private writeSidecar[\s\S]*?const current = this\.requireCurrentWritableTrack\(track\)[\s\S]*?writeSidecarLrc\(current\.path, content\)/,
  )
  assert.match(
    source,
    /private requireCurrentWritableTrack[\s\S]*?this\.repos\.tracks\.getById\(expected\.id\)[\s\S]*?this\.repos\.folders\.getById\(current\.folder_id\)[\s\S]*?expectedPath: expected\.path/,
  )
})
