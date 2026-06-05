import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, extname } from 'node:path'
import { parseFile } from 'music-metadata'
import type { IAudioMetadata } from 'music-metadata'
import { getRepos, type Repos } from '../db/repositories'
import { parseArtistName } from './ArtistNameParser'
import { readTrackMetadata, type TrackMetadata } from './MetadataExtractor'
import { artworkAbsolutePath } from './ArtworkCache'
import { writeTrackMetadata, type MetadataArtworkPayload } from './MetadataWriter'
import { getLibraryBackup } from '../services/LibraryBackup'
import { getMusicBrainzMetadataClient } from './MusicBrainzMetadata'
import type { DbTrack } from '@shared/types/db'
import type {
  MetadataCompletionApplyRequest,
  MetadataCompletionApplyResult,
  MetadataCompletionApplyTrackResult,
  MetadataCompletionCandidate,
  MetadataCompletionField,
  MetadataCompletionFieldDiff,
  MetadataCompletionPreview,
  MetadataCompletionSource,
  MetadataCompletionTarget,
  MetadataCompletionTargetsPayload,
  TrackMetadataUpdatePayload,
} from '@shared/types/ipc-contract'
import {
  displayMetadataValue,
  inferFromFilename,
  isMissingNumber,
  isMissingText,
  isPlaceholderMetadata,
  normalizeMetadataText,
  scoreMetadataCandidate,
  uniqueFields,
} from './MetadataCompletionRules'

const PREVIEW_TTL_MS = 30 * 60 * 1000
const MB_BASE = 'https://musicbrainz.org/ws/2'
const CAA_BASE = 'https://coverartarchive.org'
const REQUEST_TIMEOUT_MS = 6000
const ONLINE_PREVIEW_BUDGET_MS = 9000
const MAX_ONLINE_TRACKS_PER_PREVIEW = 4
const MB_SPACING_MS = 1100
const MAX_ARTWORK_BYTES = 8 * 1024 * 1024
const AUTO_ACCEPT = 0.78
const REVIEW_ACCEPT = 0.58

type TextMetadataField = Exclude<MetadataCompletionField, 'artwork'>

interface EmbeddedSnapshot {
  title: string | null
  artist: string | null
  album: string | null
  albumArtist: string | null
  composer: string | null
  genre: string | null
  year: string | null
  trackNumber: number | null
  totalTracks: number | null
  discNumber: number | null
  totalDiscs: number | null
  duration: number | null
  artwork: MetadataArtworkPayload | null
}

interface Proposal {
  field: TextMetadataField
  value: string | number | null
  source: MetadataCompletionSource
  confidence: number
}

interface ArtworkProposal {
  data: Buffer
  mimeType: string
  source: MetadataCompletionSource
  confidence: number
}

interface StoredCandidate extends MetadataCompletionCandidate {
  proposalValues: Partial<Record<TextMetadataField, string | number | null>>
  artworkPayload: MetadataArtworkPayload | null
}

interface StoredPreview {
  previewId: string
  createdAt: number
  candidates: StoredCandidate[]
}

