import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  OUTPUT_LIMIT_DAC_BITS,
  OUTPUT_LIMIT_DAC_RATE,
  OUTPUT_LIMIT_FIXED_RATE,
  OUTPUT_LIMIT_SETTING_OFF,
  describeOutputPath,
} from './outputPath.ts'

function info(overrides = {}) {
  return {
    open: true,
    deviceName: 'DAC',
    exclusive: false,
    bitPerfectSetting: true,
    sourceRate: 96000,
    sourceBits: 24,
    sourceIsDsd: false,
    sourceIsFloat: false,
    sourceLossless: true,
    sourceChannels: 2,
    outputRate: 96000,
    outputBits: 24,
    outputChannels: 2,
    resampled: false,
    dithered: false,
    downmixed: false,
    limitedBy: 0,
    volume: 1,
    normalizationGain: 1,
    ...overrides,
  }
}

const noProcessing = { eqEnabled: false }

test('untouched lossless output at unity gain is bit-perfect', () => {
  const d = describeOutputPath(info(), noProcessing)
  assert.equal(d.state, 'bit-perfect')
  assert.equal(d.headline, 'Bit-perfect')
  assert.equal(d.source, '24/96')
  assert.equal(d.output, '24/96')
  assert.deepEqual(d.reasons, [])
})

test('a deeper format than the file is not bit-perfect', () => {
  const d = describeOutputPath(info({ sourceRate: 44100, sourceBits: 16, outputRate: 44100, outputBits: 24, limitedBy: OUTPUT_LIMIT_DAC_BITS }), noProcessing)
  assert.equal(d.state, 'native')
  assert.equal(d.headline, 'Ampliado a 24 bits')
  assert.equal(d.source, '16/44.1')
  assert.equal(d.output, '24/44.1')
  assert.deepEqual(d.reasons, ['El DAC no admite 16 bits'])
})

test('a faster rate than the file is not bit-perfect', () => {
  const d = describeOutputPath(info({ sourceRate: 44100, outputRate: 88200, resampled: true, limitedBy: OUTPUT_LIMIT_DAC_RATE }), noProcessing)
  assert.equal(d.state, 'converted')
  assert.equal(d.headline, 'Remuestreado a 88.2 kHz')
  assert.deepEqual(d.reasons, ['El DAC no admite 44.1 kHz'])
})

test('a device that ignored the requested format is reported as it is', () => {
  const bits = describeOutputPath(info({ sourceBits: 16, outputBits: 24 }), noProcessing)
  assert.notEqual(bits.state, 'bit-perfect')
  assert.deepEqual(bits.reasons, ['El dispositivo está a 24 bits'])
  const rate = describeOutputPath(info({ outputRate: 48000, resampled: true }), noProcessing)
  assert.equal(rate.state, 'converted')
  assert.deepEqual(rate.reasons, ['El dispositivo está a 48 kHz'])
})

test('a float file never reaches the DAC bit-perfect', () => {
  const d = describeOutputPath(info({ sourceBits: 32, sourceIsFloat: true, outputBits: 32 }), noProcessing)
  assert.equal(d.state, 'native')
  assert.equal(d.source, '32f/96')
  assert.deepEqual(d.reasons, ['El archivo es de coma flotante'])
})

test('a DAC that tops out below the track explains the downsample', () => {
  const d = describeOutputPath(info({ sourceRate: 192000, outputRate: 96000, resampled: true, limitedBy: OUTPUT_LIMIT_DAC_RATE }), noProcessing)
  assert.equal(d.state, 'converted')
  assert.equal(d.headline, 'Remuestreado a 96 kHz')
  assert.deepEqual(d.reasons, ['El DAC llega a 96 kHz'])
  assert.equal(d.source, '24/192')
})

test('a 16-bit DAC reports dither and its limit', () => {
  const d = describeOutputPath(info({ outputBits: 16, dithered: true, limitedBy: OUTPUT_LIMIT_DAC_BITS }), noProcessing)
  assert.equal(d.headline, 'Reducido a 16 bits con dither')
  assert.deepEqual(d.reasons, ['El DAC llega a 16 bits'])
})

test('processing keeps the rate but is not bit-perfect', () => {
  const d = describeOutputPath(info({ volume: 0.5 }), { eqEnabled: true })
  assert.equal(d.state, 'native')
  assert.equal(d.headline, 'Sin remuestreo')
  assert.deepEqual(d.reasons, ['Volumen por debajo del 100 %', 'Ecualizador activo'])
})

test('a shallower format without dither is a conversion', () => {
  const d = describeOutputPath(info({ sourceBits: 32, outputBits: 24, limitedBy: OUTPUT_LIMIT_DAC_BITS }), noProcessing)
  assert.equal(d.state, 'converted')
  assert.equal(d.headline, 'Reducido a 24 bits')
  assert.deepEqual(d.reasons, ['El DAC llega a 24 bits'])
})

test('setting off and Windows shared mode name their cause', () => {
  assert.deepEqual(
    describeOutputPath(info({ sourceRate: 44100, outputRate: 48000, resampled: true, limitedBy: OUTPUT_LIMIT_SETTING_OFF }), noProcessing).reasons,
    ['Bit-perfect está apagado en Ajustes'],
  )
  assert.deepEqual(
    describeOutputPath(info({ sourceBits: 16, outputBits: 24, limitedBy: OUTPUT_LIMIT_SETTING_OFF }), noProcessing).reasons,
    ['Bit-perfect está apagado en Ajustes'],
  )
  assert.deepEqual(
    describeOutputPath(info({ sourceBits: 16, outputBits: 24, limitedBy: OUTPUT_LIMIT_FIXED_RATE }), noProcessing).reasons,
    ['El dispositivo funciona con un formato fijo'],
  )
  assert.deepEqual(
    describeOutputPath(info({ sourceRate: 44100, outputRate: 48000, resampled: true, limitedBy: OUTPUT_LIMIT_FIXED_RATE }), noProcessing, 'windows').reasons,
    ['En Windows, bit-perfect necesita el modo exclusivo'],
  )
})

test('DSD and lossy sources are labelled and never bit-perfect', () => {
  const dsd = describeOutputPath(info({ sourceRate: 2822400, sourceBits: 1, sourceIsDsd: true, outputRate: 352800, outputBits: 32 }), noProcessing)
  assert.equal(dsd.source, 'DSD64')
  assert.equal(dsd.headline, 'DSD convertido a PCM')
  const lossy = describeOutputPath(info({ sourceRate: 44100, sourceBits: 0, sourceLossless: false, outputRate: 44100 }), noProcessing)
  assert.equal(lossy.source, '44.1 kHz')
  assert.equal(lossy.state, 'native')
})

test('nothing loaded or output closed', () => {
  assert.equal(describeOutputPath(info({ sourceRate: null }), noProcessing).headline, 'Sin pista')
  assert.equal(describeOutputPath(null, noProcessing).state, 'idle')
})
