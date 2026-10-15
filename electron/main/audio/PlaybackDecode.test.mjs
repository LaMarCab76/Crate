import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Compares the FFmpeg-engine analysis with the values AudioEngine computed
// with BASS (native/crate-audio/tests/golden/capture-bass.mjs).
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const NATIVE_DIR = join(REPO_ROOT, 'native', 'libs')
const FIXTURES = join(REPO_ROOT, 'native', 'crate-audio', 'tests', 'fixtures')
const GOLDEN = join(REPO_ROOT, 'native', 'crate-audio', 'tests', 'golden')
const libraryName = process.platform === 'win32' ? 'crate_audio.dll' : process.platform === 'linux' ? 'libcrate_audio.so' : 'libcrate_audio.dylib'
const haveEngine = existsSync(join(NATIVE_DIR, libraryName))

process.env.CRATE_AUDIO_NATIVE_DIR ??= NATIVE_DIR
const { decodeTableBarsAnalysis, decodeWaveformAnalysis } = await import('./PlaybackDecode.ts')

const FIXTURE_NAMES = ['flac-44100-16-stereo.flac', 'pcm-22050-16-mono.wav', 'flac-48000-16-5.1.flac']

for (const fixture of FIXTURE_NAMES) {
  const golden = JSON.parse(readFileSync(join(GOLDEN, `analysis-${fixture}.json`), 'utf8'))

  test(`waveform of ${fixture} matches BASS`, { skip: !haveEngine && 'crate-audio is not built' }, async () => {
    const result = await decodeWaveformAnalysis(join(FIXTURES, fixture), 1200)
    assert.equal(result.peaks.length, golden.waveform.peaks.length)
    let worst = 0
    for (let i = 0; i < result.peaks.length; i++) worst = Math.max(worst, Math.abs(result.peaks[i] - golden.waveform.peaks[i]))
    assert.ok(worst < 1e-6, `peak envelope differs by ${worst}`)
    assert.ok(Math.abs(result.peakDb - golden.waveform.peakDb) < 1e-4, `peakDb ${result.peakDb} vs ${golden.waveform.peakDb}`)
    assert.ok(Math.abs(result.drApprox - golden.waveform.drApprox) < 1e-4, `drApprox ${result.drApprox} vs ${golden.waveform.drApprox}`)
  })

  test(`table bars of ${fixture} match BASS`, { skip: !haveEngine && 'crate-audio is not built' }, async () => {
    const result = await decodeTableBarsAnalysis(join(FIXTURES, fixture))
    assert.equal(result.frames, golden.tableBars.frames)
    assert.ok(Math.abs(result.durationSec - golden.tableBars.durationSec) < 1e-9)
    // Frames whose 2048-sample window runs past the end are windowed over the
    // remaining samples; BASS's exact stretch is only approximated there.
    const rate = { 'flac-44100-16-stereo.flac': 44100, 'pcm-22050-16-mono.wav': 22050, 'flac-48000-16-5.1.flac': 48000 }[fixture]
    const totalFrames = Math.round(golden.tableBars.durationSec * rate)
    let worst = 0
    let worstTail = 0
    let worstIndex = -1
    for (let i = 0; i < result.values.length; i++) {
      const frame = Math.floor(i / 5)
      const partial = Math.floor(Math.min(golden.tableBars.durationSec, frame / 60) * rate) + 2049 > totalFrames
      const diff = Math.abs(result.values[i] - golden.tableBars.values[i])
      if (partial) worstTail = Math.max(worstTail, diff)
      else if (diff > worst) { worst = diff; worstIndex = i }
    }
    assert.ok(worst < 1e-3, `table bars differ by ${worst} at frame ${Math.floor(worstIndex / 5)} band ${worstIndex % 5}`)
    assert.ok(worstTail < 0.05, `table bars of the final partial frames differ by ${worstTail}`)
  })
}
