import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, symlink, utimes, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  collectDeviceAudioFiles,
  collectDeviceMusicFiles,
  DEVICE_SCAN_METADATA_CONCURRENCY,
  scanDeviceAudioFiles,
} from './deviceScanCore.ts'

function metadataFor(file) {
  return {
    title: file.split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'Track',
    artist: 'Artist',
    album: 'Album',
    albumArtist: null,
    duration: 180,
    format: 'MP3',
    fileSize: 1024,
    dateModified: '2026-06-04T00:00:00.000Z',
  }
}

test('collectDeviceAudioFiles respects database.ignore, database.unignore, dotfiles and symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'crate-device-scan-'))
  try {
    await mkdir(join(root, 'Album'), { recursive: true })
    await writeFile(join(root, 'Album', '01 - Keep.mp3'), '')
    await writeFile(join(root, 'Album', '.hidden.mp3'), '')
    await symlink(join(root, 'Album', '01 - Keep.mp3'), join(root, 'Album', 'link.mp3'))

    await mkdir(join(root, 'Ignored', 'Recovered'), { recursive: true })
    await writeFile(join(root, 'Ignored', 'database.ignore'), '')
    await writeFile(join(root, 'Ignored', '02 - Skip.mp3'), '')
    await writeFile(join(root, 'Ignored', 'Recovered', 'database.unignore'), '')
    await writeFile(join(root, 'Ignored', 'Recovered', '03 - Include.flac'), '')

    const progress = []
    const files = await collectDeviceAudioFiles({
      deviceId: 'dap',
      root,
      emitProgress: (event, force) => progress.push({ event, force }),
    })

    assert.deepEqual(
      files.map(file => file.slice(root.length + 1)).sort(),
      [
        'Album/01 - Keep.mp3',
        'Ignored/Recovered/03 - Include.flac',
      ],
    )
    assert.deepEqual(progress, [{
      event: { deviceId: 'dap', scanned: 0, total: 0, phase: 'discovering' },
      force: true,
    }])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('collectDeviceMusicFiles ignores lrc sidecars during device scan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'crate-device-lrc-scan-'))
  try {
    await mkdir(join(root, 'Album'), { recursive: true })
    await writeFile(join(root, 'Album', '01 - Keep.mp3'), '')
    await writeFile(join(root, 'Album', '01 - Keep.lrc'), '[00:01.00]Line')
    await writeFile(join(root, 'Album', '.hidden.lrc'), '[00:01.00]Hidden')

    await mkdir(join(root, 'Ignored', 'Recovered'), { recursive: true })
    await writeFile(join(root, 'Ignored', 'database.ignore'), '')
    await writeFile(join(root, 'Ignored', '02 - Skip.mp3'), '')
    await writeFile(join(root, 'Ignored', '02 - Skip.lrc'), '[00:01.00]Skip')
    await writeFile(join(root, 'Ignored', 'Recovered', 'database.unignore'), '')
    await writeFile(join(root, 'Ignored', 'Recovered', '03 - Include.flac'), '')
    await writeFile(join(root, 'Ignored', 'Recovered', '03 - Include.lrc'), '[00:01.00]Include')

    const collected = await collectDeviceMusicFiles({ deviceId: 'dap', root })

    assert.deepEqual(
      collected.audioFiles.map(file => file.slice(root.length + 1)).sort(),
      [
        'Album/01 - Keep.mp3',
        'Ignored/Recovered/03 - Include.flac',
      ],
    )
    assert.equal('lyricsSidecarsByStem' in collected, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('scanDeviceAudioFiles limits metadata concurrency and emits reading plus complete progress', async () => {
  const root = '/Volumes/DAP/Music'
  const files = ['01.mp3', '02.mp3', '03.mp3', '04.mp3', '05.mp3'].map(name => `${root}/${name}`)
  const progress = []
  let active = 0
  let maxActive = 0

  const result = await scanDeviceAudioFiles({
    deviceId: 'dap',
    root,
    files,
    concurrency: DEVICE_SCAN_METADATA_CONCURRENCY,
    emitProgress: (event, force) => progress.push({ event, force }),
    readMetadata: async file => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active -= 1
      return metadataFor(file)
    },
  })

  assert.equal(maxActive, 2)
  assert.equal(result.summary.scanned, 5)
  assert.equal(result.summary.imported, 5)
  assert.equal(result.summary.errors, 0)
  assert.equal(result.tracks.length, 5)
  assert.equal('lyricsSidecars' in result, false)
  assert.equal(progress.filter(item => item.event.phase === 'reading').length, 5)
  assert.deepEqual(progress.at(-1), {
    event: { deviceId: 'dap', scanned: 5, total: 5, phase: 'complete' },
    force: true,
  })
})

test('collectDeviceMusicFiles marks only tracks changed after a cutoff in incremental scans', async () => {
  const root = await mkdtemp(join(tmpdir(), 'crate-device-incremental-collect-'))
  try {
    await writeFile(join(root, 'old.mp3'), 'old')
    await writeFile(join(root, 'changed.mp3'), 'changed')

    const now = Date.now()
    const oldDate = new Date(now - 60_000)
    const changedDate = new Date(now + 1_000)
    await utimes(join(root, 'old.mp3'), oldDate, oldDate)
    await utimes(join(root, 'changed.mp3'), changedDate, changedDate)

    const changedSince = oldDate.getTime() + 500
    const collected = await collectDeviceMusicFiles({
      deviceId: 'dap',
      root,
      changedSince,
    })

    assert.deepEqual(
      collected.audioFiles.map(file => file.slice(root.length + 1)).sort(),
      ['changed.mp3', 'old.mp3'],
    )
    assert.deepEqual([...collected.changedAudioFiles].sort(), ['changed.mp3'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('scanDeviceAudioFiles reuses reusable metadata for unchanged tracks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'crate-device-incremental-scan-'))
  try {
    const unchanged = join(root, 'unchanged.mp3')
    const changed = join(root, 'changed.mp3')
    await writeFile(unchanged, 'unchanged')
    await writeFile(changed, 'changed')

    const readMetadataCalls = []
    const result = await scanDeviceAudioFiles({
      deviceId: 'dap',
      root,
      files: [unchanged, changed],
      concurrency: 2,
      changedAudioFiles: new Set(['changed.mp3']),
      reusableMetadataByKey: new Map([
        ['unchanged.mp3', {
          title: 'From cache',
          artist: 'A',
          album: 'B',
          albumArtist: null,
          duration: 120,
          format: 'MP3',
          fileSize: 3,
          dateModified: '2026-06-04T00:00:00.000Z',
        }],
      ]),
      readMetadata: async file => {
        readMetadataCalls.push(file)
        return metadataFor(file)
      },
    })

    assert.deepEqual(readMetadataCalls, [changed])
    assert.equal(result.summary.scanned, 2)
    assert.equal(result.summary.imported, 2)
    assert.equal(result.summary.errors, 0)
    assert.equal(result.tracks.find(track => track.relativePath === 'unchanged.mp3')?.title, 'From cache')
    assert.equal(result.tracks.find(track => track.relativePath === 'changed.mp3')?.title, 'changed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
