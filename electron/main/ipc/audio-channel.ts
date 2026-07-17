import { BrowserWindow, screen, type WebContents } from 'electron'
import { secureIpcMain as ipcMain } from './secureIpc'
import { getAudioEngine, type StreamInfo } from '../audio/AudioEngine'
import { getEQManager } from '../audio/EQManager'
import { getLevelerManager } from '../audio/LevelerManager'
import { GaplessController } from '../audio/GaplessController'
import { getExclusiveModeManager } from '../audio/ExclusiveModeManager'
import { getPlaybackAnalysisService } from '../audio/PlaybackAnalysisService'
import { getDeviceSyncService } from '../devices/DeviceSyncService'
import { broadcast } from './events'
import { getRepos } from '../db/repositories'
import { getOneDriveClient } from '../cloud/OneDriveClient'
import { resolveCloudLoadOptions } from '../cloud/cloudTrackRef'
import { estimateLufsFromAnalysis, type LevelerLoudness } from '@shared/constants/leveler'
import type { DbTrack } from '@shared/types/db'
import type {
  AudioOutputDevice,
  FftMode,
  LevelerConfig,
  PlaybackCacheStats,
  PlaybackSource,
  StreamLoadResult,
  StreamInfoPayload,
  StreamLoadSource,
  StreamLoadFailureReason,
} from '@shared/types/ipc-contract'

type StreamLoadResultLike = {
  attemptedMemory?: boolean
  attempted?: boolean
  source: StreamLoadSource
  reason: StreamLoadFailureReason | null
  durationMs: number
  sizeBytes: number | null
  streamInfo: StreamInfo | StreamInfoPayload | null
  bufferedBytes?: number | null
  totalBytes?: number | null
  bufferedSec?: number | null
  bufferComplete?: boolean
}

let gapless: GaplessController | null = null
let gaplessEnabled = true

// Re-apply per-stream effects after a gapless swap (manual or native auto-
// advance). EQ FX and the leveler gain are attached to a specific stream handle,
// which the swap replaces, so both must be re-applied to the new stream.
function afterGaplessSwap(): void {
  const engine = getAudioEngine()
  getEQManager().reapply(engine.getCurrentStream())
  broadcastEqState()
  applyLevelerForCurrentTrack()
}

// Pre-seed the leveler gain for the track about to be adopted, so playback
// starts at the correct gain instead of briefly inheriting the previous track's
// (which can be audibly off when their loudness differs).
function beforeGaplessSwap(path: string): void {
  const leveler = getLevelerManager()
  const track = getRepos().tracks.getByPath(path)
  leveler.setTrackLoudness(resolveTrackLoudness(track))
  getAudioEngine().setNormalizationGain(leveler.currentGainLinear())
}

function getGapless(): GaplessController {
  if (!gapless) {
    gapless = new GaplessController(getAudioEngine())
    gapless.setOnBeforeSwap(beforeGaplessSwap)
    gapless.setOnAfterSwap(afterGaplessSwap)
  }
  return gapless
}

export function disposeGapless(): void {
  if (!gapless) return
  try { gapless.clear() } catch { /* best-effort cleanup */ }
  gapless = null
}

// Convert main-process StreamInfo into a plain JSON-safe payload (BigInt
// can't cross the IPC boundary).
function serializeStreamInfo(info: StreamInfo | StreamInfoPayload | null) {
  if (!info) return null
  return {
    freq: info.freq,
    chans: info.chans,
    ctype: info.ctype,
    duration: info.duration,
    durationBytes: Number(info.durationBytes),
    bytesPerSecond: info.bytesPerSecond,
  }
}

function serializeStreamLoadResult(result: StreamLoadResultLike | null): StreamLoadResult | null {
  if (!result) return null
  const attempted = result.attemptedMemory ?? result.attempted
    ?? false
  return {
    attempted,
    attemptedMemory: result.attemptedMemory ?? attempted,
    source: result.source,
    reason: result.reason,
    durationMs: result.durationMs,
    sizeBytes: result.sizeBytes,
    streamInfo: serializeStreamInfo(result.streamInfo),
    bufferedBytes: result.bufferedBytes ?? null,
    totalBytes: result.totalBytes ?? null,
    bufferedSec: result.bufferedSec ?? null,
    bufferComplete: result.bufferComplete ?? false,
  }
}

