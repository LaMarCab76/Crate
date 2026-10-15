#!/usr/bin/env node
// Regenerates the crate_audio test fixtures from synthetic tones. Dev-only:
// the generated files are committed, so CI never needs these encoders.
//
// Requires: flac, lame, oggenc, opusenc, wavpack, mac (Monkey's Audio),
// mpcenc, speexenc, afconvert (macOS) and an ffmpeg CLI that has the tta
// encoder and webm muxer (pass --ffmpeg=/path/to/ffmpeg).
//
// Every PCM sample is round(amp * sin(2*pi*f*n/rate) * (2^(bits-1) - 1));
// tests/test_decoder.c recomputes the same tone to check lossless decodes.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = dirname(fileURLToPath(import.meta.url))
const FFMPEG = process.argv.find(arg => arg.startsWith('--ffmpeg='))?.slice('--ffmpeg='.length) ?? 'ffmpeg'
const WORK = mkdtempSync(join(tmpdir(), 'crate-audio-fixtures-'))

// Per-channel tone frequencies and amplitudes (kept in sync with test_decoder.c).
const FREQS = [440, 660, 880, 550, 330, 990]
const AMPS = [0.5, 0.4, 0.3, 0.3, 0.3, 0.3]
// Gapless pairs split the 1 s reference at a point that is not a codec frame boundary.
const SPLIT_44100 = 26497
const SPLIT_48000 = 28837
// Ogg packs about a second per page and FFmpeg mis-trims streams that fit in a
// single page, so the Vorbis pair uses a 3 s reference (real tracks are longer).
const SPLIT_LONG_44100 = 70497

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error) throw new Error(`${command} is unavailable: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`)
}

function toneSample(channel, n, rate) {
  return AMPS[channel] * Math.sin((2 * Math.PI * FREQS[channel] * n) / rate)
}

function intTone({ rate, channels, bits, start = 0, frames }) {
  const scale = 2 ** (bits - 1) - 1
  const data = new Int32Array(frames * channels)
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) data[i * channels + c] = Math.round(toneSample(c, start + i, rate) * scale)
  }
  return data
}

function floatTone({ rate, channels, frames }) {
  const data = new Float32Array(frames * channels)
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) data[i * channels + c] = toneSample(c, i, rate)
  }
  return data
}

function wav({ rate, channels, bits, samples, float = false }) {
  const bytesPerSample = bits / 8
  const dataBytes = samples.length * bytesPerSample
  const extensible = channels > 2
  const fmtSize = extensible ? 40 : 16
  const buffer = Buffer.alloc(12 + 8 + fmtSize + 8 + dataBytes)
  let o = 0
  buffer.write('RIFF', o); o += 4
  buffer.writeUInt32LE(buffer.length - 8, o); o += 4
  buffer.write('WAVE', o); o += 4
  buffer.write('fmt ', o); o += 4
  buffer.writeUInt32LE(fmtSize, o); o += 4
  buffer.writeUInt16LE(extensible ? 0xfffe : float ? 3 : 1, o); o += 2
  buffer.writeUInt16LE(channels, o); o += 2
  buffer.writeUInt32LE(rate, o); o += 4
  buffer.writeUInt32LE(rate * channels * bytesPerSample, o); o += 4
  buffer.writeUInt16LE(channels * bytesPerSample, o); o += 2
  buffer.writeUInt16LE(bits, o); o += 2
  if (extensible) {
    buffer.writeUInt16LE(22, o); o += 2
    buffer.writeUInt16LE(bits, o); o += 2
    buffer.writeUInt32LE(channels === 6 ? 0x3f : (1 << channels) - 1, o); o += 4
    // KSDATAFORMAT_SUBTYPE_PCM / _IEEE_FLOAT
    Buffer.from(float ? '0300000000001000800000aa00389b71' : '0100000000001000800000aa00389b71', 'hex').copy(buffer, o); o += 16
  }
  buffer.write('data', o); o += 4
  buffer.writeUInt32LE(dataBytes, o); o += 4
  for (const value of samples) {
    if (float) buffer.writeFloatLE(value, o)
    else if (bits === 16) buffer.writeInt16LE(value, o)
    else if (bits === 24) buffer.writeIntLE(value, o, 3)
    else buffer.writeInt32LE(value, o)
    o += bytesPerSample
  }
  return buffer
}

