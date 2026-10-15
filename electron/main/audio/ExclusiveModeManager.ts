// Exclusive output: CoreAudio hog mode on macOS, WASAPI exclusive mode on
// Windows. The native engine does the work — it reopens the device in the new
// mode and keeps playing from the same sample — so this manager only
// serialises requests, reports the outcome and makes sure the device is
// released when the app exits.

import { broadcast } from '../ipc/events'
import { getAudioEngine, type AudioEngine } from './AudioEngine'
import type { AudioOutputDevice, ExclusiveModeState } from '@shared/types/ipc-contract'

let manager: ExclusiveModeManager | null = null

export function getExclusiveModeManager(): ExclusiveModeManager {
  if (!manager) {
    manager = new ExclusiveModeManager(getAudioEngine())
    manager.registerProcessExitHook()
    // Exclusive mode follows the user to another output device.
    getAudioEngine().setOnDeviceChanged(() => {
      void manager!.handleDeviceSwitch()
    })
  }
  return manager
}

function supportedPlatform(): boolean {
  return process.platform === 'darwin' || process.platform === 'win32'
}

export class ExclusiveModeManager {
  private engine: AudioEngine
  private inFlight: Promise<unknown> | null = null
  private exitHookInstalled = false

  constructor(engine: AudioEngine) {
    this.engine = engine
  }

  registerProcessExitHook(): void {
    if (this.exitHookInstalled) return
    this.exitHookInstalled = true
    // Backstop for will-quit: never leave a device hog-locked or at a rate the
    // user did not choose.
    process.on('exit', () => {
      try { this.engine.dispose() } catch { /* exiting anyway */ }
    })
  }

  getState(): ExclusiveModeState {
    const info = this.engine.getOutputInfoPayload()
    const enabled = this.engine.getOutputPolicy().exclusive && info.exclusive
    return { enabled, deviceId: enabled ? this.engine.getOutputDevice()?.id ?? null : null }
  }

  isSupportedDevice(device: AudioOutputDevice): boolean {
    return supportedPlatform() && device.supportsExclusive
  }

  invalidateCache(): void {
    // Device capabilities are read fresh from the engine on every listing.
  }

  async enable(): Promise<ExclusiveModeState> {
    return this.runExclusive(() => this.apply(true))
  }

  async disable(): Promise<ExclusiveModeState> {
    return this.runExclusive(() => this.apply(false))
  }

  // The engine keeps the exclusive policy when it reopens another device;
  // report whether the new device accepted it.
  async handleDeviceSwitch(): Promise<void> {
    if (!this.engine.getOutputPolicy().exclusive) return
    await this.runExclusive(async () => {
      const state = this.getState()
      if (!state.enabled) {
        await this.engine.setOutputPolicy({ exclusive: false })
        broadcast('audio:exclusive-changed', {
          ...this.getState(),
          reason: 'The new output device does not allow exclusive access',
        })
      } else {
        broadcast('audio:exclusive-changed', state)
      }
    })
  }

  dispose(): void {
    // The engine releases exclusive access when it closes the output.
  }

  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = (this.inFlight as Promise<T> | null) ?? Promise.resolve()
    const next = run.then(() => task(), () => task()).finally(() => {
      if (this.inFlight === next) this.inFlight = null
    })
    this.inFlight = next
    return next
  }

  private async apply(enabled: boolean): Promise<ExclusiveModeState> {
    if (enabled && !supportedPlatform()) {
      return { enabled: false, deviceId: null, reason: 'Exclusive mode is available on macOS and Windows' }
    }
    const device = this.engine.getOutputDevice()
    if (enabled && device && !device.supportsExclusive) {
      return { enabled: false, deviceId: null, reason: `"${device.name}" does not allow exclusive access` }
    }
    try {
      await this.engine.setOutputPolicy({ exclusive: enabled })
    } catch (error) {
      await this.engine.setOutputPolicy({ exclusive: false }).catch(() => undefined)
      const state: ExclusiveModeState = {
        enabled: false,
        deviceId: null,
        reason: `Exclusive mode failed: ${error instanceof Error ? error.message : String(error)}`,
      }
      broadcast('audio:exclusive-changed', state)
      return state
    }
    let state = this.getState()
    if (enabled && !state.enabled) {
      // The device refused exclusive access and the engine fell back to shared.
      await this.engine.setOutputPolicy({ exclusive: false })
      state = {
        ...this.getState(),
        reason: 'The device is in exclusive use by another app or refused exclusive access',
      }
    }
    broadcast('audio:exclusive-changed', state)
    return state
  }
}
