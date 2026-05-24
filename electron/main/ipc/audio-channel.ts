import { BrowserWindow, ipcMain, screen, type WebContents } from 'electron'
import { getAudioEngine, type StreamInfo } from '../audio/AudioEngine'
import { getEQManager } from '../audio/EQManager'
import { GaplessController } from '../audio/GaplessController'
import { getExclusiveModeManager } from '../audio/ExclusiveModeManager'
import { getPlaybackAnalysisService } from '../audio/PlaybackAnalysisService'
import { broadcast } from './events'
import { getRepos } from '../db/repositories'
import type { AudioOutputDevice, FftMode, PlaybackCacheStats } from '@shared/types/ipc-contract'

let gapless: GaplessController | null = null

function getGapless(): GaplessController {
  if (!gapless) gapless = new GaplessController(getAudioEngine())
  return gapless
}

// Convert main-process StreamInfo into a plain JSON-safe payload (BigInt
// can't cross the IPC boundary).
function serializeStreamInfo(info: StreamInfo | null) {
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

function broadcastEqState(): void {
  const eq = getEQManager()
  const s = eq.getState()
  broadcast('eq:changed', { enabled: s.enabled, preset: s.preset, bands: s.bands })
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

function requirePath(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error('Audio path is required')
  return value
}

export function registerAudioChannel(): void {
  const engine = getAudioEngine()
  const eq = getEQManager()
  const playbackAnalysis = getPlaybackAnalysisService()
  // Construct the exclusive-mode manager eagerly so it wires its
  // setOnDeviceChanged callback into the engine before any IPC arrives.
  // Otherwise the first device switch could fire before the manager exists,
  // missing a hog-transfer opportunity.
  getExclusiveModeManager()

  ipcMain.handle('audio:load', (_, payload: { path: string; trackId?: number | null }) => {
    // Defense in depth: when a trackId is supplied, the path must match that track's
    // DB record, so a compromised renderer can't point the engine at an arbitrary file.
    if (payload?.trackId != null) {
      const track = getRepos().tracks.getById(payload.trackId)
      if (!track || track.path !== payload.path) {
        throw new Error('audio:load: path does not match the track record')
      }
    }
    const info = engine.load(payload.path)
    eq.reapply(engine.getCurrentStream())
    broadcastEqState()
    return serializeStreamInfo(info)
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

  ipcMain.handle('audio:getWaveform', async (_, payload: { path: string; buckets?: number; trackId?: number | null }) => {
    const result = await playbackAnalysis.ensure(
      requirePath(payload?.path),
      normalizeBuckets(payload?.buckets),
      normalizeTrackId(payload?.trackId),
    )
    broadcastPlaybackCacheStats()
    return result
  })
  ipcMain.handle('audio:getCachedAnalysis', (_, payload: { path: string; buckets?: number; trackId?: number | null }) =>
    playbackAnalysis.getCached(
      requirePath(payload?.path),
      normalizeBuckets(payload?.buckets),
      normalizeTrackId(payload?.trackId),
    ))
  ipcMain.handle('audio:ensurePlaybackAnalysis', async (_, payload: { path: string; buckets?: number; trackId?: number | null }) => {
    const result = await playbackAnalysis.ensure(
      requirePath(payload?.path),
      normalizeBuckets(payload?.buckets),
      normalizeTrackId(payload?.trackId),
    )
    broadcastPlaybackCacheStats()
    return result
  })
  ipcMain.handle('audio:getCachedTableBars', (_, payload: { path: string; trackId?: number | null }) =>
    playbackAnalysis.getCachedTableBars(
      requirePath(payload?.path),
      normalizeTrackId(payload?.trackId),
    ))
  ipcMain.handle('audio:ensureTableBars', async (_, payload: { path: string; trackId?: number | null }) => {
    const result = await playbackAnalysis.ensureTableBars(
      requirePath(payload?.path),
      normalizeTrackId(payload?.trackId),
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

  ipcMain.handle('audio:preloadNext', (_, payload: { path: string }) => {
    getGapless().preloadNext(payload.path)
  })
  ipcMain.handle('audio:clearNext', () => getGapless().clearNext())
  ipcMain.handle('audio:swapNow', () => {
    const swapped = getGapless().swapToNext()
    if (swapped) eq.reapply(engine.getCurrentStream())
    return swapped
  })
  ipcMain.handle('audio:getStatus', () => ({
    status: engine.getStatus(),
    positionSec: engine.getPosition(),
    streamInfo: serializeStreamInfo(engine.getStreamInfo()),
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
  ipcMain.handle('eq:getState', () => ({
    enabled: eq.getState().enabled,
    preset: eq.getState().preset,
    bands: eq.getState().bands,
  }))
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
  ipcMain.handle('eq:previewBand', (_, payload: { index: number; gain: number }) => {
    eq.previewBand(payload.index, payload.gain)
  })
  ipcMain.handle('eq:setPreset', (_, payload: { name: string }) => {
    eq.setPreset(payload.name)
    broadcastEqState()
  })
  ipcMain.handle('eq:presets', () => eq.getPresetNames())
}
