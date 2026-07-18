import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  CLOUD_METADATA_PREFIX_BYTES,
  confidentTechnicalPatch,
  enrichCloudTechnicalTracks,
  readTechnicalMetadataFromPrefix,
} from './cloudTechnicalMetadata.ts'

function wavBuffer({ sampleRate = 48_000, bitDepth = 24, channels = 2, frames = 48_000 } = {}) {
  const bytesPerSample = bitDepth / 8
  const dataBytes = frames * channels * bytesPerSample
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(buffer.length - 8, 4)
  buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28)
  buffer.writeUInt16LE(channels * bytesPerSample, 32)
  buffer.writeUInt16LE(bitDepth, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataBytes, 40)
  return buffer
}

function cloudTrack(patch = {}) {
  return {
    id: 7,
    filename: 'track.wav',
    provider: 'onedrive',
    drive_id: 'drive-current',
    item_id: 'item-current',
    etag: 'etag-current',
    quickxor_hash: 'hash-current',
    codec: null,
    bitrate: null,
    sample_rate: null,
    bit_depth: null,
    channels: null,
    duration: 123,
    file_size: 44,
    ...patch,
  }
}

test('parses trusted technical fields from an in-memory audio prefix', async () => {
  const buffer = wavBuffer()
  const parsed = await readTechnicalMetadataFromPrefix(buffer, {
    filename: 'track.wav',
    fileSize: buffer.length,
  })
  assert.equal(parsed.codec, 'PCM')
  assert.equal(parsed.sampleRate, 48_000)
  assert.equal(parsed.bitDepth, 24)
  assert.equal(parsed.channels, 2)
  assert.equal(parsed.bitrate, 2_304_000)
  assert.equal(parsed.duration, 1)
})

test('keeps valid Graph metadata and rejects implausible parsed values', () => {
  assert.deepEqual(confidentTechnicalPatch(
    cloudTrack({ codec: null, duration: 240 }),
    {
      codec: ' FLAC ',
      codecProfile: null,
      bitrate: Number.POSITIVE_INFINITY,
      sampleRate: -1,
      bitDepth: 500,
      channels: 0,
      duration: 1,
      completeFile: false,
    },
  ), { codec: 'FLAC' })

  assert.deepEqual(confidentTechnicalPatch(
    cloudTrack({
      codec: 'AAC',
      bitrate: 320_000,
      sample_rate: 48_000,
      bit_depth: 24,
      channels: 6,
      duration: 240,
    }),
    {
      codec: 'FLAC',
      codecProfile: null,
      bitrate: 1_411_200,
      sampleRate: 44_100,
      bitDepth: 16,
      channels: 2,
      duration: 180.5,
      completeFile: true,
    },
  ), { bitrate: 1_411_200 })

  assert.deepEqual(confidentTechnicalPatch(
    cloudTrack({ duration: 0 }),
    {
      codec: 'unknown',
      codecProfile: null,
      bitrate: 1_411_200,
      sampleRate: 44_100,
      bitDepth: 16,
      channels: 2,
      duration: 180.5,
      completeFile: true,
    },
  ), {
    bitrate: 1_411_200,
    sampleRate: 44_100,
    bitDepth: 16,
    channels: 2,
    duration: 180.5,
  })
})

test('enrichment is bounded, best-effort, and uses current provider identities', async () => {
  const fetched = []
  const updated = []
  const errors = []
  const tracks = [
    cloudTrack({ id: 1, item_id: 'broken' }),
    cloudTrack({ id: 2, item_id: 'working' }),
    cloudTrack({ id: 3, provider: 'local', drive_id: null, item_id: null }),
  ]
  const enriched = await enrichCloudTechnicalTracks(tracks, {
    fetchPrefix: async (driveId, itemId, maxBytes) => {
      fetched.push([driveId, itemId, maxBytes])
      if (itemId === 'broken') throw new Error('network failure')
      return { buffer: Buffer.from('prefix') }
    },
    parse: async () => ({
      codec: 'FLAC', codecProfile: null, bitrate: 900_000, sampleRate: 96_000,
      bitDepth: 24, channels: 2, duration: 10, completeFile: true,
    }),
    update: (track, patch) => updated.push([track.id, patch]),
    onTrackError: (track, error) => errors.push([track.id, error.message]),
    yield: async () => {},
  }, new AbortController().signal)

  assert.equal(enriched, 1)
  assert.deepEqual(fetched, [
    ['drive-current', 'broken', CLOUD_METADATA_PREFIX_BYTES],
    ['drive-current', 'working', CLOUD_METADATA_PREFIX_BYTES],
  ])
  assert.deepEqual(errors, [[1, 'network failure']])
  assert.deepEqual(updated, [[2, {
    codec: 'FLAC', bitrate: 900_000, sampleRate: 96_000, bitDepth: 24, channels: 2,
  }]])
})

test('enrichment stops before parsing or updating after cancellation', async () => {
  const controller = new AbortController()
  let parsed = false
  let updated = false
  await assert.rejects(enrichCloudTechnicalTracks([cloudTrack()], {
    fetchPrefix: async () => {
      controller.abort()
      return { buffer: Buffer.from('prefix') }
    },
    parse: async () => {
      parsed = true
      return {
        codec: 'FLAC', codecProfile: null, bitrate: null, sampleRate: null,
        bitDepth: null, channels: null, duration: null, completeFile: false,
      }
    },
    update: () => { updated = true },
    yield: async () => {},
  }, controller.signal), error => error.name === 'AbortError')
  assert.equal(parsed, false)
  assert.equal(updated, false)
})