function extended80(value) {
  // IEEE 754 80-bit extended, as used by the AIFF COMM chunk.
  const buffer = Buffer.alloc(10)
  const exponent = Math.floor(Math.log2(value))
  buffer.writeUInt16BE(16383 + exponent, 0)
  const mantissa = value / 2 ** exponent
  const high = Math.floor(mantissa * 2 ** 31)
  const low = Math.floor((mantissa * 2 ** 31 - high) * 2 ** 32)
  buffer.writeUInt32BE(high >>> 0, 2)
  buffer.writeUInt32BE(low >>> 0, 6)
  return buffer
}

function aiff({ rate, channels, bits, samples }) {
  const bytesPerSample = bits / 8
  const frames = samples.length / channels
  const dataBytes = samples.length * bytesPerSample
  const buffer = Buffer.alloc(12 + 26 + 16 + dataBytes)
  let o = 0
  buffer.write('FORM', o); o += 4
  buffer.writeUInt32BE(buffer.length - 8, o); o += 4
  buffer.write('AIFF', o); o += 4
  buffer.write('COMM', o); o += 4
  buffer.writeUInt32BE(18, o); o += 4
  buffer.writeUInt16BE(channels, o); o += 2
  buffer.writeUInt32BE(frames, o); o += 4
  buffer.writeUInt16BE(bits, o); o += 2
  extended80(rate).copy(buffer, o); o += 10
  buffer.write('SSND', o); o += 4
  buffer.writeUInt32BE(8 + dataBytes, o); o += 4
  buffer.writeUInt32BE(0, o); o += 4
  buffer.writeUInt32BE(0, o); o += 4
  for (const value of samples) {
    if (bits === 16) buffer.writeInt16BE(value, o)
    else buffer.writeIntBE(value, o, 3)
    o += bytesPerSample
  }
  return buffer
}

// Second-order delta-sigma modulator: one bit per sample, +1 / -1.
function dsdBits({ rate, channels, frames, amplitudeScale }) {
  const bits = []
  for (let c = 0; c < channels; c++) {
    const out = new Uint8Array(frames)
    let v1 = 0
    let v2 = 0
    let y = 1
    for (let n = 0; n < frames; n++) {
      const x = toneSample(c, n, rate) * amplitudeScale
      v1 += x - y
      v2 += v1 - y
      y = v2 >= 0 ? 1 : -1
      out[n] = y > 0 ? 1 : 0
    }
    bits.push(out)
  }
  return bits
}

function dsf({ rate, channels, bits }) {
  const frames = bits[0].length
  const bytesPerChannel = Math.ceil(frames / 8)
  const blockSize = 4096
  const blocks = Math.ceil(bytesPerChannel / blockSize)
  const dataBytes = blocks * blockSize * channels
  const buffer = Buffer.alloc(28 + 52 + 12 + dataBytes)
  let o = 0
  buffer.write('DSD ', o); o += 4
  buffer.writeBigUInt64LE(28n, o); o += 8
  buffer.writeBigUInt64LE(BigInt(buffer.length), o); o += 8
  buffer.writeBigUInt64LE(0n, o); o += 8
  buffer.write('fmt ', o); o += 4
  buffer.writeBigUInt64LE(52n, o); o += 8
  buffer.writeUInt32LE(1, o); o += 4           // format version
  buffer.writeUInt32LE(0, o); o += 4           // DSD raw
  buffer.writeUInt32LE(channels === 2 ? 2 : 1, o); o += 4
  buffer.writeUInt32LE(channels, o); o += 4
  buffer.writeUInt32LE(rate, o); o += 4
  buffer.writeUInt32LE(1, o); o += 4           // bits per sample: LSB first
  buffer.writeBigUInt64LE(BigInt(frames), o); o += 8
  buffer.writeUInt32LE(blockSize, o); o += 4
  buffer.writeUInt32LE(0, o); o += 4
  buffer.write('data', o); o += 4
  buffer.writeBigUInt64LE(BigInt(12 + dataBytes), o); o += 8
  for (let block = 0; block < blocks; block++) {
    for (let c = 0; c < channels; c++) {
      for (let i = 0; i < blockSize; i++) {
        const byteIndex = block * blockSize + i
        let byte = 0
        for (let bit = 0; bit < 8; bit++) {
          const n = byteIndex * 8 + bit
          if (n < frames && bits[c][n]) byte |= 1 << bit
        }
        buffer[o++] = byte
      }
    }
  }
  return buffer
}

