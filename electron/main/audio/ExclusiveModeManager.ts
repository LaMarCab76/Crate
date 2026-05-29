// Drives macOS CoreAudio hog-mode on top of the BASS playback chain so the
// user can bypass the OS mixer. BASS has no hog primitive on macOS, so we
// pause + free BASS, take/release hog through the HAL, then re-init BASS on
// the same device and resume from the same byte position.
//
// The manager is the single source of truth for exclusive-mode state in the
// main process — handlers in audio-channel.ts call into it, the
// will-quit hook calls dispose() to release the device, and AudioEngine
// notifies it when the user switches output devices so we can transfer hog
// across the switch.

import { broadcast } from '../ipc/events'
import { getAudioEngine, type AudioEngine } from './AudioEngine'
import { getEQManager } from './EQManager'
import {
  coreAudioErrorName,
  enumerateOutputDevices,
  getHogOwner,
  isCoreAudioAvailable,
  setHogOwner,
  type CoreAudioDevice,
} from './coreaudio-ffi'
import type { AudioOutputDevice, ExclusiveModeState } from '@shared/types/ipc-contract'

interface PlaybackSnapshot {
  path: string | null
  positionSec: number
  wasPlaying: boolean
  volume: number
}

let manager: ExclusiveModeManager | null = null

export function getExclusiveModeManager(): ExclusiveModeManager {
  if (!manager) {
    manager = new ExclusiveModeManager(getAudioEngine())
    manager.registerProcessExitHook()
    // Bridge device-switch events from the engine into our handler so hog
    // mode survives output-device changes (release old, take new).
    getAudioEngine().setOnDeviceChanged(bassDeviceId => {
      void manager!.handleDeviceSwitch(bassDeviceId)
    })
  }
  return manager
}

export class ExclusiveModeManager {
  private engine: AudioEngine
  private enabled = false
  private heldDeviceId: number | null = null
  // CoreAudio device list cached for the duration the BASS device set is
  // stable. Invalidated on every output-device change.
  private coreaudioCache: CoreAudioDevice[] | null = null
  // Serializes enable/disable/switch attempts — CoreAudio hog operations
  // around a BASS reinit are not safe to interleave.
  private inFlight: Promise<unknown> | null = null
  private exitHookInstalled = false

  constructor(engine: AudioEngine) {
    this.engine = engine
  }

  registerProcessExitHook(): void {
    if (this.exitHookInstalled) return
    this.exitHookInstalled = true
    // Best-effort sync release when the Node process tears down. Electron's
    // app.on('will-quit') is the primary cleanup site; this is a backstop in
    // case dispose() didn't run.
    process.on('exit', () => {
      try { this.releaseHeldDeviceSync() } catch { /* exiting anyway */ }
    })
  }

  getState(): ExclusiveModeState {
    return { enabled: this.enabled, deviceId: this.heldDeviceId }
  }

  // Returns the CoreAudio device ID that corresponds to a BASS device, or
  // null if no mapping could be found. The match is best-effort across UID,
  // driver string, and human name (with several normalizations) — the BASS
  // device record exposes name + driver; we match against CoreAudio uid and
  // name.
  resolveCoreAudioId(bass: AudioOutputDevice): number | null {
    if (!isCoreAudioAvailable()) return null
    const list = this.getCoreAudioDevices()
    if (list.length === 0) return null

    const bassDriver = bass.driver?.trim() ?? ''
    const bassName = bass.name.trim()
    const looseBassName = looseName(bassName)
    const looseBassDriver = looseName(bassDriver)

    // 1. Exact UID match against BASS driver.
    if (bassDriver) {
      const hit = list.find(d => d.uid === bassDriver)
      if (hit) return hit.id
    }
    // 2. Substring: BASS driver contains CA uid (or vice versa).
    if (bassDriver) {
      const hit = list.find(d => d.uid && (bassDriver.includes(d.uid) || d.uid.includes(bassDriver)))
      if (hit) return hit.id
    }
    // 3. Exact name match.
    {
      const hit = list.find(d => d.name === bassName)
      if (hit) return hit.id
    }
    // 4. Loose name match: case-insensitive, collapse spaces, drop " (2)".
    {
      const hit = list.find(d => looseName(d.name) === looseBassName)
      if (hit) return hit.id
    }
    // 5. Loose driver/name comparison.
    if (looseBassDriver) {
      const hit = list.find(d => looseName(d.name) === looseBassDriver)
      if (hit) return hit.id
    }
    return null
  }

  isSupportedDevice(bass: AudioOutputDevice): boolean {
    return this.resolveCoreAudioId(bass) !== null
  }

  invalidateCache(): void {
    this.coreaudioCache = null
  }

  async enable(): Promise<ExclusiveModeState> {
    return this.runExclusive(() => this.doEnable())
  }

  async disable(): Promise<ExclusiveModeState> {
    return this.runExclusive(() => this.doDisable())
  }

