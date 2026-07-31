import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { findUnknownVolumeByRoot, mergeDeviceRecord, useDeviceStore } from './deviceStore.ts'

const deviceStoreSource = readFileSync(new URL('./deviceStore.ts', import.meta.url), 'utf8')

function device(id, trackCount) {
  return {
    id,
    name: id,
    rootPath: `/Volumes/${id}`,
    musicRoot: '.',
    defaultMode: 'bidirectional_safe',
    syncBase: 'review',
    pcTargetPath: `/Music/${id}`,
    artworkMaxEdge: 600,
    hasRockbox: true,
    isAvailable: true,
    trackCount,
    sourceLibraryIds: [],
    versions: {
      crateStateVersion: 1,
      machineStateVersion: 1,
      rockboxVersion: null,
      firmwareVersion: null,
    },
    portableState: {
      writable: true,
      error: null,
      lastCheckedAt: '2026-05-31T00:00:00.000Z',
    },
    lastSeenAt: '2026-05-31T00:00:00.000Z',
    lastScanAt: null,
    lastSyncAt: null,
  }
}

test('mergeDeviceRecord replaces stale track counts from a fresh DeviceRecord', () => {
  const merged = mergeDeviceRecord([device('dap', 12), device('other', 4)], device('dap', 18))

  assert.equal(merged.length, 2)
  assert.equal(merged.find(item => item.id === 'dap')?.trackCount, 18)
  assert.equal(merged.find(item => item.id === 'other')?.trackCount, 4)
})

test('mergeDeviceRecord prepends a newly seen device', () => {
  const merged = mergeDeviceRecord([device('old', 1)], device('new', 9))

  assert.deepEqual(merged.map(item => item.id), ['new', 'old'])
})

test('unknown volume actions resolve the freshly issued token by root', () => {
  const volumes = [
    { token: 'fresh-a', rootPath: '/Volumes/A', name: 'A' },
    { token: 'fresh-b', rootPath: '/Volumes/B', name: 'B' },
  ]

  assert.equal(findUnknownVolumeByRoot(volumes, '/Volumes/B')?.token, 'fresh-b')
  assert.equal(findUnknownVolumeByRoot(volumes, '/Volumes/Missing'), null)
  assert.ok(
    deviceStoreSource.includes('const snapshot = await window.api.devices.volumes()'),
    'activity volume actions should refresh their authorization before use',
  )
})

test('discardJournal resolves the matching activity center sync entry', () => {
  assert.ok(
    deviceStoreSource.includes('const discardedJournal = get().pendingJournals.find(journal => journal.id === journalId) ?? null'),
    'discardJournal should capture the pending journal before it is removed',
  )
  assert.ok(
    deviceStoreSource.includes('state.syncProgress?.planId === discardedJournal.planId'),
    'discardJournal should clear stale sync progress for the discarded plan',
  )
})

test('optimizeArtwork resolves the matching activity center artwork entry', () => {
  assert.ok(
    deviceStoreSource.includes("import type { ActivityStatus } from './activityCenterStore'"),
    'deviceStore should be able to resolve activity center artwork entries',
  )
  assert.ok(
    deviceStoreSource.includes("const { useActivityCenterStore } = await import('./activityCenterStore')"),
    'deviceStore should load the activity store lazily so Node tests can import the store',
  )
  assert.ok(
    deviceStoreSource.includes('const artworkPlanId = activeArtworkOptimizationPlan(get().syncProgress, id)'),
    'optimizeArtwork should capture the active artwork progress plan before clearing syncProgress',
  )
  assert.ok(
    deviceStoreSource.includes("result.failed > 0 ? 'warning' : 'success'"),
    'optimizeArtwork should resolve completed artwork work as success or warning',
  )
  assert.ok(
    deviceStoreSource.includes("resolveArtworkOptimizationActivity(id, artworkPlanId, 'error', (err as Error).message)"),
    'optimizeArtwork failures should stop the running artwork activity',
  )
})

