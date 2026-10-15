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

test('setting off and Windows shared mode name their cause', () => {
  assert.deepEqual(
    describeOutputPath(info({ sourceRate: 44100, outputRate: 48000, resampled: true, limitedBy: OUTPUT_LIMIT_SETTING_OFF }), noProcessing).reasons,
    ['Bit-perfect está apagado en Ajustes'],
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
