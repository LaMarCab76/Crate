// Koffi FFI bindings to the CoreAudio HAL + CoreFoundation, used exclusively
// for taking and releasing hog mode (kAudioDevicePropertyHogMode) on macOS.
// BASS provides no hog-mode primitive on macOS, so we drive the lower-level
// HAL directly and let BASS run on top.
//
// Everything in this module is macOS-only. On Win/Linux loadCoreAudio()
// returns null and every exported helper degrades to a safe no-op.

import { createRequire } from 'node:module'
import {
  coreAudioErrorName,
  kAudioDevicePropertyDeviceUID,
  kAudioDevicePropertyHogMode,
  kAudioDevicePropertyStreamConfiguration,
  kAudioHardwarePropertyDevices,
  kAudioObjectPropertyElementMain,
  kAudioObjectPropertyName,
  kAudioObjectPropertyScopeGlobal,
  kAudioObjectPropertyScopeOutput,
  kAudioObjectSystemObject,
  kCFStringEncodingUTF8,
} from './coreaudio-constants'

const require = createRequire(import.meta.url)
type KoffiNs = typeof import('koffi')
const koffi = require('koffi') as KoffiNs

export interface CoreAudioDevice {
  id: number          // AudioDeviceID (uint32)
  name: string
  uid: string
}

interface PropertyAddress {
  mSelector: number
  mScope: number
  mElement: number
}

interface CoreAudioBindings {
  GetPropertyDataSize: (id: number, addr: PropertyAddress, qSize: number, qData: Buffer | null, outSize: Uint32Array) => number
  GetPropertyData: (id: number, addr: PropertyAddress, qSize: number, qData: Buffer | null, ioSize: Uint32Array, outData: Buffer) => number
  SetPropertyData: (id: number, addr: PropertyAddress, qSize: number, qData: Buffer | null, dataSize: number, inData: Buffer) => number
  CFStringGetCString: (cfStr: unknown, buf: Buffer, bufLen: bigint, encoding: number) => number
  CFRelease: (obj: unknown) => void
}

let bindings: CoreAudioBindings | null = null
let loadFailed = false

function loadCoreAudio(): CoreAudioBindings | null {
  if (bindings) return bindings
  if (loadFailed) return null
  if (process.platform !== 'darwin') {
    loadFailed = true
    return null
  }
  try {
    const ca = koffi.load('/System/Library/Frameworks/CoreAudio.framework/CoreAudio')
    const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')

    koffi.struct('AudioObjectPropertyAddress', {
      mSelector: 'uint32_t',
      mScope: 'uint32_t',
      mElement: 'uint32_t',
    })

    bindings = {
      GetPropertyDataSize: ca.func(
        'int32_t AudioObjectGetPropertyDataSize(uint32_t, const AudioObjectPropertyAddress *, uint32_t, const void *, _Out_ uint32_t *)'
      ),
      GetPropertyData: ca.func(
        'int32_t AudioObjectGetPropertyData(uint32_t, const AudioObjectPropertyAddress *, uint32_t, const void *, _Inout_ uint32_t *, _Out_ void *)'
      ),
      SetPropertyData: ca.func(
        'int32_t AudioObjectSetPropertyData(uint32_t, const AudioObjectPropertyAddress *, uint32_t, const void *, uint32_t, const void *)'
      ),
      CFStringGetCString: cf.func('uint8_t CFStringGetCString(void *, _Out_ char *, int64_t, uint32_t)'),
      CFRelease:          cf.func('void CFRelease(void *)'),
    } as unknown as CoreAudioBindings
    return bindings
  } catch (err) {
    console.warn('[coreaudio] failed to load CoreAudio/CoreFoundation:', err)
    loadFailed = true
    return null
  }
}

function makeAddr(selector: number, scope: number, element: number = kAudioObjectPropertyElementMain): PropertyAddress {
  return { mSelector: selector, mScope: scope, mElement: element }
}

// CoreAudio writes an 8-byte CFStringRef pointer into `buf`; we decode it
// back into a koffi pointer reference, pass it through CFStringGetCString,
// then CFRelease it. Returns '' if anything along the way fails.
function readCFStringFromBuffer(buf: Buffer): string {
  const ca = loadCoreAudio()
  if (!ca) return ''
  if (buf.length < 8) return ''
  let ptr: unknown
  try {
    ptr = koffi.decode(buf, 'void *')
  } catch {
    return ''
  }
  if (!ptr) return ''
  const out = Buffer.alloc(1024)
  let str = ''
  try {
    const ok = ca.CFStringGetCString(ptr, out, BigInt(out.length), kCFStringEncodingUTF8)
    if (ok) {
      const nul = out.indexOf(0)
      str = out.toString('utf8', 0, nul < 0 ? out.length : nul)
    }
  } finally {
    try { ca.CFRelease(ptr) } catch { /* best-effort */ }
  }
  return str
}

