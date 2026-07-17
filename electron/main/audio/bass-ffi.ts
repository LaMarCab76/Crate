// koffi FFI bindings to the platform-specific BASS core library.
// Loaded lazily so the module can be imported in test environments without
// the native libraries being present.

// koffi exports a single `default` from its ESM entry. Under Electron the
// `import * as` + unwrap dance fails at runtime in the bundled output, so
// we go through `createRequire` to grab the CJS export directly — this gives
// us the koffi object straight, no interop quirks.
import { createRequire } from 'node:module'
import { bassLibPath } from './bass-paths'

const require = createRequire(import.meta.url)
type KoffiNs = typeof import('koffi')
const koffi = require('koffi') as KoffiNs

// Numeric handle types — all DWORDs (uint32) under the hood.
export type HSTREAM = number
export type HSYNC   = number
export type HFX     = number
export type HPLUGIN = number

export interface BassChannelInfo {
  freq: number
  chans: number
  flags: number
  ctype: number
  origres: number
  plugin: number
  sample: number
  filename: string | null
}

export interface BassDeviceInfo {
  name: string | null
  driver: string | null
  flags: number
}

// SYNCPROC signature: void (HSYNC handle, DWORD channel, DWORD data, void *user)
export const SYNCPROC = koffi.proto('void SYNCPROC(uint32_t, uint32_t, uint32_t, void*)')

// BASS_CHANNELINFO struct layout (see bass.h).
const BASS_CHANNELINFO = koffi.struct('BASS_CHANNELINFO', {
  freq:     'uint32_t',
  chans:    'uint32_t',
  flags:    'uint32_t',
  ctype:    'uint32_t',
  origres:  'uint32_t',
  plugin:   'uint32_t',
  sample:   'uint32_t',
  filename: 'const char*',
})

// BASS_DEVICEINFO struct layout (see bass.h).
const BASS_DEVICEINFO = koffi.struct('BASS_DEVICEINFO', {
  name:   'const char*',
  driver: 'const char*',
  flags:  'uint32_t',
})

interface BassBindings {
  lib: ReturnType<typeof koffi.load>
  Init: (device: number, freq: number, flags: number, win: bigint, dsguid: bigint) => number
  Free: () => number
  GetDeviceInfo: (device: number, info: object) => number
  SetDevice: (device: number) => number
  GetDevice: () => number
  Start: () => number
  ErrorGetCode: () => number
  PluginLoad: (file: string, flags: number) => number
  SetConfig: (option: number, value: number) => number
  GetConfig: (option: number) => number
  StreamCreateFile: (filetype: number, file: string, offset: bigint, length: bigint, flags: number) => number
  StreamCreateFileMemory: (filetype: number, file: Buffer, offset: bigint, length: bigint, flags: number) => number
  StreamGetFilePosition: (handle: number, mode: number) => bigint
  StreamFree: (handle: number) => number
  ChannelPlay: (handle: number, restart: number) => number
  ChannelPause: (handle: number) => number
  ChannelStop: (handle: number) => number
  ChannelIsActive: (handle: number) => number
  ChannelGetLength: (handle: number, mode: number) => bigint
  ChannelGetPosition: (handle: number, mode: number) => bigint
  ChannelSetPosition: (handle: number, pos: bigint, mode: number) => number
  ChannelSetAttribute: (handle: number, attrib: number, value: number) => number
  ChannelGetAttribute: (handle: number, attrib: number, outValue: Float32Array) => number
  ChannelSetSync: (handle: number, type: number, param: bigint, proc: unknown, user: bigint) => number
  ChannelRemoveSync: (handle: number, sync: number) => number
  ChannelSetFX: (handle: number, type: number, priority: number) => number
  ChannelRemoveFX: (handle: number, fx: number) => number
  ChannelGetInfo: (handle: number, info: object) => number
  ChannelGetData: (handle: number, buffer: Float32Array, length: number) => number
  ChannelGetLevelEx: (handle: number, levels: Float32Array, length: number, flags: number) => number
  ChannelSetDevice: (handle: number, device: number) => number
}

let bindings: BassBindings | null = null

