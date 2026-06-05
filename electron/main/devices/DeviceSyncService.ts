import { app, dialog, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
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
import { createThrottledBroadcaster, type ThrottledBroadcaster } from '../ipc/throttle'
import {
  optimizeEmbeddedArtwork,
  probeEmbeddedArtwork,
  type EmbeddedArtworkProbe,
  type EmbeddedArtworkProbePicture,
} from './ArtworkOptimizer'
import {
  assertOptimizedArtworkWithinLimit,
  artworkOptimizationTempPath,
  countProcessedArtworkSteps,
  hasArtworkOverLimit,
  shouldYieldArtworkAnalysis,
} from './artworkOptimizationGuards'
import { resolveArtworkOptimizationFiles } from './artworkOptimizeSelection'
import { classifyArtwork } from './artworkOptimizeDecision'
import {
  resolveOptimizeArtworkSelection,
  shouldOptimizeArtworkBeforeDeviceCopy,
} from './artworkSyncPreference'
import {
  applyPendingTrackAlbumMovesToPlan,
  type TrackAlbumMoveRow,
} from './albumMoveSyncPlan'
import { scanRockboxThemes } from './RockboxThemeScanner'
import {
  isRockboxIgnoredEntryName,
  isRockboxIgnoredRelativePath,
} from './rockboxIgnoredFiles.ts'
import { trackFingerprint } from './trackFingerprint'
import { mergeLibraryStateBaseline } from './libraryStateBaseline'
import { sidecarPathFor } from '../lyrics/providers/SidecarLrcProvider'
import { sanitizeLegacyDeviceSyncJournal } from './deviceSyncJournalSanitizer'
import {
  collectDeviceAudioFiles,
  DEVICE_SCAN_METADATA_CONCURRENCY,
  scanDeviceAudioTree,
  type DeviceScanTrackMetadata,
  type DeviceScanInternalResult,
} from './deviceScanCore'
import { clampDeviceArtworkEdge } from '@shared/constants/device-sync'
import { getOneDriveClient } from '../cloud/OneDriveClient'
import { resolveCloudLoadOptions } from '../cloud/cloudTrackRef'
import { cloudDeviceRelativePath, sanitizeSegment } from './cloudDeviceRelativePath'
import type { DbTrack } from '@shared/types/db'
import type { PickFolderResult } from '@shared/types/ipc-contract'
import type {
  ArtworkStatus,
  DeviceAlbumSummary,
  DeviceArtworkAnalysisItem,
  DeviceArtworkAnalysisResult,
  DeviceArtworkAnalysisSummary,
  DeviceArtworkOptimizationSelection,
  DeviceArtworkOptimizationSummary,
  DeviceArtistSummary,
  DeviceCandidate,
  DeviceConnectPayload,
  DeviceCapacitySummary,
  DeviceJournalStatus,
  DeviceLibraryOptions,
  DeviceLibraryResult,
  DeviceMusicRootPickResult,
  DeviceOverviewResult,
  DevicePlaylistSummary,
  DevicePendingJournal,
  DevicePortableState,
  DeviceRecord,
  DeviceScanResult,
  DeviceScanProgressEvent,
  DeviceSyncApplySelection,
  DeviceSettingsUpdate,
  DeviceStorageSummary,
  DeviceSyncAction,
  DeviceSyncActionKind,
  DeviceSyncApplyResult,
  DeviceSyncBase,
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
  RockboxThemeDeleteFileResult,
  RockboxThemeDeleteResult,
  RockboxThemeInstallResult,
  RockboxThemeInstallSourceResult,
  RockboxThemeLibraryResult,
} from '@shared/types/device-sync'

const APP_STATE_DIR = '.crate'
const ROCKBOX_DIR = '.rockbox'
const JOURNAL_DIR = 'journals'
const MACHINE_ID_FILE = 'machine-id'
const IGNORED_VOLUMES_SETTINGS_FILE = 'device-ignored-volumes.json'
const IGNORED_VOLUMES_SETTINGS_VERSION = 1
const DEVICE_STATE_VERSION = 1
const DEFAULT_SYNC_MODE: DeviceSyncMode = 'bidirectional_safe'
const VOLUME_MONITOR_INTERVAL_MS = 5000
const TEXT_PROBE_LIMIT = 16 * 1024

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

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
  sync_base: DeviceSyncBase
  pc_target_path: string
  artwork_max_edge: number
  fetch_lyrics: number
  optimize_artwork_on_sync: number
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
  fetchMissingLyrics?: boolean
  optimizeArtworkOnSync?: boolean
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
  duration?: number
  format?: string
  albumArtist?: string | null
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

type ScanInternalResult = DeviceScanInternalResult

interface CachedPlan {
  plan: DeviceSyncPlan
  deviceRoot: string
  deviceMusicRoot: string
  deviceFiles: string[]
  expiresAt: number
}

interface ActiveDeviceScan {
  promise: Promise<ScanInternalResult>
  progress: boolean
  lastProgress: DeviceScanProgressEvent | null
}

const PLAN_CACHE_TTL_MS = 30 * 60 * 1000
const PLAN_CACHE_MAX_ENTRIES = 10

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
  writeCompleteState?: boolean
  deviceRoot: string
  deviceMusicRoot: string
  startedAt: string
  updatedAt: string
  completedAt?: string
  actions: SyncJournalStep[]
  lyrics?: SyncJournalStep[]
  artwork: SyncJournalStep[]
  optimizeArtwork?: boolean
  pcTargetImported?: boolean
  result?: DeviceSyncApplyResult
}

interface DeviceCopyArtworkOutcome {
  optimized: boolean
  bytesSaved: number
}

interface StagedDeviceCopy {
  path: string
  outcome: DeviceCopyArtworkOutcome
  cleanup: () => Promise<void>
}

interface ApplyActionResult {
  deviceArtwork?: DeviceCopyArtworkOutcome
}

interface RockboxInstallFile {
  sourcePath: string
  destinationRelativePath: string
  themeName: string | null
}

interface PersistedIgnoredVolumes {
  version?: number
  ignoredUnknownRoots?: unknown[]
}

function nowIso(): string {
  return new Date().toISOString()
}

function parseTimeMs(value: string | null): number {
  return value == null ? Number.NaN : Date.parse(value)
}