function broadcastEqState(): void {
  const eq = getEQManager()
  const s = eq.getState()
  broadcast('eq:changed', { enabled: s.enabled, preset: s.preset, bands: s.bands, bandCount: s.bandCount })
}

// ---------------- Volume leveler ----------------

// Resolve a track's loudness for the leveler: prefer the persisted integrated
// loudness (from a ReplayGain/R128 tag at import), and fall back to an estimate
// derived from the cached playback analysis (RMS = peak − crest factor). Peak is
// only available once the analysis has been computed, and feeds clip prevention.
function resolveTrackLoudness(track: DbTrack | null | undefined): LevelerLoudness {
  if (!track) return { trackLufs: null, peakDb: null }
  let trackLufs = track.r128_integrated_loudness ?? null
  let peakDb: number | null = null
  // Persistent analysis decodes a local path. Cloud tracks are played from a
  // RAM buffer and must never send their onedrive:// identity to that service.
  if (track.provider === 'onedrive') return { trackLufs, peakDb }
  let cached = null
  try {
    cached = getPlaybackAnalysisService().getCached(track.path, undefined, track.id)
  } catch {
    cached = null
  }
  if (cached) {
    peakDb = cached.peakDb
    if (trackLufs == null) trackLufs = estimateLufsFromAnalysis(cached.peakDb, cached.drApprox)
  }
  return { trackLufs, peakDb }
}

function levelerStatePayload() {
  const leveler = getLevelerManager()
  return { ...leveler.getConfig(), currentGainDb: leveler.currentGainDb() }
}

function broadcastLevelerState(): void {
  broadcast('leveler:changed', levelerStatePayload())
}

// Recompute the leveler gain for whatever track is currently loaded and push it
// to the engine. When the leveler is on but the track has no loudness data yet
// (untagged + not analyzed), kick off a background analysis and re-apply once it
// lands, so the leveler "warms up" on first play and is instant thereafter.
function applyLevelerForCurrentTrack(): void {
  const engine = getAudioEngine()
  const leveler = getLevelerManager()
  const path = engine.getCurrentPath()
  const track = path ? getRepos().tracks.getByPath(path) : undefined

  leveler.setTrackLoudness(resolveTrackLoudness(track))
  engine.setNormalizationGain(leveler.currentGainLinear())
  broadcastLevelerState()

  const cfg = leveler.getConfig()
  if (!cfg.enabled || !track || track.provider === 'onedrive' || track.r128_integrated_loudness != null) return

  const playbackAnalysis = getPlaybackAnalysisService()
  let alreadyCached = false
  try {
    alreadyCached = playbackAnalysis.getCached(track.path, undefined, track.id) != null
  } catch {
    alreadyCached = false
  }
  if (alreadyCached) return

  const targetPath = track.path
  void playbackAnalysis.ensure(track.path, undefined, track.id).then(() => {
    if (engine.getCurrentPath() !== targetPath) return
    const fresh = getRepos().tracks.getByPath(targetPath)
    leveler.setTrackLoudness(resolveTrackLoudness(fresh))
    engine.setNormalizationGain(leveler.currentGainLinear())
    broadcastLevelerState()
  }).catch(() => {
    /* decode failed — leave the track unleveled */
  })
}

function promoteCurrentFileStreamToMemory(path: string, estimatedDurationSec: number | null): void {
  const engine = getAudioEngine()
  void engine.promoteCurrentToMemory({ expectedPath: path, estimatedDurationSec }).then(result => {
    if (result.source !== 'memory' || engine.getCurrentPath() !== path) return
    getEQManager().reapply(engine.getCurrentStream())
    broadcastEqState()
    applyLevelerForCurrentTrack()
  }).catch(err => {
    console.warn('[audio] background memory promotion failed:', err instanceof Error ? err.message : err)
  })
}

function normalizeFftMode(mode: unknown): FftMode {
  return mode === 'screen' || mode === 'full' || mode === 'mini' ? mode : 'off'
}