function dff({ rate, channels, bits }) {
  const frames = bits[0].length
  const bytesPerChannel = Math.ceil(frames / 8)
  const dataBytes = bytesPerChannel * channels
  const cmpr = Buffer.concat([Buffer.from('DSD '), Buffer.from([14]), Buffer.from('not compressed'), Buffer.alloc(1)])
  const chnl = Buffer.alloc(2 + 4 * channels)
  chnl.writeUInt16BE(channels, 0)
  for (let c = 0; c < channels; c++) chnl.write(c === 0 ? 'SLFT' : 'SRGT', 2 + 4 * c)
  const fs = Buffer.alloc(4)
  fs.writeUInt32BE(rate, 0)
  const chunk = (id, body, sizeOverride) => {
    const header = Buffer.alloc(12)
    header.write(id, 0)
    header.writeBigUInt64BE(BigInt(sizeOverride ?? body.length), 4)
    return Buffer.concat([header, body])
  }
  const prop = chunk('PROP', Buffer.concat([
    Buffer.from('SND '),
    chunk('FS  ', fs),
    chunk('CHNL', chnl),
    chunk('CMPR', cmpr, cmpr.length - 1),
  ]))
  const data = Buffer.alloc(dataBytes)
  for (let byteIndex = 0; byteIndex < bytesPerChannel; byteIndex++) {
    for (let c = 0; c < channels; c++) {
      let byte = 0
      for (let bit = 0; bit < 8; bit++) {
        const n = byteIndex * 8 + bit
        if (n < frames && bits[c][n]) byte |= 0x80 >> bit
      }
      data[byteIndex * channels + c] = byte
    }
  }
  const fver = Buffer.alloc(4)
  fver.writeUInt32BE(0x01050000, 0)
  const body = Buffer.concat([Buffer.from('DSD '), chunk('FVER', fver), prop, chunk('DSD ', data)])
  return chunk('FRM8', body)
}

function writeOut(name, buffer) {
  writeFileSync(join(OUT, name), buffer)
  console.log(`  ${name} (${buffer.length} bytes)`)
}

function work(name, buffer) {
  const path = join(WORK, name)
  writeFileSync(path, buffer)
  return path
}

function out(name) {
  return join(OUT, name)
}

