import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('./DuplicateAuditionService.ts', import.meta.url), 'utf8')
const channel = await readFile(new URL('../ipc/duplicate-channel.ts', import.meta.url), 'utf8')
const preload = await readFile(new URL('../../preload/index.ts', import.meta.url), 'utf8')
const contract = await readFile(new URL('../../../shared/types/ipc-contract.ts', import.meta.url), 'utf8')
const store = await readFile(new URL('../../renderer/src/stores/duplicateStore.ts', import.meta.url), 'utf8')

test('OneDrive audition propagates a per-load AbortSignal and owns an isolated temp root', () => {
  assert.match(source, /controller:\s*new AbortController\(\)/)
  assert.match(source, /getItem\(facts\.driveId, facts\.itemId, signal\)/)
  assert.match(source, /downloadChunks\(\{[\s\S]*?signal,[\s\S]*?\}\)/)
  assert.match(source, /crate-duplicate-audition-\$\{session\.generation\}-/)
  assert.match(source, /!session\.transferred && session\.tempRoot/)
  assert.match(source, /rm\(session\.tempRoot, \{ recursive: true, force: true \}\)/)
})

test('opening, closing, and invalidating cancel in-flight materialization', () => {
  const calls = source.match(/await this\.cancelPendingLoad\(\)/g) ?? []
  assert.ok(calls.length >= 3)
  assert.match(source, /pending\.controller\.abort/)
  assert.match(source, /await pending\.settled/)
})

test('audition uses the UTF-16 BASS entry point and flag on Windows', () => {
  assert.match(source, /windowsUnicode \? bass\.StreamCreateFileUnicode : bass\.StreamCreateFile/)
  assert.match(source, /windowsUnicode \? BASS_UNICODE : 0/)
})

test('duplicate review begins one idempotent main-player session before listing candidates', () => {
  assert.match(
    source,
    /async beginSession\(\): Promise<DuplicateAuditionState> \{\s*const pendingClose = this\.mainSessionGate\.pendingClose\s*if \(pendingClose\) await pendingClose\s*if \(!this\.mainSnapshot\) \{\s*this\.mainSnapshot = captureMainPlayback/,
  )
  assert.match(
    source,
    /await this\.beginSession\(\)\s*const generation = \+\+this\.generation\s*await this\.cancelPendingLoad\(\)\s*if \(generation !== this\.generation\) throw abortError\(\)/,
  )
  assert.match(channel, /duplicates:audition:beginSession/)
  assert.match(preload, /beginSession: \(\) =>\s*ipcRenderer\.invoke\('duplicates:audition:beginSession'\)/)
  assert.match(contract, /beginSession\(\): Promise<DuplicateAuditionState>/)
  assert.match(
    store,
    /await window\.api\.duplicates\.audition\.beginSession\(\)\s*if \(generation !== viewGeneration \|\| !get\(\)\.active\) return\s*const \[summary, candidates\]/,
  )
})

test('only close clears and restores the main-player snapshot', () => {
  assert.match(
    source,
    /mainSessionGate\.runClose\(async \(\) => \{[\s\S]*?const snapshot = this\.mainSnapshot\s*await this\.releaseCandidate\(true\)\s*this\.mainSnapshot = null/,
  )
  assert.match(source, /restoreMainPlayback\(engine, snapshot, stillExists\)/)
  assert.match(source, /releaseCandidate\(false\)/)
})