function getSenderDisplayHz(sender: WebContents): number | undefined {
  const win = BrowserWindow.fromWebContents(sender)
  if (!win) return undefined
  const display = screen.getDisplayMatching(win.getBounds())
  const frequency = display.displayFrequency
  return typeof frequency === 'number' && frequency > 0 ? frequency : undefined
}

function normalizeTrackId(trackId: unknown): number | null {
  return Number.isInteger(trackId) && (trackId as number) > 0 ? trackId as number : null
}

function normalizeBuckets(buckets: unknown): number | undefined {
  return Number.isInteger(buckets) && (buckets as number) > 0 ? buckets as number : undefined
}

async function resolvePlaybackSource(value: unknown, channel: string): Promise<{
  path: string
  duration: number
  trackId: number | null
  track: DbTrack | null
}> {
  if (!value || typeof value !== 'object') throw new Error(`${channel}: playback source is required`)
  const source = value as Partial<PlaybackSource>
  if (source.kind === 'library') {
    const trackId = normalizeTrackId(source.trackId)
    if (trackId == null) throw new Error(`${channel}: valid library track id is required`)
    const track = getRepos().tracks.getById(trackId)
    if (!track) throw new Error(`${channel}: library track does not exist`)
    return { path: track.path, duration: track.duration, trackId, track }
  }
  if (source.kind === 'device') {
    if (typeof source.deviceId !== 'string' || !source.deviceId.trim()) {
      throw new Error(`${channel}: device id is required`)
    }
    if (typeof source.trackKey !== 'string' || !source.trackKey.trim()) {
      throw new Error(`${channel}: device track key is required`)
    }
    const track = await getDeviceSyncService().resolvePlaybackTrack(source.deviceId, source.trackKey)
    return { ...track, trackId: null, track: null }
  }
  throw new Error(`${channel}: unsupported playback source`)
}

