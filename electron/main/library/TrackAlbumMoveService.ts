import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import { getDatabase } from '../db/database'
import { getRepos, type Repos } from '../db/repositories'
import { parseArtistName } from './ArtistNameParser'
import { readTrackMetadata, serializeTrackExtendedMetadata, type TrackMetadata } from './MetadataExtractor'
import { writeTrackMetadata, type MetadataArtworkPayload, type MetadataReleaseTags } from './MetadataWriter'
import { artworkAbsolutePath, saveArtwork } from './ArtworkCache'
import {
  getMusicBrainzMetadataClient,
  type MusicBrainzMetadataClient,
  type MusicBrainzReleaseDetail,
  type MusicBrainzReleaseTrack,
} from './MusicBrainzMetadata'
import { isVariousArtists, matchLocalAlbumForRelease, type RankedOriginalRelease } from './originalAlbumCandidates'
import { albumDirectoryFromTrackPaths, chooseNewAlbumDirectory, planNewAlbumDestination } from './newAlbumMovePlanner'
import { getLibraryBackup } from '../services/LibraryBackup'
import { getLyricsIndexService } from '../lyrics/LyricsIndexService'
import type { DbAlbum, DbFolder, DbTrack } from '@shared/types/db'
import type {
  OriginalAlbumCandidate,
  OriginalAlbumCandidatesResult,
  TrackAlbumMoveApplyResult,
  TrackAlbumMoveDuplicate as PublicMoveDuplicate,
  TrackAlbumMoveEndpoint,
  TrackAlbumMoveManualAlbum,
  TrackAlbumMovePlacementSource,
  TrackAlbumMovePreview,
  TrackAlbumMoveProposal,
  TrackAlbumMoveReplacement,
  TrackAlbumMoveSlot,
  TrackAlbumMoveTarget,
} from '@shared/types/ipc-contract'
import {
  albumDiscOccupants,
  albumMovePreviewPlacementFlags,
  albumMoveTitlesMatch,
  findAlbumMoveDuplicate,
  findTracklistSlot,
  firstFreeAlbumSlot,
  planAlbumMoveDestination,
} from './trackAlbumMovePlanner'
import {
  compareTrackQuality,
  describeTrackQuality,
  summarizeTrackQuality,
} from './trackAlbumMoveQuality'
import {
  albumMoveSidecarPathFor,
  applyAlbumMoveFileOperation,
  stageAlbumMoveReplacement,
  type AlbumMoveReplacementStage,
} from './trackAlbumMoveFileOperation'
import { requireLocalLibraryTrackPath } from './localLibraryTrackGuard'

const PREVIEW_TTL_MS = 30 * 60 * 1000
const MB_READY_CONFIDENCE = 0.58

// Where an applied preview lands. A 'new' album doesn't exist yet: its row is
// created inside the move transaction from the freshly written tags.
type StoredMoveTarget =
  | { kind: 'library'; albumId: number }
  | {
      kind: 'new'
      folderId: number
      title: string
      albumArtist: string | null
      releaseId: string | null
      releaseGroupId: string | null
    }

interface StoredPreview {
  preview: TrackAlbumMovePreview
  sourcePath: string
  target: StoredMoveTarget
  // null keeps the file's current embedded cover.
  artwork: MetadataArtworkPayload | null
  // Release-level tags (compilation flag, MusicBrainz release ids...) for the
  // destination album, so nothing from the source album survives the move.
  release: MetadataReleaseTags
}

// A MusicBrainz release fetched for a new-album preview, with its Cover Art
// Archive cover. Cached so picking another slot doesn't re-download either.
interface LoadedRelease {
  detail: MusicBrainzReleaseDetail
  artwork: MetadataArtworkPayload | null
  artworkPath: string | null
  fetchedAt: number
}

interface NewAlbumIdentity {
  title: string
  albumArtist: string | null
  year: string | null
  releaseId: string | null
  releaseGroupId: string | null
  releaseType: string | null
}

interface TrackAlbumMoveRecordInput {
  id: string
  trackId: number
  oldPath: string
  newPath: string
  oldSyncKey: string
  oldDeviceRelativePath: string
  newSyncKey: string
  newDeviceRelativePath: string
  createdAt: string
}

export interface TrackAlbumMoveServiceDeps {
  repos: Repos
  db: BetterSqliteDatabase
  musicBrainz: Pick<
    MusicBrainzMetadataClient,
    'lookupRecordingOnAlbum' | 'lookupAlbumTracklist' | 'findOriginalReleases' | 'lookupReleaseDetail' | 'fetchCoverArt'
  >
  readTrackMetadata: typeof readTrackMetadata
  writeTrackMetadata: typeof writeTrackMetadata
  scheduleBackupForTrack: (trackId: number) => void
  removeLyricsIndexEntry: (track: DbTrack) => void
  recordMove: (move: TrackAlbumMoveRecordInput) => void
  runTransaction: (fn: () => void) => void
  // Sends the replaced track's file to the OS trash (recoverable). Lazily pulls
  // electron's shell so the service stays importable in plain node tests.
  trashItem: (path: string) => Promise<void>
  // Stores downloaded cover art in the artwork cache so the preview can show
  // it; returns the cache filename, or null if it couldn't be stored.
  cacheArtwork: (artwork: MetadataArtworkPayload) => string | null
  // Removes the source folders left without playable files after the move.
  // Lazily loaded for the same reason as trashItem.
  cleanupEmptyFolders: (rootPath: string, movedPaths: string[]) => Promise<void>
}

function nowIso(): string {
  return new Date().toISOString()
}

function pictureMimeFromPath(path: string): string {
  const ext = extname(path).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.webp') return 'image/webp'
  return 'image/jpeg'
}

function text(value: string | null | undefined): string {
  return (value ?? '').trim()
}

function bestString(tracks: DbTrack[], read: (track: DbTrack) => string | null | undefined): string | null {
  const counts = new Map<string, { value: string; count: number }>()
  for (const track of tracks) {
    const value = text(read(track))
    if (!value) continue
    const key = value.normalize('NFC').toLowerCase()
    const existing = counts.get(key)
    counts.set(key, { value, count: (existing?.count ?? 0) + 1 })
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))[0]?.value ?? null
}

function sourceEndpoint(track: DbTrack): TrackAlbumMoveEndpoint {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    albumArtist: track.album_artist,
    year: track.year,
    path: track.path,
    artworkPath: track.artwork_path,
  }
}