function isFiniteTime(value: string | null): number {
  const time = parseTimeMs(value)
  return Number.isFinite(time) ? time : Number.NaN
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

// A track row's `path` is a synthetic onedrive://{driveId}/{itemId} URI for
// cloud-backed sources; such a "source" must be downloaded, not read from disk.
function isCloudSourcePath(path: string): boolean {
  return path.startsWith('onedrive://')
}

function buildReusableDeviceTrackMetadata(state: LibraryStateYaml | null): Map<string, DeviceScanTrackMetadata> {
  const out = new Map<string, DeviceScanTrackMetadata>()
  if (!state?.device?.tracks) return out
  for (const value of Object.values(state.device.tracks)) {
    if (!value?.relativePath || typeof value.relativePath !== 'string') continue
    if (!value.title || typeof value.title !== 'string') continue
    if (typeof value.artist !== 'string') continue
    if (typeof value.album !== 'string') continue
    if (typeof value.fingerprint !== 'string') continue
    if (typeof value.duration !== 'number' || !Number.isFinite(value.duration)) continue
    if (typeof value.format !== 'string' || value.format.trim().length === 0) continue

    const relPath = value.relativePath
    const key = keyForRelativePath(relPath)
    out.set(key, {
      title: value.title,
      artist: value.artist,
      album: value.album,
      albumArtist: value.albumArtist ?? null,
      duration: value.duration,
      format: value.format,
      fileSize: value.fileSize,
      dateModified: value.dateModified,
    })
  }
  return out
}

function isUsableLibraryState(state: LibraryStateYaml | null): state is LibraryStateYaml {
  if (!state) return false
  if (typeof state.version !== 'number') return false
  if (!state.pc || !state.device) return false
  if (!state.pc.tracks || Array.isArray(state.pc.tracks)) return false
  if (!state.device.tracks || Array.isArray(state.device.tracks)) return false
  const pcTrackCount = Object.keys(state.pc.tracks).length
  const deviceTrackCount = Object.keys(state.device.tracks).length
  return state.pc.trackCount === pcTrackCount && state.device.trackCount === deviceTrackCount
}

function tracksChangedSince(tracks: Array<{ key: string, dateModified: string | null }>, changedSinceMs: number): Set<string> {
  const out = new Set<string>()
  if (!Number.isFinite(changedSinceMs)) return out
  for (const track of tracks) {
    const value = isFiniteTime(track.dateModified)
    if (Number.isFinite(value) && value > changedSinceMs) out.add(track.key)
  }
  return out
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

function validateSyncBase(value: unknown): DeviceSyncBase {
  if (value === 'pc' || value === 'device' || value === 'review') {
    return value
  }
  return 'review'
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
      duration: track.duration,
      format: track.format,
      albumArtist: track.albumArtist,
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

// Async existence check: routes the (potentially slow) syscall through the libuv
// threadpool instead of blocking the main event loop. Use this on any path that
// can live on an external/sleeping drive so the spin-up wait doesn't freeze the app.
async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function readYamlFile<T>(path: string): Promise<T | null> {
  if (!(await pathExists(path))) return null
  try {
    return parseYaml(await readFile(path, 'utf8')) as T
  } catch (err) {
    console.warn(`[devices] failed to read ${path}:`, (err as Error).message)
    return null
  }
}

async function readTextProbeAsync(path: string): Promise<string | null> {
  if (!(await pathExists(path))) return null
  try {
    return (await readFile(path, 'utf8')).slice(0, TEXT_PROBE_LIMIT)
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

function emptyStorageSummary(error: string | null = null): DeviceStorageSummary {
  return {
    totalBytes: 0,
    usedBytes: 0,
    freeBytes: 0,
    musicBytes: 0,
    rockboxBytes: 0,
    otherBytes: 0,
    scannedAt: nowIso(),
    error,
  }
}

function emptyCapacitySummary(error: string | null = null): DeviceCapacitySummary {
  return {
    totalBytes: 0,
    usedBytes: 0,
    freeBytes: 0,
    scannedAt: nowIso(),
    error,
  }
}

export class DeviceSyncService {
  private planCache = new Map<string, CachedPlan>()
  private activeDeviceScans = new Map<string, ActiveDeviceScan>()
  private ignoredUnknownRoots = new Set<string>()
  private ignoredUnknownRootsLoaded = false
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
    await this.loadIgnoredUnknownRoots()
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

      const hasRockbox = await pathExists(join(normalizedRoot, ROCKBOX_DIR))
      const hasCrateState = await pathExists(join(normalizedRoot, APP_STATE_DIR, 'device.yaml'))
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
    await this.loadIgnoredUnknownRoots()
    this.ignoredUnknownRoots.add(resolve(rootPath))
    await this.saveIgnoredUnknownRoots()
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

  private ignoredVolumesPath(): string {
    return join(app.getPath('userData'), IGNORED_VOLUMES_SETTINGS_FILE)
  }

  private async loadIgnoredUnknownRoots(): Promise<void> {
    if (this.ignoredUnknownRootsLoaded) return
    this.ignoredUnknownRootsLoaded = true
    const target = this.ignoredVolumesPath()
    if (!existsSync(target)) return

    try {
      const parsed = JSON.parse(await readFile(target, 'utf8')) as PersistedIgnoredVolumes
      const roots = Array.isArray(parsed.ignoredUnknownRoots) ? parsed.ignoredUnknownRoots : []
      this.ignoredUnknownRoots = new Set(
        roots
          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          .map(value => resolve(value)),
      )
    } catch (err) {
      console.warn(`[devices] failed to read ignored volumes: ${(err as Error).message}`)
      this.ignoredUnknownRoots.clear()
    }
  }

  private async saveIgnoredUnknownRoots(): Promise<void> {
    const target = this.ignoredVolumesPath()
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, JSON.stringify({
      version: IGNORED_VOLUMES_SETTINGS_VERSION,
      ignoredUnknownRoots: [...this.ignoredUnknownRoots].sort(),
    }, null, 2), 'utf8')
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

  async pickMusicRoot(rootPath: string, currentMusicRoot?: string): Promise<DeviceMusicRootPickResult> {
    const root = resolve(rootPath)
    const rootStats = await stat(root)
    if (!rootStats.isDirectory()) throw new Error('Device root must be a directory')

    const current = sanitizeMusicRoot(currentMusicRoot ?? '.')
    const currentPath = this.resolveDeviceMusicRoot(root, current)
    const result = await dialog.showOpenDialog({
      title: 'Elegir carpeta de música en el MP3',
      defaultPath: existsSync(currentPath) ? currentPath : root,
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, absolutePath: null, musicRoot: null }
    }

    const absolutePath = resolve(result.filePaths[0])
    assertInside(root, absolutePath)
    const relativePath = toPosixRelative(root, absolutePath)
    return {
      canceled: false,
      absolutePath,
      musicRoot: relativePath === '' ? '.' : sanitizeMusicRoot(relativePath),
    }
  }

  async listDevices(): Promise<DeviceRecord[]> {
    return Promise.all(
      this.listDeviceRows().map(async row =>
        this.rowToRecordAsync(await this.refreshDeviceRockboxState(row)),
      ),
    )
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
    const musicRoot = sanitizeMusicRoot(payload.musicRoot ?? existingDevice?.musicRoot ?? existingRootRow?.music_root ?? '.')
    const defaultMode = validateSyncMode(payload.defaultMode ?? existingDevice?.defaultSyncMode ?? existingRootRow?.sync_mode)
    const syncBase = validateSyncBase(existingRootRow?.sync_base ?? 'review')
    const pcTargetPath = resolve(
      payload.pcTargetPath ?? existingMachine?.pcTargetPath ?? existingRootRow?.pc_target_path ?? this.defaultPcTargetPath(name),
    )
    const artworkMaxEdge = clampDeviceArtworkEdge(
      existingDevice?.artworkMaxEdge ?? existingRootRow?.artwork_max_edge ?? payload.artworkMaxEdge,
    )
    const fetchMissingLyrics =
      existingDevice?.fetchMissingLyrics ??
      (existingRootRow ? existingRootRow.fetch_lyrics === 1 : payload.fetchMissingLyrics ?? true)
    const optimizeArtworkOnSync =
      existingDevice?.optimizeArtworkOnSync ??
      (existingRootRow ? existingRootRow.optimize_artwork_on_sync === 1 : payload.optimizeArtworkOnSync ?? true)
    const hasRockbox = existsSync(join(rootPath, '.rockbox'))

    const linkedMachineIds = new Set(existingDevice?.linkedMachineIds ?? [])
    linkedMachineIds.add(machineId)
    const deviceId = existingDevice?.deviceId || existingRootRow?.id || randomUUID()
    const updatedAt = nowIso()
    await this.ensureDeviceMusicRoot(rootPath, musicRoot)

    const deviceYaml: DeviceYaml = {
      version: DEVICE_STATE_VERSION,
      appName: 'Crate',
      deviceId,
      name,
      musicRoot,
      defaultSyncMode: defaultMode,
      artworkMaxEdge,
      fetchMissingLyrics,
      optimizeArtworkOnSync,
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
      sync_base: syncBase,
      pc_target_path: pcTargetPath,
      artwork_max_edge: artworkMaxEdge,
      fetch_lyrics: fetchMissingLyrics ? 1 : 0,
      optimize_artwork_on_sync: optimizeArtworkOnSync ? 1 : 0,
      has_rockbox: hasRockbox ? 1 : 0,
      track_count: 0,
      created_at: createdAt,
      last_seen_at: updatedAt,
      last_scan_at: null,
      last_sync_at: null,
    })

    if (payload.sourceLibraryIds !== undefined) {
      this.setDeviceLibraries(deviceId, payload.sourceLibraryIds)
    } else if (this.deviceLibraryIds(deviceId).length === 0) {
      this.setDeviceLibraries(deviceId, getRepos().folders.list().map(folder => folder.id))
    }

    this.setPortableState(deviceId, true, null)
    const record = await this.rowToRecordAsync(this.getDeviceRow(deviceId)!)
    await this.publishVolumeSnapshot(true)
    return record
  }

  async updateSettings(deviceId: string, settings: DeviceSettingsUpdate): Promise<DeviceRecord> {
    const row = await this.requireDevice(deviceId)
    const artworkMaxEdge = clampDeviceArtworkEdge(settings.artworkMaxEdge, row.artwork_max_edge)
    const fetchMissingLyrics = settings.fetchMissingLyrics === undefined
      ? row.fetch_lyrics === 1
      : settings.fetchMissingLyrics
    const optimizeArtworkOnSync = settings.optimizeArtworkOnSync === undefined
      ? row.optimize_artwork_on_sync === 1
      : settings.optimizeArtworkOnSync
    const defaultMode = settings.defaultMode === undefined
      ? row.sync_mode
      : validateSyncMode(settings.defaultMode)
    const syncBase = settings.syncBase === undefined
      ? validateSyncBase(row.sync_base)
      : validateSyncBase(settings.syncBase)
    const musicRoot = settings.musicRoot === undefined
      ? row.music_root
      : sanitizeMusicRoot(settings.musicRoot)
    const pcTargetPath = settings.pcTargetPath === undefined
      ? row.pc_target_path
      : resolve(settings.pcTargetPath.trim() || row.pc_target_path)
    await this.ensureDeviceMusicRoot(row.root_path, musicRoot)
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
      musicRoot,
      defaultSyncMode: defaultMode,
      artworkMaxEdge,
      fetchMissingLyrics,
      optimizeArtworkOnSync,
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
      .prepare(`UPDATE devices SET music_root = ?, sync_mode = ?, sync_base = ?, pc_target_path = ?, artwork_max_edge = ?, fetch_lyrics = ?, optimize_artwork_on_sync = ?, last_seen_at = ? WHERE id = ?`)
      .run(musicRoot, defaultMode, syncBase, pcTargetPath, artworkMaxEdge, fetchMissingLyrics ? 1 : 0, optimizeArtworkOnSync ? 1 : 0, updatedAt, row.id)
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

    const record = await this.rowToRecordAsync(this.getDeviceRow(row.id)!)
    await this.publishVolumeSnapshot(true)
    return record
  }

  async scan(deviceId: string): Promise<DeviceScanResult> {
    const row = await this.requireDevice(deviceId)
    const scan = await this.scanDeviceRow(row, true)
    const storage = await this.deviceStorage(row, scan.tracks)
    const scannedAt = nowIso()
    // No pisar un conteo válido con 0 cuando el walk encontró archivos pero
    // ninguno se pudo leer (scan fallido); sí persistir 0 si el device está
    // realmente vacío (no se detectaron archivos).
    const scanLikelyFailed = scan.tracks.length === 0 && scan.summary.scanned > 0
    const nextTrackCount = scanLikelyFailed ? row.track_count : scan.tracks.length
    getDatabase()
      .prepare(`UPDATE devices SET track_count = ?, last_scan_at = ?, last_seen_at = ? WHERE id = ?`)
      .run(nextTrackCount, scannedAt, scannedAt, row.id)
    const device = await this.rowToRecordAsync(this.getDeviceRow(row.id)!)
    await this.publishVolumeSnapshot(true)
    return {
      device,
      tracks: scan.tracks,
      summary: scan.summary,
      storage,
    }
  }

  // Read-only artwork analysis for the device "Optimizar" section. Scans every
  // audio file already on the device, probes the embedded artwork dimensions and
  // reports which tracks exceed the device's max edge. Never modifies files.
  async analyzeDeviceArtwork(deviceId: string): Promise<DeviceArtworkAnalysisResult> {
    const row = await this.requireDevice(deviceId)
    const maxEdge = clampDeviceArtworkEdge(row.artwork_max_edge)
    const musicRoot = this.deviceMusicRoot(row)
    const files = await this.collectAudioFiles(row.id, musicRoot, false)

    const summary: DeviceArtworkAnalysisSummary = {
      scanned: 0,
      oversized: 0,
      withinLimit: 0,
      noArtwork: 0,
      unsupported: 0,
      errors: 0,
    }
    const items: DeviceArtworkAnalysisItem[] = []

    this.throttledBroadcast('devices:artwork-analyze:progress', true, {
      deviceId: row.id,
      scanned: 0,
      total: files.length,
      phase: 'scanning',
    })

    let processed = 0
    for (const file of files) {
      const relativePath = toPosixRelative(musicRoot, file)
      try {
        const probe = probeEmbeddedArtwork(file)
        const evaluated = this.evaluateArtworkProbe(probe, maxEdge)
        summary.scanned += 1
        switch (evaluated.status) {
          case 'oversized':
            summary.oversized += 1
            break
          case 'within_limit':
            summary.withinLimit += 1
            break
          case 'no_artwork':
            summary.noArtwork += 1
            break
          case 'unsupported':
            summary.unsupported += 1
            break
        }
        if (evaluated.status === 'oversized') {
          items.push({
            key: keyForRelativePath(relativePath),
            relativePath,
            title: probe.title || basename(file),
            artist: probe.artist,
            album: probe.album,
            format: evaluated.format,
            width: evaluated.width,
            height: evaluated.height,
            status: 'oversized',
          })
        }
      } catch (err) {
        summary.errors += 1
        console.warn(`[devices] artwork analyze skip ${file}:`, (err as Error).message)
      } finally {
        processed += 1
        this.throttledBroadcast('devices:artwork-analyze:progress', false, {
          deviceId: row.id,
          scanned: processed,
          total: files.length,
          phase: 'reading',
        })
        if (shouldYieldArtworkAnalysis(processed, files.length)) {
          await yieldToEventLoop()
        }
      }
    }

    this.throttledBroadcast('devices:artwork-analyze:progress', true, {
      deviceId: row.id,
      scanned: processed,
      total: files.length,
      phase: 'complete',
    })

    // Biggest offenders first, then stable by path.
    items.sort((a, b) => {
      const aEdge = Math.max(a.width ?? 0, a.height ?? 0)
      const bEdge = Math.max(b.width ?? 0, b.height ?? 0)
      if (aEdge !== bEdge) return bEdge - aEdge
      return a.relativePath.localeCompare(b.relativePath)
    })

    return {
      deviceId: row.id,
      artworkMaxEdge: maxEdge,
      analyzedAt: nowIso(),
      summary,
      items,
    }
  }

  async optimizeDeviceArtwork(
    deviceId: string,
    selection?: DeviceArtworkOptimizationSelection,
  ): Promise<DeviceArtworkOptimizationSummary> {
    const row = await this.requireDevice(deviceId)
    await this.assertPortableStateWritable(row)
    const deviceMusicRoot = this.deviceMusicRoot(row)
    const selectedDeviceFiles = selection
      ? resolveArtworkOptimizationFiles(deviceMusicRoot, selection)
      : undefined
    const startedAt = nowIso()
    const plan: DeviceSyncPlan = {
      id: randomUUID(),
      deviceId: row.id,
      deviceName: row.name,
      mode: row.sync_mode,
      createdAt: startedAt,
      pcTargetPath: row.pc_target_path,
      actions: [],
      summary: summaryFor([], row.track_count, row.track_count),
      deviceIndexWarning: null,
    }
    const journal = this.createSyncJournal(
      randomUUID(),
      plan,
      row.root_path,
      deviceMusicRoot,
      startedAt,
      false,
      true,
    )
    const journalPath = this.journalPath(row.root_path, journal.id)

    try {
      await writeYamlFile(journalPath, journal)
    } catch (err) {
      throw this.syncPortableWriteError(err)
    }

    try {
      await this.optimizeArtworkForJournal(
        plan,
        deviceMusicRoot,
        row.artwork_max_edge,
        journalPath,
        journal,
        selectedDeviceFiles,
      )
      const summary = this.artworkSummaryFromJournal(journal)
      const completedAt = nowIso()
      journal.status = 'completed'
      journal.phase = 'complete'
      journal.completedAt = completedAt
      journal.updatedAt = completedAt
      await writeYamlFile(journalPath, journal).catch(() => undefined)
      await unlink(journalPath).catch(() => undefined)
      getDatabase()
        .prepare(`UPDATE devices SET last_seen_at = ? WHERE id = ?`)
        .run(completedAt, row.id)
      await this.publishVolumeSnapshot(true)
      this.broadcastSyncProgress(plan, 'complete', journal.artwork.length, journal.artwork.length)
      return summary
    } catch (err) {
      const completedAt = nowIso()
      journal.status = 'failed'
      journal.phase = 'complete'
      journal.completedAt = completedAt
      journal.updatedAt = completedAt
      await writeYamlFile(journalPath, journal).catch(() => undefined)
      throw err
    }
  }

  // Collapses a file's embedded pictures into a single track-level verdict: the
  // most severe status wins (oversized > within_limit > unsupported), and among
  // ties the largest picture is reported so the UI shows the worst dimensions.
  private evaluateArtworkProbe(
    probe: EmbeddedArtworkProbe,
    maxEdge: number,
  ): { status: ArtworkStatus; format: 'jpeg' | 'png' | null; width: number | null; height: number | null } {
    if (probe.pictures.length === 0) {
      return { status: 'no_artwork', format: null, width: null, height: null }
    }
    const rank: Record<ArtworkStatus, number> = {
      no_artwork: 0,
      unsupported: 1,
      within_limit: 2,
      oversized: 3,
    }
    let chosen: EmbeddedArtworkProbePicture = probe.pictures[0]
    let chosenStatus: ArtworkStatus = 'unsupported'
    let chosenEdge = -1
    let first = true
    for (const picture of probe.pictures) {
      const status = classifyArtwork({
        maxEdge,
        hasPicture: true,
        format: picture.format,
        width: picture.width,
        height: picture.height,
      })
      const edge = Math.max(picture.width ?? 0, picture.height ?? 0)
      const better =
        first ||
        rank[status] > rank[chosenStatus] ||
        (rank[status] === rank[chosenStatus] && edge > chosenEdge)
      if (better) {
        chosen = picture
        chosenStatus = status
        chosenEdge = edge
        first = false
      }
    }
    return { status: chosenStatus, format: chosen.format, width: chosen.width, height: chosen.height }
  }

  async overview(deviceId: string): Promise<DeviceOverviewResult> {
    const stored = this.getDeviceRow(deviceId)
    if (!stored) throw new Error('Device is not connected')
    // Wake the drive off the event loop first; the spin-up wait happens on the
    // libuv threadpool so the UI (and audio) stay responsive while it spins up.
    await stat(stored.root_path).catch(() => undefined)
    const row = (await pathExists(stored.root_path))
      ? await this.refreshDeviceRockboxState(stored)
      : stored
    return {
      device: await this.rowToRecordAsync(row),
      capacity: await this.deviceCapacity(row),
    }
  }

  async deviceLibrary(deviceId: string, options: DeviceLibraryOptions = {}): Promise<DeviceLibraryResult> {
    const row = await this.requireDevice(deviceId)
    const scan = await this.scanDeviceRow(row, options.progress === true)
    const [playlists, rockboxThemeResult, storage] = await Promise.all([
      this.scanDevicePlaylists(row, scan.tracks),
      scanRockboxThemes(row.root_path),
      this.deviceStorage(row, scan.tracks),
    ])
    const rockboxThemes = rockboxThemeResult.themes
    const scannedAt = nowIso()
    // Don't clobber a valid count with 0 when the scan likely failed (files were
    // found but none could be read); only persist 0 for a genuinely empty device.
    const libScanLikelyFailed = scan.tracks.length === 0 && scan.summary.scanned > 0
    const nextLibTrackCount = libScanLikelyFailed ? row.track_count : scan.tracks.length
    getDatabase()
      .prepare(`UPDATE devices SET track_count = ?, last_seen_at = ? WHERE id = ?`)
      .run(nextLibTrackCount, scannedAt, row.id)
    const device = await this.rowToRecordAsync(this.getDeviceRow(row.id)!)
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
      rockboxThemeScan: rockboxThemeResult.scan,
      storage,
      scanSummary: scan.summary,
      summary: {
        trackCount: scan.tracks.length,
        albumCount: albums.length,
        artistCount: artists.length,
        playlistCount: playlists.length,
        rockboxThemeCount: rockboxThemes.length,
      },
    }
  }

  async rockboxThemes(deviceId: string): Promise<RockboxThemeLibraryResult> {
    const row = await this.requireDevice(deviceId)
    const rockboxThemeResult = await scanRockboxThemes(row.root_path)
    const scannedAt = nowIso()
    getDatabase()
      .prepare(`UPDATE devices SET last_seen_at = ? WHERE id = ?`)
      .run(scannedAt, row.id)
    const device = await this.rowToRecordAsync(this.getDeviceRow(row.id)!)
    await this.publishVolumeSnapshot(true)

    return {
      device,
      themes: rockboxThemeResult.themes,
      scan: rockboxThemeResult.scan,
    }
  }

  async rockboxThemeAssetPath(deviceId: string, relativePath: string): Promise<string> {
    const row = await this.requireDevice(deviceId)
    const normalized = relativePath.split('\\').join('/').replace(/^\/+/, '')
    if (!normalized || isRockboxIgnoredRelativePath(normalized)) {
      throw new Error('Invalid Rockbox theme asset path')
    }
    const parts = normalized.split('/').filter(Boolean)
    if (parts.some(part => part === '.' || part === '..' || part.includes('\u0000'))) {
      throw new Error('Invalid Rockbox theme asset path')
    }
    const rockboxRoot = join(row.root_path, ROCKBOX_DIR)
    const target = fromPosix(rockboxRoot, parts.join('/'))
    assertInside(resolve(rockboxRoot), resolve(target))
    if (!(await pathExists(target))) throw new Error('Rockbox theme asset was not found')
    return target
  }

  async deleteRockboxTheme(deviceId: string, themeId: string): Promise<RockboxThemeDeleteResult> {
    const row = await this.requireDevice(deviceId)
    const rockboxRoot = join(row.root_path, ROCKBOX_DIR)
    const before = await scanRockboxThemes(row.root_path)
    const theme = before.themes.find(item => item.id === themeId)
    if (!theme) throw new Error('Rockbox theme was not found')

    const candidatePaths = new Set<string>([
      theme.configPath,
      theme.wpsPath ?? '',
      theme.sbsPath ?? '',
      theme.fmsPath ?? '',
    ].filter(Boolean))
    const themeAssetDir = `wps/${sanitizeThemeName(theme.name)}`
    if (await pathExists(fromPosix(rockboxRoot, themeAssetDir))) candidatePaths.add(themeAssetDir)

    const files: RockboxThemeDeleteFileResult[] = []
    for (const relativePath of [...candidatePaths]) {
      files.push(await this.deleteRockboxThemePath(rockboxRoot, relativePath))
    }

    const after = await scanRockboxThemes(row.root_path)
    return {
      themeId,
      deleted: files.filter(file => file.status === 'deleted').length,
      missing: files.filter(file => file.status === 'missing').length,
      failed: files.filter(file => file.status === 'failed').length,
      files,
      themes: after.themes,
      scan: after.scan,
    }
  }

  async installRockboxThemes(deviceId: string, sourcePaths: string[]): Promise<RockboxThemeInstallResult> {
    const row = await this.requireDevice(deviceId)
    const rockboxRoot = join(row.root_path, ROCKBOX_DIR)
    if (!(await pathExists(rockboxRoot))) {
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
      ...(await scanRockboxThemes(row.root_path)),
    }
  }

  async planSync(request: DeviceSyncPlanRequest): Promise<DeviceSyncPlan> {
    const row = await this.requireDevice(request.deviceId)
    const mode = validateSyncMode(request.mode)
    const pcTargetPath = resolve(request.pcTargetPath ?? row.pc_target_path)
    const deviceMusicRoot = this.deviceMusicRoot(row)
    const libraryIds = this.deviceLibraryIds(row.id)
    const fullSync = request.fullSync === true
    const baseline = await this.readLibraryState(row)
    const lastSyncAtMs = isFiniteTime(row.last_sync_at)
    const useIncremental = !fullSync && Number.isFinite(lastSyncAtMs) && isUsableLibraryState(baseline)
    const reusableMetadata = useIncremental ? buildReusableDeviceTrackMetadata(baseline) : undefined
    const [pcTracks, deviceScan] = await Promise.all([
      this.pcLibraryTracks(libraryIds.length > 0 ? new Set(libraryIds) : undefined),
      this.scanDeviceRow(row, false, {
        changedSinceMs: useIncremental ? lastSyncAtMs : undefined,
        reusableMetadataByKey: reusableMetadata,
      }),
    ])

    const changedPcTracks = useIncremental
      ? tracksChangedSince(pcTracks, lastSyncAtMs)
      : new Set<string>()
    const changedDeviceTracks = useIncremental
      ? tracksChangedSince(deviceScan.tracks, lastSyncAtMs)
      : new Set<string>()

    // Guard contra el plan catastrófico "copiar toda la librería": si el índice
    // del device quedó vacío pero el dispositivo debería tener contenido (se
    // detectaron archivos que no se pudieron leer, o antes había temas/baseline),
    // no construimos las acciones y avisamos para reescanear.
    const deviceFilesFound = deviceScan.summary.scanned
    const baselineDeviceCount = baseline ? Object.keys(baseline.device.tracks ?? {}).length : 0
    const hadContentBefore = (row.track_count ?? 0) > 0 || baselineDeviceCount > 0
    const deviceIndexSuspect =
      deviceScan.tracks.length === 0 && (deviceFilesFound > 0 || hadContentBefore)

    const pendingAlbumMoves = this.pendingTrackAlbumMoves(row.id)
    let actions = deviceIndexSuspect
      ? []
      : this.buildActions({
          mode,
          pcTracks,
          deviceTracks: deviceScan.tracks,
          baseline,
          fullSync: !useIncremental,
          changedPcTrackKeys: changedPcTracks,
          changedDeviceTrackKeys: changedDeviceTracks,
          deviceMusicRoot,
          pcTargetPath,
        })
    if (!deviceIndexSuspect && pendingAlbumMoves.length > 0 && mode !== 'device_to_pc') {
      actions = applyPendingTrackAlbumMovesToPlan({
        actions,
        mode,
        pcTracks,
        deviceTracks: deviceScan.tracks,
        moves: pendingAlbumMoves,
        makeAction: (kind, key, pc, device, reason) =>
          this.makeAction(kind, key, pc, device, reason, deviceMusicRoot, pcTargetPath),
      })
    }
    const moveWarning = pendingAlbumMoves.length > 0 && mode === 'device_to_pc'
      ? 'Hay temas movidos localmente a otro álbum; device_to_pc no fuerza esos movimientos en el MP3.'
      : null
    const deviceIndexWarning = deviceIndexSuspect
      ? deviceFilesFound > 0
        ? `Se detectaron ${deviceFilesFound} archivos en el dispositivo pero no se pudo leer su metadata. Reescaneá antes de sincronizar.`
        : 'El índice del dispositivo quedó vacío aunque debería tener temas. Reescaneá antes de sincronizar.'
      : null
    const combinedWarning = [deviceIndexWarning, moveWarning].filter(Boolean).join(' ')
    const plan: DeviceSyncPlan = {
      id: randomUUID(),
      deviceId: row.id,
      deviceName: row.name,
      mode,
      createdAt: nowIso(),
      pcTargetPath,
      actions,
      summary: summaryFor(actions, pcTracks.length, deviceScan.tracks.length),
      deviceIndexWarning: combinedWarning || null,
    }

    this.purgeExpiredPlans()
    this.planCache.set(plan.id, {
      plan,
      deviceRoot: row.root_path,
      deviceMusicRoot,
      deviceFiles: deviceScan.tracks.map(track => track.absolutePath),
      expiresAt: Date.now() + PLAN_CACHE_TTL_MS,
    })
    while (this.planCache.size > PLAN_CACHE_MAX_ENTRIES) {
      const oldestKey = this.planCache.keys().next().value
      if (oldestKey === undefined) break
      this.planCache.delete(oldestKey)
    }
    return plan
  }

  private purgeExpiredPlans(): void {
    const now = Date.now()
    for (const [id, entry] of this.planCache) {
      if (entry.expiresAt <= now) this.planCache.delete(id)
    }
  }

  private planForSelection(
    plan: DeviceSyncPlan,
    selection: DeviceSyncApplySelection | undefined,
    deviceMusicRoot: string,
  ): DeviceSyncPlan {
    if (!selection) return plan

    const selectedIds = new Set(selection.actionIds ?? [])
    const hasExplicitSelection = Array.isArray(selection.actionIds)
    const resolutions = new Map(
      (selection.conflictResolutions ?? []).map(item => [item.actionId, item.kind]),
    )
    const actions: DeviceSyncAction[] = []

    for (const action of plan.actions) {
      const resolution = resolutions.get(action.id)
      if (resolution && resolution !== 'skip_conflict') {
        if (hasExplicitSelection && !selectedIds.has(action.id)) continue
        actions.push(this.resolvePlanAction(action, resolution, deviceMusicRoot, plan.pcTargetPath))
        continue
      }

      if (action.kind === 'skip_conflict') continue
      if (!hasExplicitSelection || selectedIds.has(action.id)) actions.push(action)
    }

    return {
      ...plan,
      actions,
      summary: summaryFor(actions, plan.summary.pcBefore, plan.summary.deviceBefore),
    }
  }

  private selectionCoversPlan(plan: DeviceSyncPlan, selection: DeviceSyncApplySelection | undefined): boolean {
    const selectedIds = new Set(selection?.actionIds ?? [])
    const hasExplicitSelection = Array.isArray(selection?.actionIds)
    const resolutions = new Map(
      (selection?.conflictResolutions ?? []).map(item => [item.actionId, item.kind]),
    )

    for (const action of plan.actions) {
      if (action.kind === 'skip_conflict') {
        const resolution = resolutions.get(action.id)
        if (!resolution || resolution === 'skip_conflict') return false
      } else if (hasExplicitSelection && !selectedIds.has(action.id)) {
        return false
      }
    }

    return true
  }

  async applySync(planId: string, selection?: DeviceSyncApplySelection): Promise<DeviceSyncApplyResult> {
    this.purgeExpiredPlans()
    const cached = this.planCache.get(planId)
    if (!cached) throw new Error('Sync plan expired. Create a new plan before applying.')

    const { plan, deviceRoot, deviceMusicRoot } = cached
    let row = await this.requireDevice(plan.deviceId)
    await this.assertPortableStateWritable(row)
    const executablePlan = this.planForSelection(plan, selection, deviceMusicRoot)
    const writeCompleteState = this.selectionCoversPlan(plan, selection)
    if (
      selection?.optimizeArtwork !== undefined &&
      (row.optimize_artwork_on_sync === 1) !== selection.optimizeArtwork
    ) {
      await this.updateSettings(row.id, { optimizeArtworkOnSync: selection.optimizeArtwork })
      row = await this.requireDevice(plan.deviceId)
    }
    const optimizeArtwork = resolveOptimizeArtworkSelection(
      selection?.optimizeArtwork,
      row.optimize_artwork_on_sync === 1,
    )
    const runId = randomUUID()
    const startedAt = nowIso()
    const journal = this.createSyncJournal(
      runId,
      executablePlan,
      deviceRoot,
      deviceMusicRoot,
      startedAt,
      writeCompleteState,
      optimizeArtwork,
    )
    const journalPath = this.journalPath(deviceRoot, journal.id)
    try {
      await writeYamlFile(journalPath, journal)
    } catch (err) {
      throw this.syncPortableWriteError(err)
    }
    this.upsertSyncRun(runId, executablePlan, startedAt)

    const result = await this.executeJournal(
      row,
      executablePlan,
      deviceRoot,
      deviceMusicRoot,
      journalPath,
      journal,
      cached.deviceFiles,
    )
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

    const row = await this.requireDevice(found.journal.plan.deviceId)
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

    return this.executeJournal(
      row,
      journal.plan,
      row.root_path,
      deviceMusicRoot,
      found.path,
      journal,
      undefined,
    )
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
    writeCompleteState: boolean,
    optimizeArtwork: boolean,
  ): SyncJournalYaml {
    return {
      version: DEVICE_STATE_VERSION,
      kind: 'device-sync',
      id: runId,
      runId,
      status: 'running',
      phase: null,
      plan,
      writeCompleteState,
      optimizeArtwork,
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
        if (this.isPendingJournal(journal)) {
          journal.artwork ??= []
          journal.optimizeArtwork ??= true
          if (sanitizeLegacyDeviceSyncJournal(journal)) {
            await writeYamlFile(path, journal).catch(() => undefined)
          }
          out.push({ path, journal })
        }
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

  private recordInlineArtworkOptimization(
    journal: SyncJournalYaml,
    relativePath: string,
    filePath: string,
    outcome: DeviceCopyArtworkOutcome,
  ): void {
    const stepId = `artwork:${keyForRelativePath(relativePath)}`
    let step = journal.artwork.find(item => item.id === stepId)
    if (!step) {
      step = {
        id: stepId,
        kind: 'optimize_artwork',
        relativePath,
        sourcePath: filePath,
        destinationPath: filePath,
        status: 'pending',
      }
      journal.artwork.push(step)
    } else {
      step.sourcePath = filePath
      step.destinationPath = filePath
    }
    this.setJournalStepCompleted(journal, step, outcome.optimized ? 'optimized' : 'skipped', outcome.bytesSaved)
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
    deviceFilesHint?: string[],
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
          optimizeArtwork: journal.optimizeArtwork ?? true,
          artworkMaxEdge: row.artwork_max_edge,
        },
      )

      let failed = this.failedSteps(journal)
      if (failed.length === 0) {
        this.broadcastSyncProgress(plan, 'refreshing', journal.actions.length, journal.actions.length)
        if (copiedIntoPcTarget && plan.pcTargetPath && !journal.pcTargetImported) {
          await this.importPcTarget(plan.pcTargetPath)
          journal.pcTargetImported = true
          await writeYamlFile(journalPath, journal)
        }
        for (const folderId of affectedPcFolderIds) {
          const folder = getRepos().folders.getById(folderId)
          if (folder) {
            getRepos().folders.updateTrackCount(folder.id, getRepos().tracks.countByFolder(folder.id))
          }
        }

        if (journal.optimizeArtwork ?? true) {
          await this.optimizeArtworkForJournal(plan, deviceMusicRoot, row.artwork_max_edge, journalPath, journal)
        }
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
      optimizeArtwork: boolean
      artworkMaxEdge: number
      signal?: AbortSignal
    },
  ): Promise<boolean> {
    const actionById = new Map(plan.actions.map(action => [action.id, action]))
    let copiedIntoPcTarget = journal.actions.some(step =>
      step.status === 'completed' && (step.kind === 'copy_device_to_pc' || step.kind === 'replace_pc')
    )
    let completed = journal.actions.reduce(
      (count, item) => (item.status === 'completed' ? count + 1 : count),
      0,
    )
    const total = journal.actions.length

    for (const step of journal.actions) {
      if (step.status === 'completed') continue
      const action = actionById.get(step.id)
      if (!action || action.kind === 'skip_conflict') {
        this.setJournalStepCompleted(journal, step, 'skipped')
        completed += 1
        await writeYamlFile(journalPath, journal)
        continue
      }

      const phase = action.kind === 'delete_device' || action.kind === 'delete_pc' ? 'deleting' : 'copying'
      this.broadcastSyncProgress(plan, phase, completed, total, action.sourcePath ?? action.relativePath, {
        title: action.title,
        kind: action.kind,
      })
      this.setJournalStepRunning(journal, step, phase)
      await writeYamlFile(journalPath, journal)

      try {
        const result = await this.applyAction(action, ctx)
        if (result.deviceArtwork && action.destinationPath) {
          this.recordInlineArtworkOptimization(journal, action.relativePath, action.destinationPath, result.deviceArtwork)
        }
        if (action.kind === 'copy_device_to_pc' || action.kind === 'replace_pc') {
          copiedIntoPcTarget = true
        }
        this.setJournalStepCompleted(journal, step, 'applied')
        completed += 1
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
    deviceFilesHint?: string[],
  ): Promise<void> {
    const files = deviceFilesHint !== undefined
      ? deviceFilesHint
      : await this.collectAudioFiles(plan.deviceId, deviceMusicRoot, false)
    const activeRelativePaths = new Set<string>()
    const artworkByPath = new Map(journal.artwork.map(step => [keyForRelativePath(step.relativePath), step]))

    let prepared = 0
    for (const file of files) {
      const relativePath = toPosixRelative(deviceMusicRoot, file)
      activeRelativePaths.add(keyForRelativePath(relativePath))
      if (!artworkByPath.has(keyForRelativePath(relativePath))) {
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
      prepared += 1
      if (shouldYieldArtworkAnalysis(prepared, files.length)) {
        await yieldToEventLoop()
      }
    }

    for (const step of journal.artwork) {
      if (step.status === 'completed') continue
      if (!activeRelativePaths.has(keyForRelativePath(step.relativePath))) {
        this.setJournalStepCompleted(journal, step, 'skipped')
      }
    }

    await writeYamlFile(journalPath, journal)

    const total = journal.artwork.length

    let processed = 0
    let pendingJournalFlush = false
    for (const step of journal.artwork) {
      if (step.status === 'completed') continue

      const filePath = fromPosix(deviceMusicRoot, step.relativePath)
      try {
        assertInside(deviceMusicRoot, resolve(filePath))
        if (!existsSync(filePath) || !this.sourceArtworkNeedsLimit(filePath, artworkMaxEdge)) {
          // Read-only probe: the file is gone or its artwork is already within the
          // limit. Mark it skipped without copying the whole audio file to a temp,
          // which is what made the on-sync pass far slower than the direct optimize.
          this.setJournalStepCompleted(journal, step, 'skipped')
          pendingJournalFlush = true
        } else {
          this.setJournalStepRunning(journal, step, 'optimizing_artwork')
          await writeYamlFile(journalPath, journal)
          this.broadcastSyncProgress(
            plan,
            'optimizing_artwork',
            countProcessedArtworkSteps(journal.artwork),
            total,
            step.relativePath,
          )
          const outcome = await this.optimizeArtworkAtomically(filePath, artworkMaxEdge)
          this.setJournalStepCompleted(
            journal,
            step,
            outcome.optimized ? 'optimized' : 'skipped',
            outcome.bytesSaved,
          )
          await writeYamlFile(journalPath, journal)
          pendingJournalFlush = false
        }
      } catch (err) {
        this.setJournalStepFailed(journal, step, err)
        pendingJournalFlush = true
      }

      processed += 1
      this.broadcastSyncProgress(
        plan,
        'optimizing_artwork',
        countProcessedArtworkSteps(journal.artwork),
        total,
        step.relativePath,
      )
      if (shouldYieldArtworkAnalysis(processed, total)) {
        if (pendingJournalFlush) {
          await writeYamlFile(journalPath, journal)
          pendingJournalFlush = false
        }
        await yieldToEventLoop()
      }
    }
    if (pendingJournalFlush) {
      await writeYamlFile(journalPath, journal)
    }
    this.broadcastSyncProgress(
      plan,
      'optimizing_artwork',
      countProcessedArtworkSteps(journal.artwork),
      total,
      undefined,
      undefined,
      true,
    )
  }

  private async optimizeArtworkAtomically(
    filePath: string,
    artworkMaxEdge: number,
  ): Promise<DeviceCopyArtworkOutcome> {
    const tmpPath = artworkOptimizationTempPath(filePath)
    await copyFile(filePath, tmpPath)
    try {
      const outcome = await this.optimizeArtworkFile(tmpPath, artworkMaxEdge)
      if (!outcome.optimized) {
        await unlink(tmpPath).catch(() => undefined)
        return outcome
      }
      await rename(tmpPath, filePath)
      return outcome
    } catch (err) {
      await unlink(tmpPath).catch(() => undefined)
      throw err
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
    const entryCache = new Map<string, DeviceTrack | null>()

    for (const file of files) {
      let content = ''
      try {
        content = await readFile(file, 'utf8')
      } catch {
        continue
      }

      const playlistTracks: DeviceTrack[] = []
      let missingCount = 0
      const fileDir = dirname(file)
      for (const line of content.split(/\r?\n/)) {
        const raw = line.trim()
        if (!raw || raw.startsWith('#')) continue
        const cacheKey = `${fileDir}\0${raw}`
        let track = entryCache.get(cacheKey)
        if (track === undefined) {
          track = this.resolvePlaylistEntry(raw, file, root, musicRoot, trackByKey)
          entryCache.set(cacheKey, track)
        }
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

  private async directorySize(rootPath: string): Promise<number> {
    const root = resolve(rootPath)
    let total = 0

    const walk = async (dir: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }

      for (const entry of entries) {
        const full = resolve(dir, entry.name)
        if (!isInside(root, full)) continue

        const entryStat = await lstat(full).catch(() => null)
        if (!entryStat || entryStat.isSymbolicLink()) continue
        if (entryStat.isDirectory()) {
          await walk(full)
        } else if (entryStat.isFile()) {
          total += entryStat.size
        }
      }
    }

    await walk(root)
    return total
  }

  private async deviceStorage(row: DeviceRow, tracks: DeviceTrack[]): Promise<DeviceStorageSummary> {
    const musicBytes = tracks.reduce((sum, track) => sum + (track.fileSize ?? 0), 0)
    const rockboxRoot = join(row.root_path, ROCKBOX_DIR)
    const rockboxBytes = (await pathExists(rockboxRoot))
      ? await this.directorySize(rockboxRoot).catch(() => 0)
      : 0

    try {
      const fsStats = await statfs(row.root_path)
      const blockSize = Math.max(0, Number(fsStats.bsize) || 0)
      const totalBytes = Math.max(0, Number(fsStats.blocks) * blockSize)
      const freeBytes = Math.max(0, Number(fsStats.bavail) * blockSize)
      const usedBytes = Math.max(0, totalBytes - freeBytes)
      return {
        totalBytes,
        usedBytes,
        freeBytes,
        musicBytes,
        rockboxBytes,
        otherBytes: Math.max(0, usedBytes - musicBytes - rockboxBytes),
        scannedAt: nowIso(),
        error: null,
      }
    } catch (err) {
      return {
        ...emptyStorageSummary(errorMessage(err)),
        musicBytes,
        rockboxBytes,
      }
    }
  }

  private async deviceCapacity(row: DeviceRow): Promise<DeviceCapacitySummary> {
    if (!(await pathExists(row.root_path))) {
      return emptyCapacitySummary('Device is offline')
    }

    try {
      const fsStats = await statfs(row.root_path)
      const blockSize = Math.max(0, Number(fsStats.bsize) || 0)
      const totalBytes = Math.max(0, Number(fsStats.blocks) * blockSize)
      const freeBytes = Math.max(0, Number(fsStats.bavail) * blockSize)
      return {
        totalBytes,
        usedBytes: Math.max(0, totalBytes - freeBytes),
        freeBytes,
        scannedAt: nowIso(),
        error: null,
      }
    } catch (err) {
      return emptyCapacitySummary(errorMessage(err))
    }
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

  private async deleteRockboxThemePath(rockboxRoot: string, relativePath: string): Promise<RockboxThemeDeleteFileResult> {
    const normalized = relativePath.split('\\').join('/').replace(/^\/+/, '')
    const target = fromPosix(rockboxRoot, normalized)
    try {
      assertInside(resolve(rockboxRoot), resolve(target))
      if (!existsSync(target)) {
        return { path: normalized, status: 'missing', error: null }
      }
      await rm(target, { recursive: true, force: false })
      return { path: normalized, status: 'deleted', error: null }
    } catch (err) {
      return {
        path: normalized,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      }
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
        if (isRockboxIgnoredEntryName(entry.name)) continue
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
    if (parts.some(part => isRockboxIgnoredEntryName(part))) return null
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

  private async deviceVersionsAsync(row: DeviceRow): Promise<DeviceVersionInfo> {
    const stateDir = join(row.root_path, APP_STATE_DIR)
    const [deviceYaml, machineStateVersion, rockboxVersion, firmwareVersion] = await Promise.all([
      readYamlFile<DeviceYaml>(join(stateDir, 'device.yaml')),
      this.detectMachineStateVersion(stateDir),
      this.detectRockboxVersion(row.root_path),
      this.detectFirmwareVersion(row.root_path),
    ])
    return {
      crateStateVersion: typeof deviceYaml?.version === 'number' ? deviceYaml.version : null,
      machineStateVersion,
      rockboxVersion,
      firmwareVersion,
    }
  }

  private async detectMachineStateVersion(stateDir: string): Promise<number | null> {
    const machinesDir = join(stateDir, 'machines')
    if (!(await pathExists(machinesDir))) return null
    let version: number | null = null
    try {
      for (const entry of await readdir(machinesDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.yaml')) continue
        const machine = await readYamlFile<MachineYaml>(join(machinesDir, entry.name))
        if (typeof machine?.version !== 'number') continue
        version = version == null ? machine.version : Math.max(version, machine.version)
      }
    } catch {
      return version
    }
    return version
  }

  private async detectRockboxVersion(rootPath: string): Promise<string | null> {
    for (const parts of ROCKBOX_VERSION_FILES) {
      const text = await readTextProbeAsync(join(rootPath, ...parts))
      if (!text) continue
      const version = extractVersionFromText(text, /rockbox/i)
      if (version) return version
    }
    return null
  }

  private async detectFirmwareVersion(rootPath: string): Promise<string | null> {
    for (const parts of FIRMWARE_VERSION_FILES) {
      const text = await readTextProbeAsync(join(rootPath, ...parts))
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
      await this.sweepStaleWriteTests(stateDir)
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

  private async sweepStaleWriteTests(stateDir: string): Promise<void> {
    const oneHourMs = 60 * 60 * 1000
    const cutoff = Date.now() - oneHourMs
    let entries
    try {
      entries = await readdir(stateDir)
    } catch {
      return
    }
    for (const name of entries) {
      if (!name.startsWith('.write-test-') || !name.endsWith('.tmp')) continue
      const full = join(stateDir, name)
      try {
        const st = await stat(full)
        if (st.mtimeMs < cutoff) await unlink(full).catch(() => undefined)
      } catch {
        /* file vanished between readdir and stat — ignore */
      }
    }
  }

  private syncPortableWriteError(err: unknown): Error {
    if (isPortableWriteError(err)) {
      return new Error(`No se puede sincronizar porque .crate no es escribible en el dispositivo: ${errorMessage(err)}`)
    }
    return err instanceof Error ? err : new Error(String(err))
  }

  // Pure: no filesystem I/O. The two drive-touching fields (isAvailable, versions)
  // are resolved off the event loop by rowToRecordAsync and passed in, so callers
  // on the device read path never block the main thread on a sleeping drive.
  private rowToRecord(row: DeviceRow, isAvailable: boolean, versions: DeviceVersionInfo): DeviceRecord {
    return {
      id: row.id,
      name: row.name,
      rootPath: row.root_path,
      musicRoot: row.music_root,
      defaultMode: row.sync_mode,
      syncBase: validateSyncBase(row.sync_base),
      pcTargetPath: row.pc_target_path,
      artworkMaxEdge: clampDeviceArtworkEdge(row.artwork_max_edge),
      fetchMissingLyrics: row.fetch_lyrics === 1,
      optimizeArtworkOnSync: row.optimize_artwork_on_sync === 1,
      hasRockbox: row.has_rockbox === 1,
      isAvailable,
      trackCount: row.track_count,
      sourceLibraryIds: this.deviceLibraryIds(row.id),
      versions,
      portableState: this.portableStateFor(row),
      lastSeenAt: row.last_seen_at,
      lastScanAt: row.last_scan_at,
      lastSyncAt: row.last_sync_at,
    }
  }

  private async rowToRecordAsync(row: DeviceRow): Promise<DeviceRecord> {
    const [isAvailable, versions] = await Promise.all([
      pathExists(row.root_path),
      this.deviceVersionsAsync(row),
    ])
    return this.rowToRecord(row, isAvailable, versions)
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

  private pendingTrackAlbumMoves(deviceId: string): TrackAlbumMoveRow[] {
    return getDatabase()
      .prepare<[string], TrackAlbumMoveRow>(`
        SELECT m.*
        FROM track_album_moves m
        WHERE NOT EXISTS (
          SELECT 1
          FROM track_album_move_device_applies a
          WHERE a.move_id = m.id AND a.device_id = ?
        )
        ORDER BY m.created_at ASC
      `)
      .all(deviceId)
  }

  private markSatisfiedTrackAlbumMoves(deviceId: string, deviceTracks: DeviceTrack[], appliedAt: string): void {
    const pending = this.pendingTrackAlbumMoves(deviceId)
    if (pending.length === 0) return
    const keys = new Set(deviceTracks.map(track => track.key))
    const satisfied = pending.filter(move => !keys.has(move.old_sync_key) && keys.has(move.new_sync_key))
    if (satisfied.length === 0) return

    const db = getDatabase()
    const tx = db.transaction((moves: TrackAlbumMoveRow[]) => {
      const insert = db.prepare(`
        INSERT OR IGNORE INTO track_album_move_device_applies (move_id, device_id, applied_at)
        VALUES (?, ?, ?)
      `)
      for (const move of moves) insert.run(move.id, deviceId, appliedAt)
    })
    tx(satisfied)
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

  private async requireDevice(deviceId: string): Promise<DeviceRow> {
    const row = this.getDeviceRow(deviceId)
    if (!row) throw new Error('Device is not connected')
    if (!(await pathExists(row.root_path))) throw new Error('Device is not mounted')
    return this.refreshDeviceRockboxState(row)
  }

  private async refreshDeviceRockboxState(row: DeviceRow): Promise<DeviceRow> {
    if (!(await pathExists(row.root_path))) return row
    const hasRockbox = (await pathExists(join(row.root_path, ROCKBOX_DIR))) ? 1 : 0
    if (row.has_rockbox === hasRockbox) return row

    getDatabase()
      .prepare(`UPDATE devices SET has_rockbox = ? WHERE id = ?`)
      .run(hasRockbox, row.id)
    return { ...row, has_rockbox: hasRockbox }
  }

  private upsertDevice(row: DeviceRow): void {
    getDatabase()
      .prepare(`
        INSERT INTO devices (
          id, name, root_path, music_root, sync_mode, sync_base, pc_target_path, artwork_max_edge, fetch_lyrics, optimize_artwork_on_sync, has_rockbox,
          track_count, created_at, last_seen_at, last_scan_at, last_sync_at
        ) VALUES (
          @id, @name, @root_path, @music_root, @sync_mode, @sync_base, @pc_target_path, @artwork_max_edge, @fetch_lyrics, @optimize_artwork_on_sync, @has_rockbox,
          @track_count, @created_at, @last_seen_at, @last_scan_at, @last_sync_at
        )
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          root_path = excluded.root_path,
          music_root = excluded.music_root,
          sync_mode = excluded.sync_mode,
          pc_target_path = excluded.pc_target_path,
          artwork_max_edge = excluded.artwork_max_edge,
          fetch_lyrics = excluded.fetch_lyrics,
          optimize_artwork_on_sync = excluded.optimize_artwork_on_sync,
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

  private resolveDeviceMusicRoot(rootPath: string, musicRoot: string): string {
    const root = musicRoot === '.' ? rootPath : fromPosix(rootPath, musicRoot)
    const resolved = resolve(root)
    assertInside(resolve(rootPath), resolved)
    return resolved
  }

  private async ensureDeviceMusicRoot(rootPath: string, musicRoot: string): Promise<string> {
    const resolved = this.resolveDeviceMusicRoot(rootPath, musicRoot)
    await mkdir(resolved, { recursive: true })
    return resolved
  }

  private deviceMusicRoot(row: DeviceRow): string {
    return this.resolveDeviceMusicRoot(row.root_path, row.music_root)
  }

  private async scanDeviceRow(
    row: DeviceRow,
    sendProgress: boolean,
    options?: {
      changedSinceMs?: number
      reusableMetadataByKey?: ReadonlyMap<string, DeviceScanTrackMetadata>
    },
  ): Promise<ScanInternalResult> {
    const musicRoot = this.deviceMusicRoot(row)
    const existing = this.activeDeviceScans.get(row.id)
    if (existing) {
      if (sendProgress) {
        existing.progress = true
        if (existing.lastProgress) {
          this.emitDeviceScanProgress(existing.lastProgress, true)
        }
      }
      return existing.promise
    }

    const active: ActiveDeviceScan = {
      promise: null as unknown as Promise<ScanInternalResult>,
      progress: sendProgress,
      lastProgress: null,
    }
    const emitProgress = (event: DeviceScanProgressEvent, force: boolean) => {
      active.lastProgress = event
      if (active.progress) this.emitDeviceScanProgress(event, force)
    }
    active.promise = scanDeviceAudioTree({
      deviceId: row.id,
      root: musicRoot,
      concurrency: DEVICE_SCAN_METADATA_CONCURRENCY,
      changedSince: options?.changedSinceMs,
      reusableMetadataByKey: options?.reusableMetadataByKey,
      readMetadata: file => readTrackMetadata(file, { artwork: false }),
      emitProgress,
    }).finally(() => {
      const current = this.activeDeviceScans.get(row.id)
      if (current === active) this.activeDeviceScans.delete(row.id)
    })
    this.activeDeviceScans.set(row.id, active)
    return active.promise
  }

  private async collectAudioFiles(deviceId: string, root: string, sendProgress: boolean): Promise<string[]> {
    return collectDeviceAudioFiles({
      deviceId,
      root,
      emitProgress: sendProgress
        ? (event, force) => this.emitDeviceScanProgress(event, force)
        : undefined,
    })
  }

  private emitDeviceScanProgress(event: DeviceScanProgressEvent, force: boolean): void {
    this.throttledBroadcast('devices:scan:progress', force, event)
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
    const dbTracks =
      folderIds && folderIds.size > 0
        ? folders.flatMap(folder => repos.tracks.getByFolder(folder.id))
        : repos.tracks.getAll()
    const rawRelCounts = new Map<string, number>()

    for (const track of dbTracks) {
      const folder = folderById.get(track.folder_id)
      if (!folder) continue
      const rawRel = this.sourceRelativePathFor(track, folder.path, folder.name)
      const key = keyForRelativePath(rawRel)
      rawRelCounts.set(key, (rawRelCounts.get(key) ?? 0) + 1)
    }

    const usedKeys = new Set<string>()
    const tracks: PcTrack[] = []
    for (const track of dbTracks) {
      const folder = folderById.get(track.folder_id)
      if (!folder) continue
      const sourceRelativePath = this.sourceRelativePathFor(track, folder.path, folder.name)
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

  // The device-relative path of a source track. Local tracks use their real
  // filesystem path relative to the library folder. Cloud tracks have a synthetic
  // onedrive:// path with no hierarchy, so the layout is rebuilt from the track's
  // human-readable cloud_remote_path (anchored on the folder name), falling back
  // to a flat filename.
  private sourceRelativePathFor(track: DbTrack, folderPath: string, folderName: string): string {
    if (track.source === 'onedrive') {
      return cloudDeviceRelativePath({
        remotePath: track.cloud_remote_path,
        filename: track.filename,
        folderName,
      })
    }
    return toPosixRelative(folderPath, track.path)
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
      trackId: track.id,
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
    fullSync: boolean
    changedPcTrackKeys: Set<string>
    changedDeviceTrackKeys: Set<string>
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
      const changedOnTrackedSide = args.changedPcTrackKeys.has(key) || args.changedDeviceTrackKeys.has(key)
      const unchangedSinceBaseline =
        pc &&
        device &&
        pcBase &&
        deviceBase &&
        pc.fingerprint === pcBase.fingerprint &&
        device.fingerprint === deviceBase.fingerprint

      if (!args.fullSync && unchangedSinceBaseline && !changedOnTrackedSide) continue

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
      pcPath: pc?.absolutePath ?? null,
      pcRelativePath: pc?.relativePath ?? null,
      pcBytes: pc?.fileSize ?? null,
      devicePath: device?.absolutePath ?? null,
      deviceRelativePath: device?.relativePath ?? null,
      deviceBytes: device?.fileSize ?? null,
      sourcePath,
      destinationPath,
      bytes: kind === 'delete_device' || kind === 'delete_pc' || kind === 'skip_conflict'
        ? 0
        : detailTrack?.fileSize ?? 0,
      reason,
    }
  }

  private resolvePlanAction(
    action: DeviceSyncAction,
    kind: DeviceSyncActionKind,
    deviceMusicRoot: string,
    pcTargetPath: string,
  ): DeviceSyncAction {
    if (kind === 'skip_conflict') return action
    const allowedKinds: DeviceSyncActionKind[] =
      action.pcPath && action.devicePath
        ? ['replace_device', 'replace_pc']
        : action.pcPath
          ? ['copy_pc_to_device', 'delete_pc']
          : action.devicePath
            ? ['copy_device_to_pc', 'delete_device']
            : []
    if (!allowedKinds.includes(kind)) {
      throw new Error(`Invalid resolution ${kind} for ${action.relativePath}`)
    }

    const pcRelativePath = action.pcRelativePath ?? action.relativePath
    const deviceRelativePath = action.deviceRelativePath ?? action.relativePath
    const pcDestination = action.pcPath ?? fromPosix(pcTargetPath, deviceRelativePath)
    const deviceDestination = action.devicePath ?? fromPosix(deviceMusicRoot, pcRelativePath)
    const sourcePath =
      kind === 'copy_pc_to_device' || kind === 'replace_device' || kind === 'delete_pc'
        ? action.pcPath
        : action.devicePath
    const destinationPath =
      kind === 'copy_pc_to_device'
        ? deviceDestination
        : kind === 'replace_device'
          ? deviceDestination
          : kind === 'copy_device_to_pc'
            ? pcDestination
            : kind === 'replace_pc'
              ? pcDestination
              : null
    const relativePath =
      kind === 'copy_pc_to_device' || kind === 'replace_device' || kind === 'delete_pc'
        ? pcRelativePath
        : deviceRelativePath
    const bytes =
      kind === 'copy_pc_to_device' || kind === 'replace_device'
        ? action.pcBytes ?? action.bytes
        : kind === 'copy_device_to_pc' || kind === 'replace_pc'
          ? action.deviceBytes ?? action.bytes
          : 0

    if ((kind === 'copy_pc_to_device' || kind === 'replace_device' || kind === 'delete_pc') && !action.pcPath) {
      throw new Error(`Cannot resolve ${kind}: PC file is missing`)
    }
    if ((kind === 'copy_device_to_pc' || kind === 'replace_pc' || kind === 'delete_device') && !action.devicePath) {
      throw new Error(`Cannot resolve ${kind}: device file is missing`)
    }

    return {
      ...action,
      id: action.id,
      kind,
      relativePath,
      sourcePath,
      destinationPath,
      bytes,
      reason: `${action.reason} · user selected ${kind}`,
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
      optimizeArtwork: boolean
      artworkMaxEdge: number
      signal?: AbortSignal
    },
  ): Promise<ApplyActionResult> {
    switch (action.kind) {
      case 'copy_pc_to_device':
      case 'replace_device':
        if (!action.sourcePath || !action.destinationPath) throw new Error('Invalid copy action')
        assertInside(ctx.deviceMusicRoot, resolve(action.destinationPath))
        {
          return this.copyPcTrackToDevice(action, ctx.artworkMaxEdge, ctx.optimizeArtwork, ctx.signal)
        }
      case 'copy_device_to_pc':
        if (!action.sourcePath || !action.destinationPath) throw new Error('Invalid copy action')
        assertInside(resolve(ctx.pcTargetPath), resolve(action.destinationPath))
        await this.copyPreservingMtime(action.sourcePath, action.destinationPath)
        return {}
      case 'replace_pc':
        if (!action.sourcePath || !action.destinationPath) throw new Error('Invalid copy action')
        this.assertPcWriteAllowed(action.destinationPath, ctx.pcTargetPath)
        await this.copyPreservingMtime(action.sourcePath, action.destinationPath)
        return {}
      case 'delete_device':
        await this.moveDeviceFileToTrash(ctx.deviceRoot, ctx.deviceMusicRoot, action.relativePath, ctx.runId)
        return {}
      case 'delete_pc':
        if (!action.sourcePath) throw new Error('Invalid delete action')
        await this.trashPcFile(action.sourcePath, ctx.affectedPcFolderIds)
        return {}
      case 'skip_conflict':
        return {}
    }
  }

  private async copyPcTrackToDevice(
    action: DeviceSyncAction,
    artworkMaxEdge: number,
    optimizeArtwork: boolean,
    signal?: AbortSignal,
  ): Promise<ApplyActionResult> {
    if (!action.sourcePath || !action.destinationPath) throw new Error('Invalid copy action')

    if (isCloudSourcePath(action.sourcePath)) {
      return this.withCloudSourceTempFile(action.sourcePath, signal, (localPath, mtimeOverride) =>
        this.copyLocalSourceToDevice(localPath, action, artworkMaxEdge, optimizeArtwork, mtimeOverride),
      )
    }
    return this.copyLocalSourceToDevice(action.sourcePath, action, artworkMaxEdge, optimizeArtwork)
  }

  private async copyLocalSourceToDevice(
    localSourcePath: string,
    action: DeviceSyncAction,
    artworkMaxEdge: number,
    optimizeArtwork: boolean,
    mtimeOverride?: Date,
  ): Promise<ApplyActionResult> {
    if (!action.destinationPath) throw new Error('Invalid copy action')

    const shouldOptimizeBeforeCopy = shouldOptimizeArtworkBeforeDeviceCopy(action.kind, optimizeArtwork)
    const staged = shouldOptimizeBeforeCopy && this.sourceArtworkNeedsLimit(localSourcePath, artworkMaxEdge)
      ? await this.stageDeviceCopyWithArtworkLimit(localSourcePath, artworkMaxEdge)
      : null
    try {
      await this.copyPreservingMtime(staged?.path ?? localSourcePath, action.destinationPath, localSourcePath, mtimeOverride)
      if (!shouldOptimizeBeforeCopy) return {}
      return { deviceArtwork: staged?.outcome ?? { optimized: false, bytesSaved: 0 } }
    } finally {
      await staged?.cleanup()
    }
  }

  // Materialize a OneDrive-backed source into a local temp file, run the local
  // copy pipeline against it, then delete the temp. The whole file is downloaded
  // into a RAM buffer via ranged GETs and written to disk so the existing
  // artwork-optimization + mtime + copy logic works unchanged. Apply runs
  // serially, so at most one of these buffers is alive at a time.
  private async withCloudSourceTempFile<T>(
    sourceOneDrivePath: string,
    signal: AbortSignal | undefined,
    run: (localPath: string, mtimeOverride?: Date) => Promise<T>,
  ): Promise<T> {
    const track = getRepos().tracks.getByPath(sourceOneDrivePath)
    if (!track) throw new Error(`Cloud source not found in library: ${sourceOneDrivePath}`)
    const opts = await resolveCloudLoadOptions(track, getOneDriveClient())
    if (!opts) throw new Error(`Track is not a OneDrive source: ${sourceOneDrivePath}`)

    const size = opts.cloudSizeBytes
    const buffer = Buffer.allocUnsafe(size)
    await getOneDriveClient().fetchFullIntoBuffer({
      driveId: opts.cloudRef.driveId,
      itemId: opts.cloudRef.itemId,
      sizeBytes: size,
      buffer,
      signal,
    })

    const tempDir = await mkdtemp(join(tmpdir(), 'crate-device-cloud-'))
    const tempPath = join(tempDir, sanitizeSegment(track.filename) || 'track')
    try {
      await writeFile(tempPath, buffer)
      const mtimeMs = track.date_modified ? Date.parse(track.date_modified) : Number.NaN
      const mtimeOverride = Number.isFinite(mtimeMs) ? new Date(mtimeMs) : undefined
      return await run(tempPath, mtimeOverride)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  }

  private sourceArtworkNeedsLimit(sourcePath: string, artworkMaxEdge: number): boolean {
    try {
      return hasArtworkOverLimit(probeEmbeddedArtwork(sourcePath), clampDeviceArtworkEdge(artworkMaxEdge))
    } catch {
      return true
    }
  }

  private async stageDeviceCopyWithArtworkLimit(sourcePath: string, artworkMaxEdge: number): Promise<StagedDeviceCopy> {
    const tempDir = await mkdtemp(join(tmpdir(), 'crate-device-artwork-'))
    const tempPath = join(tempDir, basename(sourcePath))
    try {
      await copyFile(sourcePath, tempPath)
      const outcome = await this.optimizeArtworkFile(tempPath, artworkMaxEdge)
      return {
        path: tempPath,
        outcome,
        cleanup: () => rm(tempDir, { recursive: true, force: true }),
      }
    } catch (err) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
      throw err
    }
  }

  private async optimizeArtworkFile(
    filePath: string,
    artworkMaxEdge: number,
  ): Promise<DeviceCopyArtworkOutcome> {
    const effectiveMaxEdge = clampDeviceArtworkEdge(artworkMaxEdge)
    const result = optimizeEmbeddedArtwork(filePath, effectiveMaxEdge)
    if (result.optimizedPictures === 0) {
      return { optimized: false, bytesSaved: 0 }
    }
    const optimizedStat = await stat(filePath)
    if (optimizedStat.size === 0) {
      throw new Error('Artwork optimization produced an empty file')
    }
    assertOptimizedArtworkWithinLimit(probeEmbeddedArtwork(filePath), effectiveMaxEdge)
    return { optimized: true, bytesSaved: result.bytesSaved }
  }

  private async copyPreservingMtime(source: string, destination: string, mtimeSource = source, mtimeOverride?: Date): Promise<void> {
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(source, destination)
    try {
      if (mtimeOverride) {
        await utimes(destination, mtimeOverride, mtimeOverride)
        return
      }
      const sourceStat = await stat(mtimeSource)
      await utimes(destination, sourceStat.atime, sourceStat.mtime)
    } catch (err) {
      console.warn(`[devices] utimes failed for ${destination}:`, (err as Error).message)
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
    if (existsSync(source)) {
      await mkdir(dirname(destination), { recursive: true })
      await rename(source, destination)
    }

    const sourceSidecar = sidecarPathFor(source)
    if (!existsSync(sourceSidecar)) return
    const destinationSidecar = sidecarPathFor(destination)
    assertInside(deviceMusicRoot, resolve(sourceSidecar))
    assertInside(join(deviceRoot, APP_STATE_DIR, 'trash', runId), resolve(destinationSidecar))
    try {
      await mkdir(dirname(destinationSidecar), { recursive: true })
      await rename(sourceSidecar, destinationSidecar)
    } catch (err) {
      console.warn(`[devices] could not move lyrics sidecar to trash for ${relPath}:`, (err as Error).message)
    }
  }

  private async trashPcFile(sourcePath: string, affectedFolderIds: Set<number>): Promise<void> {
    const repos = getRepos()
    const track = repos.tracks.getByPath(sourcePath)
    if (isCloudSourcePath(sourcePath)) {
      // OneDrive tracks have no local file to trash; "delete from PC" means
      // dropping the library row. The bytes in OneDrive are left untouched.
      if (track) {
        repos.tracks.deleteByPath(sourcePath)
        affectedFolderIds.add(track.folder_id)
      }
      return
    }
    await shell.trashItem(sourcePath)
    const sidecarPath = sidecarPathFor(sourcePath)
    if (existsSync(sidecarPath)) {
      await shell.trashItem(sidecarPath).catch(err => {
        console.warn(`[devices] could not trash lyrics sidecar for ${sourcePath}:`, (err as Error).message)
      })
    }
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

  private async writeSuccessfulState(
    row: DeviceRow,
    plan: DeviceSyncPlan,
    result: DeviceSyncApplyResult,
  ): Promise<void> {
    const freshRow = this.getDeviceRow(row.id) ?? row
    try {
      await access(freshRow.root_path)
    } catch {
      const message = 'El dispositivo se desconectó antes de poder escribir el estado de sincronización.'
      this.setPortableState(row.id, false, message)
      await this.publishVolumeSnapshot(true)
      throw new Error(message)
    }
    const machineId = await this.machineId()
    const libraryIds = this.deviceLibraryIds(row.id)
    const [pcTracks, deviceScan, previousState] = await Promise.all([
      this.pcLibraryTracks(libraryIds.length > 0 ? new Set(libraryIds) : undefined),
      this.scanDeviceRow(freshRow, false),
      this.readLibraryState(freshRow),
    ])
    const completedAt = result.completedAt
    // Merge the post-sync reality with the previous baseline instead of blindly
    // overwriting it. Tracks whose change is still pending (a deselected,
    // skipped, or unresolved action) keep their previous entry so the next sync
    // re-proposes the change rather than reverting it — e.g. a track deleted on
    // the PC must not be copied back from the device on the following sync.
    const merged = mergeLibraryStateBaseline({
      currentPc: snapshotFromTracks(pcTracks),
      currentDevice: snapshotFromTracks(deviceScan.tracks),
      previousPc: previousState?.pc.tracks ?? {},
      previousDevice: previousState?.device.tracks ?? {},
    })
    const state: LibraryStateYaml = {
      version: DEVICE_STATE_VERSION,
      updatedAt: completedAt,
      machineId,
      pc: {
        trackCount: Object.keys(merged.pc).length,
        tracks: merged.pc,
      },
      device: {
        trackCount: Object.keys(merged.device).length,
        tracks: merged.device,
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
        fetchMissingLyrics: freshRow.fetch_lyrics === 1,
        optimizeArtworkOnSync: freshRow.optimize_artwork_on_sync === 1,
        linkedMachineIds: [...linkedMachineIds],
        createdAt: existingDevice?.createdAt ?? row.created_at,
        updatedAt: completedAt,
      } satisfies DeviceYaml)
      await writeYamlFile(join(stateDir, 'library-state.yaml'), state)
      this.markSatisfiedTrackAlbumMoves(row.id, deviceScan.tracks, completedAt)
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
    current?: { title?: string; kind?: DeviceSyncActionKind },
    forceProgress = false,
  ): void {
    const force = forceProgress || phase === 'complete' || phase === 'writing_state' || phase === 'refreshing'
    this.throttle.emit('devices:sync:progress', force, {
      deviceId: plan.deviceId,
      planId: plan.id,
      phase,
      completed,
      total,
      currentPath,
      currentTitle: current?.title,
      currentKind: current?.kind,
    })
  }

  private throttle: ThrottledBroadcaster = createThrottledBroadcaster()

  private throttledBroadcast(channel: string, force: boolean, payload: unknown, minMs = 80): void {
    this.throttle.emit(channel, force, payload, minMs)
  }
}

let instance: DeviceSyncService | null = null
export function getDeviceSyncService(): DeviceSyncService {
  if (!instance) instance = new DeviceSyncService()
  return instance
}
