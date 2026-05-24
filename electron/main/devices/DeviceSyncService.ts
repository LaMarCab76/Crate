import { app, dialog, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
  utimes,
} from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { hostname, platform, tmpdir, userInfo } from 'node:os'
import extractZip from 'extract-zip'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { getDatabase } from '../db/database'
import { getRepos } from '../db/repositories'
import { getFolderWatcher } from '../library/FolderWatcher'
import { getImportService } from '../library/ImportService'
import { readTrackMetadata } from '../library/MetadataExtractor'
import { broadcast } from '../ipc/events'
import { optimizeEmbeddedArtwork } from './ArtworkOptimizer'
import { clampDeviceArtworkEdge } from '@shared/constants/device-sync'
import type { DbTrack } from '@shared/types/db'
import type { PickFolderResult } from '@shared/types/ipc-contract'
import type {
  DeviceAlbumSummary,
  DeviceArtworkOptimizationSummary,
  DeviceArtistSummary,
  DeviceCandidate,
  DeviceConnectPayload,
  DeviceJournalStatus,
  DeviceLibraryResult,
  DevicePlaylistSummary,
  DevicePendingJournal,
  DevicePortableState,
  DeviceRecord,
  DeviceScanResult,
  DeviceScanSummary,
  DeviceSettingsUpdate,
  DeviceSyncAction,
  DeviceSyncActionKind,
  DeviceSyncApplyResult,
  DeviceSyncFailure,
  DeviceSyncMode,
  DeviceSyncPhase,
  DeviceSyncPlan,
  DeviceSyncPlanRequest,
  DeviceSyncPlanSummary,
  DeviceTrack,
  DeviceUnknownVolume,
  DeviceVersionInfo,
  DeviceVolumeSnapshot,
  PcTrack,
  RockboxThemeInstallResult,
  RockboxThemeInstallSourceResult,
  RockboxThemeSummary,
} from '@shared/types/device-sync'

const APP_STATE_DIR = '.crate'
const ROCKBOX_DIR = '.rockbox'
const JOURNAL_DIR = 'journals'
const MACHINE_ID_FILE = 'machine-id'
const DEVICE_STATE_VERSION = 1
const DEFAULT_SYNC_MODE: DeviceSyncMode = 'bidirectional_safe'
const VOLUME_MONITOR_INTERVAL_MS = 5000
const TEXT_PROBE_LIMIT = 16 * 1024

const AUDIO_EXTENSIONS = new Set([
  '.flac', '.m4a', '.mp3', '.wav', '.aiff', '.aif',
  '.ogg', '.opus', '.ape', '.wv', '.tta',
  '.dsf', '.dff', '.webm', '.mpc', '.spx',
])

const PLAYLIST_EXTENSIONS = new Set(['.m3u', '.m3u8'])
const ROCKBOX_TOP_LEVEL_DIRS = new Set(['themes', 'wps', 'fonts', 'icons', 'backdrops'])
const ROCKBOX_SKIN_EXTENSIONS = new Set(['.wps', '.sbs', '.fms', '.rwps', '.rsbs', '.rfms'])
const ROCKBOX_ASSET_EXTENSIONS = new Set([
  '.bmp', '.png', '.jpg', '.jpeg', '.gif',
  '.fnt', '.gc', '.ico', '.icons', '.colours', '.colors',
])

const ROCKBOX_VERSION_FILES = [
  ['.rockbox', 'rockbox-info.txt'],
  ['.rockbox', 'version.txt'],
  ['.rockbox', 'build-info.txt'],
  ['rockbox-info.txt'],
]

const FIRMWARE_VERSION_FILES = [
  ['version.ini'],
  ['VERSION.INI'],
  ['version.txt'],
  ['VERSION.TXT'],
  ['firmware.version'],
  ['firmware.txt'],
]

interface DeviceRow {
  id: string
  name: string
  root_path: string
  music_root: string
  sync_mode: DeviceSyncMode
  pc_target_path: string
  artwork_max_edge: number
  has_rockbox: number
  track_count: number
  created_at: string
  last_seen_at: string
  last_scan_at: string | null
  last_sync_at: string | null
}

interface DeviceYaml {
  version: number
  appName: string
  deviceId: string
  name: string
  musicRoot: string
  defaultSyncMode: DeviceSyncMode
  artworkMaxEdge?: number
  linkedMachineIds: string[]
  createdAt: string
  updatedAt: string
}

interface MachineYaml {
  version: number
  machineId: string
  hostname: string
  platform: string
  pcTargetPath: string
  firstLinkedAt: string
  lastSeenAt: string
  lastSyncAt: string | null
}

interface SnapshotTrack {
  relativePath: string
  fingerprint: string
  fileSize: number | null
  dateModified: string | null
  title: string
  artist: string
  album: string
}

interface LibraryStateYaml {
  version: number
  updatedAt: string
  machineId: string
  pc: {
    trackCount: number
    tracks: Record<string, SnapshotTrack>
  }
  device: {
    trackCount: number
    tracks: Record<string, SnapshotTrack>
  }
}

interface ScanInternalResult {
  tracks: DeviceTrack[]
  summary: DeviceScanSummary
}

interface CachedPlan {
  plan: DeviceSyncPlan
  deviceRoot: string
  deviceMusicRoot: string
}

type JournalStepStatus = 'pending' | 'running' | 'completed' | 'failed'
type JournalStepOutcome = 'applied' | 'optimized' | 'skipped'

interface SyncJournalStep {
  id: string
  kind: DeviceSyncActionKind | 'optimize_artwork'
  relativePath: string
  sourcePath: string | null
  destinationPath: string | null
  status: JournalStepStatus
  outcome?: JournalStepOutcome
  error?: string
  startedAt?: string
  completedAt?: string
  bytesSaved?: number
}

interface SyncJournalYaml {
  version: number
  kind: 'device-sync'
  id: string
  runId: string
  status: DeviceJournalStatus
  phase: DeviceSyncPhase | null
  plan: DeviceSyncPlan
  deviceRoot: string
  deviceMusicRoot: string
  startedAt: string
  updatedAt: string
  completedAt?: string
  actions: SyncJournalStep[]
  artwork: SyncJournalStep[]
  result?: DeviceSyncApplyResult
}

interface RockboxInstallFile {
  sourcePath: string
  destinationRelativePath: string
  themeName: string | null
}

function nowIso(): string {
  return new Date().toISOString()
}

function toPosixRelative(root: string, absPath: string): string {
  return relative(root, absPath).split(sep).join('/')
}

function fromPosix(root: string, relPath: string): string {
  return join(root, ...relPath.split('/').filter(Boolean))
}

function keyForRelativePath(relPath: string): string {
  return relPath
    .split('/')
    .filter(Boolean)
    .join('/')
    .normalize('NFC')
    .toLowerCase()
}

function idForValue(value: string): string {
  return keyForRelativePath(value).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item'
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function assertInside(parent: string, child: string): void {
  if (!isInside(parent, child)) {
    throw new Error(`Refusing to operate outside ${parent}`)
  }
}

function sanitizeFolderName(value: string): string {
  return value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 80)
    || 'Device'
}

function sanitizeThemeName(value: string): string {
  return sanitizeFolderName(value).replace(/\.(cfg|wps|sbs|fms|rwps|rsbs|rfms)$/i, '') || 'Theme'
}

function sanitizeMusicRoot(value: string | undefined | null): string {
  const raw = (value ?? '.').trim() || '.'
  const normalized = raw.split('\\').join('/').replace(/^\/+/, '')
  if (normalized === '.') return '.'
  if (normalized.split('/').some(part => part === '..')) {
    throw new Error('Invalid music root')
  }
  return normalized
}

function validateSyncMode(value: unknown): DeviceSyncMode {
  if (value === 'pc_to_device' || value === 'device_to_pc' || value === 'bidirectional_safe') {
    return value
  }
  return DEFAULT_SYNC_MODE
}

function trackFingerprint(track: {
  relativePath: string
  fileSize: number | null
  dateModified: string | null
  duration: number
  title: string
  artist: string
  album: string
  format: string
}): string {
  return [
    track.relativePath,
    track.fileSize ?? '',
    track.dateModified ?? '',
    Math.round(track.duration || 0),
    track.title,
    track.artist,
    track.album,
    track.format,
  ].join('|')
}

function snapshotFromTracks<T extends DeviceTrack>(tracks: T[]): Record<string, SnapshotTrack> {
  const out: Record<string, SnapshotTrack> = {}
  for (const track of tracks) {
    out[track.key] = {
      relativePath: track.relativePath,
      fingerprint: track.fingerprint,
      fileSize: track.fileSize,
      dateModified: track.dateModified,
      title: track.title,
      artist: track.artist,
      album: track.album,
    }
  }
  return out
}

function summaryFor(actions: DeviceSyncAction[], pcBefore: number, deviceBefore: number): DeviceSyncPlanSummary {
  let pcAfter = pcBefore
  let deviceAfter = deviceBefore
  let bytesToCopy = 0
  const count = (kind: DeviceSyncActionKind) => actions.filter(a => a.kind === kind).length

  for (const action of actions) {
    switch (action.kind) {
      case 'copy_pc_to_device':
        deviceAfter += 1
        bytesToCopy += action.bytes
        break
      case 'copy_device_to_pc':
        pcAfter += 1
        bytesToCopy += action.bytes
        break
      case 'replace_device':
      case 'replace_pc':
        bytesToCopy += action.bytes
        break
      case 'delete_device':
        deviceAfter = Math.max(0, deviceAfter - 1)
        break
      case 'delete_pc':
        pcAfter = Math.max(0, pcAfter - 1)
        break
      case 'skip_conflict':
        break
    }
  }

  return {
    pcBefore,
    deviceBefore,
    pcAfter,
    deviceAfter,
    copyPcToDevice: count('copy_pc_to_device'),
    copyDeviceToPc: count('copy_device_to_pc'),
    replaceDevice: count('replace_device'),
    replacePc: count('replace_pc'),
    deleteDevice: count('delete_device'),
    deletePc: count('delete_pc'),
    conflicts: count('skip_conflict'),
    bytesToCopy,
  }
}

async function readYamlFile<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null
  try {
    return parseYaml(await readFile(path, 'utf8')) as T
  } catch (err) {
    console.warn(`[devices] failed to read ${path}:`, (err as Error).message)
    return null
  }
}