export function registerAudioChannel(): void {
  const engine = getAudioEngine()
  const eq = getEQManager()
  const leveler = getLevelerManager()
  const playbackAnalysis = getPlaybackAnalysisService()
  // Construct the exclusive-mode manager eagerly so it wires its
  // setOnDeviceChanged callback into the engine before any IPC arrives.
  // Otherwise the first device switch could fire before the manager exists,
  // missing a hog-transfer opportunity.
  getExclusiveModeManager()

  ipcMain.handle('audio:load', async (_, payload: unknown) => {
    const source = await resolvePlaybackSource(payload, 'audio:load')
    const cloud = source.track
      ? await resolveCloudLoadOptions(source.track, getOneDriveClient())
      : null
    const loadResult = await engine.load(source.path, {
      estimatedDurationSec: source.duration,
      cloudRef: cloud?.cloudRef,
      cloudSizeBytes: cloud?.cloudSizeBytes ?? null,
    })
    getGapless().bindCurrentTrackEnd()
    eq.reapply(engine.getCurrentStream())
    broadcastEqState()
    applyLevelerForCurrentTrack()
    if (loadResult.source === 'file') promoteCurrentFileStreamToMemory(source.path, source.duration)
    return serializeStreamLoadResult(loadResult)
  })

  ipcMain.handle('audio:play', () => engine.play())
  ipcMain.handle('audio:pause', () => engine.pause())
  ipcMain.handle('audio:stop', () => engine.stop())
  ipcMain.handle('audio:seek', (_, payload: { positionSec: number }) => engine.seek(payload.positionSec))
  ipcMain.handle('audio:setVolume', (_, payload: { value: number }) => engine.setVolume(payload.value))
  ipcMain.handle('audio:setFftMode', (event, payload: { mode: FftMode }) => {
    const mode = normalizeFftMode(payload?.mode)
    engine.setFftMode(mode, mode === 'screen' ? getSenderDisplayHz(event.sender) : undefined)
  })
  ipcMain.handle('audio:setMeterEnabled', (_, payload: { enabled: boolean }) =>
    engine.setMeterEnabled(Boolean(payload?.enabled)))
  const broadcastPlaybackCacheStats = (): PlaybackCacheStats => {
    const stats = playbackAnalysis.stats()
    broadcast('audio:playback-cache-changed', stats)
    return stats
  }

  ipcMain.handle('audio:getWaveform', async (_, payload: { source?: unknown; buckets?: number }) => {
    const source = await resolvePlaybackSource(payload?.source, 'audio:getWaveform')
    if (source.track?.provider === 'onedrive') throw new Error('Waveform analysis is unavailable for cloud tracks')
    const result = await playbackAnalysis.ensure(
      source.path,
      normalizeBuckets(payload?.buckets),
      source.trackId,
    )
    broadcastPlaybackCacheStats()
    return result
  })
  ipcMain.handle('audio:getCachedAnalysis', async (_, payload: { source?: unknown; buckets?: number }) => {
    const source = await resolvePlaybackSource(payload?.source, 'audio:getCachedAnalysis')
    if (source.track?.provider === 'onedrive') return null
    return playbackAnalysis.getCached(
      source.path,
      normalizeBuckets(payload?.buckets),
      source.trackId,
    )
  })
  ipcMain.handle('audio:ensurePlaybackAnalysis', async (_, payload: { source?: unknown; buckets?: number }) => {
    const source = await resolvePlaybackSource(payload?.source, 'audio:ensurePlaybackAnalysis')
    if (source.track?.provider === 'onedrive') throw new Error('Playback analysis is unavailable for cloud tracks')
    const result = await playbackAnalysis.ensure(
      source.path,
      normalizeBuckets(payload?.buckets),
      source.trackId,
    )
    broadcastPlaybackCacheStats()
    return result
  })
  ipcMain.handle('audio:getCachedTableBars', async (_, payload: { source?: unknown }) => {
    const source = await resolvePlaybackSource(payload?.source, 'audio:getCachedTableBars')
    if (source.track?.provider === 'onedrive') return null
    return playbackAnalysis.getCachedTableBars(source.path, source.trackId)
  })
  ipcMain.handle('audio:ensureTableBars', async (_, payload: { source?: unknown }) => {
    const source = await resolvePlaybackSource(payload?.source, 'audio:ensureTableBars')
    if (source.track?.provider === 'onedrive') throw new Error('Playback analysis is unavailable for cloud tracks')
    const result = await playbackAnalysis.ensureTableBars(
      source.path,
      source.trackId,
    )
    broadcastPlaybackCacheStats()
    return result
  })
  ipcMain.handle('audio:playbackCache:stats', () => playbackAnalysis.stats())
  ipcMain.handle('audio:playbackCache:setLimit', (_, payload: { maxBytes: number }) => {
    const stats = playbackAnalysis.setMaxBytes(Number(payload?.maxBytes))
    broadcast('audio:playback-cache-changed', stats)
    return stats
  })
  ipcMain.handle('audio:playbackCache:clear', () => {
    const stats = playbackAnalysis.clear()
    broadcast('audio:playback-cache-changed', stats)
    return stats
  })

  ipcMain.handle('audio:preloadNext', async (_, payload: unknown) => {
    if (!gaplessEnabled) throw new Error('Gapless playback is disabled')
    const source = await resolvePlaybackSource(payload, 'audio:preloadNext')
    const cloud = source.track
      ? await resolveCloudLoadOptions(source.track, getOneDriveClient())
      : null
    const result = await getGapless().preloadNext(source.path, cloud ?? undefined)
    return result
  })
  ipcMain.handle('audio:setGaplessEnabled', (_, payload: { enabled?: unknown }) => {
    gaplessEnabled = payload?.enabled === true
    if (!gaplessEnabled) getGapless().clearNext()
  })
  ipcMain.handle('audio:clearNext', () => getGapless().clearNext())
  ipcMain.handle('audio:swapNow', () => {
    // swapToNext() re-applies EQ + leveler via the onAfterSwap hook (shared with
    // the native auto-advance path), so we don't repeat it here.
    const result = gaplessEnabled ? getGapless().swapToNext() : null
    getGapless().bindCurrentTrackEnd()
    return serializeStreamLoadResult(result)
  })
  ipcMain.handle('audio:promoteCurrentToMemory', async () => {
    const result = await engine.promoteCurrentToMemory()
    if (result.source === 'memory') {
      eq.reapply(engine.getCurrentStream())
      broadcastEqState()
      // Same track, so the gain is unchanged, but re-assert it (the in-memory
      // re-adopt resets channel FX) and keep the renderer's readout in sync.
      applyLevelerForCurrentTrack()
    }
    return serializeStreamLoadResult(result)
  })
  ipcMain.handle('audio:getStatus', () => ({
    status: engine.getStatus(),
    positionSec: engine.getPosition(),
    streamInfo: serializeStreamInfo(engine.getStreamInfo()),
    streamSource: engine.getCurrentStreamSource(),
    bufferedBytes: engine.getCurrentStreamLoadResult().bufferedBytes,
    totalBytes: engine.getCurrentStreamLoadResult().totalBytes,
    bufferedSec: engine.getCurrentStreamLoadResult().bufferedSec,
    bufferComplete: engine.getCurrentStreamLoadResult().bufferComplete,
    volume: engine.getVolume(),
    currentPath: engine.getCurrentPath(),
  }))

  const decorate = (device: AudioOutputDevice): AudioOutputDevice => ({
    ...device,
    supportsExclusive: getExclusiveModeManager().isSupportedDevice(device),
  })

  ipcMain.handle('audio:devices:list', () => engine.listOutputDevices().map(decorate))
  ipcMain.handle('audio:devices:current', () => {
    const current = engine.getOutputDevice()
    return current ? decorate(current) : null
  })
  ipcMain.handle('audio:devices:set', (_, payload: { deviceId: number }) => {
    const selected = engine.setOutputDevice(payload.deviceId)
    // Invalidate any cached CoreAudio mapping so the next exclusive-mode
    // check sees a fresh device list.
    getExclusiveModeManager().invalidateCache()
    const movedPreload = getGapless().movePreloadedToOutputDevice(selected.id)
    if (!movedPreload) {
      console.warn(`[audio] cleared preloaded stream after output device switch to ${selected.name}`)
    }
    return decorate(selected)
  })

  ipcMain.handle('audio:exclusive:get', () => getExclusiveModeManager().getState())
  ipcMain.handle('audio:exclusive:set', async (_, payload: { enabled: boolean }) => {
    const mgr = getExclusiveModeManager()
    return payload.enabled ? await mgr.enable() : await mgr.disable()
  })

  // ---------------- EQ ----------------
  ipcMain.handle('eq:getState', () => {
    const s = eq.getState()
    return { enabled: s.enabled, preset: s.preset, bands: s.bands, bandCount: s.bandCount }
  })
  ipcMain.handle('eq:setEnabled', (_, payload: { enabled: boolean }) => {
    eq.setEnabled(payload.enabled)
    broadcastEqState()
  })
  ipcMain.handle('eq:setBand', (_, payload: { index: number; gain: number }) => {
    eq.setBand(payload.index, payload.gain)
    broadcastEqState()
  })
  ipcMain.handle('eq:setBands', (_, payload: { bands: number[] }) => {
    eq.setBands(payload.bands)
    broadcastEqState()
  })
  ipcMain.handle('eq:setBandCount', (_, payload: { count: number }) => {
    eq.setBandCount(payload.count)
    broadcastEqState()
  })
  ipcMain.handle('eq:previewBand', (_, payload: { index: number; gain: number }) => {
    eq.previewBand(payload.index, payload.gain)
  })
  ipcMain.handle('eq:setPreset', (_, payload: { name: string }) => {
    eq.setPreset(payload.name)
    broadcastEqState()
  })
  ipcMain.handle('eq:presets', () => eq.getPresetNames())

  // ---------------- Volume leveler ----------------
  ipcMain.handle('leveler:getState', () => levelerStatePayload())
  ipcMain.handle('leveler:setConfig', (_, patch: Partial<LevelerConfig>) => {
    leveler.setConfig(patch ?? {})
    // Recompute for the current track (also warms up analysis on enable) and
    // push the new gain to the engine + renderer.
    applyLevelerForCurrentTrack()
    return levelerStatePayload()
  })
}