  // Called by AudioEngine after BASS device switch completes. If we hold
  // hog, transfer it from the old device to the new one so the user keeps
  // exclusive output across the switch.
  async handleDeviceSwitch(_newBassDeviceId: number): Promise<void> {
    if (!this.enabled) return
    this.invalidateCache()
    await this.runExclusive(async () => {
      // Release any previously held device, then attempt to take hog on the
      // current BASS device.
      const oldHeld = this.heldDeviceId
      if (oldHeld !== null) {
        setHogOwner(oldHeld, -1)
        this.heldDeviceId = null
      }
      const state = await this.doEnable({ skipReinitIfAlreadyHeld: false })
      if (!state.enabled) {
        // We failed to re-acquire on the new device. Broadcast the failure
        // so the UI can reflect the off state with a reason.
        this.enabled = false
        broadcast('audio:exclusive-changed', state)
      }
      return state
    })
  }

  // Run on app shutdown to make sure no device stays hog-locked after we
  // exit. dispose() is the async-friendly version; releaseHeldDeviceSync()
  // is the sync best-effort fallback wired to process.on('exit').
  dispose(): void {
    this.releaseHeldDeviceSync()
  }

  private releaseHeldDeviceSync(): void {
    if (this.heldDeviceId !== null) {
      try { setHogOwner(this.heldDeviceId, -1) } catch { /* nothing we can do */ }
      this.heldDeviceId = null
    }
    this.enabled = false
  }

  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = (this.inFlight as Promise<T> | null) ?? Promise.resolve()
    const next = run.then(() => task()).finally(() => {
      if (this.inFlight === next) this.inFlight = null
    })
    this.inFlight = next
    return next
  }

  private async doEnable(_opts: { skipReinitIfAlreadyHeld?: boolean } = {}): Promise<ExclusiveModeState> {
    if (!isCoreAudioAvailable()) {
      return { enabled: false, deviceId: null, reason: 'Exclusive mode requires macOS' }
    }
    const currentBass = this.engine.getOutputDevice()
    if (!currentBass) {
      return { enabled: false, deviceId: null, reason: 'No output device selected' }
    }
    const caId = this.resolveCoreAudioId(currentBass)
    if (caId === null) {
      return {
        enabled: false,
        deviceId: null,
        reason: `Could not match "${currentBass.name}" to a CoreAudio device`,
      }
    }

    const ownerPid = getHogOwner(caId)
    if (ownerPid !== -1 && ownerPid !== process.pid) {
      return {
        enabled: false,
        deviceId: null,
        reason: `Device is already in exclusive use by another process (pid ${ownerPid})`,
      }
    }

    const snapshot = this.snapshotPlayback()

    // Free BASS before touching hog mode — CoreAudio rejects HogMode writes
    // while an IOProc is attached to the device.
    this.engine.teardownForReinit()

    if (ownerPid !== process.pid) {
      const status = setHogOwner(caId, process.pid)
      if (status !== 0) {
        // Failed to take hog. Reinit BASS in normal mode so playback can
        // continue, then surface the error.
        this.engine.reinitDevice(currentBass.id)
        await this.restorePlayback(snapshot)
        return {
          enabled: false,
          deviceId: null,
          reason: `CoreAudio rejected hog request: ${coreAudioErrorName(status)}`,
        }
      }
    }

    this.heldDeviceId = caId
    this.enabled = true
    this.engine.reinitDevice(currentBass.id)
    await this.restorePlayback(snapshot)

    const next: ExclusiveModeState = { enabled: true, deviceId: currentBass.id }
    broadcast('audio:exclusive-changed', next)
    return next
  }

  private async doDisable(): Promise<ExclusiveModeState> {
    if (!this.enabled) {
      return { enabled: false, deviceId: null }
    }
    const currentBass = this.engine.getOutputDevice()
    const snapshot = this.snapshotPlayback()

    // Same ordering as enable: free BASS, mutate hog, re-init.
    this.engine.teardownForReinit()

    if (this.heldDeviceId !== null) {
      setHogOwner(this.heldDeviceId, -1)
      this.heldDeviceId = null
    }
    this.enabled = false

    if (currentBass) {
      this.engine.reinitDevice(currentBass.id)
      await this.restorePlayback(snapshot)
    }

    const next: ExclusiveModeState = { enabled: false, deviceId: null }
    broadcast('audio:exclusive-changed', next)
    return next
  }

  private snapshotPlayback(): PlaybackSnapshot {
    return {
      path: this.engine.getCurrentPath(),
      positionSec: this.engine.getPosition(),
      wasPlaying: this.engine.getStatus() === 'playing',
      volume: this.engine.getVolume(),
    }
  }

  private async restorePlayback(snap: PlaybackSnapshot): Promise<void> {
    if (!snap.path) return
    try {
      await this.engine.load(snap.path)
      this.engine.setVolume(snap.volume)
      getEQManager().reapply(this.engine.getCurrentStream())
      if (snap.positionSec > 0) this.engine.seek(snap.positionSec)
      if (snap.wasPlaying) this.engine.play()
    } catch (err) {
      console.warn('[exclusive] failed to restore playback after reinit:', err)
    }
  }

  private getCoreAudioDevices(): CoreAudioDevice[] {
    if (this.coreaudioCache) return this.coreaudioCache
    this.coreaudioCache = enumerateOutputDevices()
    return this.coreaudioCache
  }
}

// Normalize a CoreAudio/BASS device name for loose comparison: lowercase,
// trim, collapse runs of whitespace, and drop common "(n)" suffixes BASS
// appends when there are duplicate names.
function looseName(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/\s*\(\d+\)\s*$/, '')
    .replace(/\s+/g, ' ')
}
