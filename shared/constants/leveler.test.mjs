import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  RG_REFERENCE_LUFS,
  LEVELER_DEFAULTS,
  LEVELER_MAX_GAIN_DB,
  LEVELER_CLIP_HEADROOM_DB,
  LEVELER_TARGET_MIN,
  LEVELER_TARGET_MAX,
  clampTargetLufs,
  normalizeLevelerConfig,
  dbToLinear,
  lufsFromReplayGain,
  estimateLufsFromAnalysis,
  levelerGainDb,
  levelerGainLinear,
  formatLevelerGain,
} from './leveler.ts'

test('dbToLinear maps 0 dB to unity and ±6 dB sensibly', () => {
  assert.equal(dbToLinear(0), 1)
  assert.ok(Math.abs(dbToLinear(6) - 1.9953) < 0.001)
  assert.ok(Math.abs(dbToLinear(-6) - 0.5012) < 0.001)
})

test('clampTargetLufs clamps and rounds, falling back to default', () => {
  assert.equal(clampTargetLufs(-18), -18)
  assert.equal(clampTargetLufs(-18.4), -18)
  assert.equal(clampTargetLufs(-1000), LEVELER_TARGET_MIN)
  assert.equal(clampTargetLufs(0), LEVELER_TARGET_MAX)
  assert.equal(clampTargetLufs(undefined), LEVELER_DEFAULTS.targetLufs)
  assert.equal(clampTargetLufs(Number.NaN), LEVELER_DEFAULTS.targetLufs)
})

test('normalizeLevelerConfig coerces partial/legacy shapes', () => {
  assert.deepEqual(normalizeLevelerConfig(null), LEVELER_DEFAULTS)
  assert.deepEqual(normalizeLevelerConfig({}), LEVELER_DEFAULTS)
  assert.deepEqual(
    normalizeLevelerConfig({ enabled: true, targetLufs: -14, preventClipping: false }),
    { enabled: true, targetLufs: -14, preventClipping: false },
  )
  // preventClipping defaults to true when omitted
  assert.equal(normalizeLevelerConfig({ enabled: true }).preventClipping, true)
})

test('lufsFromReplayGain inverts the -18 LUFS reference', () => {
  assert.equal(lufsFromReplayGain(0), RG_REFERENCE_LUFS)
  assert.equal(lufsFromReplayGain(-5), -13) // hot master, negative RG
  assert.equal(lufsFromReplayGain(3), -21) // quiet master, positive RG
  assert.equal(lufsFromReplayGain(null), null)
})

test('estimateLufsFromAnalysis derives RMS dBFS from peak + crest factor', () => {
  // peakDb -1, drApprox 13 → rms -14
  assert.equal(estimateLufsFromAnalysis(-1, 13), -14)
  assert.equal(estimateLufsFromAnalysis(null, 13), null)
  assert.equal(estimateLufsFromAnalysis(-1, null), null)
})

test('levelerGainDb returns 0 when disabled or no loudness', () => {
  const cfg = { enabled: false, targetLufs: -18, preventClipping: true }
  assert.equal(levelerGainDb(cfg, { trackLufs: -30, peakDb: -1 }), 0)
  assert.equal(levelerGainDb({ ...cfg, enabled: true }, { trackLufs: null, peakDb: -1 }), 0)
})

test('levelerGainDb boosts quiet tracks and attenuates loud ones', () => {
  const cfg = { enabled: true, targetLufs: -18, preventClipping: false }
  // quiet track at -24 → +6 dB boost
  assert.equal(levelerGainDb(cfg, { trackLufs: -24, peakDb: -12 }), 6)
  // loud track at -12 → -6 dB cut
  assert.equal(levelerGainDb(cfg, { trackLufs: -12, peakDb: -1 }), -6)
})

test('levelerGainDb clamps to the max gain range', () => {
  const cfg = { enabled: true, targetLufs: -6, preventClipping: false }
  // -40 LUFS toward -6 would be +34 dB, clamped to +15
  assert.equal(levelerGainDb(cfg, { trackLufs: -40, peakDb: -30 }), LEVELER_MAX_GAIN_DB)
})

test('preventClipping caps a boost so post-gain peak keeps headroom', () => {
  const cfg = { enabled: true, targetLufs: -10, preventClipping: true }
  // quiet track: target -10, lufs -20 → +10 dB desired, but peak is -3 dBFS.
  // max gain to keep peak <= -0.5 is -(-3) - 0.5 = 2.5 dB.
  const gain = levelerGainDb(cfg, { trackLufs: -20, peakDb: -3 })
  assert.equal(gain, 3 - LEVELER_CLIP_HEADROOM_DB)
})

test('preventClipping does not cap when there is enough headroom', () => {
  const cfg = { enabled: true, targetLufs: -10, preventClipping: true }
  // peak is -20 dBFS, +10 dB boost lands at -10 dBFS — well clear.
  assert.equal(levelerGainDb(cfg, { trackLufs: -20, peakDb: -20 }), 10)
})

test('levelerGainLinear is the linear form of the dB gain', () => {
  const cfg = { enabled: true, targetLufs: -18, preventClipping: false }
  const loud = { trackLufs: -24, peakDb: -12 }
  assert.ok(Math.abs(levelerGainLinear(cfg, loud) - dbToLinear(6)) < 1e-9)
  // disabled → unity
  assert.equal(levelerGainLinear({ ...cfg, enabled: false }, loud), 1)
})

test('formatLevelerGain renders signed one-decimal dB', () => {
  assert.equal(formatLevelerGain(0), '0.0 dB')
  assert.equal(formatLevelerGain(3), '+3.0 dB')
  assert.equal(formatLevelerGain(-1.5), '−1.5 dB')
})
