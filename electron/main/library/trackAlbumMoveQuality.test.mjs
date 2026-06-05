import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  compareTrackQuality,
  describeTrackQuality,
  isLosslessAudio,
  summarizeTrackQuality,
} from './trackAlbumMoveQuality.ts'

test('isLosslessAudio recognises lossless formats and codecs', () => {
  assert.equal(isLosslessAudio('flac'), true)
  assert.equal(isLosslessAudio('FLAC'), true)
  assert.equal(isLosslessAudio('wav'), true)
  assert.equal(isLosslessAudio('aiff'), true)
  // ALAC lives in an mp4/m4a container: trust the codec.
  assert.equal(isLosslessAudio('m4a', 'alac'), true)
  assert.equal(isLosslessAudio('mp4', 'alac'), true)
  assert.equal(isLosslessAudio('mp3'), false)
  assert.equal(isLosslessAudio('m4a', 'aac'), false)
  assert.equal(isLosslessAudio('ogg', 'vorbis'), false)
  assert.equal(isLosslessAudio('opus'), false)
})

test('summarizeTrackQuality maps db row fields', () => {
  assert.deepEqual(
    summarizeTrackQuality({ format: 'flac', codec: 'flac', sample_rate: 96000, bit_depth: 24 }),
    { format: 'flac', lossless: true, sampleRate: 96000, bitDepth: 24 },
  )
  assert.deepEqual(
    summarizeTrackQuality({ format: 'mp3', codec: 'mp3', sample_rate: 44100, bit_depth: null }),
    { format: 'mp3', lossless: false, sampleRate: 44100, bitDepth: null },
  )
})

test('compareTrackQuality prefers lossless, then sample rate, then bit depth', () => {
  const flac = summarizeTrackQuality({ format: 'flac', codec: 'flac', sample_rate: 44100, bit_depth: 16 })
  const mp3 = summarizeTrackQuality({ format: 'mp3', codec: 'mp3', sample_rate: 44100, bit_depth: null })
  // lossless beats lossy regardless of sample rate
  assert.ok(compareTrackQuality(flac, mp3) > 0)
  assert.ok(compareTrackQuality(mp3, flac) < 0)

  const hiRes = summarizeTrackQuality({ format: 'flac', codec: 'flac', sample_rate: 96000, bit_depth: 24 })
  // higher sample rate wins between two lossless files
  assert.ok(compareTrackQuality(hiRes, flac) > 0)

  const flac24 = summarizeTrackQuality({ format: 'flac', codec: 'flac', sample_rate: 44100, bit_depth: 24 })
  // same sample rate -> higher bit depth wins
  assert.ok(compareTrackQuality(flac24, flac) > 0)

  // identical -> tie
  assert.equal(compareTrackQuality(flac, flac), 0)
})

test('compareTrackQuality ignores bitrate (not part of the summary)', () => {
  const lowSr = summarizeTrackQuality({ format: 'mp3', codec: 'mp3', sample_rate: 44100, bit_depth: null })
  const sameSr = summarizeTrackQuality({ format: 'mp3', codec: 'mp3', sample_rate: 44100, bit_depth: null })
  // two lossy files with equal sample rate and no bit depth are a tie even if
  // their bitrates differ — bitrate is intentionally not considered.
  assert.equal(compareTrackQuality(lowSr, sameSr), 0)
})

test('describeTrackQuality builds a compact label', () => {
  assert.equal(
    describeTrackQuality({ format: 'flac', lossless: true, sampleRate: 96000, bitDepth: 24 }),
    'FLAC lossless 96kHz 24bit',
  )
  assert.equal(
    describeTrackQuality({ format: 'mp3', lossless: false, sampleRate: 44100, bitDepth: null }),
    'MP3 lossy 44.1kHz',
  )
})
