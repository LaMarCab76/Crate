import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  ACTIVITY_MAX_ITEMS,
  activityActionIdsFor,
  activityFromDownloadJob,
  activityFromAppUpdateState,
  activityFromUnknownVolume,
  activityProgress,
  hydrateActivityItems,
  primaryActivityActionIdFor,
  syncUnknownVolumeActivities,
  upsertActivityItem,
} from './activityCenterStore.ts'

function baseActivity(id, status = 'running', updatedAt = 1000) {
  return {
    id,
    category: 'devices',
    status,
    title: id,
    detail: null,
    progress: null,
    read: false,
    createdAt: updatedAt,
    updatedAt,
    metadata: {},
    actionIds: [],
  }
}

function downloadJob(status, overrides = {}) {
  return {
    id: 'job-1',
    provider: 'qobuz',
    providerTrackId: 'remote-1',
    status,
    quality: 'lossless',
    folderId: null,
    title: 'Track',
    artist: 'Artist',
    album: 'Album',
    artworkUrl: null,
    sourceUrl: null,
    path: null,
    error: null,
    bytesReceived: 25,
    bytesTotal: 100,
    createdAt: 100,
    updatedAt: 200,
    completedAt: null,
    ...overrides,
  }
}

test('upserts progress without duplicating an activity id', () => {
  const first = upsertActivityItem([], {
    id: 'device-sync:1',
    category: 'devices',
    status: 'running',
    title: 'Sync',
    progress: activityProgress(1, 10),
  }, 100)
  const second = upsertActivityItem(first, {
    id: 'device-sync:1',
    category: 'devices',
    status: 'running',
    title: 'Sync',
    progress: activityProgress(3, 10),
  }, 200)

  assert.equal(second.length, 1)
  assert.equal(second[0].progress.percent, 30)
  assert.equal(second[0].createdAt, 100)
  assert.equal(second[0].updatedAt, 200)
})

test('normalizes activity progress with a bounded percentage', () => {
  assert.deepEqual(activityProgress(14, 10), {
    completed: 10,
    total: 10,
    percent: 100,
    label: '10/10',
  })
  assert.equal(activityProgress(4, 0).percent, null)
})

test('maps download statuses to success, warning and error activity states', () => {
  assert.equal(activityFromDownloadJob(downloadJob('completed')).status, 'success')
  assert.equal(activityFromDownloadJob(downloadJob('unavailable')).status, 'warning')
  assert.equal(activityFromDownloadJob(downloadJob('failed', { error: 'boom' })).status, 'error')
})

test('ignores non-actionable update states that would create constant GitHub activity', () => {
  const base = {
    currentVersion: '0.4.2',
    updateVersion: null,
    releaseName: null,
    releaseDate: null,
    releaseNotes: null,
    progress: null,
    error: null,
    lastCheckedAt: null,
    canCheck: false,
    canDownload: false,
    canInstall: false,
  }

  assert.equal(activityFromAppUpdateState({ ...base, status: 'idle' }), null)
  assert.equal(activityFromAppUpdateState({ ...base, status: 'unsupported', error: 'GitHub Releases packaged only' }), null)
  assert.equal(activityFromAppUpdateState({ ...base, status: 'not-available', lastCheckedAt: 100 }), null)
  assert.equal(activityFromAppUpdateState({ ...base, status: 'checking' }).status, 'running')
  assert.equal(activityFromAppUpdateState({ ...base, status: 'available', updateVersion: '0.4.3' }).id, 'app-update')
})

test('hydrates active persisted activities as interrupted warnings', () => {
  const hydrated = hydrateActivityItems([
    baseActivity('running', 'running', 10),
    baseActivity('done', 'success', 20),
  ], 999)

  assert.equal(hydrated.find(item => item.id === 'running')?.status, 'warning')
  assert.equal(hydrated.find(item => item.id === 'running')?.read, false)
  assert.equal(hydrated.find(item => item.id === 'running')?.updatedAt, 999)
  assert.equal(hydrated.find(item => item.id === 'done')?.status, 'success')
})

