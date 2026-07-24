import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  ACTIVITY_MAX_ITEMS,
  activityActionIdsFor,
  activityFromDownloadJob,
  activityFromAppUpdateState,
  activityFromDuplicateProgress,
  activityFromDuplicateSummary,
  activityFromUnknownVolume,
  activityProgress,
  hydrateActivityItems,
  isActiveActivityStatus,
  primaryActivityActionIdFor,
  resolveDeviceArtworkOptimizationActivity,
  resolveDeviceSyncActivityDiscarded,
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

test('explicit null clears stale activity detail and progress', () => {
  const first = upsertActivityItem([], {
    id: 'duplicates:pending',
    category: 'duplicates',
    status: 'running',
    title: 'Analizando',
    detail: 'Track.flac',
    progress: activityProgress(121, 121),
  }, 100)
  const second = upsertActivityItem(first, {
    id: 'duplicates:pending',
    category: 'duplicates',
    status: 'error',
    title: 'No disponible',
    detail: null,
    progress: null,
  }, 200)

  assert.equal(second[0].detail, null)
  assert.equal(second[0].progress, null)
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

test('drops interrupted persisted artwork optimization activities during hydration', () => {
  const hydrated = hydrateActivityItems([
    {
      ...baseActivity('device-sync:artwork-1', 'warning', 10),
      title: 'Optimizando artwork',
      progress: activityProgress(44, 93),
      metadata: { activityKind: 'device-artwork-optimization', deviceId: 'dev-1', planId: 'artwork-1' },
    },
    {
      ...baseActivity('device-sync:artwork-2', 'warning', 20),
      title: 'Artwork optimizado',
      progress: activityProgress(93, 93),
      metadata: { activityKind: 'device-artwork-optimization', deviceId: 'dev-1', planId: 'artwork-2' },
    },
  ], 999)

  assert.equal(hydrated.some(item => item.id === 'device-sync:artwork-1'), false)
  assert.equal(hydrated.some(item => item.id === 'device-sync:artwork-2'), true)
})

test('discarded device sync activities stop counting as active work', () => {
  const runningSync = {
    ...baseActivity('device-sync:plan-1', 'running', 100),
    title: 'Sincronizando dispositivo',
    detail: 'Copiando',
    progress: activityProgress(2, 10),
    metadata: { activityKind: 'device-sync', deviceId: 'dev-1', planId: 'plan-1' },
    actionIds: ['open-device-sync'],
  }

  const resolved = resolveDeviceSyncActivityDiscarded([runningSync], 'plan-1', 200)
  const item = resolved[0]

  assert.equal(item.status, 'info')
  assert.equal(isActiveActivityStatus(item.status), false)
  assert.equal(item.title, 'Sync descartada')
  assert.equal(item.detail, 'Sync incompleta descartada.')
  assert.equal(item.progress, null)
  assert.equal(item.updatedAt, 200)
  assert.deepEqual(item.actionIds, ['open-device-sync'])
})

test('completed device artwork optimization activities stop showing as active work', () => {
  const runningArtwork = {
    ...baseActivity('device-sync:plan-artwork', 'running', 100),
    title: 'Optimizando artwork',
    detail: 'Track.flac',
    progress: activityProgress(44, 93),
    metadata: { activityKind: 'device-artwork-optimization', deviceId: 'dev-1', planId: 'plan-artwork' },
    actionIds: ['open-device-sync'],
  }

  const resolved = resolveDeviceArtworkOptimizationActivity(
    [runningArtwork],
    'dev-1',
    'plan-artwork',
    'success',
    'Se optimizaron 49 carátulas.',
    200,
  )
  const item = resolved[0]

  assert.equal(item.status, 'success')
  assert.equal(isActiveActivityStatus(item.status), false)
  assert.equal(item.title, 'Artwork optimizado')
  assert.equal(item.detail, 'Se optimizaron 49 carátulas.')
  assert.deepEqual(item.progress, activityProgress(93, 93))
  assert.equal(item.updatedAt, 200)
  assert.equal(item.metadata.activityKind, 'device-artwork-optimization')
  assert.equal(item.metadata.planId, 'plan-artwork')
})

test('failed device artwork optimization activities stop running and keep progress context', () => {
  const runningArtwork = {
    ...baseActivity('device-sync:plan-artwork', 'running', 100),
    title: 'Optimizando artwork',
    detail: 'Track.flac',
    progress: activityProgress(44, 93),
    metadata: { activityKind: 'device-artwork-optimization', deviceId: 'dev-1', planId: 'plan-artwork' },
    actionIds: ['open-device-sync'],
  }

  const resolved = resolveDeviceArtworkOptimizationActivity(
    [runningArtwork],
    'dev-1',
    'plan-artwork',
    'error',
    'No se pudo escribir el archivo.',
    200,
  )
  const item = resolved[0]

  assert.equal(item.status, 'error')
  assert.equal(isActiveActivityStatus(item.status), false)
  assert.equal(item.title, 'Artwork no optimizado')
  assert.equal(item.detail, 'No se pudo escribir el archivo.')
  assert.deepEqual(item.progress, activityProgress(44, 93))
  assert.equal(item.updatedAt, 200)
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

test('duplicate summary exposes one stable, actionable warning', () => {
  const item = activityFromDuplicateSummary({
    pendingCount: 3,
    analyzedCount: 30,
    queuedCount: 0,
    running: false,
    dismissedCount: 2,
    staleCount: 0,
    analyzingCount: 0,
    failedCount: 0,
    lastAnalyzedAt: null,
  })

  assert.equal(item.id, 'duplicates:pending')
  assert.equal(item.category, 'duplicates')
  assert.equal(item.status, 'warning')
  assert.deepEqual(item.actionIds, ['open-duplicates'])
  assert.equal(primaryActivityActionIdFor({
    ...baseActivity(item.id, item.status, 100),
    ...item,
    progress: item.progress ?? null,
    detail: item.detail ?? null,
    metadata: item.metadata ?? {},
    actionIds: item.actionIds ?? [],
  }), 'open-duplicates')
})

test('duplicate progress keeps the activity id stable and maps completion', () => {
  const progress = activityFromDuplicateProgress({
    phase: 'fingerprinting',
    completed: 4,
    total: 10,
    message: 'Track.flac',
  })
  const complete = activityFromDuplicateProgress({ phase: 'complete', completed: 10, total: 10 })

  assert.equal(progress.id, 'duplicates:pending')
  assert.equal(progress.status, 'running')
  assert.equal(progress.progress.percent, 40)
  assert.equal(complete.status, 'success')
})

test('duplicate native blocker is one explicit system error with no stale track count or progress', () => {
  const item = activityFromDuplicateSummary({
    pendingCount: 0,
    analyzedCount: 0,
    queuedCount: 0,
    running: false,
    dismissedCount: 0,
    staleCount: 0,
    analyzingCount: 0,
    failedCount: 0,
    lastAnalyzedAt: null,
    blocker: {
      code: 'native_component_missing',
      message: 'Falta Chromaprint 1.6.0. Las pistas no presentan errores.',
      retryable: false,
      requiresRestart: true,
      component: 'Chromaprint',
      version: '1.6.0',
    },
  })

  assert.equal(item.id, 'duplicates:pending')
  assert.equal(item.status, 'error')
  assert.equal(item.progress, null)
  assert.match(item.title, /componente/i)
  assert.match(item.detail, /Chromaprint 1\.6\.0/)
  assert.doesNotMatch(item.detail, /temas? requieren/i)

  const running = upsertActivityItem([], activityFromDuplicateProgress({
    phase: 'fingerprinting',
    completed: 121,
    total: 121,
  }), 100)
  const blocked = upsertActivityItem(running, item, 200)
  assert.equal(blocked[0].progress, null, 'blocked summary must clear the previous 121/121 bar')
})

test('disconnected duplicate root waits without disabling a same-process retry', () => {
  const blocker = {
    code: 'local_library_unavailable',
    message: 'La biblioteca “02 - Biblioteca” no está conectada. Volvé a analizar.',
    retryable: true,
    requiresRestart: false,
    affectedFolders: [{
      folderId: 7,
      name: '02 - Biblioteca',
      path: '/Volumes/H2-SD/02 - Biblioteca',
      state: 'unavailable',
    }],
  }
  const summaryItem = activityFromDuplicateSummary({
    pendingCount: 0,
    analyzedCount: 0,
    queuedCount: 0,
    running: false,
    dismissedCount: 0,
    staleCount: 0,
    analyzingCount: 0,
    failedCount: 0,
    lastAnalyzedAt: null,
    blocker,
  })
  const progressItem = activityFromDuplicateProgress({
    phase: 'error',
    completed: 0,
    total: 203,
    message: blocker.message,
    blocker,
  })

  assert.equal(summaryItem.status, 'waiting')
  assert.equal(summaryItem.title, 'Biblioteca desconectada')
  assert.equal(summaryItem.progress, null)
  assert.equal(progressItem.status, 'waiting')
  assert.equal(progressItem.progress, null)
})

test('duplicate error progress never renders a misleading zero progress bar', () => {
  const item = activityFromDuplicateProgress({
    phase: 'error',
    completed: 0,
    total: 0,
    message: 'Falta Chromaprint.',
  })
  assert.equal(item.status, 'error')
  assert.equal(item.progress, null)
  assert.match(item.title, /no disponible/i)
})

test('unknown volume adapter keeps action metadata stable', () => {
  const item = upsertActivityItem([], activityFromUnknownVolume({ rootPath: '/Volumes/New', name: 'New' }), 100)[0]

  assert.equal(item.category, 'devices')
  assert.equal(item.status, 'warning')
  assert.deepEqual(item.actionIds, ['connect-device', 'add-library', 'ignore-volume', 'open-libraries'])
})
