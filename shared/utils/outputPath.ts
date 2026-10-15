// Describes the audio output path for the player's indicator: what the track
// is, what the device receives, and why they differ (bit-perfect, DAC limits,
// processing). Pure so it can be unit-tested.

import type { OutputInfoPayload } from '../types/ipc-contract'

// Why the output differs from the track (OutputInfoPayload.limitedBy).
// Mirrors CA_LIMIT_* in native/crate-audio/include/crate_audio.h.
export const OUTPUT_LIMIT_DAC_RATE = 0x01
export const OUTPUT_LIMIT_DAC_BITS = 0x02
export const OUTPUT_LIMIT_DAC_CHANNELS = 0x04
export const OUTPUT_LIMIT_FIXED_RATE = 0x08
export const OUTPUT_LIMIT_SETTING_OFF = 0x10

export type OutputPathState = 'idle' | 'bit-perfect' | 'native' | 'converted'

export interface OutputPathDescription {
  state: OutputPathState
  source: string | null      // "16/44.1", "DSD64", "AAC · 44.1 kHz"
  output: string | null      // "24/96"
  headline: string           // "Bit-perfect", "Sin remuestreo", "Remuestreado a 48 kHz"
  reasons: string[]          // why it isn't bit-perfect, most important first
}

export interface OutputProcessing {
  eqEnabled: boolean
}

function khz(rate: number): string {
  const value = rate / 1000
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10)
}

function sourceLabel(info: OutputInfoPayload): string | null {
  if (info.sourceRate == null) return null
  if (info.sourceIsDsd) return `DSD${Math.round(info.sourceRate / 44100)}`
  if (info.sourceLossless && info.sourceBits) {
    return `${info.sourceBits}${info.sourceIsFloat ? 'f' : ''}/${khz(info.sourceRate)}`
  }
  return `${khz(info.sourceRate)} kHz`
}

function outputLabel(info: OutputInfoPayload): string | null {
  if (info.outputRate == null) return null
  return info.outputBits ? `${info.outputBits}/${khz(info.outputRate)}` : `${khz(info.outputRate)} kHz`
}

export function describeOutputPath(
  info: OutputInfoPayload | null,
  processing: OutputProcessing,
  platform: 'macos' | 'windows' | 'linux' = 'macos',
): OutputPathDescription {
  if (!info || !info.open || info.outputRate == null) {
    return { state: 'idle', source: null, output: null, headline: 'Salida cerrada', reasons: [] }
  }
  const source = sourceLabel(info)
  const output = outputLabel(info)
  if (source == null) {
    return { state: 'idle', source: null, output, headline: 'Sin pista', reasons: [] }
  }

  const reasons: string[] = []
  const limited = info.limitedBy
  if (limited & OUTPUT_LIMIT_SETTING_OFF) reasons.push('Bit-perfect está apagado en Ajustes')
  if (limited & OUTPUT_LIMIT_FIXED_RATE) {
    reasons.push(platform === 'windows'
      ? 'En Windows, bit-perfect necesita el modo exclusivo'
      : 'El dispositivo funciona a una frecuencia fija')
  }
  if (limited & OUTPUT_LIMIT_DAC_RATE) {
    reasons.push(info.sourceRate != null && info.sourceRate > info.outputRate && !info.sourceIsDsd
      ? `El DAC llega a ${khz(info.outputRate)} kHz`
      : `El DAC no admite ${khz(info.sourceIsDsd ? (info.sourceRate ?? 0) / 8 : info.sourceRate ?? 0)} kHz`)
  }
  if (limited & OUTPUT_LIMIT_DAC_BITS && info.outputBits) reasons.push(`El DAC llega a ${info.outputBits} bits`)
  if (limited & OUTPUT_LIMIT_DAC_CHANNELS && info.outputChannels) {
    reasons.push(`El dispositivo tiene ${info.outputChannels} canales`)
  }
  if (!info.sourceLossless) reasons.push('El formato del archivo tiene pérdida')
  if (info.volume < 1) reasons.push('Volumen por debajo del 100 %')
  if (processing.eqEnabled) reasons.push('Ecualizador activo')
  if (Math.abs(info.normalizationGain - 1) > 1e-6) reasons.push('Nivelador de volumen activo')

  const untouched = !info.resampled && !info.dithered && !info.downmixed
  if (untouched && reasons.length === 0 && !info.sourceIsDsd) {
    return { state: 'bit-perfect', source, output, headline: 'Bit-perfect', reasons }
  }
  let headline: string
  if (info.resampled) headline = `Remuestreado a ${khz(info.outputRate)} kHz`
  else if (info.downmixed) headline = 'Mezclado a estéreo'
  else if (info.dithered) headline = `Reducido a ${info.outputBits ?? 16} bits con dither`
  else if (info.sourceIsDsd) headline = 'DSD convertido a PCM'
  else headline = 'Sin remuestreo'
  return { state: untouched ? 'native' : 'converted', source, output, headline, reasons }
}
