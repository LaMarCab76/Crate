import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { sanitizeLegacyDeviceSyncJournal } from './deviceSyncJournalSanitizer.ts'

const serviceSource = readFileSync(new URL('./DeviceSyncService.ts', import.meta.url), 'utf8')

test('DeviceSyncService reuses the active device scan promise for concurrent callers', () => {
  assert.ok(
    serviceSource.includes('private activeDeviceScans = new Map<string, ActiveDeviceScan>()'),
    'service should keep active scans by device id',
  )
  assert.ok(
    serviceSource.includes('const existing = this.activeDeviceScans.get(row.id)'),
    'scanDeviceRow should check for an active scan before starting a new one',
  )
  assert.ok(
    serviceSource.includes('return existing.promise'),
    'concurrent scan callers should join the active scan promise',
  )
  assert.ok(
    serviceSource.includes('if (current === active) this.activeDeviceScans.delete(row.id)'),
    'active scan entries should be removed after the matching promise settles',
  )
})

test('DeviceSyncService scans device metadata without embedded artwork', () => {
  assert.ok(
    serviceSource.includes('readMetadata: file => readTrackMetadata(file, { artwork: false })'),
    'device scan should skip embedded artwork extraction and cache writes',
  )
  assert.ok(
    serviceSource.includes('DEVICE_SCAN_METADATA_CONCURRENCY'),
    'device scan should use the shared metadata concurrency limit',
  )
})

test('DeviceSyncService does not plan or execute device lyrics synchronization', () => {
  assert.ok(
    serviceSource.includes('sanitizeLegacyDeviceSyncJournal'),
    'legacy journals should be sanitized before resume/list handling',
  )
  assert.ok(!serviceSource.includes('reconcileLyricsForJournal'), 'sync should not have a lyrics reconcile phase')
  assert.ok(!serviceSource.includes('ensureLyricsSidecarForCopy'), 'copy actions should not copy lrc sidecars')
  assert.ok(!serviceSource.includes('resolvePcLyricsPresence'), 'sync should not resolve PC lyrics inventory')
  assert.ok(!serviceSource.includes('loadPcLyricsContent'), 'sync should not load lyrics content for propagation')
  assert.ok(!serviceSource.includes('deviceLyricsSidecars'), 'plan cache should not carry device lrc sidecars')
  assert.ok(!serviceSource.includes('sync_lyrics'), 'journals should not create lyrics sync steps')
  assert.ok(!serviceSource.includes('fetching_lyrics'), 'sync progress should not expose a lyrics phase')
  assert.ok(!serviceSource.includes('LrclibProvider'), 'device sync should not depend on LRCLIB')
  assert.ok(!serviceSource.includes('fetchOnline('), 'device sync should not call LyricsService.fetchOnline')
  assert.ok(!serviceSource.includes('fetchForSelection'), 'device sync should not use bulk online lyrics fetch')
  assert.ok(!serviceSource.includes('readEmbeddedLyrics'), 'device sync should not open MP3 audio just to probe lyrics')
})

test('legacy lyrics journal steps are sanitized before pending journals resume', () => {
  const journal = {
    phase: 'fetching_lyrics',
    actions: [
      { id: 'copy:1', kind: 'copy_pc_to_device', status: 'pending' },
      { id: 'lyrics:stale-action', kind: 'sync_lyrics', status: 'running' },
    ],
    lyrics: [
      { id: 'lyrics:1', kind: 'sync_lyrics', status: 'running' },
    ],
    artwork: [
      { id: 'artwork:1', kind: 'optimize_artwork', status: 'pending' },
      { id: 'lyrics:stale-artwork', kind: 'sync_lyrics', status: 'pending' },
    ],
  }

  assert.equal(sanitizeLegacyDeviceSyncJournal(journal), true)
  assert.equal(journal.phase, null)
  assert.deepEqual(journal.actions.map(step => step.kind), ['copy_pc_to_device'])
  assert.deepEqual(journal.lyrics, [])
  assert.deepEqual(journal.artwork.map(step => step.kind), ['optimize_artwork'])
})

test('DeviceSyncService runs incremental scans when last_sync_at is present', () => {
  assert.ok(
    serviceSource.includes('const useIncremental = !fullSync && Number.isFinite(lastSyncAtMs) && isUsableLibraryState(baseline)'),
    'planSync should compute incremental mode only when fullSync is false and last sync is parseable',
  )
  assert.ok(
    serviceSource.includes('const reusableMetadata = useIncremental ? buildReusableDeviceTrackMetadata(baseline) : undefined'),
    'incremental scans must preload reusable metadata from previous baseline',
  )
})

test('DeviceSyncService falls back to full sync when baseline is missing or unusable', () => {
  assert.ok(
    serviceSource.includes('const baseline = await this.readLibraryState(row)'),
    'planSync should read stored library-state before deciding scan mode',
  )
  assert.ok(
    serviceSource.includes('const useIncremental = !fullSync && Number.isFinite(lastSyncAtMs) && isUsableLibraryState(baseline)'),
    'invalid baseline should force full sync through isUsableLibraryState gate',
  )
  assert.ok(
    serviceSource.includes('fullSync: !useIncremental'),
    'buildActions must receive fullSync false for incremental and true for fallback',
  )
})

test('DeviceSyncService passes changed-since signals into incremental device scan', () => {
  assert.ok(
    serviceSource.includes('this.scanDeviceRow(row, false, {'),
    'planSync should call scanDeviceRow with per-scan options',
  )
  assert.ok(
    serviceSource.includes('changedSinceMs: useIncremental ? lastSyncAtMs : undefined,'),
    'scan options should include changedSinceMs for incremental runs',
  )
  assert.ok(
    serviceSource.includes('reusableMetadataByKey: reusableMetadata,'),
    'scan options should include reusable metadata map when baseline is used',
  )
  assert.ok(
    serviceSource.includes('const changedPcTracks = useIncremental'),
    'planSync should compute changed track-key sets for incremental change filtering',
  )
})
