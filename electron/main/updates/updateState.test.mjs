import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  createInitialUpdateState,
  normalizeReleaseNotes,
  reduceUpdateState,
} from './updateState.ts'

test('unsupported update state disables every updater action', () => {
  const state = createInitialUpdateState('0.4.2', false, 'packaged only')

  assert.equal(state.status, 'unsupported')
  assert.equal(state.error, 'packaged only')
  assert.equal(state.canCheck, false)
  assert.equal(state.canDownload, false)
  assert.equal(state.canInstall, false)
})

test('available update exposes download action with release metadata', () => {
  const initial = createInitialUpdateState('0.4.2', true)
  const state = reduceUpdateState(initial, {
    type: 'available',
    now: 123,
    info: {
      version: '0.4.3',
      releaseName: 'Crate v0.4.3',
      releaseDate: '2026-05-31T12:00:00.000Z',
      releaseNotes: [{ version: '0.4.3', note: 'Updater panel' }],
    },
  })

  assert.equal(state.status, 'available')
  assert.equal(state.updateVersion, '0.4.3')
  assert.equal(state.releaseName, 'Crate v0.4.3')
  assert.equal(state.releaseNotes, '0.4.3\nUpdater panel')
  assert.equal(state.lastCheckedAt, 123)
  assert.equal(state.canCheck, true)
  assert.equal(state.canDownload, true)
  assert.equal(state.canInstall, false)
})

test('downloaded update exposes install action and completes progress', () => {
  const initial = createInitialUpdateState('0.4.2', true)
  const downloading = reduceUpdateState(initial, {
    type: 'downloading',
    progress: { percent: 42.4, transferred: 42, total: 100, bytesPerSecond: 10 },
  })
  const downloaded = reduceUpdateState(downloading, {
    type: 'downloaded',
    now: 456,
    info: { version: '0.4.3' },
  })

  assert.equal(downloading.status, 'downloading')
  assert.equal(downloading.canCheck, false)
  assert.equal(downloading.progress?.percent, 42.4)
  assert.equal(downloaded.status, 'downloaded')
  assert.equal(downloaded.progress?.percent, 100)
  assert.equal(downloaded.canDownload, false)
  assert.equal(downloaded.canInstall, true)
})

test('errors preserve a useful message and allow a retry', () => {
  const initial = createInitialUpdateState('0.4.2', true)
  const state = reduceUpdateState(initial, {
    type: 'error',
    now: 789,
    error: new Error('GitHub rate limit'),
  })

  assert.equal(state.status, 'error')
  assert.equal(state.error, 'GitHub rate limit')
  assert.equal(state.canCheck, true)
})

test('release notes normalize empty and structured updater values', () => {
  assert.equal(normalizeReleaseNotes('  '), null)
  assert.equal(normalizeReleaseNotes(null), null)
  assert.equal(
    normalizeReleaseNotes([
      { version: '0.4.3', note: 'Fixes' },
      { note: 'More polish' },
      {},
    ]),
    '0.4.3\nFixes\n\nMore polish',
  )
})
