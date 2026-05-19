// Gapless dual-stream swap. We preload the next track ahead of time and use
// BASS_SYNC_END to switch to it the moment the current stream finishes.
//
// CRITICAL: koffi callbacks are GC-rooted only as long as we hold a JS
// reference to them. BASS keeps a native pointer to the callback function;
// if the JS callback is collected before BASS_ChannelRemoveSync is called,
// BASS will dereference garbage memory and segfault inside its audio thread.
// We therefore keep every registered SYNCPROC alive in a module-level Map
// keyed by the sync handle until the corresponding RemoveSync call returns.

import { createRequire } from 'node:module'
import { broadcast } from '../ipc/events'

const require = createRequire(import.meta.url)
const koffi = require('koffi') as typeof import('koffi')

import { BASS_SYNC_END, BASS_SYNC_ONETIME } from './bass-constants'
import { loadBass, SYNCPROC, type HSTREAM, type HSYNC } from './bass-ffi'
import type { AudioEngine } from './AudioEngine'

interface PreloadedStream {
  path: string
  handle: HSTREAM
  duration: number
}

// Module-level retention of native callbacks. We can't put these on the
// instance because some BASS callback paths can fire after the controller
// would otherwise be GC'd — keeping the map at module scope guarantees the
// retention spans the entire process lifetime.
//
// koffi.register returns its own pointer type — we hold it as `unknown` in
// our own types but pass through to koffi APIs that need it via casts.
type KoffiCallbackPtr = Parameters<typeof koffi.unregister>[0]
type RegisteredCallback = { sync: HSYNC; channel: HSTREAM; cb: KoffiCallbackPtr }
const retainedCallbacks = new Set<RegisteredCallback>()

function registerEndSync(channel: HSTREAM, handler: () => void): RegisteredCallback {
  const bass = loadBass()
  // The SYNCPROC signature is: (HSYNC, channel, data, user). We ignore all
  // four args because we close over `handler` in JS.
  const cb = koffi.register(() => {
    try { handler() } catch (err) { console.error('[gapless] sync handler error:', err) }
  }, koffi.pointer(SYNCPROC)) as KoffiCallbackPtr

  const sync = bass.ChannelSetSync(channel, BASS_SYNC_END | BASS_SYNC_ONETIME, 0n, cb, 0n)
  const entry: RegisteredCallback = { sync, channel, cb }
  retainedCallbacks.add(entry)
  return entry
}

function releaseCallback(entry: RegisteredCallback): void {
  const bass = loadBass()
  bass.ChannelRemoveSync(entry.channel, entry.sync)
  retainedCallbacks.delete(entry)
  // koffi.unregister requires the pointer we got back from register.
  try { koffi.unregister(entry.cb) } catch { /* already unregistered */ }
}

export class GaplessController {
  private next: PreloadedStream | null = null
  private nextRegistration: RegisteredCallback | null = null

  constructor(private engine: AudioEngine) {}

  // Preload a track. Idempotent for the same path. The end-of-stream sync is
  // attached to the CURRENT stream so that when it finishes we swap to the
  // preloaded one and start playback in the same audio thread tick.
  preloadNext(path: string): void {
    if (this.next && this.next.path === path) return
    this.clearNext()

    const created = this.engine.createStream(path)
    this.next = {
      path,
      handle: created.handle,
      duration: created.info.duration,
    }

    const currentStream = this.engine.getCurrentStream()
    if (currentStream === 0) {
      // Nothing playing yet — we'll just hold onto the preload. The caller
      // can promote it via swapToNext() whenever it's ready.
      return
    }
    this.nextRegistration = registerEndSync(currentStream, () => this.swapToNext())
  }

  // Forcibly swap to the preloaded stream right now (used when the user hits
  // "Next" before the current track ends, OR fired automatically by the
  // BASS_SYNC_END callback above).
  swapToNext(): boolean {
    if (!this.next) return false
    const preloaded = this.next
    this.next = null

    // We no longer need the end-sync — the current stream is about to be freed.
    if (this.nextRegistration) {
      // Mark for release on a microtask so we don't unregister inside the
      // callback that triggered us (which would leave dangling state).
      const reg = this.nextRegistration
      this.nextRegistration = null
      queueMicrotask(() => releaseCallback(reg))
    }

    const old = this.engine.releaseCurrent()
    if (old.handle !== 0) this.engine.freeStream(old.handle)
    this.engine.adoptStream(preloaded.handle, preloaded.path)
    const bass = loadBass()
    bass.ChannelPlay(preloaded.handle, 0)
    broadcast('audio:gapless-fired', { path: preloaded.path })
    return true
  }

  // Drop the preloaded stream without playing it (e.g. queue was modified).
  clearNext(): void {
    if (!this.next) return
    this.engine.freeStream(this.next.handle)
    this.next = null
    if (this.nextRegistration) {
      const reg = this.nextRegistration
      this.nextRegistration = null
      releaseCallback(reg)
    }
  }

  movePreloadedToOutputDevice(deviceId: number): boolean {
    if (!this.next) return true
    const moved = this.engine.moveStreamToOutputDevice(this.next.handle, deviceId)
    if (!moved) this.clearNext()
    return moved
  }

  hasNext(): boolean { return this.next !== null }
  getNextPath(): string | null { return this.next?.path ?? null }
}
