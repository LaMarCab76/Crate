import { lstat, readdir, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { probeKind } from './dirEntryKind.ts'
import { trackFingerprint } from './trackFingerprint.ts'
import type {
  DeviceScanProgressEvent,
  DeviceScanSummary,
  DeviceTrack,
} from '@shared/types/device-sync'

export const DEVICE_SCAN_METADATA_CONCURRENCY = 2

export const DEVICE_AUDIO_EXTENSIONS = new Set([
  '.flac', '.m4a', '.mp3', '.wav', '.aiff', '.aif',
  '.ogg', '.opus', '.ape', '.wv', '.tta',
  '.dsf', '.dff', '.webm', '.mpc', '.spx',
])

function normalizeDeviceScanConcurrency(value: number): number {
  if (!Number.isFinite(value)) return DEVICE_SCAN_METADATA_CONCURRENCY
  return Math.max(1, Math.floor(value))
}

export interface DeviceScanTrackMetadata {
  title: string
  artist: string
  album: string
  albumArtist: string | null
  duration: number
  format: string
  fileSize: number | null
  dateModified: string | null
}

export interface DeviceScanInternalResult {
  tracks: DeviceTrack[]
  summary: DeviceScanSummary
}

export type DeviceScanProgressEmitter = (event: DeviceScanProgressEvent, force: boolean) => void

export interface DeviceCollectedMusicFiles {
  audioFiles: string[]
  changedAudioFiles: Set<string>
}

function toPosixRelative(root: string, absPath: string): string {
  return relative(root, absPath).split(sep).join('/')
}

function keyForRelativePath(relPath: string): string {
  return relPath
    .split('/')
    .filter(Boolean)
    .join('/')
    .normalize('NFC')
    .toLowerCase()
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export async function collectDeviceMusicFiles({
  deviceId,
  root,
  emitProgress,
  changedSince,
}: {
  deviceId: string
  root: string
  emitProgress?: DeviceScanProgressEmitter
  changedSince?: number
}): Promise<DeviceCollectedMusicFiles> {
  const audioFiles: string[] = []
  const changedAudioFiles = new Set<string>()
  const cutoffMs = typeof changedSince === 'number' && Number.isFinite(changedSince)
    ? changedSince
    : null
  const rootResolved = resolve(root)
  emitProgress?.({
    deviceId,
    scanned: 0,
    total: 0,
    phase: 'discovering',
  }, true)

  const walk = async (dir: string, inheritedIgnored: boolean): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      console.warn(`[devices] unreadable dir ${dir}:`, (err as Error).message)
      return
    }

    const names = new Set(entries.map(entry => entry.name))
    const ignored = names.has('database.unignore') ? false : inheritedIgnored || names.has('database.ignore')

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = resolve(dir, entry.name)
      if (!isInside(rootResolved, full)) continue

      let kind = probeKind(entry)
      if (kind === 'unknown') {
        try {
          kind = probeKind(await lstat(full))
        } catch (err) {
          console.warn(`[devices] unreadable entry ${full}:`, (err as Error).message)
          continue
        }
      }

      if (kind === 'link') continue
      if (kind === 'dir') {
        await walk(full, ignored)
      } else if (kind === 'file' && !ignored) {
        const extension = extname(entry.name).toLowerCase()
        const relativePath = toPosixRelative(rootResolved, full)
        const key = keyForRelativePath(relativePath)

        if (DEVICE_AUDIO_EXTENSIONS.has(extension)) {
          audioFiles.push(full)
          if (cutoffMs === null) {
            changedAudioFiles.add(key)
          } else {
            let changed = false
            try {
              const fileStats = await stat(full)
              changed = fileStats.mtimeMs > cutoffMs
            } catch (err) {
              console.warn(`[devices] unreadable file ${full}:`, (err as Error).message)
              changed = true
            }
            if (changed) changedAudioFiles.add(key)
          }
        }
      }
    }
  }

  await walk(rootResolved, false)
  return { audioFiles, changedAudioFiles }
}

