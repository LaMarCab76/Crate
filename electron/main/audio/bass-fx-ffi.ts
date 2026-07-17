// koffi bindings for the platform-specific BASS_FX library. We expose only
// what we actually use for the equalizer. Reverb / volume FX live in the same
// library and can be added later by adding more struct definitions and calls.

import { createRequire } from 'node:module'
import { loadBass } from './bass-ffi'
import { bassLibPath } from './bass-paths'

const require = createRequire(import.meta.url)
const koffi = require('koffi') as typeof import('koffi')

// BASS_BFX_PEAKEQ layout (see bass_fx.h from un4seen.com).
export const BASS_BFX_PEAKEQ = koffi.struct('BASS_BFX_PEAKEQ', {
  lBand:      'int32_t',
  fBandwidth: 'float',
  fQ:         'float',
  fCenter:    'float',
  fGain:      'float',
  lChannel:   'int32_t',
})

export interface PeakEqParams {
  lBand: number
  fBandwidth: number
  fQ: number
  fCenter: number
  fGain: number
  lChannel: number
}

// BASS_BFX_BQF layout (see bass_fx.h). We use it with the PEAKINGEQ filter so
// each EQ band is a standalone biquad filter instead of relying on PEAKEQ's
// internal multi-band state.
export const BASS_BFX_BQF = koffi.struct('BASS_BFX_BQF', {
  lFilter:    'int32_t',
  fCenter:    'float',
  fGain:      'float',
  fBandwidth: 'float',
  fQ:         'float',
  fS:         'float',
  lChannel:   'int32_t',
})

export interface BqfParams {
  lFilter: number
  fCenter: number
  fGain: number
  fBandwidth: number
  fQ: number
  fS: number
  lChannel: number
}

interface BassFxBindings {
  lib: ReturnType<typeof koffi.load>
  FXSetParameters: (handle: number, params: PeakEqParams) => number
  FXGetParameters: (handle: number, out: object) => number
  FXSetBqfParameters: (handle: number, params: BqfParams) => number
  FXGetBqfParameters: (handle: number, out: object) => number
  GetVersion:      () => number
}

let bindings: BassFxBindings | null = null

export function loadBassFx(): BassFxBindings {
  if (bindings) return bindings
  // Loading libbass_fx runs its static constructor, which registers the BFX
  // effects with the core BASS so BASS_ChannelSetFX recognises them.
  const fxLib = koffi.load(bassLibPath('bass_fx'))
  // BASS_FXSet/GetParameters are CORE BASS exports (libbass_fx only exports
  // BASS_FX_GetVersion), so bind them from the same libbass handle bass-ffi
  // already opened rather than relying on dlsym traversing the dependency.
  const core = loadBass().lib
  bindings = {
    lib: fxLib,
    FXSetParameters: core.func('int32_t BASS_FXSetParameters(uint32_t, const BASS_BFX_PEAKEQ *)'),
    FXGetParameters: core.func('int32_t BASS_FXGetParameters(uint32_t, _Out_ BASS_BFX_PEAKEQ *)'),
    FXSetBqfParameters: core.func('int32_t BASS_FXSetParameters(uint32_t, const BASS_BFX_BQF *)'),
    FXGetBqfParameters: core.func('int32_t BASS_FXGetParameters(uint32_t, _Out_ BASS_BFX_BQF *)'),
    GetVersion:      fxLib.func('uint32_t BASS_FX_GetVersion(void)'),
  }
  return bindings
}

export const BASS_BFX_CHANALL = -1
export const BASS_BFX_BQF_PEAKINGEQ = 6
