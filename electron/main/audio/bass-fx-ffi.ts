// koffi bindings for libbass_fx.dylib. We expose only what we actually use:
// the 10-band peaking equalizer. Reverb / volume FX live in the same library
// and can be added later by adding more struct definitions and func calls.

import * as koffiNs from 'koffi'
import { app } from 'electron'
import { join } from 'node:path'

const koffi = ((koffiNs as unknown as { default?: typeof koffiNs }).default ?? koffiNs)

// BASS_BFX_PEAKEQ layout (see old_swift/HiFidelity/Core/Audio/bass-include/bass_fx.h).
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

interface BassFxBindings {
  lib: ReturnType<typeof koffi.load>
  FXSetParameters: (handle: number, params: PeakEqParams) => number
  FXGetParameters: (handle: number, out: object) => number
  GetVersion:      () => number
}

let bindings: BassFxBindings | null = null

function nativeLibPath(name: string): string {
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
  return join(base, 'native', 'libs', name)
}

export function loadBassFx(): BassFxBindings {
  if (bindings) return bindings
  const lib = koffi.load(nativeLibPath('libbass_fx.dylib'))
  bindings = {
    lib,
    FXSetParameters: lib.func('int32_t BASS_FXSetParameters(uint32_t, const BASS_BFX_PEAKEQ *)'),
    FXGetParameters: lib.func('int32_t BASS_FXGetParameters(uint32_t, _Out_ BASS_BFX_PEAKEQ *)'),
    GetVersion:      lib.func('uint32_t BASS_FX_GetVersion(void)'),
  }
  return bindings
}

// Default 10-band frequency layout (matches AudioEffectsManager.swift in the
// legacy app). All bands start flat (0 dB gain), bandwidth 1 octave.
export const DEFAULT_EQ_FREQS: ReadonlyArray<number> = [
  32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000,
]

export const BASS_BFX_CHANALL = -1
