import { BrowserWindow, ipcMain, screen, type WebContents } from 'electron'
import { getAudioEngine, type StreamInfo } from '../audio/AudioEngine'
import { getEQManager } from '../audio/EQManager'
import { GaplessController } from '../audio/GaplessController'
import { getRepos } from '../db/repositories'
import { getLibraryBackup } from '../services/LibraryBackup'
import { broadcast } from './events'
import type { EqPreviewScope, FftMode } from '@shared/types/ipc-contract'

let gapless: GaplessController | null = null
let currentTrackId: number | null = null

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
  broadcast('eq:changed', {
    enabled: s.enabled,
    preset: s.preset,
    bands: s.bands,
    overrideBands: eq.getOverrideBands(),
  })
}

function applyOverrideForTrack(trackId: number | null): void {
  const eq = getEQManager()
  if (trackId == null) {
    eq.applyOverride(null)
    return
  }
  const ovr = getRepos().tracks.getEqOverride(trackId)
  eq.applyOverride(ovr?.enabled ? ovr.bands : null)
}

function normalizeFftMode(mode: unknown): FftMode {
  return mode === 'screen' || mode === 'full' || mode === 'mini' ? mode : 'off'
}

function normalizeEqPreviewScope(scope: unknown): EqPreviewScope {
  return scope === 'override' ? 'override' : 'global'
}

function getSenderDisplayHz(sender: WebContents): number | undefined {
  const win = BrowserWindow.fromWebContents(sender)
  if (!win) return undefined
  const display = screen.getDisplayMatching(win.getBounds())
  const frequency = display.displayFrequency
  return typeof frequency === 'number' && frequency > 0 ? frequency : undefined
}

export function registerAudioChannel(): void {
  const engine = getAudioEngine()
  const eq = getEQManager()

  ipcMain.handle('audio:load', (_, payload: { path: string; trackId?: number | null }) => {
    const info = engine.load(payload.path)
    eq.reapply(engine.getCurrentStream())
    currentTrackId = payload.trackId ?? null
    applyOverrideForTrack(currentTrackId)
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

  ipcMain.handle('audio:preloadNext', (_, payload: { path: string }) => {
    getGapless().preloadNext(payload.path)
  })
  ipcMain.handle('audio:clearNext', () => getGapless().clearNext())
  ipcMain.handle('audio:swapNow', () => {
    const swapped = getGapless().swapToNext()
    if (swapped) eq.reapply(engine.getCurrentStream())
    return swapped
  })
  // Renderer signals which track is now playing after a gapless swap (or any
  // other path-only change). Lets us look up + apply the new track's EQ.
  ipcMain.handle('audio:setActiveTrack', (_, payload: { trackId: number | null }) => {
    currentTrackId = payload.trackId ?? null
    applyOverrideForTrack(currentTrackId)
    broadcastEqState()
  })

  ipcMain.handle('audio:getStatus', () => ({
    status: engine.getStatus(),
    positionSec: engine.getPosition(),
    streamInfo: serializeStreamInfo(engine.getStreamInfo()),
    volume: engine.getVolume(),
    currentPath: engine.getCurrentPath(),
  }))

  ipcMain.handle('audio:devices:list', () => engine.listOutputDevices())
  ipcMain.handle('audio:devices:current', () => engine.getOutputDevice())
  ipcMain.handle('audio:devices:set', (_, payload: { deviceId: number }) => {
    const selected = engine.setOutputDevice(payload.deviceId)
    const movedPreload = getGapless().movePreloadedToOutputDevice(selected.id)
    if (!movedPreload) {
      console.warn(`[audio] cleared preloaded stream after output device switch to ${selected.name}`)
    }
    return selected
  })

  // ---------------- EQ ----------------
  ipcMain.handle('eq:getState', () => ({
    enabled: eq.getState().enabled,
    preset: eq.getState().preset,
    bands: eq.getState().bands,
    overrideBands: eq.getOverrideBands(),
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
  ipcMain.handle('eq:previewBand', (_, payload: { index: number; gain: number; scope: EqPreviewScope }) => {
    eq.previewBand(payload.index, payload.gain, normalizeEqPreviewScope(payload?.scope))
  })
  ipcMain.handle('eq:setPreset', (_, payload: { name: string }) => {
    eq.setPreset(payload.name)
    broadcastEqState()
  })
  ipcMain.handle('eq:presets', () => eq.getPresetNames())

  // Per-track EQ override. The renderer hits these from the "Custom for this
  // track" UI in the fullscreen player.
  ipcMain.handle('eq:setTrackOverride', (_, payload: { trackId: number; override: { enabled: boolean; bands: number[] } | null }) => {
    getRepos().tracks.setEqOverride(payload.trackId, payload.override)
    if (payload.trackId === currentTrackId) {
      eq.applyOverride(payload.override?.enabled ? payload.override.bands : null)
    }
    getLibraryBackup().scheduleWriteForTrack(payload.trackId)
    broadcastEqState()
  })
  ipcMain.handle('eq:getTrackOverride', (_, trackId: number) => {
    return getRepos().tracks.getEqOverride(trackId)
  })
}