interface MusicBrainzResult {
  title: string | null
  artist: string | null
  album: string | null
  albumArtist: string | null
  genre: string | null
  year: string | null
  trackNumber: number | null
  totalTracks: number | null
  discNumber: number | null
  totalDiscs: number | null
  releaseId: string | null
  releaseGroupId: string | null
  confidence: number
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function asString(value: unknown): string | null {
  if (value == null) return null
  const text = String(value).trim()
  return text || null
}

function asNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

function joinCredit(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  const text = value
    .map(item => {
      if (!item || typeof item !== 'object') return ''
      const row = item as Record<string, unknown>
      if (row['name'] != null) return String(row['name'])
      const artist = row['artist']
      if (artist && typeof artist === 'object') {
        return String((artist as Record<string, unknown>)['name'] ?? '')
      }
      return ''
    })
    .filter(Boolean)
    .join(', ')
    .trim()
  return text || null
}

function firstTagName(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  const sorted = [...value].sort((a, b) => {
    const ac = typeof a === 'object' && a ? Number((a as Record<string, unknown>)['count'] ?? 0) : 0
    const bc = typeof b === 'object' && b ? Number((b as Record<string, unknown>)['count'] ?? 0) : 0
    return bc - ac
  })
  for (const item of sorted) {
    if (!item || typeof item !== 'object') continue
    const name = asString((item as Record<string, unknown>)['name'])
    if (name) return name
  }
  return null
}

function pictureMimeFromPath(path: string): string {
  const ext = extname(path).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.webp') return 'image/webp'
  return 'image/jpeg'
}

function dataUrl(data: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${data.toString('base64')}`
}

function safeYear(value: string | null): string | null {
  if (!value) return null
  const match = /\d{4}/.exec(value)
  return match ? match[0] : null
}

function cleanQueryValue(value: string | null | undefined): string {
  return (value ?? '').replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim()
}

function makeDiff(
  field: TextMetadataField,
  current: string | number | null | undefined,
  proposal: Proposal,
): MetadataCompletionFieldDiff {
  return {
    field,
    current: displayMetadataValue(current),
    proposed: displayMetadataValue(proposal.value),
    source: proposal.source,
    confidence: proposal.confidence,
    selected: proposal.confidence >= AUTO_ACCEPT,
  }
}

function fieldValueFromSnapshot(snapshot: EmbeddedSnapshot, field: TextMetadataField): string | number | null {
  return snapshot[field]
}

function isMissingField(snapshot: EmbeddedSnapshot, field: MetadataCompletionField): boolean {
  if (field === 'artwork') return snapshot.artwork == null
  if (field === 'trackNumber' || field === 'totalTracks' || field === 'discNumber' || field === 'totalDiscs') {
    return isMissingNumber(snapshot[field])
  }
  return isMissingText(snapshot[field])
}

function missingFields(snapshot: EmbeddedSnapshot): MetadataCompletionField[] {
  const fields: MetadataCompletionField[] = []
  for (const field of [
    'title',
    'artist',
    'album',
    'albumArtist',
    'genre',
    'year',
    'trackNumber',
    'totalTracks',
    'discNumber',
    'totalDiscs',
    'artwork',
  ] as const) {
    if (isMissingField(snapshot, field)) fields.push(field)
  }
  return fields
}

function titleForTrack(track: DbTrack): string {
  return track.title || basename(track.path, extname(track.path))
}

function bestUnanimousString(tracks: DbTrack[], read: (track: DbTrack) => string | null | undefined): string | null {
  const counts = new Map<string, { value: string; count: number }>()
  for (const track of tracks) {
    const value = (read(track) ?? '').trim()
    if (isPlaceholderMetadata(value)) continue
    const key = normalizeMetadataText(value)
    const existing = counts.get(key)
    counts.set(key, { value, count: (existing?.count ?? 0) + 1 })
  }
  if (counts.size !== 1) return null
  return [...counts.values()][0].value
}

function bestUnanimousNumber(tracks: DbTrack[], read: (track: DbTrack) => number | null | undefined): number | null {
  const values = new Set<number>()
  for (const track of tracks) {
    const value = read(track)
    if (!isMissingNumber(value)) values.add(value as number)
  }
  if (values.size !== 1) return null
  return [...values][0]
}

function publicCandidate(candidate: StoredCandidate): MetadataCompletionCandidate {
  const { proposalValues: _proposalValues, artworkPayload: _artworkPayload, ...rest } = candidate
  return rest
}

export class MetadataCompletionService {
  private repos: Repos
  private previews = new Map<string, StoredPreview>()
  private lastMusicBrainzAt = 0

  constructor() {
    this.repos = getRepos()
  }

  async findTargets(folderId?: number | null, limit = 24): Promise<MetadataCompletionTargetsPayload> {
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 24
    const tracks = folderId != null
      ? this.repos.tracks.getByFolder(folderId)
      : this.repos.tracks.getAll({ limit: 10000 })
    const targets: MetadataCompletionTarget[] = []

    for (const track of tracks) {
      if (targets.length >= safeLimit) break
      try {
        const snapshot = await this.readEmbeddedSnapshot(track.path)
        const missing = missingFields(snapshot)
        if (missing.length === 0) continue
        targets.push({
          trackId: track.id,
          title: titleForTrack(track),
          artist: track.artist,
          album: track.album,
          path: track.path,
          missingFields: missing,
        })
      } catch {
        /* Ignore unreadable files in discovery; apply/preview will surface errors. */
      }
    }

    return {
      folderId: folderId ?? null,
      totalCandidates: targets.length,
      targets,
    }
  }

  async preview(trackIds: number[]): Promise<MetadataCompletionPreview> {
    this.pruneExpiredPreviews()
    const uniqueIds = [...new Set(trackIds.filter(id => Number.isInteger(id) && id > 0))]
    const candidates: StoredCandidate[] = []
    const onlineDeadline = Date.now() + ONLINE_PREVIEW_BUDGET_MS
    let onlineSlots = MAX_ONLINE_TRACKS_PER_PREVIEW

    for (const id of uniqueIds) {
      const track = this.repos.tracks.getById(id)
      if (!track) continue
      const allowOnline = onlineSlots > 0 && Date.now() < onlineDeadline
      const candidate = await this.buildCandidate(track, allowOnline)
      if (allowOnline) onlineSlots -= 1
      if (candidate && (candidate.fields.length > 0 || candidate.artwork)) {
        candidates.push(candidate)
      }
    }

    const previewId = randomUUID()
    const stored: StoredPreview = { previewId, createdAt: Date.now(), candidates }
    this.previews.set(previewId, stored)
    return {
      previewId,
      createdAt: stored.createdAt,
      candidates: candidates.map(publicCandidate),
    }
  }

  async apply(request: MetadataCompletionApplyRequest): Promise<MetadataCompletionApplyResult> {
    const preview = this.previews.get(request.previewId)
    if (!preview) throw new Error('Metadata preview expired. Run the search again.')

    const selections = new Map<number, Set<MetadataCompletionField>>()
    for (const selection of request.selections ?? []) {
      if (!Number.isInteger(selection.trackId) || selection.trackId <= 0) continue
      selections.set(selection.trackId, new Set(uniqueFields(selection.fields)))
    }

    const results: MetadataCompletionApplyTrackResult[] = []
    for (const candidate of preview.candidates) {
      const selected = selections.get(candidate.trackId)
      if (!selected || selected.size === 0) continue
      results.push(await this.applyCandidate(candidate, selected))
    }

    this.previews.delete(request.previewId)
    return {
      applied: results.filter(result => result.ok).length,
      failed: results.filter(result => !result.ok).length,
      results,
    }
  }

  private async buildCandidate(track: DbTrack, allowOnline: boolean): Promise<StoredCandidate | null> {
    const warnings: string[] = []
    let snapshot: EmbeddedSnapshot
    try {
      snapshot = await this.readEmbeddedSnapshot(track.path)
    } catch (err) {
      return {
        trackId: track.id,
        title: titleForTrack(track),
        artist: track.artist,
        album: track.album,
        path: track.path,
        confidence: 0,
        fields: [],
        artwork: null,
        warnings: [`No se pudo leer el archivo: ${err instanceof Error ? err.message : String(err)}`],
        proposalValues: {},
        artworkPayload: null,
      }
    }

    const missing = new Set(missingFields(snapshot))
    const proposals = new Map<TextMetadataField, Proposal>()
    let artwork: ArtworkProposal | null = null

    this.addFilenameProposals(track, snapshot, missing, proposals)
    this.addFolderProposals(track, snapshot, missing, proposals, warnings)

    if (missing.has('artwork')) {
      artwork = this.artworkFromFolder(track)
    }

    let online: { proposals: Proposal[]; artwork: ArtworkProposal | null; lowConfidence: boolean } = {
      proposals: [],
      artwork: null,
      lowConfidence: false,
    }
    const unresolved = this.needsOnlineFallback(missing, proposals, artwork)
    if (unresolved && allowOnline) {
      online = await this.onlineProposals(track, snapshot, missing, proposals, warnings)
      for (const proposal of online.proposals) {
        if (!proposals.has(proposal.field)) proposals.set(proposal.field, proposal)
      }
      if (!artwork && online.artwork) artwork = online.artwork
    } else if (unresolved) {
      warnings.push('La búsqueda online se omitió en este lote para evitar demoras; probá con menos pistas si faltan más datos.')
    }

    const fields = [...proposals.values()]
      .filter(proposal => proposal.value != null && displayMetadataValue(proposal.value) != null)
      .map(proposal => makeDiff(proposal.field, fieldValueFromSnapshot(snapshot, proposal.field), proposal))

    if (online.lowConfidence) {
      for (const field of fields) {
        if (field.source === 'musicbrainz' && field.confidence < AUTO_ACCEPT) field.selected = false
      }
    }

    const selectedScores = [
      ...fields.map(field => field.confidence),
      ...(artwork ? [artwork.confidence] : []),
    ]
    const confidence = selectedScores.length > 0
      ? selectedScores.reduce((sum, score) => sum + score, 0) / selectedScores.length
      : 0

    const proposalValues: StoredCandidate['proposalValues'] = {}
    for (const proposal of proposals.values()) proposalValues[proposal.field] = proposal.value

    return {
      trackId: track.id,
      title: titleForTrack(track),
      artist: track.artist,
      album: track.album,
      path: track.path,
      confidence,
      fields,
      artwork: artwork
        ? {
            currentArtworkPath: track.artwork_path,
            proposedDataUrl: dataUrl(artwork.data, artwork.mimeType),
            mimeType: artwork.mimeType,
            source: artwork.source,
            confidence: artwork.confidence,
            selected: artwork.confidence >= AUTO_ACCEPT,
          }
        : null,
      warnings,
      proposalValues,
      artworkPayload: artwork ? { data: artwork.data, mimeType: artwork.mimeType } : null,
    }
  }

  private addFilenameProposals(
    track: DbTrack,
    snapshot: EmbeddedSnapshot,
    missing: Set<MetadataCompletionField>,
    proposals: Map<TextMetadataField, Proposal>,
  ): void {
    const inferred = inferFromFilename(track.path)
    if (missing.has('title') && inferred.title) {
      proposals.set('title', { field: 'title', value: inferred.title, source: 'filename', confidence: 0.72 })
    }
    if (missing.has('trackNumber') && inferred.trackNumber) {
      proposals.set('trackNumber', { field: 'trackNumber', value: inferred.trackNumber, source: 'filename', confidence: 0.82 })
    }
    if (missing.has('discNumber') && inferred.discNumber) {
      proposals.set('discNumber', { field: 'discNumber', value: inferred.discNumber, source: 'filename', confidence: 0.78 })
    }

    if (missing.has('totalTracks') && snapshot.trackNumber && track.total_tracks) {
      proposals.set('totalTracks', { field: 'totalTracks', value: track.total_tracks, source: 'folder', confidence: 0.76 })
    }
  }

  private addFolderProposals(
    track: DbTrack,
    snapshot: EmbeddedSnapshot,
    missing: Set<MetadataCompletionField>,
    proposals: Map<TextMetadataField, Proposal>,
    warnings: string[],
  ): void {
    const sameDirectory = this.sameDirectoryTracks(track)
    if (sameDirectory.length === 0) return

    const stringFields: Array<[TextMetadataField, (row: DbTrack) => string | null | undefined]> = [
      ['artist', row => row.artist],
      ['album', row => row.album],
      ['albumArtist', row => row.album_artist],
      ['composer', row => row.composer],
      ['genre', row => row.genre],
      ['year', row => row.year],
    ]

    for (const [field, read] of stringFields) {
      if (!missing.has(field) || proposals.has(field)) continue
      const value = bestUnanimousString(sameDirectory, read)
      if (value) proposals.set(field, { field, value, source: 'folder', confidence: 0.88 })
    }

    const numberFields: Array<[TextMetadataField, (row: DbTrack) => number | null | undefined]> = [
      ['totalTracks', row => row.total_tracks],
      ['discNumber', row => row.disc_number],
      ['totalDiscs', row => row.total_discs],
    ]
    for (const [field, read] of numberFields) {
      if (!missing.has(field) || proposals.has(field)) continue
      const value = bestUnanimousNumber(sameDirectory, read)
      if (value) proposals.set(field, { field, value, source: 'folder', confidence: 0.86 })
    }

    if (missing.has('totalTracks') && !proposals.has('totalTracks')) {
      const maxTrack = Math.max(...sameDirectory.map(row => row.track_number ?? 0), track.track_number ?? 0)
      if (maxTrack > 1) {
        proposals.set('totalTracks', { field: 'totalTracks', value: maxTrack, source: 'folder', confidence: 0.74 })
      }
    }

    const albumNames = new Set(sameDirectory.map(row => normalizeMetadataText(row.album)).filter(Boolean))
    if (albumNames.size > 1) {
      warnings.push('La carpeta contiene más de un álbum detectado; se evitaron campos ambiguos.')
    }
    void snapshot
  }

  private artworkFromFolder(track: DbTrack): ArtworkProposal | null {
    const sameDirectory = this.sameDirectoryTracks(track)
    const sibling = sameDirectory.find(row => row.artwork_path && existsSync(artworkAbsolutePath(row.artwork_path)))
    if (!sibling?.artwork_path) return null
    const path = artworkAbsolutePath(sibling.artwork_path)
    try {
      return {
        data: readFileSync(path),
        mimeType: pictureMimeFromPath(path),
        source: 'folder',
        confidence: 0.88,
      }
    } catch {
      return null
    }
  }

  private needsOnlineFallback(
    missing: Set<MetadataCompletionField>,
    proposals: Map<TextMetadataField, Proposal>,
    artwork: ArtworkProposal | null,
  ): boolean {
    for (const field of missing) {
      if (field === 'artwork') {
        if (!artwork) return true
        continue
      }
      if (!proposals.has(field)) return true
    }
    return false
  }

  private async onlineProposals(
    track: DbTrack,
    snapshot: EmbeddedSnapshot,
    missing: Set<MetadataCompletionField>,
    proposals: Map<TextMetadataField, Proposal>,
    warnings: string[],
  ): Promise<{ proposals: Proposal[]; artwork: ArtworkProposal | null; lowConfidence: boolean }> {
    const queryTitle = displayMetadataValue(proposals.get('title')?.value) ?? snapshot.title ?? track.title
    const queryArtist = displayMetadataValue(proposals.get('artist')?.value) ?? snapshot.artist ?? track.artist
    const queryAlbum = displayMetadataValue(proposals.get('album')?.value) ?? snapshot.album ?? track.album

    if (isMissingText(queryTitle) || isMissingText(queryArtist)) {
      return { proposals: [], artwork: null, lowConfidence: false }
    }

    try {
      const result = await getMusicBrainzMetadataClient().lookupRecordingOnAlbum({
        title: queryTitle,
        artist: queryArtist,
        album: isMissingText(queryAlbum) ? null : queryAlbum,
        durationSeconds: snapshot.duration ?? track.duration,
      })
      if (!result || result.confidence < REVIEW_ACCEPT) {
        return { proposals: [], artwork: null, lowConfidence: false }
      }

      const sourceConfidence = result.confidence
      const out: Proposal[] = []
      const add = (field: TextMetadataField, value: string | number | null) => {
        if (!missing.has(field) || proposals.has(field) || value == null || displayMetadataValue(value) == null) return
        out.push({ field, value, source: 'musicbrainz', confidence: sourceConfidence })
      }

      add('title', result.title)
      add('artist', result.artist)
      add('album', result.album)
      add('albumArtist', result.albumArtist)
      add('genre', result.genre)
      add('year', result.year)
      add('trackNumber', result.trackNumber)
      add('totalTracks', result.totalTracks)
      add('discNumber', result.discNumber)
      add('totalDiscs', result.totalDiscs)

      const artwork = missing.has('artwork')
        ? await this.fetchCoverArt(result.releaseId, result.releaseGroupId, sourceConfidence)
        : null
      if (sourceConfidence < AUTO_ACCEPT) warnings.push('MusicBrainz encontró una coincidencia de baja confianza; revisá los campos antes de aplicar.')

      return { proposals: out, artwork, lowConfidence: sourceConfidence < AUTO_ACCEPT }
    } catch (err) {
      warnings.push(`Búsqueda online no disponible: ${err instanceof Error ? err.message : String(err)}`)
      return { proposals: [], artwork: null, lowConfidence: false }
    }
  }

  private async applyCandidate(
    candidate: StoredCandidate,
    selected: Set<MetadataCompletionField>,
  ): Promise<MetadataCompletionApplyTrackResult> {
    const track = this.repos.tracks.getById(candidate.trackId)
    const base = {
      trackId: candidate.trackId,
      title: candidate.title,
      path: candidate.path,
      appliedFields: [] as MetadataCompletionField[],
      backupPath: null as string | null,
    }
    if (!track) return { ...base, ok: false, error: 'Track no longer exists.' }

    const payload: TrackMetadataUpdatePayload = {}
    const appliedFields: MetadataCompletionField[] = []
    const assign = <K extends keyof TrackMetadataUpdatePayload>(field: MetadataCompletionField, key: K) => {
      if (!selected.has(field)) return
      const value = candidate.proposalValues[field as TextMetadataField]
      if (value == null) return
      ;(payload[key] as string | number | null | undefined) = value as never
      appliedFields.push(field)
    }

    assign('title', 'title')
    assign('artist', 'artist')
    assign('album', 'album')
    assign('albumArtist', 'albumArtist')
    assign('composer', 'composer')
    assign('genre', 'genre')
    assign('year', 'year')
    assign('trackNumber', 'trackNumber')
    assign('totalTracks', 'totalTracks')
    assign('discNumber', 'discNumber')
    assign('totalDiscs', 'totalDiscs')

    const artwork = selected.has('artwork') ? candidate.artworkPayload : null
    if (artwork) appliedFields.push('artwork')
    if (appliedFields.length === 0) return { ...base, ok: true, error: null }

    try {
      const result = writeTrackMetadata(track.path, payload, { artwork, createBackup: true })
      await this.refreshTrackMetadataInDb(track.id)
      return {
        ...base,
        ok: true,
        appliedFields,
        backupPath: result.backupPath,
        error: null,
      }
    } catch (err) {
      return {
        ...base,
        ok: false,
        appliedFields,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  private async readEmbeddedSnapshot(path: string): Promise<EmbeddedSnapshot> {
    const metadata = await parseFile(path, {
      skipCovers: false,
      skipPostHeaders: false,
      includeChapters: false,
    })
    return this.snapshotFromMetadata(metadata)
  }

  private snapshotFromMetadata(metadata: IAudioMetadata): EmbeddedSnapshot {
    const common = metadata.common
    const picture = common.picture?.[0]
    return {
      title: asString(common.title),
      artist: asString(common.artist) ?? (Array.isArray(common.artists) ? common.artists.filter(Boolean).join(', ') : null),
      album: asString(common.album),
      albumArtist: asString(common.albumartist),
      composer: Array.isArray(common.composer) ? common.composer.filter(Boolean).join('; ') : asString(common.composer),
      genre: Array.isArray(common.genre) ? common.genre.filter(Boolean).join('; ') : asString(common.genre),
      year: common.year != null ? String(common.year) : safeYear(asString(common.date)),
      trackNumber: common.track?.no ?? null,
      totalTracks: common.track?.of ?? null,
      discNumber: common.disk?.no ?? null,
      totalDiscs: common.disk?.of ?? null,
      duration: metadata.format.duration ?? null,
      artwork: picture ? { data: Buffer.from(picture.data), mimeType: picture.format || 'image/jpeg' } : null,
    }
  }

  private sameDirectoryTracks(track: DbTrack): DbTrack[] {
    const dir = dirname(track.path)
    return this.repos.tracks
      .getByFolder(track.folder_id)
      .filter(candidate => candidate.id !== track.id && dirname(candidate.path) === dir)
  }

  private async fetchMusicBrainz(query: {
    title: string
    artist: string
    album: string | null
    durationSeconds: number | null
  }): Promise<MusicBrainzResult | null> {
    const result = await this.searchMusicBrainzRecording(query)
    if (!result) return null
    if (result.releaseId) {
      const enriched = await this.lookupMusicBrainzRelease(result, query)
      if (enriched) return enriched
    }
    return result
  }

  private async searchMusicBrainzRecording(query: {
    title: string
    artist: string
    album: string | null
    durationSeconds: number | null
  }): Promise<MusicBrainzResult | null> {
    const lucene = `recording:"${cleanQueryValue(query.title)}" AND artist:"${cleanQueryValue(query.artist)}"`
    const params = new URLSearchParams({
      fmt: 'json',
      limit: '5',
      query: lucene,
    })
    let json = await this.fetchMusicBrainzJson(`${MB_BASE}/recording?${params.toString()}`)
    let recordings = Array.isArray((json as Record<string, unknown>)['recordings'])
      ? (json as Record<string, unknown>)['recordings'] as unknown[]
      : []

    if (recordings.length === 0) {
      const fallback = new URLSearchParams({
        fmt: 'json',
        limit: '5',
        query: `${cleanQueryValue(query.title)} ${cleanQueryValue(query.artist)}`,
      })
      json = await this.fetchMusicBrainzJson(`${MB_BASE}/recording?${fallback.toString()}`)
      recordings = Array.isArray((json as Record<string, unknown>)['recordings'])
        ? (json as Record<string, unknown>)['recordings'] as unknown[]
        : []
    }

    const ranked = recordings
      .map(recording => this.mapRecording(recording, query))
      .filter((item): item is MusicBrainzResult => item != null)
      .sort((a, b) => b.confidence - a.confidence)

    return ranked[0] ?? null
  }

  private mapRecording(recording: unknown, query: {
    title: string
    artist: string
    album: string | null
    durationSeconds: number | null
  }): MusicBrainzResult | null {
    if (!recording || typeof recording !== 'object') return null
    const row = recording as Record<string, unknown>
    const title = asString(row['title'])
    const artist = joinCredit(row['artist-credit'])
    if (!title || !artist) return null
    const releases = Array.isArray(row['releases']) ? row['releases'] as Record<string, unknown>[] : []
    const release = this.pickRelease(releases, query.album)
    const album = asString(release?.['title']) ?? query.album
    const releaseDate = safeYear(asString(release?.['date']) ?? asString(row['first-release-date']))
    const releaseGroup = release?.['release-group'] && typeof release['release-group'] === 'object'
      ? release['release-group'] as Record<string, unknown>
      : null
    const confidence = scoreMetadataCandidate({
      title: query.title,
      artist: query.artist,
      album: query.album,
      durationSeconds: query.durationSeconds,
      candidateTitle: title,
      candidateArtist: artist,
      candidateAlbum: album,
      candidateDurationSeconds: typeof row['length'] === 'number' ? row['length'] / 1000 : null,
    })

    return {
      title,
      artist,
      album,
      albumArtist: joinCredit(release?.['artist-credit']) ?? artist,
      genre: firstTagName(row['tags']),
      year: releaseDate,
      trackNumber: null,
      totalTracks: null,
      discNumber: null,
      totalDiscs: null,
      releaseId: asString(release?.['id']),
      releaseGroupId: asString(releaseGroup?.['id']),
      confidence,
    }
  }

  private pickRelease(releases: Record<string, unknown>[], album: string | null): Record<string, unknown> | null {
    if (releases.length === 0) return null
    if (album) {
      const target = normalizeMetadataText(album)
      const exact = releases.find(release => normalizeMetadataText(asString(release['title']) ?? '') === target)
      if (exact) return exact
    }
    return releases.find(release => asString(release['status']) === 'Official') ?? releases[0]
  }

  private async lookupMusicBrainzRelease(
    base: MusicBrainzResult,
    query: { title: string; artist: string; album: string | null; durationSeconds: number | null },
  ): Promise<MusicBrainzResult | null> {
    if (!base.releaseId) return base
    const params = new URLSearchParams({
      fmt: 'json',
      inc: 'recordings+artist-credits+release-groups+genres+tags',
    })
    const json = await this.fetchMusicBrainzJson(`${MB_BASE}/release/${encodeURIComponent(base.releaseId)}?${params.toString()}`)
    if (!json || typeof json !== 'object') return base
    const row = json as Record<string, unknown>
    const media = Array.isArray(row['media']) ? row['media'] as Record<string, unknown>[] : []
    let trackNumber: number | null = null
    let totalTracks: number | null = null
    let discNumber: number | null = null
    const totalDiscs = media.length > 0 ? media.length : null

    for (const medium of media) {
      const tracks = Array.isArray(medium['tracks']) ? medium['tracks'] as Record<string, unknown>[] : []
      const match = tracks.find(track => {
        const rec = track['recording'] && typeof track['recording'] === 'object'
          ? track['recording'] as Record<string, unknown>
          : null
        return normalizeMetadataText(asString(rec?.['title']) ?? asString(track['title']) ?? '') === normalizeMetadataText(query.title)
      })
      if (match) {
        trackNumber = asNumber(match['position'] ?? match['number'])
        totalTracks = asNumber(medium['track-count']) ?? tracks.length
        discNumber = asNumber(medium['position'])
        break
      }
    }

    const releaseGroup = row['release-group'] && typeof row['release-group'] === 'object'
      ? row['release-group'] as Record<string, unknown>
      : null
    return {
      ...base,
      album: asString(row['title']) ?? base.album,
      albumArtist: joinCredit(row['artist-credit']) ?? base.albumArtist,
      genre: firstTagName(row['genres']) ?? firstTagName(row['tags']) ?? base.genre,
      year: safeYear(asString(row['date'])) ?? base.year,
      trackNumber: trackNumber ?? base.trackNumber,
      totalTracks: totalTracks ?? base.totalTracks,
      discNumber: discNumber ?? base.discNumber,
      totalDiscs: totalDiscs ?? base.totalDiscs,
      releaseGroupId: asString(releaseGroup?.['id']) ?? base.releaseGroupId,
    }
  }

  private async fetchCoverArt(
    releaseId: string | null,
    releaseGroupId: string | null,
    confidence: number,
  ): Promise<ArtworkProposal | null> {
    const urls = [
      releaseId ? `${CAA_BASE}/release/${encodeURIComponent(releaseId)}` : null,
      releaseGroupId ? `${CAA_BASE}/release-group/${encodeURIComponent(releaseGroupId)}` : null,
    ].filter((url): url is string => url != null)

    for (const url of urls) {
      try {
        const json = await this.fetchJson(url, false)
        const artUrl = this.coverUrlFromArchive(json)
        if (!artUrl) continue
        const art = await this.fetchArtworkBytes(artUrl)
        if (art) return { ...art, source: 'cover-art-archive', confidence: Math.max(confidence, 0.8) }
      } catch {
        /* Try the next cover source. */
      }
    }
    return null
  }

  private coverUrlFromArchive(json: unknown): string | null {
    if (!json || typeof json !== 'object') return null
    const images = Array.isArray((json as Record<string, unknown>)['images'])
      ? (json as Record<string, unknown>)['images'] as Record<string, unknown>[]
      : []
    const image = images.find(item => item['front'] === true)
      ?? images.find(item => item['approved'] === true)
      ?? images[0]
    if (!image) return null
    const thumbnails = image['thumbnails'] && typeof image['thumbnails'] === 'object'
      ? image['thumbnails'] as Record<string, unknown>
      : {}
    return asString(thumbnails['1200'])
      ?? asString(thumbnails['500'])
      ?? asString(image['image'])
  }

  private async fetchArtworkBytes(url: string): Promise<Omit<ArtworkProposal, 'source' | 'confidence'> | null> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': this.userAgent(), Accept: 'image/jpeg,image/png,image/webp' },
        signal: ctrl.signal,
      })
      if (!response.ok) return null
      const mimeType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
      if (!['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(mimeType)) return null
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARTWORK_BYTES) return null
      return { data: bytes, mimeType: mimeType === 'image/jpg' ? 'image/jpeg' : mimeType }
    } finally {
      clearTimeout(timer)
    }
  }

  private async fetchMusicBrainzJson(url: string): Promise<unknown> {
    return this.fetchJson(url, true)
  }

  private async fetchJson(url: string, rateLimitMusicBrainz: boolean): Promise<unknown> {
    if (rateLimitMusicBrainz) {
      const since = Date.now() - this.lastMusicBrainzAt
      if (since < MB_SPACING_MS) await delay(MB_SPACING_MS - since)
      this.lastMusicBrainzAt = Date.now()
    }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': this.userAgent(), Accept: 'application/json' },
        signal: ctrl.signal,
      })
      if (response.status === 404) return null
      if (response.status === 503) throw new Error('MusicBrainz rate limit reached')
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    } finally {
      clearTimeout(timer)
    }
  }

  private async refreshTrackMetadataInDb(trackId: number): Promise<DbTrack | null> {
    const track = this.repos.tracks.getById(trackId)
    if (!track) return null
    const md = await readTrackMetadata(track.path)
    this.updateDbFromMetadata(track, md)
    getLibraryBackup().scheduleWriteForTrack(track.id)
    return this.repos.tracks.getById(track.id) ?? track
  }

  private updateDbFromMetadata(track: DbTrack, md: TrackMetadata): void {
    const parsedArtist = parseArtistName(md.artist)
    const artist = this.repos.artists.getOrCreate(parsedArtist.primary || md.artist)
    const album = this.repos.albums.getOrCreate(md.album, md.albumArtist ?? null, md.year || null)
    const genre = md.genre ? this.repos.genres.getOrCreate(md.genre) : null

    this.repos.tracks.updateMetadata({
      id: track.id,
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
      artworkPath: md.artwork?.filename ?? track.artwork_path,
      filename: basename(track.path),
      artistId: artist.id,
      albumId: album.id,
      genreId: genre?.id ?? null,
    })
  }

  private pruneExpiredPreviews(): void {
    const now = Date.now()
    for (const [id, preview] of this.previews.entries()) {
      if (now - preview.createdAt > PREVIEW_TTL_MS) this.previews.delete(id)
    }
  }

  private userAgent(): string {
    let version = '0.0.0'
    try { version = app.getVersion() } catch { /* app may be unavailable in tests */ }
    return `Crate/${version} (https://github.com/LaMarCab76/LocalLibrary)`
  }
}

let instance: MetadataCompletionService | null = null

export function getMetadataCompletionService(): MetadataCompletionService {
  if (!instance) instance = new MetadataCompletionService()
  return instance
}