export async function collectDeviceAudioFiles(args: {
  deviceId: string
  root: string
  emitProgress?: DeviceScanProgressEmitter
}): Promise<string[]> {
  return (await collectDeviceMusicFiles(args)).audioFiles
}

export async function scanDeviceAudioFiles({
  deviceId,
  root,
  files,
  readMetadata,
  emitProgress,
  concurrency = DEVICE_SCAN_METADATA_CONCURRENCY,
  changedAudioFiles,
  reusableMetadataByKey,
}: {
  deviceId: string
  root: string
  files: string[]
  readMetadata: (file: string) => Promise<DeviceScanTrackMetadata>
  emitProgress?: DeviceScanProgressEmitter
  concurrency?: number
  changedAudioFiles?: Set<string>
  reusableMetadataByKey?: ReadonlyMap<string, DeviceScanTrackMetadata>
}): Promise<DeviceScanInternalResult> {
  const tracks: DeviceTrack[] = []
  const limit = Math.min(normalizeDeviceScanConcurrency(concurrency), Math.max(1, files.length))
  let nextIndex = 0
  let scanned = 0
  let errors = 0

  const worker = async (): Promise<void> => {
    while (nextIndex < files.length) {
      const file = files[nextIndex++]
      const relativePath = toPosixRelative(root, file)
      const key = keyForRelativePath(relativePath)
      const shouldRead = changedAudioFiles === undefined || changedAudioFiles.has(key)
      try {
        let md: DeviceScanTrackMetadata
        if (!shouldRead && reusableMetadataByKey?.has(key)) {
          md = reusableMetadataByKey.get(key) as DeviceScanTrackMetadata
        } else {
          md = await readMetadata(file)
        }
        const track: DeviceTrack = {
          key,
          relativePath,
          absolutePath: file,
          title: md.title,
          artist: md.artist,
          album: md.album,
          albumArtist: md.albumArtist,
          duration: md.duration,
          format: md.format,
          fileSize: md.fileSize,
          dateModified: md.dateModified,
          fingerprint: '',
        }
        track.fingerprint = trackFingerprint(track)
        tracks.push(track)
      } catch (err) {
        errors += 1
        console.warn(`[devices] skip ${file}:`, (err as Error).message)
      } finally {
        scanned += 1
        emitProgress?.({
          deviceId,
          scanned,
          total: files.length,
          phase: 'reading',
        }, false)
      }
    }
  }

  await Promise.all(Array.from({ length: files.length === 0 ? 0 : limit }, () => worker()))

  emitProgress?.({
    deviceId,
    scanned,
    total: files.length,
    phase: 'complete',
  }, true)

  return {
    tracks: tracks.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    summary: {
      scanned,
      imported: tracks.length,
      skipped: files.length - tracks.length,
      errors,
    },
  }
}

export async function scanDeviceAudioTree({
  deviceId,
  root,
  readMetadata,
  emitProgress,
  concurrency,
  changedSince,
  reusableMetadataByKey,
}: {
  deviceId: string
  root: string
  readMetadata: (file: string) => Promise<DeviceScanTrackMetadata>
  emitProgress?: DeviceScanProgressEmitter
  concurrency?: number
  changedSince?: number
  reusableMetadataByKey?: ReadonlyMap<string, DeviceScanTrackMetadata>
}): Promise<DeviceScanInternalResult> {
  const collected = await collectDeviceMusicFiles({
    deviceId,
    root,
    emitProgress,
    changedSince,
  })
  return scanDeviceAudioFiles({
    deviceId,
    root: resolve(root),
    files: collected.audioFiles,
    changedAudioFiles: collected.changedAudioFiles,
    reusableMetadataByKey,
    readMetadata,
    emitProgress,
    concurrency,
  })
}
