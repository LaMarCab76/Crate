import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseFile } from 'music-metadata'
import { writeTrackMetadata } from './MetadataWriter.ts'

// Smallest FLAC taglib accepts: the magic, a STREAMINFO block and a Vorbis
// comment. No audio frames are needed to read and rewrite tags.
function metadataBlock(type, body, last) {
  const header = Buffer.alloc(4)
  header[0] = (last ? 0x80 : 0) | type
  header.writeUIntBE(body.length, 1, 3)
  return Buffer.concat([header, body])
}

function streamInfo() {
  const body = Buffer.alloc(34)
  body.writeUInt16BE(4096, 0)
  body.writeUInt16BE(4096, 2)
  const sampleRate = 44100
  body[10] = (sampleRate >> 12) & 0xff
  body[11] = (sampleRate >> 4) & 0xff
  body[12] = ((sampleRate & 0x0f) << 4) | (1 << 1) // 2 channels, 16-bit
  body[13] = 0xf0
  return body
}

function vorbisComment(fields) {
  const vendor = Buffer.from('crate-test')
  const parts = [Buffer.alloc(4), vendor, Buffer.alloc(4)]
  parts[0].writeUInt32LE(vendor.length)
  parts[2].writeUInt32LE(fields.length)
  for (const field of fields) {
    const bytes = Buffer.from(field)
    const length = Buffer.alloc(4)
    length.writeUInt32LE(bytes.length)
    parts.push(length, bytes)
  }
  return Buffer.concat(parts)
}

function compilationTrackFlac() {
  const dir = mkdtempSync(join(tmpdir(), 'crate-release-tags-'))
  const path = join(dir, '07 - Borrowed Song.flac')
  writeFileSync(path, Buffer.concat([
    Buffer.from('fLaC'),
    metadataBlock(0, streamInfo(), false),
    metadataBlock(4, vorbisComment([
      'TITLE=Borrowed Song',
      'ARTIST=The Band',
      'ALBUM=Now Hits 42',
      'ALBUMARTIST=Various Artists',
      'COMPILATION=1',
      'MUSICBRAINZ_ALBUMID=11111111-1111-1111-1111-111111111111',
      'MUSICBRAINZ_RELEASEGROUPID=22222222-2222-2222-2222-222222222222',
      'MUSICBRAINZ_ALBUMARTISTID=89ad4ac3-39f7-470e-963a-56509c546377',
      'MUSICBRAINZ_RELEASETRACKID=33333333-3333-3333-3333-333333333333',
      'MUSICBRAINZ_TRACKID=44444444-4444-4444-4444-444444444444',
      'RELEASETYPE=album; compilation',
      'REPLAYGAIN_ALBUM_GAIN=-7.00 dB',
      'REPLAYGAIN_ALBUM_PEAK=0.990000',
      'REPLAYGAIN_TRACK_GAIN=-6.00 dB',
    ]), true),
  ]))
  return { dir, path }
}

test('release tags replace the compilation identity and keep per-recording tags', async () => {
  const { dir, path } = compilationTrackFlac()
  try {
    writeTrackMetadata(path, { album: 'Original Album', albumArtist: 'The Band' }, {
      release: {
        isCompilation: false,
        musicBrainzReleaseId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        musicBrainzReleaseGroupId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        musicBrainzReleaseArtistId: null,
        musicBrainzReleaseType: 'album',
        musicBrainzReleaseStatus: 'official',
        musicBrainzReleaseCountry: 'US',
        clearMusicBrainzDiscId: true,
        clearAlbumReplayGain: true,
      },
    })
    const { common } = await parseFile(path)
    assert.equal(common.album, 'Original Album')
    assert.equal(common.albumartist, 'The Band')
    assert.ok(!common.compilation, 'COMPILATION must be removed')
    assert.equal(common.musicbrainz_albumid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
    assert.equal(common.musicbrainz_releasegroupid, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
    assert.equal(common.musicbrainz_albumartistid, undefined, 'the Various Artists id must go')
    assert.equal(common.musicbrainz_trackid, undefined, 'the release-track id belongs to the old release')
    assert.deepEqual(common.releasetype, ['album'], 'RELEASETYPE (read by the importer) is rewritten, not just the legacy field')
    assert.equal(common.releasestatus, 'official')
    assert.equal(common.replaygain_album_gain, undefined, 'album gain was measured over the old album')
    assert.equal(common.replaygain_track_gain?.dB, -6, 'track gain is still valid')
    assert.equal(common.musicbrainz_recordingid, '44444444-4444-4444-4444-444444444444', 'same recording, same id')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('undefined release ids leave the file untouched while null clears them', async () => {
  const { dir, path } = compilationTrackFlac()
  try {
    writeTrackMetadata(path, {}, {
      release: {
        isCompilation: true,
        musicBrainzReleaseId: undefined,
        musicBrainzReleaseGroupId: null,
      },
    })
    const { common } = await parseFile(path)
    assert.equal(common.compilation, true)
    assert.equal(common.musicbrainz_albumid, '11111111-1111-1111-1111-111111111111')
    assert.equal(common.musicbrainz_releasegroupid, undefined)
    assert.equal(common.replaygain_album_gain?.dB, -7, 'album gain is only cleared on request')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