function readCFStringProperty(id: number, selector: number, scope: number): string {
  const ca = loadCoreAudio()
  if (!ca) return ''
  const addr = makeAddr(selector, scope)
  const sizeOut = new Uint32Array(1)
  if (ca.GetPropertyDataSize(id, addr, 0, null, sizeOut) !== 0) return ''
  const size = sizeOut[0]
  if (size < 8) return ''
  const buf = Buffer.alloc(size)
  const ioSize = new Uint32Array(1)
  ioSize[0] = size
  if (ca.GetPropertyData(id, addr, 0, null, ioSize, buf) !== 0) return ''
  return readCFStringFromBuffer(buf)
}

// AudioBufferList layout: { UInt32 mNumberBuffers; AudioBuffer mBuffers[1]; }
// A device with output streams has mNumberBuffers > 0 under the output scope.
function deviceHasOutputStreams(id: number): boolean {
  const ca = loadCoreAudio()
  if (!ca) return false
  const addr = makeAddr(kAudioDevicePropertyStreamConfiguration, kAudioObjectPropertyScopeOutput)
  const sizeOut = new Uint32Array(1)
  if (ca.GetPropertyDataSize(id, addr, 0, null, sizeOut) !== 0) return false
  if (sizeOut[0] < 4) return false
  const buf = Buffer.alloc(sizeOut[0])
  const ioSize = new Uint32Array(1)
  ioSize[0] = sizeOut[0]
  if (ca.GetPropertyData(id, addr, 0, null, ioSize, buf) !== 0) return false
  return buf.readUInt32LE(0) > 0
}

// Lists every device the system can route audio out through. Used by
// ExclusiveModeManager to match BASS device names/drivers against CoreAudio
// IDs. Returns an empty array on non-macOS or if the load failed.
export function enumerateOutputDevices(): CoreAudioDevice[] {
  const ca = loadCoreAudio()
  if (!ca) return []
  const addr = makeAddr(kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal)
  const sizeOut = new Uint32Array(1)
  if (ca.GetPropertyDataSize(kAudioObjectSystemObject, addr, 0, null, sizeOut) !== 0) return []
  const totalBytes = sizeOut[0]
  if (totalBytes === 0) return []
  const buf = Buffer.alloc(totalBytes)
  const ioSize = new Uint32Array(1)
  ioSize[0] = totalBytes
  if (ca.GetPropertyData(kAudioObjectSystemObject, addr, 0, null, ioSize, buf) !== 0) return []
  const count = Math.floor(totalBytes / 4)
  const devices: CoreAudioDevice[] = []
  for (let i = 0; i < count; i++) {
    const id = buf.readUInt32LE(i * 4)
    if (!deviceHasOutputStreams(id)) continue
    const name = readCFStringProperty(id, kAudioObjectPropertyName, kAudioObjectPropertyScopeGlobal)
    const uid = readCFStringProperty(id, kAudioDevicePropertyDeviceUID, kAudioObjectPropertyScopeGlobal)
    devices.push({ id, name, uid })
  }
  return devices
}

// pid_t holding hog ownership. -1 → device is free, otherwise the owning
// process's pid. Returns -1 on any error / non-macOS as a safe sentinel.
export function getHogOwner(deviceId: number): number {
  const ca = loadCoreAudio()
  if (!ca) return -1
  const addr = makeAddr(kAudioDevicePropertyHogMode, kAudioObjectPropertyScopeGlobal)
  const buf = Buffer.alloc(4)
  const ioSize = new Uint32Array(1)
  ioSize[0] = 4
  if (ca.GetPropertyData(deviceId, addr, 0, null, ioSize, buf) !== 0) return -1
  return buf.readInt32LE(0)
}

// Returns 0 on success or a CoreAudio OSStatus error code. Pass `process.pid`
// to take ownership, `-1` to release.
export function setHogOwner(deviceId: number, pid: number): number {
  const ca = loadCoreAudio()
  if (!ca) return -1
  const addr = makeAddr(kAudioDevicePropertyHogMode, kAudioObjectPropertyScopeGlobal)
  const buf = Buffer.alloc(4)
  buf.writeInt32LE(pid, 0)
  return ca.SetPropertyData(deviceId, addr, 0, null, 4, buf)
}

export function isCoreAudioAvailable(): boolean {
  return loadCoreAudio() !== null
}

export { coreAudioErrorName }