test('drops persisted non-actionable update activities during hydration', () => {
  const hydrated = hydrateActivityItems([
    {
      ...baseActivity('app-update', 'warning', 10),
      category: 'updates',
      metadata: { activityKind: 'app-update', updateStatus: 'unsupported' },
      detail: 'Las actualizaciones desde GitHub Releases se activan en la app empaquetada.',
    },
    {
      ...baseActivity('real-update', 'info', 20),
      category: 'updates',
      metadata: { activityKind: 'app-update', updateStatus: 'available' },
    },
  ], 999)

  assert.equal(hydrated.some(item => item.id === 'app-update'), false)
  assert.equal(hydrated.some(item => item.id === 'real-update'), true)
})

test('prunes persisted activity history to the latest 100 entries', () => {
  const items = Array.from({ length: ACTIVITY_MAX_ITEMS + 5 }, (_, index) =>
    baseActivity(`item-${index}`, 'success', index),
  )

  const upserted = upsertActivityItem(items, {
    id: 'new',
    category: 'library',
    status: 'success',
    title: 'new',
  }, 1000)

  assert.equal(upserted.length, ACTIVITY_MAX_ITEMS)
  assert.equal(upserted[0].id, 'new')
  assert.equal(upserted.some(item => item.id === 'item-0'), false)
})

test('unknown volume activities expose classification actions and resolve when absent', () => {
  const volume = { rootPath: '/Volumes/DAP', name: 'DAP' }
  const withVolume = syncUnknownVolumeActivities([], [volume], 100)
  const item = withVolume[0]

  assert.deepEqual(activityActionIdsFor(item), ['connect-device', 'add-library', 'ignore-volume', 'open-libraries'])
  assert.equal(item.metadata.rootPath, '/Volumes/DAP')

  const resolved = syncUnknownVolumeActivities(withVolume, [], 200)
  assert.equal(resolved[0].status, 'success')
  assert.equal(resolved[0].detail, 'Volumen clasificado o desconectado.')
})

test('primary activity actions navigate to the matching app section', () => {
  const unknownVolume = upsertActivityItem([], activityFromUnknownVolume({ rootPath: '/Volumes/DAP', name: 'DAP' }), 100)[0]
  const download = upsertActivityItem([], activityFromDownloadJob(downloadJob('downloading')), 100)[0]
  const fallback = {
    ...baseActivity('custom', 'info', 100),
    category: 'library',
    actionIds: ['connect-device', 'open-import'],
  }

  assert.equal(primaryActivityActionIdFor(unknownVolume), 'open-libraries')
  assert.equal(primaryActivityActionIdFor(download), 'open-downloads')
  assert.equal(primaryActivityActionIdFor(fallback), 'open-import')
})

test('primary activity actions prefer contextual device and lyrics destinations', () => {
  assert.equal(primaryActivityActionIdFor({
    ...baseActivity('lyrics', 'running', 100),
    category: 'lyrics',
    metadata: { activityKind: 'lyrics-selection' },
  }), 'open-lyrics-settings')
  assert.equal(primaryActivityActionIdFor({
    ...baseActivity('sync', 'running', 100),
    category: 'devices',
    metadata: { activityKind: 'device-sync', deviceId: 'dev-1' },
  }), 'open-device-sync')
  assert.equal(primaryActivityActionIdFor({
    ...baseActivity('scan', 'running', 100),
    category: 'devices',
    metadata: { activityKind: 'device-scan', deviceId: 'dev-1' },
  }), 'open-device')
})

test('unknown volume adapter keeps action metadata stable', () => {
  const item = upsertActivityItem([], activityFromUnknownVolume({ rootPath: '/Volumes/New', name: 'New' }), 100)[0]

  assert.equal(item.category, 'devices')
  assert.equal(item.status, 'warning')
  assert.deepEqual(item.actionIds, ['connect-device', 'add-library', 'ignore-volume', 'open-libraries'])
})