test('device connect returns before the background library refresh completes', () => {
  assert.ok(
    deviceStoreSource.includes("const [devices, pendingJournals] = await Promise.all(["),
    'connect should only wait for device list and pending journals',
  )
  assert.ok(
    deviceStoreSource.includes(".loadDeviceLibrary(device.id, { force: true, background: true, progress: true })"),
    'connect should kick off a background library refresh with device scan progress',
  )
  assert.ok(
    !deviceStoreSource.includes('window.api.devices.library(device.id).catch(() => null)'),
    'connect should not block on devices.library after registering the device',
  )
})

test('manual device scan uses one library call instead of scan plus library', () => {
  assert.ok(
    deviceStoreSource.includes("const library = await window.api.devices.library(id, { progress: true })"),
    'manual scan should request a single library refresh with progress',
  )
  assert.ok(
    deviceStoreSource.includes('const scanResult = scanResultFromLibrary(library)'),
    'manual scan should derive the scan result from the library payload',
  )
  assert.ok(
    !deviceStoreSource.includes('const scanResult = await window.api.devices.scan(id)'),
    'manual scan should not call devices.scan and then fetch devices.library',
  )
})

test('planSync passes fullSync into the renderer API payload', () => {
  assert.ok(
    deviceStoreSource.includes('planSync: async (mode, pcTargetPath, fullSync) => {'),
    'store planSync signature should accept fullSync as third argument',
  )
  assert.ok(
    deviceStoreSource.includes('fullSync,'),
    'store should include fullSync in planSync payload',
  )
  assert.ok(
    deviceStoreSource.includes("const requestVersion = beginDeviceRequest('plan', deviceId)"),
    'each plan calculation should receive a monotonic request version',
  )
  assert.ok(
    deviceStoreSource.includes("!isCurrentDeviceRequest('plan', deviceId, requestVersion) || get().selectedDeviceId !== deviceId"),
    'a stale plan response must not replace the latest selected-device plan',
  )
  assert.ok(
    deviceStoreSource.includes("if (deviceId) beginDeviceRequest('plan', deviceId)"),
    'clearing a plan should invalidate any calculation still in flight',
  )
})

test('only the newest overlapping plan calculation updates the store', async () => {
  const pending = []
  globalThis.window = {
    api: {
      devices: {
        planSync: payload => new Promise(resolve => pending.push({ payload, resolve })),
      },
    },
  }
  useDeviceStore.setState({ selectedDeviceId: 'dap', plan: null, loading: false, error: null })

  try {
    const first = useDeviceStore.getState().planSync('bidirectional_safe', '/Music', false)
    const second = useDeviceStore.getState().planSync('bidirectional_safe', '/Music', true)
    assert.equal(pending.length, 2)

    pending[1].resolve({ id: 'newest', deviceId: 'dap', actions: [] })
    await second
    pending[0].resolve({ id: 'stale', deviceId: 'dap', actions: [] })
    await first

    assert.equal(useDeviceStore.getState().plan?.id, 'newest')
    assert.equal(useDeviceStore.getState().loading, false)
    assert.equal(pending[1].payload.fullSync, true)
  } finally {
    delete globalThis.window
    useDeviceStore.setState({ selectedDeviceId: null, plan: null, loading: false, error: null })
  }
})

test('clearing an in-flight plan ignores its response and releases loading', async () => {
  let resolvePlan
  globalThis.window = {
    api: {
      devices: {
        planSync: () => new Promise(resolve => { resolvePlan = resolve }),
      },
    },
  }
  useDeviceStore.setState({ selectedDeviceId: 'dap', plan: null, loading: false, error: null })

  try {
    const pendingPlan = useDeviceStore.getState().planSync('bidirectional_safe', '/Music', false)
    assert.equal(useDeviceStore.getState().loading, true)
    useDeviceStore.getState().clearPlan()
    assert.equal(useDeviceStore.getState().loading, false)

    resolvePlan({ id: 'late', deviceId: 'dap', actions: [] })
    await pendingPlan
    assert.equal(useDeviceStore.getState().plan, null)
    assert.equal(useDeviceStore.getState().loading, false)
  } finally {
    delete globalThis.window
    useDeviceStore.setState({ selectedDeviceId: null, plan: null, loading: false, error: null })
  }
})

