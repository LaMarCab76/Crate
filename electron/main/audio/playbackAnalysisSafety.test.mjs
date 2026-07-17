import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { requireFilesystemPlaybackAnalysisPath } from './playbackAnalysisSafety.ts'

test('playback analysis rejects OneDrive identities before native filesystem work', () => {
  assert.equal(requireFilesystemPlaybackAnalysisPath('/Music/song.flac', 'local'), '/Music/song.flac')
  assert.throws(
    () => requireFilesystemPlaybackAnalysisPath('onedrive://drive/item'),
    /unavailable for OneDrive/,
  )
  assert.throws(
    () => requireFilesystemPlaybackAnalysisPath('/synthetic/cloud/path.flac', 'onedrive'),
    /unavailable for OneDrive/,
  )
})

test('analysis service applies the cloud and current-library guards before stat/native decode', () => {
  const source = readFileSync(new URL('./PlaybackAnalysisService.ts', import.meta.url), 'utf8')
  assert.match(
    source,
    /function fingerprintFor[\s\S]*?requireFilesystemPlaybackAnalysisPath\(track\.path, track\.provider\)[\s\S]*?statSync\(track\.path\)/,
  )
  assert.match(
    source,
    /private async decodeAndStore[\s\S]*?this\.requireCurrentLocalTrack\(track\)[\s\S]*?decodePlaybackAnalysis\(current\.path/,
  )
  assert.match(
    source,
    /private async decodeAndStoreTableBars[\s\S]*?this\.requireCurrentLocalTrack\(track\)[\s\S]*?decodeTableBars\(current\.path\)/,
  )
})
