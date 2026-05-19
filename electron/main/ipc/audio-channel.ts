import { ipcMain } from 'electron'
import { getAudioEngine, type StreamInfo } from '../audio/AudioEngine'
import { getEQManager } from '../audio/EQManager'
import { GaplessController } from '../audio/GaplessController'
import { broadcast } from './events'

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

export function registerAudioChannel(): void {
  const engine = getAudioEngine()
  const eq = getEQManager()

  ipcMain.handle('audio:load', (_, payload: { path: string }) => {
    const info = engine.load(payload.path)
    eq.reapply(engine.getCurrentStream())
    return serializeStreamInfo(info)
  })

  ipcMain.handle('audio:play', () => engine.play())
  ipcMain.handle('audio:pause', () => engine.pause())
  ipcMain.handle('audio:stop', () => engine.stop())
  ipcMain.handle('audio:seek', (_, payload: { positionSec: number }) => engine.seek(payload.positionSec))
  ipcMain.handle('audio:setVolume', (_, payload: { value: number }) => engine.setVolume(payload.value))

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

  // ---------------- EQ ----------------
  ipcMain.handle('eq:getState', () => eq.getState())
  ipcMain.handle('eq:setEnabled', (_, payload: { enabled: boolean }) => {
    eq.setEnabled(payload.enabled)
    broadcast('eq:changed', eq.getState())
  })
  ipcMain.handle('eq:setBand', (_, payload: { index: number; gain: number }) => {
    eq.setBand(payload.index, payload.gain)
    broadcast('eq:changed', eq.getState())
  })
  ipcMain.handle('eq:setPreset', (_, payload: { name: string }) => {
    eq.setPreset(payload.name)
    broadcast('eq:changed', eq.getState())
  })
  ipcMain.handle('eq:presets', () => eq.getPresetNames())
}