test('switching A to B and back invalidates the original A plan request', async () => {
  let resolvePlan
  globalThis.window = {
    api: {
      devices: {
        planSync: () => new Promise(resolve => { resolvePlan = resolve }),
      },
    },
  }
  useDeviceStore.setState({ selectedDeviceId: 'a', plan: null, loading: false, error: null })

  try {
    const staleA = useDeviceStore.getState().planSync('bidirectional_safe', '/Music/A', false)
    useDeviceStore.getState().selectDevice('b')
    useDeviceStore.getState().selectDevice('a')
    resolvePlan({ id: 'stale-a', deviceId: 'a', actions: [] })
    await staleA

    assert.equal(useDeviceStore.getState().selectedDeviceId, 'a')
    assert.equal(useDeviceStore.getState().plan, null)
    assert.equal(useDeviceStore.getState().loading, false)
  } finally {
    delete globalThis.window
    useDeviceStore.setState({ selectedDeviceId: null, plan: null, loading: false, error: null })
  }
})

test('a stale plan rejection cannot overwrite a newer successful plan', async () => {
  const pending = []
  globalThis.window = {
    api: {
      devices: {
        planSync: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
      },
    },
  }
  useDeviceStore.setState({ selectedDeviceId: 'dap', plan: null, loading: false, error: null })

  try {
    const stale = useDeviceStore.getState().planSync('bidirectional_safe', '/Music', false)
    const latest = useDeviceStore.getState().planSync('bidirectional_safe', '/Music', true)
    pending[1].resolve({ id: 'latest', deviceId: 'dap', actions: [] })
    await latest
    pending[0].reject(new Error('stale failure'))
    await assert.rejects(stale, /stale failure/)

    assert.equal(useDeviceStore.getState().plan?.id, 'latest')
    assert.equal(useDeviceStore.getState().loading, false)
    assert.equal(useDeviceStore.getState().error, null)
  } finally {
    delete globalThis.window
    useDeviceStore.setState({ selectedDeviceId: null, plan: null, loading: false, error: null })
  }
})

test('a completed apply can calculate and expose a second plan without remounting the store', async () => {
  globalThis.window = {
    api: {
      devices: {
        applySync: async planId => ({
          planId,
          deviceId: 'dap',
          applied: 1,
          failed: [],
          completedAt: '2026-07-31T20:00:00.000Z',
        }),
        list: async () => [],
        listPendingJournals: async () => [],
        library: async () => { throw new Error('not needed for this cycle test') },
        planSync: async () => ({ id: 'second-plan', deviceId: 'dap', actions: [] }),
      },
    },
  }
  useDeviceStore.setState({
    selectedDeviceId: 'dap',
    plan: { id: 'first-plan', deviceId: 'dap', actions: [] },
    syncProgress: {
      deviceId: 'dap',
      planId: 'first-plan',
      phase: 'complete',
      completed: 1,
      total: 1,
    },
    loading: false,
    error: null,
  })

  try {
    await useDeviceStore.getState().applyPlan('first-plan')
    assert.equal(useDeviceStore.getState().plan, null)
    assert.equal(useDeviceStore.getState().syncProgress, null)

    await useDeviceStore.getState().planSync('bidirectional_safe', '/Music', false)
    assert.equal(useDeviceStore.getState().plan?.id, 'second-plan')
    assert.equal(useDeviceStore.getState().loading, false)
  } finally {
    delete globalThis.window
    useDeviceStore.setState({
      selectedDeviceId: null,
      plan: null,
      syncProgress: null,
      loading: false,
      error: null,
    })
  }
})
