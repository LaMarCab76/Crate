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
import { getRepos } from '../db/repositories'
import { getOneDriveClient } from '../cloud/OneDriveClient'
import { resolveCloudLoadOptions } from '../cloud/cloudTrackRef'
import { getAudioEngine, type AudioEngine } from './AudioEngine'
import { getEQManager } from './EQManager'
import {
  restoreExclusivePlaybackSnapshot,
  type ExclusivePlaybackSnapshot,
} from './exclusivePlaybackSnapshot'
import {
  coreAudioErrorName,
  enumerateOutputDevices,
  getHogOwner,
  isCoreAudioAvailable,
  setHogOwner,
  type CoreAudioDevice,
} from './coreaudio-ffi'
import type { AudioOutputDevice, ExclusiveModeState } from '@shared/types/ipc-contract'

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

    let snapshot: ExclusivePlaybackSnapshot
    try {
      snapshot = await this.snapshotPlayback()
    } catch (err) {
      return { enabled: false, deviceId: null, reason: `Could not snapshot playback: ${errorMessage(err)}` }
    }

    try {
      // Free BASS before touching hog mode — CoreAudio rejects HogMode writes
      // while an IOProc is attached to the device.
      this.engine.teardownForReinit()
    } catch (err) {
      return { enabled: false, deviceId: null, reason: `Could not prepare audio for exclusive mode: ${errorMessage(err)}` }
    }

    if (ownerPid !== process.pid) {
      const status = setHogOwner(caId, process.pid)
      if (status !== 0) {
        // Failed to take hog. Reinit BASS in normal mode so playback can
        // continue, then surface the error.
        try {
          this.engine.reinitDevice(currentBass.id)
          await this.restorePlayback(snapshot)
        } catch (rollbackErr) {
          return {
            enabled: false,
            deviceId: null,
            reason: `CoreAudio rejected hog request and normal playback could not be restored: ${errorMessage(rollbackErr)}`,
          }
        }
        return {
          enabled: false,
          deviceId: null,
          reason: `CoreAudio rejected hog request: ${coreAudioErrorName(status)}`,
        }
      }
    }

    this.heldDeviceId = caId
    this.enabled = true
    try {
      this.engine.reinitDevice(currentBass.id)
      await this.restorePlayback(snapshot)
    } catch (err) {
      // Taking hog is not success until BASS and the previous stream have both
      // been restored. Release ownership and rebuild the normal output path.
      try { setHogOwner(caId, -1) } catch { /* reported below */ }
      this.heldDeviceId = null
      this.enabled = false
      try {
        this.engine.teardownForReinit()
        this.engine.reinitDevice(currentBass.id)
        await this.restorePlayback(snapshot)
      } catch (rollbackErr) {
        return {
          enabled: false,
          deviceId: null,
          reason: `Exclusive mode failed (${errorMessage(err)}); normal playback rollback also failed: ${errorMessage(rollbackErr)}`,
        }
      }
      return { enabled: false, deviceId: null, reason: `Exclusive mode failed and was rolled back: ${errorMessage(err)}` }
    }

    const next: ExclusiveModeState = { enabled: true, deviceId: currentBass.id }
    broadcast('audio:exclusive-changed', next)
    return next
  }

  private async doDisable(): Promise<ExclusiveModeState> {
    if (!this.enabled) {
      return { enabled: false, deviceId: null }
    }
    const currentBass = this.engine.getOutputDevice()
    let snapshot: ExclusivePlaybackSnapshot
    try {
      snapshot = await this.snapshotPlayback()
    } catch (err) {
      return {
        enabled: true,
        deviceId: currentBass?.id ?? null,
        reason: `Could not snapshot playback before leaving exclusive mode: ${errorMessage(err)}`,
      }
    }

    // Same ordering as enable: free BASS, mutate hog, re-init.
    this.engine.teardownForReinit()

    const heldDeviceId = this.heldDeviceId
    if (heldDeviceId !== null) {
      const releaseStatus = setHogOwner(heldDeviceId, -1)
      if (releaseStatus !== 0) {
        this.engine.reinitDevice(currentBass?.id ?? -1)
        await this.restorePlayback(snapshot)
        return {
          enabled: true,
          deviceId: currentBass?.id ?? null,
          reason: `CoreAudio rejected exclusive-mode release: ${coreAudioErrorName(releaseStatus)}`,
        }
      }
      this.heldDeviceId = null
    }
    this.enabled = false

    if (currentBass) {
      try {
        this.engine.reinitDevice(currentBass.id)
        await this.restorePlayback(snapshot)
      } catch (err) {
        // Restore the previous exclusive state if normal reinitialization failed.
        if (heldDeviceId !== null && setHogOwner(heldDeviceId, process.pid) === 0) {
          this.heldDeviceId = heldDeviceId
          this.enabled = true
          this.engine.teardownForReinit()
          this.engine.reinitDevice(currentBass.id)
          await this.restorePlayback(snapshot)
          return { enabled: true, deviceId: currentBass.id, reason: `Normal-mode restore failed; exclusive mode was restored: ${errorMessage(err)}` }
        }
        throw err
      }
    }

    const next: ExclusiveModeState = { enabled: false, deviceId: null }
    broadcast('audio:exclusive-changed', next)
    return next
  }

  private async snapshotPlayback(): Promise<ExclusivePlaybackSnapshot> {
    const path = this.engine.getCurrentPath()
    const track = path ? getRepos().tracks.getByPath(path) : null
    const cloud = track?.provider === 'onedrive'
      ? await resolveCloudLoadOptions(track, getOneDriveClient())
      : null
    if (path?.startsWith('onedrive://') && !cloud) {
      throw new Error('OneDrive track is no longer indexed with a valid cloud reference')
    }
    return {
      path,
      positionSec: this.engine.getPosition(),
      estimatedDurationSec: this.engine.getStreamInfo()?.duration ?? track?.duration ?? null,
      wasPlaying: this.engine.getStatus() === 'playing',
      volume: this.engine.getVolume(),
      cloudRef: cloud?.cloudRef ?? null,
      cloudSizeBytes: cloud?.cloudSizeBytes ?? null,
    }
  }

  private async restorePlayback(snap: ExclusivePlaybackSnapshot): Promise<void> {
    await restoreExclusivePlaybackSnapshot(
      this.engine,
      snap,
      stream => getEQManager().reapply(stream),
    )
  }

  private getCoreAudioDevices(): CoreAudioDevice[] {
    if (this.coreaudioCache) return this.coreaudioCache
    this.coreaudioCache = enumerateOutputDevices()
    return this.coreaudioCache
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