try {
  console.log(`[fixtures] writing to ${OUT}`)

  // Reference PCM.
  const ref441 = wav({ rate: 44100, channels: 2, bits: 16, samples: intTone({ rate: 44100, channels: 2, bits: 16, frames: 44100 }) })
  writeOut('ref-44100-16-stereo.wav', ref441)
  const ref441Path = out('ref-44100-16-stereo.wav')
  const ref48 = work('ref-48000.wav', wav({ rate: 48000, channels: 2, bits: 16, samples: intTone({ rate: 48000, channels: 2, bits: 16, frames: 48000 }) }))

  writeOut('pcm-44100-24-stereo.wav', wav({ rate: 44100, channels: 2, bits: 24, samples: intTone({ rate: 44100, channels: 2, bits: 24, frames: 22050 }) }))
  writeOut('pcm-48000-f32-stereo.wav', wav({ rate: 48000, channels: 2, bits: 32, float: true, samples: floatTone({ rate: 48000, channels: 2, frames: 24000 }) }))
  writeOut('pcm-22050-16-mono.wav', wav({ rate: 22050, channels: 1, bits: 16, samples: intTone({ rate: 22050, channels: 1, bits: 16, frames: 11025 }) }))
  writeOut('aiff-44100-16-stereo.aiff', aiff({ rate: 44100, channels: 2, bits: 16, samples: intTone({ rate: 44100, channels: 2, bits: 16, frames: 22050 }) }))
  writeOut('aiff-48000-24-stereo.aif', aiff({ rate: 48000, channels: 2, bits: 24, samples: intTone({ rate: 48000, channels: 2, bits: 24, frames: 12000 }) }))

  // Lossless codecs.
  run('flac', ['--silent', '--best', '-f', '-o', out('flac-44100-16-stereo.flac'), ref441Path])
  const hires96 = work('hires-96.wav', wav({ rate: 96000, channels: 2, bits: 24, samples: intTone({ rate: 96000, channels: 2, bits: 24, frames: 48000 }) }))
  run('flac', ['--silent', '--best', '-f', '-o', out('flac-96000-24-stereo.flac'), hires96])
  const hires192 = work('hires-192.wav', wav({ rate: 192000, channels: 2, bits: 24, samples: intTone({ rate: 192000, channels: 2, bits: 24, frames: 48000 }) }))
  run('flac', ['--silent', '--best', '-f', '-o', out('flac-192000-24-stereo.flac'), hires192])
  const surround = work('surround.wav', wav({ rate: 48000, channels: 6, bits: 16, samples: intTone({ rate: 48000, channels: 6, bits: 16, frames: 24000 }) }))
  run('flac', ['--silent', '--best', '-f', '-o', out('flac-48000-16-5.1.flac'), surround])
  run('afconvert', ['-f', 'm4af', '-d', 'alac', ref441Path, out('alac-44100-16-stereo.m4a')])
  run('afconvert', ['-f', 'm4af', '-d', 'alac', hires96, out('alac-96000-24-stereo.m4a')])
  run('mac', [ref441Path, out('ape-44100-16-stereo.ape'), '-c2000'])
  run('wavpack', ['-q', '-y', '-hh', ref441Path, '-o', out('wavpack-44100-16-stereo.wv')])
  run(FFMPEG, ['-v', 'error', '-y', '-i', ref441Path, '-c:a', 'tta', out('tta-44100-16-stereo.tta')])

  // Lossy codecs.
  run('afconvert', ['-f', 'm4af', '-d', 'aac', '-b', '192000', ref441Path, out('aac-44100-stereo.m4a')])
  run('lame', ['--quiet', '-b', '192', ref441Path, out('mp3-44100-stereo.mp3')])
  run('oggenc', ['--quiet', '-q', '6', '-o', out('vorbis-44100-stereo.ogg'), ref441Path])
  run('opusenc', ['--quiet', '--bitrate', '160', ref48, out('opus-48000-stereo.opus')])
  run(FFMPEG, ['-v', 'error', '-y', '-i', out('opus-48000-stereo.opus'), '-c:a', 'copy', '-f', 'webm', out('opus-48000-stereo.webm')])
  run('mpcenc', ['--silent', '--overwrite', '--quality', '6', ref441Path, out('mpc-44100-stereo.mpc')])
  const speech = work('speech-32000.wav', wav({ rate: 32000, channels: 1, bits: 16, samples: intTone({ rate: 32000, channels: 1, bits: 16, frames: 32000 }) }))
  run('speexenc', ['--quiet', '--ultra-wideband', '--quality', '8', speech, out('speex-32000-mono.spx')])

  // DSD: 0.25 s of DSD64 and DSD128 at -12 dB (half of SACD's 0 dB level).
  const dsd64 = dsdBits({ rate: 2822400, channels: 2, frames: 2822400 / 4, amplitudeScale: 0.5 })
  writeOut('dsd64-stereo.dsf', dsf({ rate: 2822400, channels: 2, bits: dsd64 }))
  writeOut('dsd64-stereo.dff', dff({ rate: 2822400, channels: 2, bits: dsd64 }))
  const dsd128 = dsdBits({ rate: 5644800, channels: 2, frames: 5644800 / 8, amplitudeScale: 0.5 })
  writeOut('dsd128-stereo.dsf', dsf({ rate: 5644800, channels: 2, bits: dsd128 }))

  // Gapless pairs: the 1 s reference split in two.
  const partA441 = work('gapless-a-44100.wav', wav({ rate: 44100, channels: 2, bits: 16, samples: intTone({ rate: 44100, channels: 2, bits: 16, frames: SPLIT_44100 }) }))
  const partB441 = work('gapless-b-44100.wav', wav({ rate: 44100, channels: 2, bits: 16, samples: intTone({ rate: 44100, channels: 2, bits: 16, start: SPLIT_44100, frames: 44100 - SPLIT_44100 }) }))
  const partA48 = work('gapless-a-48000.wav', wav({ rate: 48000, channels: 2, bits: 16, samples: intTone({ rate: 48000, channels: 2, bits: 16, frames: SPLIT_48000 }) }))
  const partB48 = work('gapless-b-48000.wav', wav({ rate: 48000, channels: 2, bits: 16, samples: intTone({ rate: 48000, channels: 2, bits: 16, start: SPLIT_48000, frames: 48000 - SPLIT_48000 }) }))
  for (const [part, path, path48] of [['a', partA441, partA48], ['b', partB441, partB48]]) {
    writeOut(`gapless-${part}.wav`, readFileSync(path))
    run('flac', ['--silent', '--best', '-f', '-o', out(`gapless-${part}.flac`), path])
    run('lame', ['--quiet', '-b', '192', path, out(`gapless-${part}.mp3`)])
    run('afconvert', ['-f', 'm4af', '-d', 'aac', '-b', '192000', path, out(`gapless-${part}.m4a`)])
    run('opusenc', ['--quiet', '--bitrate', '160', path48, out(`gapless-${part}.opus`)])
  }

  const longA = work('gapless-long-a.wav', wav({ rate: 44100, channels: 2, bits: 16, samples: intTone({ rate: 44100, channels: 2, bits: 16, frames: SPLIT_LONG_44100 }) }))
  const longB = work('gapless-long-b.wav', wav({ rate: 44100, channels: 2, bits: 16, samples: intTone({ rate: 44100, channels: 2, bits: 16, start: SPLIT_LONG_44100, frames: 3 * 44100 - SPLIT_LONG_44100 }) }))
  run('oggenc', ['--quiet', '-q', '6', '-o', out('gapless-long-a.ogg'), longA])
  run('oggenc', ['--quiet', '-q', '6', '-o', out('gapless-long-b.ogg'), longB])

  // Broken inputs.
  const flacBytes = readFileSync(out('flac-44100-16-stereo.flac'))
  writeOut('broken-truncated.flac', flacBytes.subarray(0, Math.floor(flacBytes.length * 0.6)))
  const garbage = Buffer.alloc(8192)
  let state = 0x2545f491
  for (let i = 0; i < garbage.length; i++) {
    state ^= state << 13; state >>>= 0
    state ^= state >>> 17
    state ^= state << 5; state >>>= 0
    garbage[i] = state & 0xff
  }
  writeOut('broken-garbage.mp3', garbage)
  writeOut('broken-empty.flac', Buffer.alloc(0))

  console.log('[fixtures] done')
} finally {
  rmSync(WORK, { recursive: true, force: true })
}