function readYamlFileSync<T>(path: string): T | null {
  if (!existsSync(path)) return null
  try {
    return parseYaml(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

function readTextProbe(path: string): string | null {
  if (!existsSync(path)) return null
  try {
    return readFileSync(path, 'utf8').slice(0, TEXT_PROBE_LIMIT)
  } catch {
    return null
  }
}

function compactVersionLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 120)
}

function extractVersionFromText(text: string, fallbackNeedle?: RegExp): string | null {
  const lines = text
    .split(/\r?\n/)
    .map(line => compactVersionLine(line))
    .filter(Boolean)

  for (const line of lines) {
    const match = line.match(/^(?:rockbox\s*)?(?:version|revision|build|firmware|fw)\s*[:=]\s*(.+)$/i)
    if (match?.[1]) return compactVersionLine(match[1])
  }

  if (fallbackNeedle) {
    const found = lines.find(line => fallbackNeedle.test(line))
    if (found) return found
  }

  return lines[0] ?? null
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function errorCode(err: unknown): string | null {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code
    return typeof code === 'string' ? code : null
  }
  return null
}

function isPortableWriteError(err: unknown): boolean {
  const code = errorCode(err)
  return code === 'EPERM' || code === 'EACCES' || code === 'EROFS' || code === 'ENOSPC'
}

async function writeYamlFile(path: string, payload: unknown): Promise<void> {
  const tmp = `${path}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(tmp, stringifyYaml(payload), 'utf8')
  await rename(tmp, path)
}

function emptyArtworkSummary(): DeviceArtworkOptimizationSummary {
  return {
    scanned: 0,
    optimized: 0,
    skipped: 0,
    failed: 0,
    bytesSaved: 0,
  }
}

export class DeviceSyncService {
  private planCache = new Map<string, CachedPlan>()
  private ignoredUnknownRoots = new Set<string>()
  private portableStateCache = new Map<string, DevicePortableState>()
  private volumeMonitorTimer: ReturnType<typeof setInterval> | null = null
  private lastVolumeSignature = ''

  async detectCandidates(): Promise<DeviceCandidate[]> {
    const roots = await this.candidateRoots()
    const out: DeviceCandidate[] = []
    for (const rootPath of roots) {
      const hasRockbox = existsSync(join(rootPath, '.rockbox'))
      const hasCrateState = existsSync(join(rootPath, APP_STATE_DIR, 'device.yaml'))
      if (!hasRockbox && !hasCrateState) continue
      out.push({
        rootPath,
        name: basename(rootPath) || rootPath,
        hasRockbox,
        hasCrateState,
      })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  async volumeSnapshot(): Promise<DeviceVolumeSnapshot> {
    const roots = await this.candidateRoots()
    const libraryRoots = getRepos()
      .folders
      .list()
      .map(folder => resolve(folder.path))
    const candidates: DeviceCandidate[] = []
    const unknownVolumes: DeviceUnknownVolume[] = []

    for (const rootPath of roots) {
      const normalizedRoot = resolve(rootPath)
      if (this.getDeviceRowByRoot(normalizedRoot)) continue

      const hasRockbox = existsSync(join(normalizedRoot, ROCKBOX_DIR))
      const hasCrateState = existsSync(join(normalizedRoot, APP_STATE_DIR, 'device.yaml'))
      if (hasRockbox || hasCrateState) {
        candidates.push({
          rootPath: normalizedRoot,
          name: basename(normalizedRoot) || normalizedRoot,
          hasRockbox,
          hasCrateState,
        })
        continue
      }

      if (libraryRoots.some(libraryRoot => isInside(normalizedRoot, libraryRoot))) continue

      if (!this.ignoredUnknownRoots.has(normalizedRoot)) {
        unknownVolumes.push({
          rootPath: normalizedRoot,
          name: basename(normalizedRoot) || normalizedRoot,
        })
      }
    }

    return {
      devices: await this.listDevices(),
      candidates: candidates.sort((a, b) => a.name.localeCompare(b.name)),
      unknownVolumes: unknownVolumes.sort((a, b) => a.name.localeCompare(b.name)),
    }
  }

  async ignoreVolume(rootPath: string): Promise<DeviceVolumeSnapshot> {
    this.ignoredUnknownRoots.add(resolve(rootPath))
    return this.publishVolumeSnapshot(true)
  }

  startVolumeMonitor(intervalMs = VOLUME_MONITOR_INTERVAL_MS): void {
    if (this.volumeMonitorTimer) return
    void this.publishVolumeSnapshot(true)
    this.volumeMonitorTimer = setInterval(() => {
      void this.publishVolumeSnapshot(false)
    }, intervalMs)
    this.volumeMonitorTimer.unref?.()
  }

  stopVolumeMonitor(): void {
    if (!this.volumeMonitorTimer) return
    clearInterval(this.volumeMonitorTimer)
    this.volumeMonitorTimer = null
  }

  private async publishVolumeSnapshot(force: boolean): Promise<DeviceVolumeSnapshot> {
    const snapshot = await this.volumeSnapshot()
    const signature = JSON.stringify({
      devices: snapshot.devices.map(device => [
        device.id,
        device.rootPath,
        device.isAvailable,
        device.trackCount,
        device.lastSeenAt,
        device.lastScanAt,
        device.lastSyncAt,
      ]),
      candidates: snapshot.candidates.map(candidate => [
        candidate.rootPath,
        candidate.hasRockbox,
        candidate.hasCrateState,
      ]),
      unknownVolumes: snapshot.unknownVolumes.map(volume => volume.rootPath),
    })
    if (force || signature !== this.lastVolumeSignature) {
      this.lastVolumeSignature = signature
      broadcast('devices:volumes-changed', snapshot)
    }
    return snapshot
  }

  async pickRoot(): Promise<PickFolderResult> {
    const result = await dialog.showOpenDialog({
      title: 'Connect MP3 / DAP',
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, path: null }
    }
    return { canceled: false, path: result.filePaths[0] }
  }

  async listDevices(): Promise<DeviceRecord[]> {
    return this.listDeviceRows().map(row => this.rowToRecord(row))
  }

  async connect(payload: DeviceConnectPayload): Promise<DeviceRecord> {
    const rootPath = resolve(payload.rootPath)
    const rootStats = await stat(rootPath)
    if (!rootStats.isDirectory()) throw new Error('Device root must be a directory')

    const stateDir = join(rootPath, APP_STATE_DIR)
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'database.ignore'), '', 'utf8')

    const existingDevice = await readYamlFile<DeviceYaml>(join(stateDir, 'device.yaml'))
    const existingRootRow = this.getDeviceRowByRoot(rootPath)
    const machineId = await this.machineId()
    const machinePath = join(stateDir, 'machines', `${machineId}.yaml`)
    const existingMachine = await readYamlFile<MachineYaml>(machinePath)
    const createdAt = existingDevice?.createdAt ?? existingRootRow?.created_at ?? nowIso()
    const name = (payload.name?.trim() || existingDevice?.name || basename(rootPath) || 'Rockbox Device').trim()
    const musicRoot = sanitizeMusicRoot(payload.musicRoot ?? existingDevice?.musicRoot ?? '.')
    const defaultMode = validateSyncMode(payload.defaultMode ?? existingDevice?.defaultSyncMode)
    const pcTargetPath = resolve(payload.pcTargetPath ?? existingMachine?.pcTargetPath ?? this.defaultPcTargetPath(name))
    const artworkMaxEdge = clampDeviceArtworkEdge(
      existingDevice?.artworkMaxEdge ?? existingRootRow?.artwork_max_edge ?? payload.artworkMaxEdge,
    )
    const hasRockbox = existsSync(join(rootPath, '.rockbox'))

    const linkedMachineIds = new Set(existingDevice?.linkedMachineIds ?? [])
    linkedMachineIds.add(machineId)
    const deviceId = existingDevice?.deviceId || existingRootRow?.id || randomUUID()
    const updatedAt = nowIso()

    const deviceYaml: DeviceYaml = {
      version: DEVICE_STATE_VERSION,
      appName: 'Crate',
      deviceId,
      name,
      musicRoot,
      defaultSyncMode: defaultMode,
      artworkMaxEdge,
      linkedMachineIds: [...linkedMachineIds],
      createdAt,
      updatedAt,
    }
    const machineYaml: MachineYaml = {
      version: DEVICE_STATE_VERSION,
      machineId,
      hostname: hostname(),
      platform: platform(),
      pcTargetPath,
      firstLinkedAt: existingMachine?.firstLinkedAt ?? updatedAt,
      lastSeenAt: updatedAt,
      lastSyncAt: existingMachine?.lastSyncAt ?? null,
    }

    await writeYamlFile(join(stateDir, 'device.yaml'), deviceYaml)
    await writeYamlFile(machinePath, machineYaml)
    this.upsertDevice({
      id: deviceId,
      name,
      root_path: rootPath,
      music_root: musicRoot,
      sync_mode: defaultMode,
      pc_target_path: pcTargetPath,
      artwork_max_edge: artworkMaxEdge,
      has_rockbox: hasRockbox ? 1 : 0,
      track_count: 0,
      created_at: createdAt,
      last_seen_at: updatedAt,
      last_scan_at: null,
      last_sync_at: null,
    })

    // First time this device is linked on this machine: default to syncing every
    // current library. Libraries added afterwards stay opt-in.
    if (this.deviceLibraryIds(deviceId).length === 0) {
      this.setDeviceLibraries(deviceId, getRepos().folders.list().map(folder => folder.id))
    }

    this.setPortableState(deviceId, true, null)
    const record = this.rowToRecord(this.getDeviceRow(deviceId)!)
    await this.publishVolumeSnapshot(true)
    return record
  }

  async updateSettings(deviceId: string, settings: DeviceSettingsUpdate): Promise<DeviceRecord> {
    const row = this.requireDevice(deviceId)
    const artworkMaxEdge = clampDeviceArtworkEdge(settings.artworkMaxEdge, row.artwork_max_edge)
    const defaultMode = settings.defaultMode === undefined
      ? row.sync_mode
      : validateSyncMode(settings.defaultMode)
    const pcTargetPath = settings.pcTargetPath === undefined
      ? row.pc_target_path
      : resolve(settings.pcTargetPath.trim() || row.pc_target_path)
    const updatedAt = nowIso()
    const stateDir = join(row.root_path, APP_STATE_DIR)
    const devicePath = join(stateDir, 'device.yaml')
    const existingDevice = await readYamlFile<DeviceYaml>(devicePath)
    const machineId = await this.machineId()
    const linkedMachineIds = new Set(existingDevice?.linkedMachineIds ?? [])
    linkedMachineIds.add(machineId)

    const deviceYaml: DeviceYaml = {
      version: existingDevice?.version ?? DEVICE_STATE_VERSION,
      appName: existingDevice?.appName ?? 'Crate',
      deviceId: row.id,
      name: row.name,
      musicRoot: row.music_root,
      defaultSyncMode: defaultMode,
      artworkMaxEdge,
      linkedMachineIds: [...linkedMachineIds],
      createdAt: existingDevice?.createdAt ?? row.created_at,
      updatedAt,
    }

    const machinePath = join(stateDir, 'machines', `${machineId}.yaml`)
    const existingMachine = await readYamlFile<MachineYaml>(machinePath)
    const machineYaml: MachineYaml = {
      version: existingMachine?.version ?? DEVICE_STATE_VERSION,
      machineId,
      hostname: existingMachine?.hostname ?? hostname(),
      platform: existingMachine?.platform ?? platform(),
      pcTargetPath,
      firstLinkedAt: existingMachine?.firstLinkedAt ?? updatedAt,
      lastSeenAt: updatedAt,
      lastSyncAt: existingMachine?.lastSyncAt ?? row.last_sync_at,
    }
    getDatabase()
      .prepare(`UPDATE devices SET sync_mode = ?, pc_target_path = ?, artwork_max_edge = ?, last_seen_at = ? WHERE id = ?`)
      .run(defaultMode, pcTargetPath, artworkMaxEdge, updatedAt, row.id)
    if (settings.sourceLibraryIds !== undefined) {
      this.setDeviceLibraries(row.id, settings.sourceLibraryIds)
    }

    try {
      await writeYamlFile(devicePath, deviceYaml)
      await writeYamlFile(machinePath, machineYaml)
      this.setPortableState(row.id, true, null)
    } catch (err) {
      if (!isPortableWriteError(err)) throw err
      this.setPortableState(
        row.id,
        false,
        `La configuración local se guardó, pero no se pudo actualizar .crate en el dispositivo: ${errorMessage(err)}`,
      )
    }

    const record = this.rowToRecord(this.getDeviceRow(row.id)!)
    await this.publishVolumeSnapshot(true)
    return record
  }

  async scan(deviceId: string): Promise<DeviceScanResult> {
    const row = this.requireDevice(deviceId)
    const scan = await this.scanDeviceRow(row, true)
    const scannedAt = nowIso()
    getDatabase()
      .prepare(`UPDATE devices SET track_count = ?, last_scan_at = ?, last_seen_at = ? WHERE id = ?`)
      .run(scan.tracks.length, scannedAt, scannedAt, row.id)
    const device = this.rowToRecord(this.getDeviceRow(row.id)!)
    await this.publishVolumeSnapshot(true)
    return {
      device,
      tracks: scan.tracks,
      summary: scan.summary,
    }
  }

  async deviceLibrary(deviceId: string): Promise<DeviceLibraryResult> {
    const row = this.requireDevice(deviceId)
    const scan = await this.scanDeviceRow(row, false)
    const [playlists, rockboxThemes] = await Promise.all([
      this.scanDevicePlaylists(row, scan.tracks),
      this.scanRockboxThemes(row),
    ])
    const scannedAt = nowIso()
    getDatabase()
      .prepare(`UPDATE devices SET track_count = ?, last_seen_at = ? WHERE id = ?`)
      .run(scan.tracks.length, scannedAt, row.id)
    const device = this.rowToRecord(this.getDeviceRow(row.id)!)
    await this.publishVolumeSnapshot(true)

    const albums = this.deviceAlbums(scan.tracks)
    const artists = this.deviceArtists(scan.tracks)
    return {
      device,
      tracks: scan.tracks,
      albums,
      artists,
      playlists,
      rockboxThemes,
      summary: {
        trackCount: scan.tracks.length,
        albumCount: albums.length,
        artistCount: artists.length,
        playlistCount: playlists.length,
        rockboxThemeCount: rockboxThemes.length,
      },
    }
  }

  async installRockboxThemes(deviceId: string, sourcePaths: string[]): Promise<RockboxThemeInstallResult> {
    const row = this.requireDevice(deviceId)
    const rockboxRoot = join(row.root_path, ROCKBOX_DIR)
    if (!existsSync(rockboxRoot)) {
      throw new Error('Rockbox is not installed on this device')
    }

    const sources: RockboxThemeInstallSourceResult[] = []
    for (const rawPath of [...new Set(sourcePaths.map(path => resolve(path)))]) {
      sources.push(await this.installRockboxThemeSource(rockboxRoot, rawPath))
    }

    return {
      installed: sources.filter(source => source.status === 'installed').length,
      skipped: sources.filter(source => source.status === 'skipped').length,
      failed: sources.filter(source => source.status === 'failed').length,
      sources,
      themes: await this.scanRockboxThemes(row),
    }
  }

  async planSync(request: DeviceSyncPlanRequest): Promise<DeviceSyncPlan> {
    const row = this.requireDevice(request.deviceId)
    const mode = validateSyncMode(request.mode)
    const pcTargetPath = resolve(request.pcTargetPath ?? row.pc_target_path)
    const deviceMusicRoot = this.deviceMusicRoot(row)
    const libraryIds = this.deviceLibraryIds(row.id)
    const [pcTracks, deviceScan, baseline] = await Promise.all([
      this.pcLibraryTracks(libraryIds.length > 0 ? new Set(libraryIds) : undefined),
      this.scanDeviceRow(row, false),
      this.readLibraryState(row),
    ])

    const actions = this.buildActions({
      mode,
      pcTracks,
      deviceTracks: deviceScan.tracks,
      baseline,
      deviceMusicRoot,
      pcTargetPath,
    })
    const plan: DeviceSyncPlan = {
      id: randomUUID(),
      deviceId: row.id,
      deviceName: row.name,
      mode,
      createdAt: nowIso(),
      pcTargetPath,
      actions,
      summary: summaryFor(actions, pcTracks.length, deviceScan.tracks.length),
    }

    this.planCache.set(plan.id, {
      plan,
      deviceRoot: row.root_path,
      deviceMusicRoot,
    })
    return plan
  }

  async applySync(planId: string): Promise<DeviceSyncApplyResult> {
    const cached = this.planCache.get(planId)
    if (!cached) throw new Error('Sync plan expired. Create a new preview before applying.')

    const { plan, deviceRoot, deviceMusicRoot } = cached
    const row = this.requireDevice(plan.deviceId)
    await this.assertPortableStateWritable(row)
    const runId = randomUUID()
    const startedAt = nowIso()
    const journal = this.createSyncJournal(runId, plan, deviceRoot, deviceMusicRoot, startedAt)
    const journalPath = this.journalPath(deviceRoot, journal.id)
    try {
      await writeYamlFile(journalPath, journal)
    } catch (err) {
      throw this.syncPortableWriteError(err)
    }
    this.upsertSyncRun(runId, plan, startedAt)

    const result = await this.executeJournal(row, plan, deviceRoot, deviceMusicRoot, journalPath, journal)
    if (result.failed.length === 0) this.planCache.delete(plan.id)
    return result
  }

  async listPendingJournals(): Promise<DevicePendingJournal[]> {
    const journals = await this.loadPendingJournals()
    return journals
      .map(entry => this.toPendingJournal(entry.journal))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async resumeJournal(journalId: string): Promise<DeviceSyncApplyResult> {
    const found = await this.findPendingJournal(journalId)
    if (!found) throw new Error('Pending sync journal was not found')

    const row = this.requireDevice(found.journal.plan.deviceId)
    const deviceMusicRoot = this.deviceMusicRoot(row)
    const journal = found.journal
    journal.status = 'running'
    journal.phase = null
    journal.deviceRoot = row.root_path
    journal.deviceMusicRoot = deviceMusicRoot
    journal.updatedAt = nowIso()
    for (const step of [...journal.actions, ...journal.artwork]) {
      if (step.status === 'running') step.status = 'pending'
    }
    await writeYamlFile(found.path, journal)
    this.upsertSyncRun(journal.runId, journal.plan, journal.startedAt)

    return this.executeJournal(row, journal.plan, row.root_path, deviceMusicRoot, found.path, journal)
  }

  async discardJournal(journalId: string): Promise<void> {
    const found = await this.findPendingJournal(journalId)
    if (!found) return
    found.journal.status = 'discarded'
    found.journal.phase = null
    found.journal.updatedAt = nowIso()
    found.journal.completedAt = found.journal.updatedAt
    await writeYamlFile(found.path, found.journal)
  }

  private async candidateRoots(): Promise<string[]> {
    const roots: string[] = []
    const pushChildren = async (root: string) => {
      if (!existsSync(root)) return
      try {
        const entries = await readdir(root, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          roots.push(join(root, entry.name))
        }
      } catch {
        /* ignore unreadable mount root */
      }
    }

    if (process.platform === 'darwin') {
      await pushChildren('/Volumes')
    } else if (process.platform === 'win32') {
      for (let code = 68; code <= 90; code++) {
        const drive = `${String.fromCharCode(code)}:\\`
        if (existsSync(drive)) roots.push(drive)
      }
    } else {
      const user = userInfo().username
      await pushChildren(`/run/media/${user}`)
      await pushChildren(`/media/${user}`)
      await pushChildren('/mnt')
    }
    return [...new Set(roots.map(root => resolve(root)))]
  }

  private journalPath(deviceRoot: string, journalId: string): string {
    return join(deviceRoot, APP_STATE_DIR, JOURNAL_DIR, `sync-${journalId}.yaml`)
  }

  private createSyncJournal(
    runId: string,
    plan: DeviceSyncPlan,
    deviceRoot: string,
    deviceMusicRoot: string,
    startedAt: string,
  ): SyncJournalYaml {
    return {
      version: DEVICE_STATE_VERSION,
      kind: 'device-sync',
      id: runId,
      runId,
      status: 'running',
      phase: null,
      plan,
      deviceRoot,
      deviceMusicRoot,
      startedAt,
      updatedAt: startedAt,
      actions: plan.actions
        .filter(action => action.kind !== 'skip_conflict')
        .map(action => ({
          id: action.id,
          kind: action.kind,
          relativePath: action.relativePath,
          sourcePath: action.sourcePath,
          destinationPath: action.destinationPath,
          status: 'pending',
        })),
      artwork: [],
    }
  }

  private isPendingJournal(journal: SyncJournalYaml | null): journal is SyncJournalYaml {
    return Boolean(
      journal &&
      journal.version === DEVICE_STATE_VERSION &&
      journal.kind === 'device-sync' &&
      (journal.status === 'running' || journal.status === 'failed')
    )
  }

  private async loadPendingJournals(): Promise<Array<{ path: string; journal: SyncJournalYaml }>> {
    const out: Array<{ path: string; journal: SyncJournalYaml }> = []
    for (const row of this.listDeviceRows()) {
      if (!existsSync(row.root_path)) continue
      const dir = join(row.root_path, APP_STATE_DIR, JOURNAL_DIR)
      if (!existsSync(dir)) continue
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.startsWith('sync-') || !entry.name.endsWith('.yaml')) continue
        const path = join(dir, entry.name)
        const journal = await readYamlFile<SyncJournalYaml>(path)
        if (this.isPendingJournal(journal)) out.push({ path, journal })
      }
    }
    return out
  }

  private async findPendingJournal(journalId: string): Promise<{ path: string; journal: SyncJournalYaml } | null> {
    const pending = await this.loadPendingJournals()
    return pending.find(entry => entry.journal.id === journalId || entry.journal.runId === journalId) ?? null
  }

  private artworkSummaryFromJournal(journal: SyncJournalYaml): DeviceArtworkOptimizationSummary {
    const summary = emptyArtworkSummary()
    for (const step of journal.artwork) {
      summary.scanned += 1
      if (step.status === 'failed') {
        summary.failed += 1
      } else if (step.outcome === 'optimized') {
        summary.optimized += 1
        summary.bytesSaved += step.bytesSaved ?? 0
      } else if (step.status === 'completed') {
        summary.skipped += 1
      }
    }
    return summary
  }

  private toPendingJournal(journal: SyncJournalYaml): DevicePendingJournal {
    const allSteps = [...journal.actions, ...journal.artwork]
    const current = allSteps.find(step => step.status === 'running') ?? allSteps.find(step => step.status === 'failed')
    return {
      id: journal.id,
      deviceId: journal.plan.deviceId,
      deviceName: journal.plan.deviceName,
      deviceRoot: journal.deviceRoot,
      planId: journal.plan.id,
      mode: journal.plan.mode,
      status: journal.status,
      phase: journal.phase,
      startedAt: journal.startedAt,
      updatedAt: journal.updatedAt,
      totalActions: allSteps.length,
      completedActions: allSteps.filter(step => step.status === 'completed').length,
      failedActions: allSteps.filter(step => step.status === 'failed').length,
      currentPath: current?.relativePath ?? null,
      artwork: this.artworkSummaryFromJournal(journal),
    }
  }

  private setJournalStepRunning(journal: SyncJournalYaml, step: SyncJournalStep, phase: DeviceSyncPhase): void {
    const updatedAt = nowIso()
    step.status = 'running'
    step.startedAt = updatedAt
    delete step.completedAt
    delete step.error
    delete step.outcome
    delete step.bytesSaved
    journal.status = 'running'
    journal.phase = phase
    journal.updatedAt = updatedAt
  }

  private setJournalStepCompleted(
    journal: SyncJournalYaml,
    step: SyncJournalStep,
    outcome: JournalStepOutcome,
    bytesSaved?: number,
  ): void {
    const updatedAt = nowIso()
    step.status = 'completed'
    step.outcome = outcome
    step.completedAt = updatedAt
    if (bytesSaved && bytesSaved > 0) step.bytesSaved = bytesSaved
    delete step.error
    journal.updatedAt = updatedAt
  }

  private setJournalStepFailed(journal: SyncJournalYaml, step: SyncJournalStep, err: unknown): void {
    const updatedAt = nowIso()
    step.status = 'failed'
    step.error = err instanceof Error ? err.message : String(err)
    step.completedAt = updatedAt
    journal.status = 'failed'
    journal.updatedAt = updatedAt
  }

  private failedSteps(journal: SyncJournalYaml): DeviceSyncFailure[] {
    return [...journal.actions, ...journal.artwork]
      .filter(step => step.status === 'failed')
      .map(step => ({
        actionId: step.id,
        path: step.sourcePath ?? step.destinationPath ?? step.relativePath,
        error: step.error ?? 'Operation failed',
      }))
  }

  private async executeJournal(
    row: DeviceRow,
    plan: DeviceSyncPlan,
    deviceRoot: string,
    deviceMusicRoot: string,
    journalPath: string,
    journal: SyncJournalYaml,
  ): Promise<DeviceSyncApplyResult> {
    const affectedPcFolderIds = new Set<number>()
    try {
      const copiedIntoPcTarget = await this.executeSyncJournalActions(
        plan,
        journalPath,
        journal,
        {
          deviceRoot,
          deviceMusicRoot,
          pcTargetPath: plan.pcTargetPath,
          runId: journal.runId,
          affectedPcFolderIds,
        },
      )

      let failed = this.failedSteps(journal)
      if (failed.length === 0) {
        this.broadcastSyncProgress(plan, 'refreshing', journal.actions.length, journal.actions.length)
        if (copiedIntoPcTarget) {
          await this.importPcTarget(plan.pcTargetPath)
        }
        for (const folderId of affectedPcFolderIds) {
          const folder = getRepos().folders.getById(folderId)
          if (folder) {
            getRepos().folders.updateTrackCount(folder.id, getRepos().tracks.countByFolder(folder.id))
          }
        }

        await this.optimizeArtworkForJournal(plan, deviceMusicRoot, row.artwork_max_edge, journalPath, journal)
        failed = this.failedSteps(journal)
      }

      const completedAt = nowIso()
      const result: DeviceSyncApplyResult = {
        planId: plan.id,
        deviceId: plan.deviceId,
        applied: journal.actions.filter(step => step.status === 'completed').length,
        failed,
        summary: plan.summary,
        artwork: this.artworkSummaryFromJournal(journal),
        completedAt,
      }

      if (failed.length === 0) {
        this.broadcastSyncProgress(plan, 'writing_state', journal.actions.length, journal.actions.length)
        await this.writeSuccessfulState(row, plan, result)
        this.finishSyncRun(journal.runId, 'success', completedAt, result)
        journal.status = 'completed'
        journal.phase = 'complete'
        journal.completedAt = completedAt
        journal.updatedAt = completedAt
        journal.result = result
        await writeYamlFile(journalPath, journal)
        await unlink(journalPath).catch(() => undefined)
      } else {
        this.finishSyncRun(journal.runId, 'failed', completedAt, result)
        journal.status = 'failed'
        journal.completedAt = completedAt
        journal.updatedAt = completedAt
        journal.result = result
        await writeYamlFile(journalPath, journal)
      }

      broadcast('library:changed', { reason: 'device-sync' })
      this.broadcastSyncProgress(plan, 'complete', journal.actions.length, journal.actions.length)
      return result
    } catch (err) {
      const completedAt = nowIso()
      const result: DeviceSyncApplyResult = {
        planId: plan.id,
        deviceId: plan.deviceId,
        applied: journal.actions.filter(step => step.status === 'completed').length,
        failed: [
          ...this.failedSteps(journal),
          {
            actionId: 'sync',
            path: row.root_path,
            error: err instanceof Error ? err.message : String(err),
          },
        ],
        summary: plan.summary,
        artwork: this.artworkSummaryFromJournal(journal),
        completedAt,
      }
      this.finishSyncRun(journal.runId, 'failed', completedAt, result)
      journal.status = 'failed'
      journal.completedAt = completedAt
      journal.updatedAt = completedAt
      journal.result = result
      await writeYamlFile(journalPath, journal).catch(() => undefined)
      return result
    }
  }

  private async executeSyncJournalActions(
    plan: DeviceSyncPlan,
    journalPath: string,
    journal: SyncJournalYaml,
    ctx: {
      deviceRoot: string
      deviceMusicRoot: string
      pcTargetPath: string
      runId: string
      affectedPcFolderIds: Set<number>
    },
  ): Promise<boolean> {
    const actionById = new Map(plan.actions.map(action => [action.id, action]))
    let copiedIntoPcTarget = journal.actions.some(step =>
      step.status === 'completed' && (step.kind === 'copy_device_to_pc' || step.kind === 'replace_pc')
    )

    for (const step of journal.actions) {
      if (step.status === 'completed') continue
      const action = actionById.get(step.id)
      if (!action || action.kind === 'skip_conflict') {
        this.setJournalStepCompleted(journal, step, 'skipped')
        await writeYamlFile(journalPath, journal)
        continue
      }

      const completed = journal.actions.filter(item => item.status === 'completed').length
      const phase = action.kind === 'delete_device' || action.kind === 'delete_pc' ? 'deleting' : 'copying'
      this.broadcastSyncProgress(plan, phase, completed, journal.actions.length, action.sourcePath ?? action.relativePath)
      this.setJournalStepRunning(journal, step, phase)
      await writeYamlFile(journalPath, journal)

      try {
        await this.applyAction(action, ctx)
        if (action.kind === 'copy_device_to_pc' || action.kind === 'replace_pc') {
          copiedIntoPcTarget = true
        }
        this.setJournalStepCompleted(journal, step, 'applied')
      } catch (err) {
        this.setJournalStepFailed(journal, step, err)
      }
      await writeYamlFile(journalPath, journal)
    }

    return copiedIntoPcTarget
  }

  private async optimizeArtworkForJournal(
    plan: DeviceSyncPlan,
    deviceMusicRoot: string,
    artworkMaxEdge: number,
    journalPath: string,
    journal: SyncJournalYaml,
  ): Promise<void> {
    const files = await this.collectAudioFiles(plan.deviceId, deviceMusicRoot, false)
    const activeRelativePaths = new Set<string>()
    const artworkByPath = new Map(journal.artwork.map(step => [keyForRelativePath(step.relativePath), step]))

    for (const file of files) {
      const relativePath = toPosixRelative(deviceMusicRoot, file)
      activeRelativePaths.add(keyForRelativePath(relativePath))
      if (artworkByPath.has(keyForRelativePath(relativePath))) continue
      const step: SyncJournalStep = {
        id: `artwork:${keyForRelativePath(relativePath)}`,
        kind: 'optimize_artwork',
        relativePath,
        sourcePath: file,
        destinationPath: file,
        status: 'pending',
      }
      journal.artwork.push(step)
      artworkByPath.set(keyForRelativePath(relativePath), step)
    }

    for (const step of journal.artwork) {
      if (step.status === 'completed') continue
      if (!activeRelativePaths.has(keyForRelativePath(step.relativePath))) {
        this.setJournalStepCompleted(journal, step, 'skipped')
      }
    }

    await writeYamlFile(journalPath, journal)

    for (const step of journal.artwork) {
      if (step.status === 'completed') continue
      const completed = journal.artwork.filter(item => item.status === 'completed').length
      this.broadcastSyncProgress(plan, 'optimizing_artwork', completed, journal.artwork.length, step.relativePath)
      this.setJournalStepRunning(journal, step, 'optimizing_artwork')
      await writeYamlFile(journalPath, journal)

      try {
        const filePath = fromPosix(deviceMusicRoot, step.relativePath)
        assertInside(deviceMusicRoot, resolve(filePath))
        if (!existsSync(filePath)) {
          this.setJournalStepCompleted(journal, step, 'skipped')
        } else {
          const result = optimizeEmbeddedArtwork(filePath, artworkMaxEdge)
          this.setJournalStepCompleted(
            journal,
            step,
            result.optimizedPictures > 0 ? 'optimized' : 'skipped',
            result.bytesSaved,
          )
        }
      } catch (err) {
        this.setJournalStepFailed(journal, step, err)
      }
      await writeYamlFile(journalPath, journal)
    }
  }

  private deviceAlbums(tracks: DeviceTrack[]): DeviceAlbumSummary[] {
    const byAlbum = new Map<string, DeviceTrack[]>()
    for (const track of tracks) {
      const album = track.album || 'Unknown Album'
      const artist = track.albumArtist || track.artist || 'Unknown Artist'
      const key = idForValue(`${artist}/${album}`)
      const group = byAlbum.get(key) ?? []
      group.push(track)
      byAlbum.set(key, group)
    }

    return [...byAlbum.entries()]
      .map(([id, albumTracks]) => {
        const first = albumTracks[0]
        return {
          id,
          title: first?.album || 'Unknown Album',
          artist: first?.albumArtist || first?.artist || 'Unknown Artist',
          trackCount: albumTracks.length,
          duration: albumTracks.reduce((sum, track) => sum + track.duration, 0),
          fileSize: albumTracks.reduce((sum, track) => sum + (track.fileSize ?? 0), 0),
          tracks: albumTracks.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
        }
      })
      .sort((a, b) => a.title.localeCompare(b.title) || a.artist.localeCompare(b.artist))
  }

  private deviceArtists(tracks: DeviceTrack[]): DeviceArtistSummary[] {
    const byArtist = new Map<string, DeviceTrack[]>()
    for (const track of tracks) {
      const artist = track.artist || track.albumArtist || 'Unknown Artist'
      const key = idForValue(artist)
      const group = byArtist.get(key) ?? []
      group.push(track)
      byArtist.set(key, group)
    }

    return [...byArtist.entries()]
      .map(([id, artistTracks]) => {
        const albums = new Set(artistTracks.map(track => track.album || 'Unknown Album'))
        return {
          id,
          name: artistTracks[0]?.artist || artistTracks[0]?.albumArtist || 'Unknown Artist',
          albumCount: albums.size,
          trackCount: artistTracks.length,
          duration: artistTracks.reduce((sum, track) => sum + track.duration, 0),
          fileSize: artistTracks.reduce((sum, track) => sum + (track.fileSize ?? 0), 0),
          tracks: artistTracks.sort((a, b) => a.album.localeCompare(b.album) || a.relativePath.localeCompare(b.relativePath)),
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  private async scanDevicePlaylists(row: DeviceRow, tracks: DeviceTrack[]): Promise<DevicePlaylistSummary[]> {
    const root = resolve(row.root_path)
    const musicRoot = this.deviceMusicRoot(row)
    const trackByKey = new Map(tracks.map(track => [track.key, track]))
    const files = await this.collectPlaylistFiles(root)
    const playlists: DevicePlaylistSummary[] = []

    for (const file of files) {
      let content = ''
      try {
        content = await readFile(file, 'utf8')
      } catch {
        continue
      }

      const playlistTracks: DeviceTrack[] = []
      let missingCount = 0
      for (const line of content.split(/\r?\n/)) {
        const raw = line.trim()
        if (!raw || raw.startsWith('#')) continue
        const track = this.resolvePlaylistEntry(raw, file, root, musicRoot, trackByKey)
        if (track) playlistTracks.push(track)
        else missingCount += 1
      }

      const relativePath = toPosixRelative(root, file)
      playlists.push({
        id: idForValue(relativePath),
        name: basename(file, extname(file)),
        relativePath,
        trackCount: playlistTracks.length,
        missingCount,
        tracks: playlistTracks,
      })
    }

    return playlists.sort((a, b) => a.name.localeCompare(b.name) || a.relativePath.localeCompare(b.relativePath))
  }

  private async collectPlaylistFiles(root: string): Promise<string[]> {
    const out: string[] = []
    const walk = async (dir: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }

      for (const entry of entries) {
        if (entry.name === ROCKBOX_DIR || entry.name === APP_STATE_DIR) continue
        if (entry.name.startsWith('.')) continue
        const full = resolve(dir, entry.name)
        if (!isInside(root, full)) continue
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          await walk(full)
        } else if (entry.isFile() && PLAYLIST_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
          out.push(full)
        }
      }
    }
    await walk(root)
    return out
  }

  private resolvePlaylistEntry(
    rawEntry: string,
    playlistPath: string,
    deviceRoot: string,
    musicRoot: string,
    trackByKey: Map<string, DeviceTrack>,
  ): DeviceTrack | null {
    let value = rawEntry.trim()
    if (/^https?:\/\//i.test(value)) return null
    if (/^file:/i.test(value)) {
      try {
        value = decodeURIComponent(new URL(value).pathname)
      } catch {
        return null
      }
    }
    value = value.split('\\').join('/')

    const candidates: string[] = []
    if (/^[a-zA-Z]:\//.test(value)) {
      candidates.push(resolve(value))
    } else if (value.startsWith('/')) {
      const relative = value.replace(/^\/+/, '')
      candidates.push(resolve(deviceRoot, relative))
      candidates.push(resolve(musicRoot, relative))
    } else {
      candidates.push(resolve(dirname(playlistPath), value))
      candidates.push(resolve(musicRoot, value))
    }

    for (const candidate of candidates) {
      if (!isInside(musicRoot, candidate)) continue
      const key = keyForRelativePath(toPosixRelative(musicRoot, candidate))
      const track = trackByKey.get(key)
      if (track) return track
    }

    return null
  }

  private async scanRockboxThemes(row: DeviceRow): Promise<RockboxThemeSummary[]> {
    const rockboxRoot = join(row.root_path, ROCKBOX_DIR)
    const themesRoot = join(rockboxRoot, 'themes')
    if (!existsSync(themesRoot)) return []

    let entries
    try {
      entries = await readdir(themesRoot, { withFileTypes: true })
    } catch {
      return []
    }

    const themes: RockboxThemeSummary[] = []
    for (const entry of entries) {
      if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.cfg') continue
      const configPath = join(themesRoot, entry.name)
      const name = basename(entry.name, '.cfg')
      let config = ''
      try {
        config = await readFile(configPath, 'utf8')
      } catch {
        /* still show unreadable cfg files */
      }
      const configStat = await stat(configPath).catch(() => null)
      themes.push({
        id: idForValue(name),
        name,
        configPath: `themes/${entry.name}`,
        wpsPath: this.themeConfigPath(rockboxRoot, config, 'wps', `wps/${name}.wps`),
        sbsPath: this.themeConfigPath(rockboxRoot, config, 'sbs', `wps/${name}.sbs`),
        fmsPath: this.themeConfigPath(rockboxRoot, config, 'fms', `wps/${name}.fms`),
        font: this.themeConfigPath(rockboxRoot, config, 'font', null),
        updatedAt: configStat?.mtime.toISOString() ?? null,
      })
    }

    return themes.sort((a, b) => a.name.localeCompare(b.name))
  }

  private themeConfigPath(rockboxRoot: string, config: string, key: string, fallback: string | null): string | null {
    const raw = this.themeConfigValue(config, key)
    const candidates = [
      raw ? this.normalizeRockboxConfigPath(raw) : null,
      fallback,
    ].filter((value): value is string => Boolean(value))

    for (const relPath of candidates) {
      const absolute = fromPosix(rockboxRoot, relPath)
      if (isInside(rockboxRoot, resolve(absolute)) && existsSync(absolute)) return relPath
    }

    return raw && key === 'font' ? this.normalizeRockboxConfigPath(raw) : null
  }

  private themeConfigValue(config: string, key: string): string | null {
    const pattern = new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, 'im')
    const match = config.match(pattern)
    return match?.[1]?.replace(/^"|"$/g, '').trim() || null
  }

  private normalizeRockboxConfigPath(value: string): string {
    const normalized = value.split('\\').join('/').replace(/^\/+/, '')
    return normalized.replace(/^\.rockbox\//i, '')
  }

  private async installRockboxThemeSource(rockboxRoot: string, sourcePath: string): Promise<RockboxThemeInstallSourceResult> {
    let tempDir: string | null = null
    try {
      const source = resolve(sourcePath)
      const sourceStat = await lstat(source)
      if (sourceStat.isSymbolicLink()) throw new Error('Symlink sources are not supported')

      let installRoot = source
      if (sourceStat.isFile()) {
        if (extname(source).toLowerCase() !== '.zip') {
          throw new Error('Only folders and .zip files can be installed as Rockbox themes')
        }
        tempDir = await mkdtemp(join(tmpdir(), 'crate-rockbox-theme-'))
        await extractZip(source, { dir: tempDir })
        installRoot = tempDir
      } else if (!sourceStat.isDirectory()) {
        throw new Error('Theme source must be a folder or .zip file')
      }

      const installFiles = await this.collectRockboxInstallFiles(installRoot)
      if (installFiles.length === 0) {
        return {
          sourcePath,
          status: 'skipped',
          themeNames: [],
          filesCopied: 0,
          error: 'No Rockbox theme files were found',
        }
      }

      for (const file of installFiles) {
        const destination = fromPosix(rockboxRoot, file.destinationRelativePath)
        assertInside(rockboxRoot, resolve(destination))
        await this.copyPreservingMtime(file.sourcePath, destination)
      }

      const themeNames = [...new Set(installFiles.map(file => file.themeName).filter((name): name is string => Boolean(name)))]
      return {
        sourcePath,
        status: 'installed',
        themeNames,
        filesCopied: installFiles.length,
        error: null,
      }
    } catch (err) {
      return {
        sourcePath,
        status: 'failed',
        themeNames: [],
        filesCopied: 0,
        error: err instanceof Error ? err.message : String(err),
      }
    } finally {
      if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private async collectRockboxInstallFiles(sourceRoot: string): Promise<RockboxInstallFile[]> {
    const root = resolve(sourceRoot)
    const sourceFiles = await this.collectRegularInstallFiles(root)
    const relEntries = sourceFiles.map(sourcePath => ({
      sourcePath,
      parts: toPosixRelative(root, sourcePath).split('/').filter(Boolean),
    }))
    const wrapper =
      relEntries.length > 0 &&
      relEntries.every(entry => entry.parts.length > 1 && entry.parts[0] === relEntries[0].parts[0]) &&
      !ROCKBOX_TOP_LEVEL_DIRS.has(relEntries[0].parts[0].toLowerCase()) &&
      relEntries[0].parts[0].toLowerCase() !== ROCKBOX_DIR
        ? relEntries[0].parts[0]
        : null
    const looseThemeName = sanitizeThemeName(
      relEntries.find(entry => extname(entry.parts.at(-1) ?? '').toLowerCase() === '.cfg')?.parts.at(-1) ??
      basename(root),
    )

    const installFiles: RockboxInstallFile[] = []
    const seenDestinations = new Set<string>()
    for (const entry of relEntries) {
      const mapped = this.mapRockboxInstallFile(
        entry.sourcePath,
        wrapper && entry.parts[0] === wrapper ? entry.parts.slice(1) : entry.parts,
        looseThemeName,
      )
      if (!mapped) continue
      if (seenDestinations.has(mapped.destinationRelativePath)) continue
      seenDestinations.add(mapped.destinationRelativePath)
      installFiles.push(mapped)
    }

    return installFiles
  }

  private async collectRegularInstallFiles(root: string): Promise<string[]> {
    const out: string[] = []
    const walk = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name === '__MACOSX' || entry.name === '.DS_Store') continue
        const full = resolve(dir, entry.name)
        if (!isInside(root, full)) throw new Error(`Invalid source path: ${entry.name}`)
        const entryStat = await lstat(full)
        if (entryStat.isSymbolicLink()) throw new Error(`Symlink entries are not supported: ${entry.name}`)
        if (entryStat.isDirectory()) {
          await walk(full)
        } else if (entryStat.isFile()) {
          out.push(full)
        }
      }
    }
    await walk(root)
    return out
  }

  private mapRockboxInstallFile(sourcePath: string, originalParts: string[], looseThemeName: string): RockboxInstallFile | null {
    let parts = [...originalParts]
    const rockboxIndex = parts.findIndex(part => part.toLowerCase() === ROCKBOX_DIR)
    if (rockboxIndex >= 0) {
      parts = parts.slice(rockboxIndex + 1)
    } else {
      const firstRockboxDir = parts.findIndex(part => ROCKBOX_TOP_LEVEL_DIRS.has(part.toLowerCase()))
      if (firstRockboxDir > 0) parts = parts.slice(firstRockboxDir)
    }

    const fileName = parts.at(-1)
    if (!fileName) return null
    const ext = extname(fileName).toLowerCase()
    const top = parts[0]?.toLowerCase()

    if (top && ROCKBOX_TOP_LEVEL_DIRS.has(top)) {
      if (top === 'themes' && ext !== '.cfg') return null
      const destination = this.normalizeRockboxDestinationParts([top, ...parts.slice(1)])
      if (!destination) return null
      return {
        sourcePath,
        destinationRelativePath: destination,
        themeName: top === 'themes' && ext === '.cfg'
          ? sanitizeThemeName(fileName)
          : top === 'wps' && ROCKBOX_SKIN_EXTENSIONS.has(ext)
            ? sanitizeThemeName(fileName)
            : null,
      }
    }

    if (ext === '.cfg') {
      return {
        sourcePath,
        destinationRelativePath: `themes/${fileName}`,
        themeName: sanitizeThemeName(fileName),
      }
    }

    if (ROCKBOX_SKIN_EXTENSIONS.has(ext)) {
      return {
        sourcePath,
        destinationRelativePath: `wps/${fileName}`,
        themeName: sanitizeThemeName(fileName),
      }
    }

    if (ROCKBOX_ASSET_EXTENSIONS.has(ext)) {
      const assetParts = parts.filter(part => part !== '.' && part !== '..')
      const destination = this.normalizeRockboxDestinationParts(['wps', looseThemeName, ...assetParts])
      if (!destination) return null
      return {
        sourcePath,
        destinationRelativePath: destination,
        themeName: looseThemeName,
      }
    }

    return null
  }

  private normalizeRockboxDestinationParts(parts: string[]): string | null {
    if (parts.length < 2) return null
    const normalized = parts.map((part, index) => index === 0 ? part.toLowerCase() : part)
    const top = normalized[0]
    if (!ROCKBOX_TOP_LEVEL_DIRS.has(top)) return null
    if (normalized.some(part => !part || part === '.' || part === '..' || part.includes('\u0000') || part.includes('/') || part.includes('\\'))) {
      return null
    }
    return normalized.join('/')
  }

  private deviceVersions(row: DeviceRow): DeviceVersionInfo {
    const stateDir = join(row.root_path, APP_STATE_DIR)
    const deviceYaml = readYamlFileSync<DeviceYaml>(join(stateDir, 'device.yaml'))
    const machineStateVersion = this.detectMachineStateVersion(stateDir)
    return {
      crateStateVersion: typeof deviceYaml?.version === 'number' ? deviceYaml.version : null,
      machineStateVersion,
      rockboxVersion: this.detectRockboxVersion(row.root_path),
      firmwareVersion: this.detectFirmwareVersion(row.root_path),
    }
  }

  private detectMachineStateVersion(stateDir: string): number | null {
    const machinesDir = join(stateDir, 'machines')
    if (!existsSync(machinesDir)) return null
    let version: number | null = null
    try {
      for (const entry of readdirSync(machinesDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.yaml')) continue
        const machine = readYamlFileSync<MachineYaml>(join(machinesDir, entry.name))
        if (typeof machine?.version !== 'number') continue
        version = version == null ? machine.version : Math.max(version, machine.version)
      }
    } catch {
      return version
    }
    return version
  }

  private detectRockboxVersion(rootPath: string): string | null {
    for (const parts of ROCKBOX_VERSION_FILES) {
      const text = readTextProbe(join(rootPath, ...parts))
      if (!text) continue
      const version = extractVersionFromText(text, /rockbox/i)
      if (version) return version
    }
    return null
  }

  private detectFirmwareVersion(rootPath: string): string | null {
    for (const parts of FIRMWARE_VERSION_FILES) {
      const text = readTextProbe(join(rootPath, ...parts))
      if (!text) continue
      const version = extractVersionFromText(text)
      if (version) return version
    }
    return null
  }

  private setPortableState(deviceId: string, writable: boolean | null, error: string | null): void {
    this.portableStateCache.set(deviceId, {
      writable,
      error,
      lastCheckedAt: nowIso(),
    })
  }

  private portableStateFor(row: DeviceRow): DevicePortableState {
    return this.portableStateCache.get(row.id) ?? {
      writable: null,
      error: null,
      lastCheckedAt: null,
    }
  }

  private async assertPortableStateWritable(row: DeviceRow): Promise<void> {
    const stateDir = join(row.root_path, APP_STATE_DIR)
    const probePath = join(stateDir, `.write-test-${randomUUID()}.tmp`)
    try {
      await mkdir(stateDir, { recursive: true })
      await writeFile(probePath, 'ok', 'utf8')
      await unlink(probePath).catch(() => undefined)
      this.setPortableState(row.id, true, null)
    } catch (err) {
      await unlink(probePath).catch(() => undefined)
      const message = `No se puede sincronizar porque .crate no es escribible en el dispositivo: ${errorMessage(err)}`
      this.setPortableState(row.id, false, message)
      await this.publishVolumeSnapshot(true)
      throw new Error(message)
    }
  }

  private syncPortableWriteError(err: unknown): Error {
    if (isPortableWriteError(err)) {
      return new Error(`No se puede sincronizar porque .crate no es escribible en el dispositivo: ${errorMessage(err)}`)
    }
    return err instanceof Error ? err : new Error(String(err))
  }

  private rowToRecord(row: DeviceRow): DeviceRecord {
    return {
      id: row.id,
      name: row.name,
      rootPath: row.root_path,
      musicRoot: row.music_root,
      defaultMode: row.sync_mode,
      pcTargetPath: row.pc_target_path,
      artworkMaxEdge: clampDeviceArtworkEdge(row.artwork_max_edge),
      hasRockbox: row.has_rockbox === 1,
      isAvailable: existsSync(row.root_path),
      trackCount: row.track_count,
      sourceLibraryIds: this.deviceLibraryIds(row.id),
      versions: this.deviceVersions(row),
      portableState: this.portableStateFor(row),
      lastSeenAt: row.last_seen_at,
      lastScanAt: row.last_scan_at,
      lastSyncAt: row.last_sync_at,
    }
  }

  // Folders (libraries) this device is configured to sync from. Empty list means
  // "every library" — see pcLibraryTracks / planSync.
  private deviceLibraryIds(deviceId: string): number[] {
    return getDatabase()
      .prepare<[string], { folder_id: number }>(
        `SELECT folder_id FROM device_libraries WHERE device_id = ? ORDER BY folder_id`,
      )
      .all(deviceId)
      .map(r => r.folder_id)
  }

  // Replace the device's source-library selection. Stale folder ids (folders that
  // no longer exist) are dropped so the foreign key never rejects the insert.
  private setDeviceLibraries(deviceId: string, folderIds: number[]): void {
    const db = getDatabase()
    const existing = new Set(getRepos().folders.list().map(folder => folder.id))
    const unique = [...new Set(folderIds)].filter(id => Number.isInteger(id) && existing.has(id))
    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM device_libraries WHERE device_id = ?`).run(deviceId)
      const insert = db.prepare(
        `INSERT OR IGNORE INTO device_libraries (device_id, folder_id) VALUES (?, ?)`,
      )
      for (const folderId of unique) insert.run(deviceId, folderId)
    })
    tx()
  }

  private listDeviceRows(): DeviceRow[] {
    return getDatabase()
      .prepare<unknown[], DeviceRow>(`
        SELECT * FROM devices ORDER BY last_seen_at DESC, name COLLATE NOCASE ASC
      `)
      .all()
  }

  private getDeviceRow(deviceId: string): DeviceRow | undefined {
    return getDatabase()
      .prepare<[string], DeviceRow>(`SELECT * FROM devices WHERE id = ?`)
      .get(deviceId)
  }

  private getDeviceRowByRoot(rootPath: string): DeviceRow | undefined {
    return getDatabase()
      .prepare<[string], DeviceRow>(`SELECT * FROM devices WHERE root_path = ?`)
      .get(rootPath)
  }

  private requireDevice(deviceId: string): DeviceRow {
    const row = this.getDeviceRow(deviceId)
    if (!row) throw new Error('Device is not connected')
    if (!existsSync(row.root_path)) throw new Error('Device is not mounted')
    return row
  }

  private upsertDevice(row: DeviceRow): void {
    getDatabase()
      .prepare(`
        INSERT INTO devices (
          id, name, root_path, music_root, sync_mode, pc_target_path, artwork_max_edge, has_rockbox,
          track_count, created_at, last_seen_at, last_scan_at, last_sync_at
        ) VALUES (
          @id, @name, @root_path, @music_root, @sync_mode, @pc_target_path, @artwork_max_edge, @has_rockbox,
          @track_count, @created_at, @last_seen_at, @last_scan_at, @last_sync_at
        )
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          root_path = excluded.root_path,
          music_root = excluded.music_root,
          sync_mode = excluded.sync_mode,
          pc_target_path = excluded.pc_target_path,
          artwork_max_edge = excluded.artwork_max_edge,
          has_rockbox = excluded.has_rockbox,
          last_seen_at = excluded.last_seen_at
      `)
      .run(row as unknown as Record<string, unknown>)
  }

  private async machineId(): Promise<string> {
    const target = join(app.getPath('userData'), MACHINE_ID_FILE)
    if (existsSync(target)) {
      const existing = (await readFile(target, 'utf8')).trim()
      if (existing) return existing
    }
    const id = randomUUID()
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, id, 'utf8')
    return id
  }

  private defaultPcTargetPath(deviceName: string): string {
    return join(app.getPath('music'), 'Crate Device Imports', sanitizeFolderName(deviceName))
  }

  private deviceMusicRoot(row: DeviceRow): string {
    const root = row.music_root === '.' ? row.root_path : fromPosix(row.root_path, row.music_root)
    const resolved = resolve(root)
    assertInside(resolve(row.root_path), resolved)
    return resolved
  }

  private async scanDeviceRow(row: DeviceRow, sendProgress: boolean): Promise<ScanInternalResult> {
    const musicRoot = this.deviceMusicRoot(row)
    const files = await this.collectAudioFiles(row.id, musicRoot, sendProgress)
    const tracks: DeviceTrack[] = []
    let scanned = 0
    let errors = 0

    for (const file of files) {
      try {
        const md = await readTrackMetadata(file)
        const relativePath = toPosixRelative(musicRoot, file)
        const track: DeviceTrack = {
          key: keyForRelativePath(relativePath),
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
        if (sendProgress) {
          broadcast('devices:scan:progress', {
            deviceId: row.id,
            scanned,
            total: files.length,
            phase: 'reading',
          })
        }
      }
    }

    if (sendProgress) {
      broadcast('devices:scan:progress', {
        deviceId: row.id,
        scanned,
        total: files.length,
        phase: 'complete',
      })
    }

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

  private async collectAudioFiles(deviceId: string, root: string, sendProgress: boolean): Promise<string[]> {
    const out: string[] = []
    const rootResolved = resolve(root)
    if (sendProgress) {
      broadcast('devices:scan:progress', {
        deviceId,
        scanned: 0,
        total: 0,
        phase: 'discovering',
      })
    }

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
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          await walk(full, ignored)
        } else if (!ignored && entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
          out.push(full)
        }
      }
    }

    await walk(rootResolved, false)
    return out
  }

  private async pcLibraryTracks(folderIds?: Set<number>): Promise<PcTrack[]> {
    const repos = getRepos()
    const allFolders = repos.folders.list()
    // Scope to the device's selected libraries; empty/undefined = every library.
    const folders =
      folderIds && folderIds.size > 0
        ? allFolders.filter(folder => folderIds.has(folder.id))
        : allFolders
    const folderById = new Map(folders.map(folder => [folder.id, folder]))
    const dbTracks = repos.tracks.getAll()
    const rawRelCounts = new Map<string, number>()

    for (const track of dbTracks) {
      const folder = folderById.get(track.folder_id)
      if (!folder) continue
      const rawRel = toPosixRelative(folder.path, track.path)
      const key = keyForRelativePath(rawRel)
      rawRelCounts.set(key, (rawRelCounts.get(key) ?? 0) + 1)
    }

    const usedKeys = new Set<string>()
    const tracks: PcTrack[] = []
    for (const track of dbTracks) {
      const folder = folderById.get(track.folder_id)
      if (!folder) continue
      const sourceRelativePath = toPosixRelative(folder.path, track.path)
      const rawKey = keyForRelativePath(sourceRelativePath)
      let relativePath = sourceRelativePath
      if ((rawRelCounts.get(rawKey) ?? 0) > 1) {
        const folderPrefix = sanitizeFolderName(folder.name || basename(folder.path) || `folder-${folder.id}`)
        relativePath = `${folderPrefix}/${sourceRelativePath}`
      }
      let key = keyForRelativePath(relativePath)
      if (usedKeys.has(key)) {
        relativePath = `folder-${folder.id}/${sourceRelativePath}`
        key = keyForRelativePath(relativePath)
      }
      usedKeys.add(key)

      const pcTrack = this.dbTrackToPcTrack(track, folder.id, folder.name, folder.path, sourceRelativePath, relativePath, key)
      tracks.push(pcTrack)
    }

    return tracks.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  }

  private dbTrackToPcTrack(
    track: DbTrack,
    folderId: number,
    folderName: string,
    folderPath: string,
    sourceRelativePath: string,
    relativePath: string,
    key: string,
  ): PcTrack {
    const out: PcTrack = {
      key,
      relativePath,
      absolutePath: track.path,
      title: track.title,
      artist: track.artist,
      album: track.album,
      albumArtist: track.album_artist,
      duration: track.duration,
      format: track.format,
      fileSize: track.file_size,
      dateModified: track.date_modified,
      fingerprint: '',
      folderId,
      folderName,
      folderPath,
      sourceRelativePath,
    }
    out.fingerprint = trackFingerprint(out)
    return out
  }

  private async readLibraryState(row: DeviceRow): Promise<LibraryStateYaml | null> {
    return readYamlFile<LibraryStateYaml>(join(row.root_path, APP_STATE_DIR, 'library-state.yaml'))
  }

  private buildActions(args: {
    mode: DeviceSyncMode
    pcTracks: PcTrack[]
    deviceTracks: DeviceTrack[]
    baseline: LibraryStateYaml | null
    deviceMusicRoot: string
    pcTargetPath: string
  }): DeviceSyncAction[] {
    const pcByKey = new Map(args.pcTracks.map(track => [track.key, track]))
    const deviceByKey = new Map(args.deviceTracks.map(track => [track.key, track]))
    const basePc = args.baseline?.pc.tracks ?? {}
    const baseDevice = args.baseline?.device.tracks ?? {}
    const keys = new Set([...pcByKey.keys(), ...deviceByKey.keys(), ...Object.keys(basePc), ...Object.keys(baseDevice)])
    const actions: DeviceSyncAction[] = []

    const push = (kind: DeviceSyncActionKind, key: string, pc: PcTrack | undefined, device: DeviceTrack | undefined, reason: string) => {
      actions.push(this.makeAction(kind, key, pc, device, reason, args.deviceMusicRoot, args.pcTargetPath))
    }

    for (const key of [...keys].sort()) {
      const pc = pcByKey.get(key)
      const device = deviceByKey.get(key)
      const pcBase = basePc[key]
      const deviceBase = baseDevice[key]
      const unchangedSinceBaseline =
        pc &&
        device &&
        pcBase &&
        deviceBase &&
        pc.fingerprint === pcBase.fingerprint &&
        device.fingerprint === deviceBase.fingerprint

      if (unchangedSinceBaseline) continue

      if (args.mode === 'pc_to_device') {
        if (pc && !device) push('copy_pc_to_device', key, pc, device, 'Missing on device')
        else if (pc && device && pc.fingerprint !== device.fingerprint) push('replace_device', key, pc, device, 'PC version differs')
        else if (!pc && device) push('delete_device', key, pc, device, 'Not present in PC library')
        continue
      }

      if (args.mode === 'device_to_pc') {
        if (device && !pc) push('copy_device_to_pc', key, pc, device, 'Missing on PC')
        else if (device && pc && pc.fingerprint !== device.fingerprint) push('replace_pc', key, pc, device, 'Device version differs')
        else if (!device && pc) push('delete_pc', key, pc, device, 'Not present on device')
        continue
      }

      if (pc && !device) {
        if (deviceBase && pcBase && pc.fingerprint === pcBase.fingerprint) {
          push('delete_pc', key, pc, device, 'Deleted from device since last sync')
        } else if (deviceBase && pcBase) {
          push('skip_conflict', key, pc, device, 'Device deleted it, PC changed it')
        } else {
          push('copy_pc_to_device', key, pc, device, 'New on PC')
        }
        continue
      }

      if (device && !pc) {
        if (pcBase && deviceBase && device.fingerprint === deviceBase.fingerprint) {
          push('delete_device', key, pc, device, 'Deleted from PC since last sync')
        } else if (pcBase && deviceBase) {
          push('skip_conflict', key, pc, device, 'PC deleted it, device changed it')
        } else {
          push('copy_device_to_pc', key, pc, device, 'New on device')
        }
        continue
      }

      if (!pc || !device || pc.fingerprint === device.fingerprint) continue

      const pcChanged = !pcBase || pcBase.fingerprint !== pc.fingerprint
      const deviceChanged = !deviceBase || deviceBase.fingerprint !== device.fingerprint
      if (pcChanged && !deviceChanged) push('replace_device', key, pc, device, 'Changed on PC')
      else if (deviceChanged && !pcChanged) push('replace_pc', key, pc, device, 'Changed on device')
      else push('skip_conflict', key, pc, device, 'Changed on both sides')
    }

    return actions
  }

  private makeAction(
    kind: DeviceSyncActionKind,
    key: string,
    pc: PcTrack | undefined,
    device: DeviceTrack | undefined,
    reason: string,
    deviceMusicRoot: string,
    pcTargetPath: string,
  ): DeviceSyncAction {
    const detailTrack =
      kind === 'copy_device_to_pc' || kind === 'replace_pc' || kind === 'delete_device'
        ? device ?? pc
        : pc ?? device
    const relativePath = detailTrack?.relativePath ?? pc?.relativePath ?? device?.relativePath ?? key
    const sourcePath =
      kind === 'copy_pc_to_device' || kind === 'replace_device' || kind === 'delete_pc'
        ? pc?.absolutePath ?? null
        : kind === 'skip_conflict'
          ? pc?.absolutePath ?? device?.absolutePath ?? null
          : device?.absolutePath ?? null
    const destinationPath =
      kind === 'copy_pc_to_device'
        ? fromPosix(deviceMusicRoot, pc?.relativePath ?? relativePath)
        : kind === 'replace_device'
          ? device?.absolutePath ?? fromPosix(deviceMusicRoot, pc?.relativePath ?? relativePath)
          : kind === 'copy_device_to_pc'
            ? fromPosix(pcTargetPath, device?.relativePath ?? relativePath)
            : kind === 'replace_pc'
              ? pc?.absolutePath ?? fromPosix(pcTargetPath, device?.relativePath ?? relativePath)
          : null

    return {
      id: randomUUID(),
      kind,
      key,
      relativePath,
      title: detailTrack?.title ?? relativePath,
      artist: detailTrack?.artist ?? '',
      album: detailTrack?.album ?? '',
      sourcePath,
      destinationPath,
      bytes: kind === 'delete_device' || kind === 'delete_pc' || kind === 'skip_conflict'
        ? 0
        : detailTrack?.fileSize ?? 0,
      reason,
    }
  }

  private async applyAction(
    action: DeviceSyncAction,
    ctx: {
      deviceRoot: string
      deviceMusicRoot: string
      pcTargetPath: string
      runId: string
      affectedPcFolderIds: Set<number>
    },
  ): Promise<void> {
    switch (action.kind) {
      case 'copy_pc_to_device':
      case 'replace_device':
        if (!action.sourcePath || !action.destinationPath) throw new Error('Invalid copy action')
        assertInside(ctx.deviceMusicRoot, resolve(action.destinationPath))
        await this.copyPreservingMtime(action.sourcePath, action.destinationPath)
        return
      case 'copy_device_to_pc':
        if (!action.sourcePath || !action.destinationPath) throw new Error('Invalid copy action')
        assertInside(resolve(ctx.pcTargetPath), resolve(action.destinationPath))
        await this.copyPreservingMtime(action.sourcePath, action.destinationPath)
        return
      case 'replace_pc':
        if (!action.sourcePath || !action.destinationPath) throw new Error('Invalid copy action')
        this.assertPcWriteAllowed(action.destinationPath, ctx.pcTargetPath)
        await this.copyPreservingMtime(action.sourcePath, action.destinationPath)
        return
      case 'delete_device':
        await this.moveDeviceFileToTrash(ctx.deviceRoot, ctx.deviceMusicRoot, action.relativePath, ctx.runId)
        return
      case 'delete_pc':
        if (!action.sourcePath) throw new Error('Invalid delete action')
        await this.trashPcFile(action.sourcePath, ctx.affectedPcFolderIds)
        return
      case 'skip_conflict':
        return
    }
  }

  private async copyPreservingMtime(source: string, destination: string): Promise<void> {
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(source, destination)
    try {
      const sourceStat = await stat(source)
      await utimes(destination, sourceStat.atime, sourceStat.mtime)
    } catch {
      /* mtime preservation is best-effort */
    }
  }

  private assertPcWriteAllowed(destinationPath: string, pcTargetPath: string): void {
    const destination = resolve(destinationPath)
    if (isInside(resolve(pcTargetPath), destination)) return
    const folders = getRepos().folders.list()
    if (folders.some(folder => isInside(resolve(folder.path), destination))) return
    throw new Error(`Refusing to write outside the configured PC library: ${destinationPath}`)
  }

  private async moveDeviceFileToTrash(deviceRoot: string, deviceMusicRoot: string, relPath: string, runId: string): Promise<void> {
    const source = fromPosix(deviceMusicRoot, relPath)
    assertInside(deviceMusicRoot, resolve(source))
    const destination = fromPosix(join(deviceRoot, APP_STATE_DIR, 'trash', runId), relPath)
    assertInside(join(deviceRoot, APP_STATE_DIR, 'trash', runId), resolve(destination))
    if (!existsSync(source)) return
    await mkdir(dirname(destination), { recursive: true })
    await rename(source, destination)
  }

  private async trashPcFile(sourcePath: string, affectedFolderIds: Set<number>): Promise<void> {
    const repos = getRepos()
    const track = repos.tracks.getByPath(sourcePath)
    await shell.trashItem(sourcePath)
    if (track) {
      repos.tracks.deleteByPath(sourcePath)
      affectedFolderIds.add(track.folder_id)
    }
  }

  private async importPcTarget(pcTargetPath: string): Promise<void> {
    const target = resolve(pcTargetPath)
    await mkdir(target, { recursive: true })
    const repos = getRepos()
    const name = basename(target) || target
    const folder = repos.folders.add(target, name)
    getFolderWatcher().start(folder.id, folder.path)
    await getImportService().scan(folder.id, folder.path)
  }

  private async writeSuccessfulState(row: DeviceRow, plan: DeviceSyncPlan, result: DeviceSyncApplyResult): Promise<void> {
    const freshRow = this.getDeviceRow(row.id) ?? row
    const machineId = await this.machineId()
    const [pcTracks, deviceScan] = await Promise.all([
      this.pcLibraryTracks(),
      this.scanDeviceRow(freshRow, false),
    ])
    const completedAt = result.completedAt
    const state: LibraryStateYaml = {
      version: DEVICE_STATE_VERSION,
      updatedAt: completedAt,
      machineId,
      pc: {
        trackCount: pcTracks.length,
        tracks: snapshotFromTracks(pcTracks),
      },
      device: {
        trackCount: deviceScan.tracks.length,
        tracks: snapshotFromTracks(deviceScan.tracks),
      },
    }
    const stateDir = join(row.root_path, APP_STATE_DIR)
    const existingDevice = await readYamlFile<DeviceYaml>(join(stateDir, 'device.yaml'))
    const linkedMachineIds = new Set(existingDevice?.linkedMachineIds ?? [])
    linkedMachineIds.add(machineId)
    try {
      await writeYamlFile(join(stateDir, 'device.yaml'), {
        version: existingDevice?.version ?? DEVICE_STATE_VERSION,
        appName: existingDevice?.appName ?? 'Crate',
        deviceId: row.id,
        name: freshRow.name,
        musicRoot: freshRow.music_root,
        defaultSyncMode: plan.mode,
        artworkMaxEdge: clampDeviceArtworkEdge(freshRow.artwork_max_edge),
        linkedMachineIds: [...linkedMachineIds],
        createdAt: existingDevice?.createdAt ?? row.created_at,
        updatedAt: completedAt,
      } satisfies DeviceYaml)
      await writeYamlFile(join(stateDir, 'library-state.yaml'), state)
      await writeYamlFile(join(stateDir, 'sync-runs', `${completedAt.replace(/[:.]/g, '-')}-${plan.id}.yaml`), {
        version: DEVICE_STATE_VERSION,
        plan,
        result,
      })

      const machinePath = join(stateDir, 'machines', `${machineId}.yaml`)
      const machine = await readYamlFile<MachineYaml>(machinePath)
      if (machine) {
        machine.lastSyncAt = completedAt
        machine.lastSeenAt = completedAt
        machine.pcTargetPath = plan.pcTargetPath
        await writeYamlFile(machinePath, machine)
      }
      this.setPortableState(row.id, true, null)
    } catch (err) {
      const wrapped = this.syncPortableWriteError(err)
      this.setPortableState(row.id, false, wrapped.message)
      await this.publishVolumeSnapshot(true)
      throw wrapped
    }

    getDatabase()
      .prepare(`
        UPDATE devices
        SET sync_mode = ?, pc_target_path = ?, track_count = ?, last_scan_at = ?, last_sync_at = ?, last_seen_at = ?
        WHERE id = ?
      `)
      .run(plan.mode, plan.pcTargetPath, deviceScan.tracks.length, completedAt, completedAt, completedAt, row.id)
  }

  private upsertSyncRun(runId: string, plan: DeviceSyncPlan, startedAt: string): void {
    getDatabase()
      .prepare(`
        INSERT INTO device_sync_runs (id, device_id, mode, started_at, status, plan_json)
        VALUES (?, ?, ?, ?, 'running', ?)
        ON CONFLICT(id) DO UPDATE SET
          status = 'running',
          finished_at = NULL,
          plan_json = excluded.plan_json,
          result_json = NULL
      `)
      .run(runId, plan.deviceId, plan.mode, startedAt, JSON.stringify(plan))
  }

  private finishSyncRun(runId: string, status: 'success' | 'failed', finishedAt: string, result: DeviceSyncApplyResult): void {
    getDatabase()
      .prepare(`
        UPDATE device_sync_runs SET status = ?, finished_at = ?, result_json = ? WHERE id = ?
      `)
      .run(status, finishedAt, JSON.stringify(result), runId)
  }

  private broadcastSyncProgress(
    plan: DeviceSyncPlan,
    phase: DeviceSyncPhase,
    completed: number,
    total: number,
    currentPath?: string,
  ): void {
    broadcast('devices:sync:progress', {
      deviceId: plan.deviceId,
      planId: plan.id,
      phase,
      completed,
      total,
      currentPath,
    })
  }
}

let instance: DeviceSyncService | null = null
export function getDeviceSyncService(): DeviceSyncService {
  if (!instance) instance = new DeviceSyncService()
  return instance
}