function targetAlbumArtist(album: DbAlbum, tracks: DbTrack[]): string {
  return album.album_artist ?? bestString(tracks, track => track.album_artist) ?? bestString(tracks, track => track.artist) ?? ''
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
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

function syncRelativeFor(folder: DbFolder, path: string): string {
  return toPosixRelative(folder.path, path)
}

function publicDuplicate(duplicate: ReturnType<typeof findAlbumMoveDuplicate>): PublicMoveDuplicate | null {
  if (!duplicate) return null
  return {
    trackId: duplicate.id,
    title: duplicate.title,
    path: duplicate.path,
    reason: duplicate.reason,
  }
}

function moveErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class TrackAlbumMoveService {
  private deps: TrackAlbumMoveServiceDeps
  private previews = new Map<string, StoredPreview>()
  private releases = new Map<string, LoadedRelease>()

  constructor(deps?: Partial<TrackAlbumMoveServiceDeps>) {
    const db = deps?.db ?? getDatabase()
    this.deps = {
      repos: deps?.repos ?? getRepos(),
      db,
      musicBrainz: deps?.musicBrainz ?? getMusicBrainzMetadataClient(),
      readTrackMetadata: deps?.readTrackMetadata ?? readTrackMetadata,
      writeTrackMetadata: deps?.writeTrackMetadata ?? writeTrackMetadata,
      scheduleBackupForTrack: deps?.scheduleBackupForTrack ?? (trackId => getLibraryBackup().scheduleWriteForTrack(trackId)),
      removeLyricsIndexEntry: deps?.removeLyricsIndexEntry ?? (track => getLyricsIndexService().removeEntryForTrack(track)),
      recordMove: deps?.recordMove ?? (move => this.recordMoveInDb(move)),
      runTransaction: deps?.runTransaction ?? (fn => db.transaction(fn)()),
      trashItem: deps?.trashItem ?? (async path => {
        const { shell } = await import('electron')
        await shell.trashItem(path)
      }),
      cacheArtwork: deps?.cacheArtwork ?? (artwork => {
        try {
          return saveArtwork(artwork.data, artwork.mimeType).filename
        } catch {
          return null
        }
      }),
      cleanupEmptyFolders: deps?.cleanupEmptyFolders ?? (async (rootPath, movedPaths) => {
        const { getFolderCleanupService } = await import('../folder-cleanup/FolderCleanupService')
        await getFolderCleanupService().cleanupLocalAfterDeletion({
          rootPath,
          deletedPaths: movedPaths,
          origin: 'album-move',
        })
      }),
    }
  }

  // Candidate original albums for a track (usually one downloaded from a
  // compilation), each flagged with the library album it already matches.
  async findOriginalAlbums(trackId: number): Promise<OriginalAlbumCandidatesResult> {
    const track = this.requireTrack(trackId)
    if (track.provider !== 'local') throw new Error('Mover entre álbumes no está disponible para pistas cloud.')
    const sourceAlbum = track.album_id != null ? this.deps.repos.albums.getById(track.album_id) ?? null : null
    const sourceIsCompilation = track.compilation === 1 ||
      sourceAlbum?.is_compilation === 1 ||
      isVariousArtists(track.album_artist)
    const warnings: string[] = []
    let ranked: RankedOriginalRelease[] = []
    try {
      ranked = await this.deps.musicBrainz.findOriginalReleases({
        title: track.title,
        artist: track.artist,
        searchArtist: parseArtistName(track.artist).primary || track.artist,
        durationSeconds: track.duration > 0 ? track.duration : null,
      })
    } catch (err) {
      warnings.push(`MusicBrainz no está disponible (${moveErrorMessage(err)}). Podés crear el álbum a mano.`)
    }
    if (ranked.length === 0 && warnings.length === 0) {
      warnings.push('MusicBrainz no encontró álbumes con este tema. Podés crear el álbum a mano.')
    }
    const localAlbums = this.deps.repos.albums.getAll()
    const candidates = ranked.map((release): OriginalAlbumCandidate => {
      const local = matchLocalAlbumForRelease(release, localAlbums)
      return {
        releaseId: release.releaseId,
        releaseGroupId: release.releaseGroupId,
        recordingId: release.recordingId,
        title: release.title,
        artist: release.artist,
        year: release.year,
        country: release.country,
        status: release.status,
        primaryType: release.primaryType,
        secondaryTypes: release.secondaryTypes,
        trackNumber: release.trackNumber,
        discNumber: release.discNumber,
        totalTracks: release.totalTracks,
        confidence: release.confidence,
        localAlbumId: local?.id ?? null,
        localTrackCount: local?.track_count ?? 0,
        isCurrentAlbum: local != null && local.id === track.album_id,
      }
    })
    return { trackId, sourceIsCompilation, candidates, warnings }
  }

  async preview(trackId: number, target: TrackAlbumMoveTarget, trackNumberOverride: number | null = null): Promise<TrackAlbumMovePreview> {
    this.pruneExpiredPreviews()
    const track = this.requireTrack(trackId)
    if (track.provider !== 'local') throw new Error('Mover entre álbumes no está disponible para pistas cloud.')
    const built = target.kind === 'library'
      ? await this.buildPreview(track, this.requireAlbum(target.albumId), trackNumberOverride)
      : await this.buildNewAlbumPreview(track, target, trackNumberOverride)
    this.previews.set(built.preview.previewId, built)
    return built.preview
  }

  async apply(previewId: string, confirmLowerQualityReplace = false): Promise<TrackAlbumMoveApplyResult> {
    this.pruneExpiredPreviews()
    const stored = this.previews.get(previewId)
    if (!stored) throw new Error('La vista previa expiró. Volvé a calcular el movimiento.')
    if (stored.preview.status !== 'ready' || !stored.preview.proposal) {
      throw new Error(stored.preview.errors[0] ?? 'El movimiento no está listo para aplicar.')
    }

    const track = this.requireTrack(stored.preview.source.id)
    if (track.path !== stored.sourcePath) {
      throw new Error('El archivo cambió desde la vista previa. Volvé a calcular el movimiento.')
    }
    const targetAlbum = stored.target.kind === 'library' ? this.requireAlbum(stored.target.albumId) : null
    if (stored.target.kind === 'new') this.assertNewAlbumStillMissing(stored.target)
    const localErrors = this.validateStoredPreview(track, targetAlbum, stored, confirmLowerQualityReplace)
    if (localErrors.length > 0) throw new Error(localErrors[0])

    const proposal = stored.preview.proposal
    const sourceFolder = this.deps.repos.folders.getById(track.folder_id)
    const sourcePath = requireLocalLibraryTrackPath({
      track,
      folder: sourceFolder,
      expectedPath: stored.sourcePath,
      label: 'La pista original',
    })
    const destinationPath = resolve(proposal.destinationPath)
    this.folderForDestination(targetAlbum, destinationPath)
    const applyResult: { movedTrack: DbTrack | null } = { movedTrack: null }

    // Replacement is staged on the same filesystem first, not sent to trash.
    // This keeps it reversible until metadata, file moves and the DB transaction
    // have all committed.
    const replacement = stored.preview.replacement
    let replacedTrack: DbTrack | null = null
    let replacementStage: AlbumMoveReplacementStage | null = null
    if (replacement && (replacement.incomingIsBetter || confirmLowerQualityReplace)) {
      replacedTrack = this.deps.repos.tracks.getById(replacement.trackId) ?? null
      if (!replacedTrack) {
        throw new Error('La pista a reemplazar ya no existe. Volvé a calcular el movimiento.')
      }
      const replacedPath = requireLocalLibraryTrackPath({
        track: replacedTrack,
        folder: this.deps.repos.folders.getById(replacedTrack.folder_id),
        expectedPath: replacement.path,
        label: 'La pista a reemplazar',
      })
      try {
        replacementStage = await stageAlbumMoveReplacement(replacedPath)
      } catch (err) {
        throw new Error(`No se pudo preparar de forma reversible la pista reemplazada: ${moveErrorMessage(err)}`)
      }
    }

    try {
      await applyAlbumMoveFileOperation({
        sourcePath,
        destinationPath,
        writeTempMetadata: tempPath => {
          this.deps.writeTrackMetadata(tempPath, this.payloadFromProposal(proposal), {
            artwork: stored.artwork,
            release: stored.release,
            createBackup: false,
          })
        },
        afterFilesMoved: async () => {
          const md = await this.deps.readTrackMetadata(destinationPath)
          applyResult.movedTrack = this.updateDbAfterMove(track, targetAlbum, md, destinationPath, randomUUID(), sourcePath, replacedTrack)
        },
      })
    } catch (err) {
      if (replacementStage) {
        try {
          await replacementStage.rollback()
        } catch (rollbackErr) {
          throw new Error(
            `${moveErrorMessage(err)}; además falló restaurar la pista reemplazada: ${moveErrorMessage(rollbackErr)}`,
          )
        }
      }
      throw err
    }

    const movedTrack = applyResult.movedTrack
    if (!movedTrack) throw new Error('No se pudo actualizar la biblioteca después de mover el archivo.')
    if (replacementStage) {
      await replacementStage.retire(path => this.deps.trashItem(path)).catch(err => {
        // The new track and DB are already committed. Retain the staged file for
        // manual recovery rather than turning a cleanup failure into data loss.
        console.warn(
          `[album-move] replacement committed but staged cleanup failed at ${replacementStage?.audioBackupPath}:`,
          moveErrorMessage(err),
        )
      })
    }
    this.previews.delete(previewId)
    if (sourceFolder) {
      await this.deps.cleanupEmptyFolders(sourceFolder.path, [sourcePath]).catch(err => {
        console.warn('[album-move] empty folder cleanup failed:', moveErrorMessage(err))
      })
    }
    return {
      trackId: movedTrack.id,
      previousPath: sourcePath,
      path: destinationPath,
      title: movedTrack.title,
      artist: movedTrack.artist,
      album: movedTrack.album,
    }
  }

  accessRootsForPreview(previewId: string): string[] {
    this.pruneExpiredPreviews()
    const stored = this.previews.get(previewId)
    if (!stored?.preview.proposal) throw new Error('La vista previa expiró. Volvé a calcular el movimiento.')
    const track = this.requireTrack(stored.preview.source.id)
    const sourceFolder = this.deps.repos.folders.getById(track.folder_id)
    if (!sourceFolder || sourceFolder.provider !== 'local' || sourceFolder.role !== 'library') {
      throw new Error('La biblioteca original ya no existe.')
    }
    const targetAlbum = stored.target.kind === 'library' ? this.requireAlbum(stored.target.albumId) : null
    const destinationFolder = this.folderForDestination(targetAlbum, resolve(stored.preview.proposal.destinationPath))
    return [...new Set([resolve(sourceFolder.path), resolve(destinationFolder.path)])]
  }

  // Builds the move into an album that isn't in the library yet: from a
  // MusicBrainz release (identity, official tracklist, Cover Art Archive cover)
  // or from fields typed by the user. The folder goes next to the album
  // artist's other albums in the track's library, else <root>/<Artist>/<Album>.
  private async buildNewAlbumPreview(
    track: DbTrack,
    target: Exclude<TrackAlbumMoveTarget, { kind: 'library' }>,
    trackNumberOverride: number | null,
  ): Promise<StoredPreview> {
    const sourceFolder = this.deps.repos.folders.getById(track.folder_id)
    if (!sourceFolder || sourceFolder.provider !== 'local' || sourceFolder.role !== 'library') {
      throw new Error('La biblioteca original ya no existe.')
    }

    let loaded: LoadedRelease | null = null
    let detail: MusicBrainzReleaseDetail | null = null
    let manual: TrackAlbumMoveManualAlbum | null = null
    let album: NewAlbumIdentity
    if (target.kind === 'release') {
      loaded = await this.loadRelease(target.releaseId)
      detail = loaded.detail
      album = {
        title: detail.title,
        albumArtist: detail.albumArtist ?? track.artist,
        year: detail.year,
        releaseId: detail.releaseId,
        releaseGroupId: detail.releaseGroupId,
        releaseType: [detail.primaryType, ...detail.secondaryTypes].filter(Boolean).join(' + ') || null,
      }
    } else {
      manual = normalizeManualAlbum(target.album)
      album = {
        title: manual.title,
        albumArtist: manual.albumArtist,
        year: manual.year,
        releaseId: null,
        releaseGroupId: null,
        releaseType: null,
      }
    }

    // The album may already be in the library (or have appeared since the
    // candidates were listed): then it's a plain move into that album.
    const existing = matchLocalAlbumForRelease({
      releaseIds: album.releaseId ? [album.releaseId] : [],
      releaseGroupId: album.releaseGroupId,
      title: album.title,
      artist: album.albumArtist,
    }, this.deps.repos.albums.getAll())
    if (existing) {
      const built = await this.buildPreview(track, existing, trackNumberOverride)
      if (existing.id !== track.album_id) {
        built.preview.warnings.unshift(`"${existing.title}" ya está en tu biblioteca: el tema se mueve a ese álbum.`)
      }
      return built
    }

    const previewId = randomUUID()
    const createdAt = Date.now()
    const errors: string[] = []
    const warnings: string[] = []

    // Where the incoming song sits on the release: the exact recording first,
    // then a title match on the official tracklist.
    const tracklist = detail?.tracklist ?? []
    const recordingSlot = target.kind === 'release' && target.recordingId
      ? tracklist.find(entry => entry.recordingId === target.recordingId) ?? null
      : null
    const titleSlot = recordingSlot ? null : findTracklistSlot({ tracklist, title: track.title, discNumber: null })
    const matchedSlot = recordingSlot ?? titleSlot
    const overrideNumber = positiveTrackNumber(trackNumberOverride)
    const discNumber = matchedSlot?.discNumber ?? manual?.discNumber ?? 1
    let placementSource: TrackAlbumMovePlacementSource
    let trackNumber: number
    if (overrideNumber != null) {
      trackNumber = overrideNumber
      placementSource = 'override'
    } else if (recordingSlot) {
      trackNumber = recordingSlot.trackNumber
      placementSource = 'musicbrainz'
    } else if (titleSlot) {
      trackNumber = titleSlot.trackNumber
      placementSource = 'tracklist'
      warnings.push(`Ubicada por la lista oficial de MusicBrainz en la pista ${trackNumber}.`)
    } else {
      trackNumber = 1
      placementSource = 'append'
      errors.push(detail
        ? 'No encontramos el tema en la lista oficial del álbum. Elegí el número de pista.'
        : 'Indicá el número de pista del tema en el álbum.')
    }

    const totalDiscs = detail ? detail.totalDiscs : manual?.totalDiscs ?? null
    const totalTracks = detail ? detail.discTrackCounts[discNumber] ?? null : manual?.totalTracks ?? null
    const officialTitles = officialTitlesForDisc(tracklist, discNumber)
    const slots = buildAlbumMoveSlots(new Map(), totalTracks, trackNumber, officialTitles)

    // Prefer the title as printed on the original album only when it is the
    // very same recording or the same normalized title (fixes casing/edition
    // suffixes from the compilation without renaming a different song).
    const title = recordingSlot?.title ?? (titleSlot && titleSlot.score >= 1 ? titleSlot.title : track.title)
    const albumArtist = album.albumArtist || track.artist
    const year = album.year ?? ''
    const genre = track.genre || detail?.genre || ''

    const directoryPlan = chooseNewAlbumDirectory({
      rootPath: sourceFolder.path,
      albumArtist,
      albumTitle: album.title,
      year: album.year,
      artistAlbumDirectories: this.artistAlbumDirectories(sourceFolder, albumArtist, track.album_id),
    })
    const destination = planNewAlbumDestination({
      directory: directoryPlan.directory,
      sourcePath: track.path,
      title,
      trackNumber,
      totalTracks,
      discNumber,
      totalDiscs,
    })
    const destinationPath = resolve(destination.destinationPath)
    if (!isInside(resolve(sourceFolder.path), destinationPath)) {
      errors.push('La ruta destino queda fuera de la biblioteca del álbum.')
    }
    if (destinationPath === resolve(track.path)) {
      errors.push('La ruta destino es igual a la ruta actual.')
    }
    if (existsSync(destinationPath)) {
      errors.push(`Ya existe un archivo en destino: ${destinationPath}`)
    }
    const destinationSidecar = albumMoveSidecarPathFor(destinationPath)
    if (existsSync(albumMoveSidecarPathFor(track.path)) && existsSync(destinationSidecar)) {
      errors.push(`Ya existe una letra .lrc en destino: ${destinationSidecar}`)
    }
    if (process.platform === 'win32' && destinationPath.length >= 250) {
      errors.push('La ruta destino es demasiado larga para Windows. Acortá el nombre del álbum o del tema.')
    }

    // Cover Art Archive cover for the release. Without one the file keeps its
    // current embedded cover (never blocks the move).
    const artwork = loaded?.artwork ?? null
    const artworkPath = loaded?.artworkPath ?? null
    if (detail && !artwork) {
      warnings.push('Cover Art Archive no tiene carátula para este álbum; se mantiene la carátula actual.')
    }

    const proposal: TrackAlbumMoveProposal = {
      title,
      artist: track.artist,
      album: album.title,
      albumArtist,
      genre,
      year,
      trackNumber,
      totalTracks,
      discNumber,
      totalDiscs,
      filename: destination.filename,
      destinationPath,
      destinationDirectory: destination.directory,
      artworkPath: artworkPath ?? track.artwork_path ?? '',
      musicBrainzConfidence: recordingSlot ? 1 : titleSlot?.score ?? 0,
    }
    const release: MetadataReleaseTags = detail
      ? {
          isCompilation: isVariousArtists(albumArtist),
          musicBrainzReleaseId: detail.releaseId,
          musicBrainzReleaseGroupId: detail.releaseGroupId,
          musicBrainzReleaseArtistId: detail.albumArtistIds.length === 1 ? detail.albumArtistIds[0] : null,
          musicBrainzReleaseType: [detail.primaryType, ...detail.secondaryTypes]
            .filter((type): type is string => !!type)
            .map(type => type.toLowerCase())
            .join('; ') || null,
          musicBrainzReleaseStatus: detail.status?.toLowerCase() ?? null,
          musicBrainzReleaseCountry: detail.country,
          clearMusicBrainzDiscId: true,
          clearAlbumReplayGain: true,
        }
      : {
          isCompilation: isVariousArtists(albumArtist),
          musicBrainzReleaseId: null,
          musicBrainzReleaseGroupId: null,
          musicBrainzReleaseArtistId: null,
          musicBrainzReleaseType: null,
          musicBrainzReleaseStatus: null,
          musicBrainzReleaseCountry: null,
          clearMusicBrainzDiscId: true,
          clearAlbumReplayGain: true,
        }

    const isReady = errors.length === 0
    const preview: TrackAlbumMovePreview = {
      previewId,
      createdAt,
      status: isReady ? 'ready' : 'blocked',
      source: sourceEndpoint(track),
      targetAlbum: {
        id: null,
        isNew: true,
        title: album.title,
        artist: albumArtist,
        year: album.year,
        artworkPath: artworkPath ?? track.artwork_path ?? null,
        trackCount: 0,
        releaseId: album.releaseId,
        releaseType: album.releaseType,
      },
      proposal,
      duplicate: null,
      slots,
      discNumber,
      totalTracks,
      selectedTrackNumber: trackNumber,
      suggestedTrackNumber: matchedSlot?.trackNumber ?? null,
      trackNumberFromMusicBrainz: placementSource === 'musicbrainz',
      placementSource,
      ...albumMovePreviewPlacementFlags(isReady ? proposal : null, placementSource),
      replacement: null,
      errors,
      warnings,
    }
    return {
      preview,
      sourcePath: track.path,
      target: {
        kind: 'new',
        folderId: sourceFolder.id,
        title: album.title,
        albumArtist,
        releaseId: album.releaseId,
        releaseGroupId: album.releaseGroupId,
      },
      artwork,
      release,
    }
  }

  private async loadRelease(releaseId: string): Promise<LoadedRelease> {
    const cached = this.releases.get(releaseId)
    if (cached && Date.now() - cached.fetchedAt <= PREVIEW_TTL_MS) return cached
    let detail: MusicBrainzReleaseDetail | null
    try {
      detail = await this.deps.musicBrainz.lookupReleaseDetail(releaseId)
    } catch (err) {
      throw new Error(`No se pudo leer el álbum en MusicBrainz (${moveErrorMessage(err)}). Probá de nuevo o creá el álbum a mano.`)
    }
    if (!detail) throw new Error('MusicBrainz ya no tiene ese álbum. Elegí otro o creá el álbum a mano.')
    let artwork: MetadataArtworkPayload | null = null
    let artworkPath: string | null = null
    try {
      const art = await this.deps.musicBrainz.fetchCoverArt(detail.releaseId, detail.releaseGroupId)
      if (art) {
        artwork = { data: art.data, mimeType: art.mimeType }
        artworkPath = this.deps.cacheArtwork(artwork)
      }
    } catch {
      artwork = null
    }
    const loaded: LoadedRelease = { detail, artwork, artworkPath, fetchedAt: Date.now() }
    this.releases.set(releaseId, loaded)
    return loaded
  }

  // Folders of the album artist's other albums in this library root, used to
  // place a new album next to them with the same naming style.
  private artistAlbumDirectories(folder: DbFolder, albumArtist: string, sourceAlbumId: number | null): string[] {
    const directories: string[] = []
    for (const album of this.deps.repos.albums.getAll()) {
      if (album.id === sourceAlbumId || album.is_compilation === 1) continue
      if (!albumMoveTitlesMatch(album.album_artist, albumArtist)) continue
      const paths = this.deps.repos.entityTracks.getTracksForAlbum(album.id)
        .filter(row => row.provider === 'local' && row.folder_id === folder.id)
        .map(row => row.path)
      const directory = albumDirectoryFromTrackPaths(paths)
      if (directory) directories.push(directory)
    }
    return directories
  }

  private assertNewAlbumStillMissing(target: Extract<StoredMoveTarget, { kind: 'new' }>): void {
    const existing = matchLocalAlbumForRelease({
      releaseIds: target.releaseId ? [target.releaseId] : [],
      releaseGroupId: target.releaseGroupId,
      title: target.title,
      artist: target.albumArtist,
    }, this.deps.repos.albums.getAll())
    if (existing) {
      throw new Error(`"${existing.title}" ya está en tu biblioteca. Volvé a calcular el movimiento.`)
    }
  }

  // Release tags for a move into an album already in the library: its own
  // compilation flag and MusicBrainz ids replace the source album's.
  private releaseTagsForLibraryAlbum(track: DbTrack, album: DbAlbum, targetTracks: DbTrack[]): MetadataReleaseTags {
    const siblings = targetTracks.filter(row => row.id !== track.id)
    const isCompilation = siblings.length > 0
      ? siblings.filter(row => row.compilation === 1).length * 2 > siblings.length
      : album.is_compilation === 1
    const sameAlbumArtist = albumMoveTitlesMatch(track.album_artist, targetAlbumArtist(album, targetTracks))
    return {
      isCompilation,
      musicBrainzReleaseId: album.musicbrainz_album_id,
      musicBrainzReleaseGroupId: album.musicbrainz_release_group_id,
      // Still valid when both albums share the album artist; otherwise it names
      // the old album's artist (e.g. "Various Artists").
      musicBrainzReleaseArtistId: sameAlbumArtist ? undefined : null,
      musicBrainzReleaseType: album.release_type,
      musicBrainzReleaseStatus: null,
      musicBrainzReleaseCountry: album.release_country,
      clearMusicBrainzDiscId: true,
      clearAlbumReplayGain: true,
    }
  }

  private async buildPreview(track: DbTrack, targetAlbum: DbAlbum, trackNumberOverride: number | null): Promise<StoredPreview> {
    const previewId = randomUUID()
    const createdAt = Date.now()
    const targetTracks = this.deps.repos.entityTracks.getTracksForAlbum(targetAlbum.id)
      .filter(candidate => candidate.provider === 'local')
    const errors: string[] = []
    const warnings: string[] = []
    let proposal: TrackAlbumMoveProposal | null = null
    let duplicate: PublicMoveDuplicate | null = null
    let artwork: MetadataArtworkPayload | null = null
    let slots: TrackAlbumMoveSlot[] = []
    let discNumberForSlots = 1
    let totalTracksForSlots: number | null = null
    let selectedTrackNumber: number | null = null
    let suggestedTrackNumber: number | null = null
    let trackNumberFromMusicBrainz = false
    let placementSource: TrackAlbumMovePlacementSource = 'append'
    let replacement: TrackAlbumMoveReplacement | null = null

    if (track.album_id === targetAlbum.id) {
      errors.push('El tema ya pertenece a ese álbum.')
    }
    if (targetTracks.length === 0) {
      errors.push('El álbum destino no tiene pistas locales para tomar carpeta y artwork.')
    }

    const artworkTrack = targetTracks.find(candidate =>
      candidate.id !== track.id &&
      candidate.artwork_path &&
      existsSync(artworkAbsolutePath(candidate.artwork_path))
    )
    if (artworkTrack?.artwork_path) {
      const artworkPath = artworkAbsolutePath(artworkTrack.artwork_path)
      artwork = { data: readFileSync(artworkPath), mimeType: pictureMimeFromPath(artworkPath) }
    } else if (targetTracks.length > 0) {
      errors.push('El álbum destino no tiene artwork local reutilizable.')
    }

    if (errors.length === 0) {
      // Confirm with MusicBrainz when possible, but never let a missing or
      // uncertain MusicBrainz answer block a move between albums that already
      // exist in the library. The proposal is built from library data; MusicBrainz
      // only refines metadata/track number when it confidently agrees.
      let match: Awaited<ReturnType<TrackAlbumMoveServiceDeps['musicBrainz']['lookupRecordingOnAlbum']>> = null
      let mbChecked = false
      try {
        match = await this.deps.musicBrainz.lookupRecordingOnAlbum({
          title: track.title,
          artist: track.artist,
          album: targetAlbum.title,
          durationSeconds: track.duration,
        })
        mbChecked = true
      } catch (err) {
        warnings.push(`MusicBrainz no está disponible (${moveErrorMessage(err)}); se usan los datos de la biblioteca.`)
      }
      if (mbChecked) {
        if (!match) {
          warnings.push('MusicBrainz no encontró el tema en ese álbum; se usan los datos de la biblioteca.')
        } else if (match.confidence < MB_READY_CONFIDENCE) {
          warnings.push('MusicBrainz no confirmó el tema en ese álbum; se usan los datos de la biblioteca.')
          match = null
        }
      }

      const title = match?.title ?? track.title
      const artist = match?.artist ?? track.artist
      const albumArtist = (match?.albumArtist ?? targetAlbumArtist(targetAlbum, targetTracks)) || null
      const year = match?.year ?? targetAlbum.year ?? bestString(targetTracks, row => row.year) ?? track.year
      const genre = match?.genre ?? bestString(targetTracks, row => row.genre) ?? track.genre
      const totalTracks = match?.totalTracks ?? bestNumber(targetTracks, row => row.total_tracks)
      const discNumber = match?.discNumber ?? bestNumber(targetTracks, row => row.disc_number)
      const totalDiscs = match?.totalDiscs ?? bestNumber(targetTracks, row => row.total_discs)

      // The destination album's full official tracklist. Lets us pinpoint the
      // incoming track's real position by title — even when it currently sits in
      // a gap (a missing track) — instead of blindly appending at the end. Only
      // fetched when it could change the outcome (no user override and no
      // confident MusicBrainz track number, which both outrank it). Never blocks:
      // any failure degrades to library-only placement below.
      let officialTracklist: MusicBrainzReleaseTrack[] = []
      const needsTracklist = positiveTrackNumber(trackNumberOverride) == null && positiveTrackNumber(match?.trackNumber) == null
      if (mbChecked && needsTracklist) {
        try {
          officialTracklist = await this.deps.musicBrainz.lookupAlbumTracklist({
            album: targetAlbum.title,
            albumArtist: targetAlbumArtist(targetAlbum, targetTracks),
            musicBrainzAlbumId: targetAlbum.musicbrainz_album_id,
          })
        } catch (err) {
          warnings.push(`No se pudo obtener la lista oficial del álbum (${moveErrorMessage(err)}); se usan los datos de la biblioteca.`)
        }
      }

      // Layout of the destination disc: recommend a free slot and render the
      // picker straight from the existing library album.
      discNumberForSlots = normalizedDiscNumber(discNumber)
      totalTracksForSlots = totalTracks
      const occupants = albumDiscOccupants(targetTracks, track.id, discNumber)
      suggestedTrackNumber = firstFreeAlbumSlot(occupants, totalTracks)

      // The same song already in the album (any slot) is a replacement candidate
      // even when MusicBrainz/recommendation points elsewhere.
      const titleTwin = targetTracks.find(row => row.id !== track.id && albumMoveTitlesMatch(row.title, title)) ?? null
      const mbNumber = positiveTrackNumber(match?.trackNumber)
      const overrideNumber = positiveTrackNumber(trackNumberOverride)
      const tracklistMatch = findTracklistSlot({ tracklist: officialTracklist, title, discNumber })

      // Priority chain, most to least certain: user override → confident
      // MusicBrainz recording → official-tracklist title match (locates the slot
      // even if it's currently a gap) → same-title twin in the library → first
      // free gap → append at the end (flagged so the UI can warn).
      let effective: number
      if (overrideNumber != null) {
        effective = overrideNumber
        placementSource = 'override'
      } else if (mbNumber != null) {
        effective = mbNumber
        trackNumberFromMusicBrainz = true
        placementSource = 'musicbrainz'
      } else if (tracklistMatch != null) {
        effective = tracklistMatch.trackNumber
        placementSource = 'tracklist'
        if (tracklistMatch.discNumber !== discNumberForSlots) {
          warnings.push(`La lista oficial ubica esta pista en el disco ${tracklistMatch.discNumber}.`)
        }
      } else if (titleTwin && positiveTrackNumber(titleTwin.track_number) != null) {
        effective = positiveTrackNumber(titleTwin.track_number)!
        placementSource = 'titleTwin'
      } else if (suggestedTrackNumber != null) {
        effective = suggestedTrackNumber
        placementSource = 'gap'
      } else {
        effective = occupants.size > 0 ? Math.max(...occupants.keys()) + 1 : 1
        placementSource = 'append'
      }
      selectedTrackNumber = effective
      slots = buildAlbumMoveSlots(occupants, totalTracks, effective, officialTitlesForDisc(officialTracklist, discNumberForSlots))

      if (overrideNumber == null) {
        if (placementSource === 'tracklist') {
          warnings.push(`Ubicada por la lista oficial de MusicBrainz en la pista ${effective}.`)
        } else if (placementSource === 'titleTwin') {
          warnings.push(`El álbum ya tiene este tema en la pista ${effective}.`)
        } else if (placementSource === 'gap') {
          warnings.push(`Se recomendó la primera pista libre (${effective}).`)
        } else if (placementSource === 'append') {
          warnings.push(`No se encontró esta pista en el álbum; se agregará al final (${effective}).`)
        }
      }

      const destination = planAlbumMoveDestination({
        sourcePath: track.path,
        targetTracks,
        title,
        trackNumber: effective,
        totalTracks,
        discNumber,
        totalDiscs,
      })

      // A taken slot or title twin becomes a replacement decision instead of a
      // hard block: we only proceed when the incoming file is higher quality
      // (lossless > lossy, then sample rate, then bit depth).
      const duplicateTrack = findAlbumMoveDuplicate({
        targetTracks,
        sourceTrackId: track.id,
        title,
        trackNumber: effective,
        discNumber,
      })
      duplicate = publicDuplicate(duplicateTrack)
      const replaceRow = duplicateTrack ? targetTracks.find(row => row.id === duplicateTrack.id) ?? null : null
      if (replaceRow) {
        // Quality replacement only makes sense for the SAME song. A different song
        // sitting in the chosen slot is a plain conflict — the user must pick
        // another (the picker highlights the free slots).
        const sameSong = albumMoveTitlesMatch(replaceRow.title, title)
        if (sameSong) {
          const incoming = summarizeTrackQuality(track)
          const existing = summarizeTrackQuality(replaceRow)
          const incomingIsBetter = compareTrackQuality(incoming, existing) > 0
          replacement = { trackId: replaceRow.id, title: replaceRow.title, path: replaceRow.path, incoming, existing, incomingIsBetter }
          if (incomingIsBetter) {
            warnings.push(`Se reemplazará "${replaceRow.title}" (${describeTrackQuality(existing)}) por la versión entrante (${describeTrackQuality(incoming)}).`)
          } else {
            // Not a hard error: the preview stays "ready" but the renderer must
            // collect an explicit "borrar igual" confirmation before apply.
            warnings.push(`El álbum ya tiene "${replaceRow.title}" con calidad igual o superior (${describeTrackQuality(existing)}). Podés borrarlo y mover igual.`)
          }
        } else {
          errors.push(`La pista ${effective} ya está ocupada por "${replaceRow.title}". Elegí otro número.`)
        }
      }

      const destinationPath = resolve(destination.destinationPath)
      const replacePath = replaceRow ? resolve(replaceRow.path) : null
      if (destinationPath === resolve(track.path)) {
        errors.push('La ruta destino es igual a la ruta actual.')
      }
      // A pre-existing file at the destination only blocks when it isn't the
      // replaced track's own file (which gets trashed before the move).
      if (existsSync(destinationPath) && destinationPath !== replacePath) {
        errors.push(`Ya existe un archivo en destino: ${destinationPath}`)
      }
      const destinationSidecar = albumMoveSidecarPathFor(destinationPath)
      const replaceSidecar = replacePath ? albumMoveSidecarPathFor(replacePath) : null
      if (existsSync(albumMoveSidecarPathFor(track.path)) && existsSync(destinationSidecar) && destinationSidecar !== replaceSidecar) {
        errors.push(`Ya existe una letra .lrc en destino: ${destinationSidecar}`)
      }

      proposal = {
        title,
        artist,
        album: match?.album ?? targetAlbum.title,
        albumArtist,
        genre,
        year,
        trackNumber: effective,
        totalTracks,
        discNumber,
        totalDiscs,
        filename: destination.filename,
        destinationPath,
        destinationDirectory: destination.directory,
        artworkPath: artworkTrack?.artwork_path ?? '',
        musicBrainzConfidence: match?.confidence ?? 0,
      }
    }

    const isReady = errors.length === 0 && proposal != null && artwork != null
    const preview: TrackAlbumMovePreview = {
      previewId,
      createdAt,
      status: isReady ? 'ready' : 'blocked',
      source: sourceEndpoint(track),
      targetAlbum: {
        id: targetAlbum.id,
        isNew: false,
        title: targetAlbum.title,
        artist: targetAlbumArtist(targetAlbum, targetTracks),
        year: targetAlbum.year,
        artworkPath: artworkTrack?.artwork_path ?? null,
        trackCount: targetTracks.length,
        releaseId: targetAlbum.musicbrainz_album_id,
        releaseType: targetAlbum.release_type,
      },
      proposal,
      duplicate,
      slots,
      discNumber: discNumberForSlots,
      totalTracks: totalTracksForSlots,
      selectedTrackNumber,
      suggestedTrackNumber,
      trackNumberFromMusicBrainz,
      placementSource,
      ...albumMovePreviewPlacementFlags(isReady ? proposal : null, placementSource),
      replacement,
      errors,
      warnings,
    }
    return {
      preview,
      sourcePath: track.path,
      target: { kind: 'library', albumId: targetAlbum.id },
      artwork,
      release: this.releaseTagsForLibraryAlbum(track, targetAlbum, targetTracks),
    }
  }

  private validateStoredPreview(
    track: DbTrack,
    targetAlbum: DbAlbum | null,
    stored: StoredPreview,
    confirmLowerQualityReplace = false,
  ): string[] {
    const errors: string[] = []
    const preview = stored.preview
    const proposal = preview.proposal
    if (!proposal) return ['El movimiento no tiene propuesta para aplicar.']
    const targetTracks = targetAlbum
      ? this.deps.repos.entityTracks.getTracksForAlbum(targetAlbum.id).filter(candidate => candidate.provider === 'local')
      : []
    // The track we're allowed to overwrite/trash — when the incoming file is the
    // higher-quality one, or when the user confirmed deleting an equal/lower
    // quality same-title track. Its slot, file and sidecar are exempt below.
    const replacement = preview.replacement && (preview.replacement.incomingIsBetter || confirmLowerQualityReplace)
      ? preview.replacement
      : null
    const replacePath = replacement ? resolve(replacement.path) : null
    const replaceSidecar = replacePath ? albumMoveSidecarPathFor(replacePath) : null
    if (preview.replacement && !preview.replacement.incomingIsBetter && !confirmLowerQualityReplace) {
      errors.push(`El álbum ya tiene "${preview.replacement.title}" con calidad igual o superior; confirmá para borrarlo y mover igual.`)
    }
    const duplicate = findAlbumMoveDuplicate({
      targetTracks,
      sourceTrackId: track.id,
      title: proposal.title,
      trackNumber: proposal.trackNumber,
      discNumber: proposal.discNumber,
    })
    if (duplicate && duplicate.id !== replacement?.trackId) {
      errors.push(`El álbum destino ya tiene una pista equivalente: ${duplicate.title}.`)
    }
    if (!existsSync(track.path)) errors.push('El archivo original ya no existe.')
    if (existsSync(proposal.destinationPath) && resolve(proposal.destinationPath) !== replacePath) {
      errors.push(`Ya existe un archivo en destino: ${proposal.destinationPath}`)
    }
    const destinationSidecar = albumMoveSidecarPathFor(resolve(proposal.destinationPath))
    if (existsSync(albumMoveSidecarPathFor(track.path)) && existsSync(destinationSidecar) && destinationSidecar !== replaceSidecar) {
      errors.push(`Ya existe una letra .lrc en destino: ${destinationSidecar}`)
    }
    const folderId = stored.target.kind === 'new' ? stored.target.folderId : targetTracks[0]?.folder_id ?? track.folder_id
    const folder = this.deps.repos.folders.getById(folderId)
    if (!folder && stored.target.kind === 'new') errors.push('La biblioteca destino ya no existe.')
    if (folder && !isInside(resolve(folder.path), resolve(proposal.destinationPath))) {
      errors.push('La ruta destino queda fuera de la biblioteca del álbum.')
    }
    return errors
  }

  private payloadFromProposal(proposal: TrackAlbumMoveProposal) {
    return {
      title: proposal.title,
      artist: proposal.artist,
      album: proposal.album,
      albumArtist: proposal.albumArtist,
      genre: proposal.genre,
      year: proposal.year,
      trackNumber: proposal.trackNumber,
      totalTracks: proposal.totalTracks,
      discNumber: proposal.discNumber,
      totalDiscs: proposal.totalDiscs,
    }
  }

  private updateDbAfterMove(
    originalTrack: DbTrack,
    // null when moving into a new album, created here from the written tags.
    targetAlbum: DbAlbum | null,
    md: TrackMetadata,
    destinationPath: string,
    moveId: string,
    sourcePath: string,
    replacedTrack: DbTrack | null = null,
  ): DbTrack {
    const parsedArtist = parseArtistName(md.artist)
    const artist = this.deps.repos.artists.getOrCreate(parsedArtist.primary || md.artist)
    const genre = md.genre ? this.deps.repos.genres.getOrCreate(md.genre) : null
    const destinationFolder = this.folderForDestination(targetAlbum, destinationPath)
    const sourceFolder = this.deps.repos.folders.getById(originalTrack.folder_id)
    if (!sourceFolder) throw new Error('La biblioteca original ya no existe.')

    const oldRelative = syncRelativeFor(sourceFolder, sourcePath)
    const newRelative = syncRelativeFor(destinationFolder, destinationPath)
    const moveRecord: TrackAlbumMoveRecordInput = {
      id: moveId,
      trackId: originalTrack.id,
      oldPath: sourcePath,
      newPath: destinationPath,
      oldSyncKey: keyForRelativePath(oldRelative),
      oldDeviceRelativePath: oldRelative,
      newSyncKey: keyForRelativePath(newRelative),
      newDeviceRelativePath: newRelative,
      createdAt: nowIso(),
    }

    const replacesOther = replacedTrack != null && replacedTrack.id !== originalTrack.id
    let targetAlbumId = targetAlbum?.id ?? null
    this.deps.runTransaction(() => {
      this.deps.removeLyricsIndexEntry(originalTrack)
      // Drop the displaced row in the same transaction. Its file remains in a
      // reversible same-filesystem staging path until this transaction commits.
      if (replacesOther) {
        this.deps.removeLyricsIndexEntry(replacedTrack)
        this.deps.repos.tracks.deleteById(replacedTrack.id)
      }
      const albumId = targetAlbum?.id ?? this.createAlbumForMovedTrack(md)
      targetAlbumId = albumId
      this.deps.repos.tracks.moveAndUpdateMetadata({
        id: originalTrack.id,
        path: destinationPath,
        filename: basename(destinationPath),
        folderId: destinationFolder.id,
        title: md.title,
        artist: md.artist,
        album: md.album,
        albumArtist: md.albumArtist,
        composer: md.composer,
        genre: md.genre,
        year: md.year,
        trackNumber: md.trackNumber,
        totalTracks: md.totalTracks,
        discNumber: md.discNumber,
        totalDiscs: md.totalDiscs,
        compilation: md.isCompilation ? 1 : 0,
        releaseDate: md.releaseDate,
        originalReleaseDate: md.originalReleaseDate,
        mediaType: md.mediaType,
        extendedMetadata: serializeTrackExtendedMetadata(md),
        duration: md.duration,
        format: md.format,
        codec: md.codec,
        bitrate: md.bitrate,
        sampleRate: md.sampleRate,
        channels: md.channels,
        bitDepth: md.bitDepth,
        fileSize: md.fileSize,
        bpm: md.bpm,
        musicalKey: md.musicalKey,
        dateModified: md.dateModified,
        artworkPath: md.artwork?.filename ?? originalTrack.artwork_path,
        artistId: artist.id,
        albumId,
        genreId: genre?.id ?? null,
      })
      this.deps.recordMove(moveRecord)
    })

    this.deps.repos.folders.updateTrackCount(originalTrack.folder_id, this.deps.repos.tracks.countByFolder(originalTrack.folder_id))
    if (destinationFolder.id !== originalTrack.folder_id) {
      this.deps.repos.folders.updateTrackCount(destinationFolder.id, this.deps.repos.tracks.countByFolder(destinationFolder.id))
    }
    if (replacesOther && replacedTrack.folder_id !== originalTrack.folder_id && replacedTrack.folder_id !== destinationFolder.id) {
      this.deps.repos.folders.updateTrackCount(replacedTrack.folder_id, this.deps.repos.tracks.countByFolder(replacedTrack.folder_id))
    }
    this.deps.scheduleBackupForTrack(originalTrack.id)
    return this.deps.repos.tracks.getById(originalTrack.id) ?? {
      ...originalTrack,
      path: destinationPath,
      filename: basename(destinationPath),
      folder_id: destinationFolder.id,
      title: md.title,
      artist: md.artist,
      album: md.album,
      album_artist: md.albumArtist,
      genre: md.genre,
      year: md.year,
      track_number: md.trackNumber,
      total_tracks: md.totalTracks,
      disc_number: md.discNumber,
      total_discs: md.totalDiscs,
      artwork_path: md.artwork?.filename ?? originalTrack.artwork_path,
      album_id: targetAlbumId,
      artist_id: artist.id,
      genre_id: genre?.id ?? null,
    }
  }

  // Album row for a track moved into an album that wasn't in the library. Keyed
  // exactly like the importer (title, album artist, year) so a later rescan
  // lands on the same row; its release identity is SET from the new tags rather
  // than merged, so no compilation flag or stale release id carries over.
  private createAlbumForMovedTrack(md: TrackMetadata): number {
    const album = this.deps.repos.albums.getOrCreate(md.album, md.albumArtist ?? null, md.year || null)
    if (!this.deps.repos.albums.replaceReleaseMetadataIfEmpty(album.id, md)) {
      this.deps.repos.albums.enrichReleaseMetadata(album.id, md)
    }
    return album.id
  }

  private folderForDestination(targetAlbum: DbAlbum | null, destinationPath: string): DbFolder {
    const targetTracks = targetAlbum
      ? this.deps.repos.entityTracks.getTracksForAlbum(targetAlbum.id).filter(candidate => candidate.provider === 'local')
      : []
    const exact = targetTracks
      .map(track => this.deps.repos.folders.getById(track.folder_id))
      .filter((folder): folder is DbFolder =>
        folder?.provider === 'local' && folder.role === 'library',
      )
      .find(folder => isInside(resolve(folder.path), resolve(destinationPath)))
    if (exact) return exact

    const folders = this.deps.repos.folders
      .list()
      .filter(folder =>
        folder.provider === 'local' &&
        folder.role === 'library' &&
        isInside(resolve(folder.path), resolve(destinationPath)),
      )
      .sort((a, b) => b.path.length - a.path.length)
    const folder = folders[0]
    if (!folder) throw new Error('La ruta destino no pertenece a ninguna biblioteca.')
    return folder
  }

  private recordMoveInDb(move: TrackAlbumMoveRecordInput): void {
    this.deps.db.prepare(`
      INSERT INTO track_album_moves (
        id, track_id, old_path, new_path, old_sync_key, old_device_relative_path,
        new_sync_key, new_device_relative_path, created_at
      ) VALUES (
        @id, @trackId, @oldPath, @newPath, @oldSyncKey, @oldDeviceRelativePath,
        @newSyncKey, @newDeviceRelativePath, @createdAt
      )
    `).run(move as unknown as Record<string, unknown>)
  }

  private requireTrack(trackId: number): DbTrack {
    const track = this.deps.repos.tracks.getById(trackId)
    if (!track) throw new Error('El tema ya no existe en la biblioteca.')
    return track
  }

  private requireAlbum(albumId: number): DbAlbum {
    const album = this.deps.repos.albums.getById(albumId)
    if (!album) throw new Error('El álbum destino ya no existe.')
    return album
  }

  private pruneExpiredPreviews(): void {
    const now = Date.now()
    for (const [id, stored] of this.previews.entries()) {
      if (now - stored.preview.createdAt > PREVIEW_TTL_MS) this.previews.delete(id)
    }
    for (const [id, loaded] of this.releases.entries()) {
      if (now - loaded.fetchedAt > PREVIEW_TTL_MS) this.releases.delete(id)
    }
  }
}

function bestNumber(tracks: DbTrack[], read: (track: DbTrack) => number | null | undefined): number | null {
  const counts = new Map<number, number>()
  for (const track of tracks) {
    const value = read(track)
    if (!Number.isInteger(value) || (value as number) <= 0) continue
    counts.set(value as number, (counts.get(value as number) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null
}

function positiveTrackNumber(value: number | null | undefined): number | null {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : null
}

function normalizedDiscNumber(value: number | null | undefined): number {
  return positiveTrackNumber(value) ?? 1
}

function officialTitlesForDisc(tracklist: MusicBrainzReleaseTrack[], discNumber: number): Map<number, string> {
  const titles = new Map<number, string>()
  for (const entry of tracklist) {
    if (entry.discNumber === discNumber && !titles.has(entry.trackNumber)) titles.set(entry.trackNumber, entry.title)
  }
  return titles
}

function normalizeManualAlbum(input: TrackAlbumMoveManualAlbum): TrackAlbumMoveManualAlbum {
  const title = text(input?.title)
  const albumArtist = text(input?.albumArtist)
  const year = text(input?.year)
  if (!title) throw new Error('Indicá el nombre del álbum.')
  if (!albumArtist) throw new Error('Indicá el artista del álbum.')
  if (year && !/^\d{4}$/.test(year)) throw new Error('El año tiene que tener 4 dígitos.')
  return {
    title,
    albumArtist,
    year: year || null,
    totalTracks: positiveTrackNumber(input?.totalTracks),
    discNumber: positiveTrackNumber(input?.discNumber),
    totalDiscs: positiveTrackNumber(input?.totalDiscs),
  }
}

function buildAlbumMoveSlots(
  occupants: Map<number, DbTrack>,
  totalTracks: number | null,
  selected: number,
  officialTitles: Map<number, string> = new Map(),
): TrackAlbumMoveSlot[] {
  const max = Math.max(
    positiveTrackNumber(totalTracks) ?? 0,
    occupants.size > 0 ? Math.max(...occupants.keys()) : 0,
    positiveTrackNumber(selected) ?? 1,
  )
  const slots: TrackAlbumMoveSlot[] = []
  for (let number = 1; number <= max; number++) {
    const occupant = occupants.get(number)
    slots.push({
      trackNumber: number,
      occupiedBy: occupant
        ? { trackId: occupant.id, title: occupant.title, quality: summarizeTrackQuality(occupant) }
        : null,
      officialTitle: officialTitles.get(number) ?? null,
    })
  }
  return slots
}

let instance: TrackAlbumMoveService | null = null

export function getTrackAlbumMoveService(): TrackAlbumMoveService {
  if (!instance) instance = new TrackAlbumMoveService()
  return instance
}