export function loadBass(): BassBindings {
  if (bindings) return bindings

  const lib = koffi.load(bassLibPath('bass'))

  bindings = {
    lib,
    Init:               lib.func('int32_t BASS_Init(int32_t, uint32_t, uint32_t, uint64_t, uint64_t)'),
    Free:               lib.func('int32_t BASS_Free(void)'),
    GetDeviceInfo:      lib.func('int32_t BASS_GetDeviceInfo(uint32_t, _Out_ BASS_DEVICEINFO *)'),
    SetDevice:          lib.func('int32_t BASS_SetDevice(uint32_t)'),
    GetDevice:          lib.func('uint32_t BASS_GetDevice(void)'),
    Start:              lib.func('int32_t BASS_Start(void)'),
    ErrorGetCode:       lib.func('int32_t BASS_ErrorGetCode(void)'),
    PluginLoad:         lib.func('uint32_t BASS_PluginLoad(const char *, uint32_t)'),
    SetConfig:          lib.func('int32_t BASS_SetConfig(uint32_t, uint32_t)'),
    GetConfig:          lib.func('uint32_t BASS_GetConfig(uint32_t)'),
    StreamCreateFile:   lib.func('uint32_t BASS_StreamCreateFile(int32_t, const char *, uint64_t, uint64_t, uint32_t)'),
    StreamCreateFileMemory: lib.func('BASS_StreamCreateFile', 'uint32_t', ['int32_t', 'const void *', 'uint64_t', 'uint64_t', 'uint32_t']),
    StreamGetFilePosition: lib.func('uint64_t BASS_StreamGetFilePosition(uint32_t, uint32_t)'),
    StreamFree:         lib.func('int32_t BASS_StreamFree(uint32_t)'),
    ChannelPlay:        lib.func('int32_t BASS_ChannelPlay(uint32_t, int32_t)'),
    ChannelPause:       lib.func('int32_t BASS_ChannelPause(uint32_t)'),
    ChannelStop:        lib.func('int32_t BASS_ChannelStop(uint32_t)'),
    ChannelIsActive:    lib.func('uint32_t BASS_ChannelIsActive(uint32_t)'),
    ChannelGetLength:   lib.func('uint64_t BASS_ChannelGetLength(uint32_t, uint32_t)'),
    ChannelGetPosition: lib.func('uint64_t BASS_ChannelGetPosition(uint32_t, uint32_t)'),
    ChannelSetPosition: lib.func('int32_t BASS_ChannelSetPosition(uint32_t, uint64_t, uint32_t)'),
    ChannelSetAttribute:lib.func('int32_t BASS_ChannelSetAttribute(uint32_t, uint32_t, float)'),
    ChannelGetAttribute:lib.func('int32_t BASS_ChannelGetAttribute(uint32_t, uint32_t, _Out_ float *)'),
    ChannelSetSync:     lib.func('uint32_t BASS_ChannelSetSync(uint32_t, uint32_t, uint64_t, SYNCPROC*, void *)'),
    ChannelRemoveSync:  lib.func('int32_t BASS_ChannelRemoveSync(uint32_t, uint32_t)'),
    ChannelSetFX:       lib.func('uint32_t BASS_ChannelSetFX(uint32_t, uint32_t, int32_t)'),
    ChannelRemoveFX:    lib.func('int32_t BASS_ChannelRemoveFX(uint32_t, uint32_t)'),
    ChannelGetInfo:     lib.func('int32_t BASS_ChannelGetInfo(uint32_t, _Out_ BASS_CHANNELINFO *)'),
    ChannelGetData:     lib.func('uint32_t BASS_ChannelGetData(uint32_t, _Out_ float *, uint32_t)'),
    ChannelGetLevelEx:  lib.func('int32_t BASS_ChannelGetLevelEx(uint32_t, _Out_ float *, float, uint32_t)'),
    ChannelSetDevice:   lib.func('int32_t BASS_ChannelSetDevice(uint32_t, uint32_t)'),
  } as unknown as BassBindings

  // Force koffi to register the struct under the name used in func signatures above.
  void BASS_CHANNELINFO
  void BASS_DEVICEINFO

  return bindings
}

// Helper to convert seconds → BASS byte position via the seconds-to-bytes API.
// We do this inline using length/duration ratio rather than calling
// BASS_ChannelSeconds2Bytes to keep the binding surface small.
export function makeChannelGetInfo(): (h: number) => BassChannelInfo {
  const b = loadBass()
  return (handle: number): BassChannelInfo => {
    const info = {
      freq: 0, chans: 0, flags: 0, ctype: 0,
      origres: 0, plugin: 0, sample: 0, filename: null,
    } as Record<string, unknown>
    b.ChannelGetInfo(handle, info)
    return info as unknown as BassChannelInfo
  }
}
