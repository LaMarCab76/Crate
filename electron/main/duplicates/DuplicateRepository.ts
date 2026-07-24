import { randomUUID } from 'node:crypto'
import type { Database as BetterSqliteDatabase, Statement } from 'better-sqlite3'
import type {
  DuplicateCandidateDetail,
  DuplicateCandidateStatus,
  DuplicateCandidateSummary,
  DuplicateEvidence,
  DuplicateKeepBothReason,
  DuplicateListRequest,
  DuplicateSegment,
  DuplicateSummary,
  DuplicateTrackView,
} from '@shared/types/duplicates'
import type { LibraryProvider, LibraryRole } from '@shared/types/library-locations'
import type { DuplicatePrefilterPair } from './candidatePrefilter.ts'
import type { DuplicateClassification } from './classification.ts'
import type { DuplicateTrackFacts } from './domain.ts'
import {
  decodeFingerprintFrames,
  encodeFingerprintFrames,
  fingerprintDigest,
  type AudioFingerprint,
  type FingerprintComparison,
  type FingerprintSource,
} from './fingerprint.ts'
import type { DuplicateRecommendation } from './recommendation.ts'

interface TrackFactsRow {
  id: number
  folder_id: number
  provider: LibraryProvider
  library_role: LibraryRole
  library_name: string
  path: string
  filename: string
  title: string
  artist: string
  primary_artist: string | null
  album: string
  album_artist: string | null
  year: string
  duration: number
  track_number: number | null
  disc_number: number | null
  format: string
  codec: string | null
  bitrate: number | null
  sample_rate: number | null
  bit_depth: number | null
  channels: number | null
  file_size: number | null
  date_modified: string | null
  artwork_path: string | null
  date_added: string
  compilation: number
  album_compilation: number | null
  release_type: string | null
  media_type: string | null
  musicbrainz_release_id: string | null
  musicbrainz_release_group_id: string | null
  extended_metadata: string | null
  drive_id: string | null
  item_id: string | null
  etag: string | null
}

interface AnalysisRow {
  track_id: number
  source_provider: LibraryProvider
  source_locator: string
  source_file_size: number | null
  source_modified: string | null
  source_etag: string | null
  source_signature: string
  algorithm: string
  algorithm_version: string
  status: 'pending' | 'running' | 'ready' | 'error'
  fingerprint_blob: Buffer | null
  fingerprint_digest: string | null
  frame_count: number
  frames_per_second: number
  delay_seconds: number
  duration_seconds: number
  error: string | null
  created_at: string
  updated_at: string
}

interface CandidateRow {
  id: string
  track_low_id: number
  track_high_id: number
  revision: number
  status: DuplicateCandidateStatus
  similarity: number
  alignment_offset_frames: number
  matching_frames: number
  compared_frames: number
  segments_json: string
  acoustic_relation: DuplicateCandidateDetail['acousticRelation']
  editorial_relation: DuplicateCandidateDetail['editorialRelation']
  evidence_json: string
  recommendation_reasons_json: string
  recommended_track_id: number | null
  low_fingerprint_digest: string
  high_fingerprint_digest: string
  prefilter_json: string
  created_at: string
  updated_at: string
}

interface IdentityRow {
  id: string
  track_id: number
  acoustic_digest: string
  algorithm: string
  algorithm_version: string
  created_at: string
  updated_at: string
}

export interface DuplicateIdentity {
  id: string
  trackId: number
  acousticDigest: string
  algorithm: string
  algorithmVersion: string
  createdAt: string
  updatedAt: string
}

export interface DuplicateAnalysisRecord {
  trackId: number
  sourceSignature: string
  status: AnalysisRow['status']
  fingerprint: AudioFingerprint | null
  fingerprintDigest: string | null
  error: string | null
  updatedAt: string
}

export interface SaveDuplicateCandidateInput {
  pair: DuplicatePrefilterPair<DuplicateTrackFacts>
  comparison: FingerprintComparison
  classification: DuplicateClassification
  recommendation: DuplicateRecommendation
  lowFingerprintDigest: string
  highFingerprintDigest: string
  status?: DuplicateCandidateStatus
}

export interface DuplicatePairDecisionInput {
  lowIdentity: DuplicateIdentity
  highIdentity: DuplicateIdentity
  reason: DuplicateKeepBothReason
  source?: 'database' | 'portable'
  createdAt?: string
}

export interface DuplicateResolutionRunInput {
  id?: string
  candidateId: string
  action: 'keep_both' | 'trash_left' | 'trash_right'
  keptTrackId: number | null
  removedTrackId: number | null
  expectedRevision: number
  sourceSnapshot: unknown
  deviceIntents?: unknown[]
}

export interface DuplicateResolutionRunRow {
  id: string
  candidate_id: string
  action: 'keep_both' | 'trash_left' | 'trash_right'
  kept_track_id: number | null
  removed_track_id: number | null
  expected_revision: number
  source_snapshot_json: string
  device_intents_json: string
  storage_receipt_json: string | null
  state: 'planned' | 'storage_done' | 'committed' | 'failed'
  error: string | null
  created_at: string
  updated_at: string
  storage_done_at: string | null
  committed_at: string | null
}

const TRACK_FACTS_SELECT = `
  SELECT
    t.id, t.folder_id, t.provider, f.role AS library_role, f.name AS library_name,
    t.path, t.filename, t.title, t.artist, ar.name AS primary_artist,
    t.album, t.album_artist, t.year,
    t.duration, t.track_number, t.disc_number, t.format, t.codec, t.bitrate,
    t.sample_rate, t.bit_depth, t.channels, t.file_size, t.date_modified,
    t.artwork_path, t.date_added, t.compilation, t.media_type,
    t.extended_metadata, t.drive_id, t.item_id, t.etag,
    a.is_compilation AS album_compilation, a.release_type,
    a.musicbrainz_album_id AS musicbrainz_release_id,
    a.musicbrainz_release_group_id
  FROM tracks t
  JOIN folders f ON f.id = t.folder_id
  LEFT JOIN albums a ON a.id = t.album_id
  LEFT JOIN artists ar ON ar.id = t.artist_id
`

function parseObject(value: string | null): Record<string, unknown> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function rowToTrackFacts(row: TrackFactsRow): DuplicateTrackFacts {
  const metadata = parseObject(row.extended_metadata)
  const taggedReleaseTypes = Array.isArray(metadata.releaseTypes)
    ? metadata.releaseTypes
      .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
      .map(value => value.trim())
    : []
  const musicBrainz = metadata.musicbrainz && typeof metadata.musicbrainz === 'object'
    ? metadata.musicbrainz as Record<string, unknown>
    : {}
  return {
    id: row.id,
    folderId: row.folder_id,
    provider: row.provider,
    libraryRole: row.library_role,
    libraryName: row.library_name,
    path: row.path,
    filename: row.filename,
    title: row.title,
    artist: row.artist,
    primaryArtist: row.primary_artist,
    album: row.album,
    albumArtist: row.album_artist,
    year: row.year,
    duration: row.duration,
    trackNumber: row.track_number,
    discNumber: row.disc_number,
    format: row.format,
    codec: row.codec,
    bitrate: row.bitrate,
    sampleRate: row.sample_rate,
    bitDepth: row.bit_depth,
    channels: row.channels,
    fileSize: row.file_size,
    dateModified: row.date_modified,
    artworkPath: row.artwork_path,
    dateAdded: row.date_added,
    compilation: row.compilation === 1,
    albumCompilation: row.album_compilation === 1,
    releaseType: taggedReleaseTypes.length > 0 ? taggedReleaseTypes.join(', ') : row.release_type,
    mediaType: row.media_type,
    musicBrainzRecordingId: firstString(metadata, [
      'musicbrainzRecordingId', 'musicbrainz_recording_id', 'musicbrainz_trackid',
    ]) ?? firstString(musicBrainz, ['recordingId', 'recording_id']),
    musicBrainzReleaseId: firstString(metadata, [
      'musicbrainzReleaseId', 'musicbrainzAlbumId',
      'musicbrainz_release_id', 'musicbrainz_albumid',
    ]) ?? firstString(musicBrainz, ['releaseId', 'release_id']) ?? row.musicbrainz_release_id,
    musicBrainzReleaseGroupId: firstString(metadata, [
      'musicbrainzReleaseGroupId', 'musicbrainz_release_group_id',
    ]) ?? firstString(musicBrainz, ['releaseGroupId', 'release_group_id'])
      ?? row.musicbrainz_release_group_id,
    driveId: row.drive_id,
    itemId: row.item_id,
    etag: row.etag,
  }
}

function trackView(track: DuplicateTrackFacts): DuplicateTrackView {
  return {
    id: track.id,
    folderId: track.folderId,
    provider: track.provider,
    title: track.title,
    artist: track.artist,
    album: track.album,
    albumArtist: track.albumArtist,
    year: track.year,
    duration: track.duration,
    trackNumber: track.trackNumber,
    discNumber: track.discNumber,
    format: track.format,
    codec: track.codec,
    bitrate: track.bitrate,
    sampleRate: track.sampleRate,
    bitDepth: track.bitDepth,
    channels: track.channels,
    fileSize: track.fileSize,
    libraryName: track.libraryName,
    path: track.path,
    artworkPath: track.artworkPath,
    releaseType: track.releaseType,
    isCompilation: track.compilation || track.albumCompilation,
    dateAdded: track.dateAdded,
  }
}

function jsonArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed as T[] : []
  } catch {
    return []
  }
}

function identity(row: IdentityRow): DuplicateIdentity {
  return {
    id: row.id,
    trackId: row.track_id,
    acousticDigest: row.acoustic_digest,
    algorithm: row.algorithm,
    algorithmVersion: row.algorithm_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class DuplicateRepository {
  private readonly db: BetterSqliteDatabase
  private readonly trackById: Statement
  private readonly eligibleTracks: Statement
  private readonly analysisById: Statement
  private readonly candidateById: Statement
  private readonly identityByTrack: Statement

  constructor(db: BetterSqliteDatabase) {
    this.db = db
    this.trackById = db.prepare(`${TRACK_FACTS_SELECT} WHERE t.id = ?`)
    this.eligibleTracks = db.prepare(`
      ${TRACK_FACTS_SELECT}
      WHERE f.role = 'library' AND t.provider IN ('local', 'onedrive')
      ORDER BY t.artist COLLATE NOCASE, t.duration, t.id
    `)
    this.analysisById = db.prepare(`SELECT * FROM duplicate_track_analyses WHERE track_id = ?`)
    this.candidateById = db.prepare(`SELECT * FROM duplicate_candidates WHERE id = ?`)
    this.identityByTrack = db.prepare(`SELECT * FROM duplicate_track_identities WHERE track_id = ?`)
  }

  listEligibleTracks(): DuplicateTrackFacts[] {
    return (this.eligibleTracks.all() as TrackFactsRow[]).map(rowToTrackFacts)
  }

  getTrackFacts(trackId: number): DuplicateTrackFacts | null {
    const row = this.trackById.get(trackId) as TrackFactsRow | undefined
    return row ? rowToTrackFacts(row) : null
  }

  getAnalysis(trackId: number): DuplicateAnalysisRecord | null {
    const row = this.analysisById.get(trackId) as AnalysisRow | undefined
    if (!row) return null
    let fingerprint: AudioFingerprint | null = null
    if (row.status === 'ready' && row.fingerprint_blob) {
      fingerprint = {
        algorithm: row.algorithm,
        algorithmVersion: row.algorithm_version,
        framesPerSecond: row.frames_per_second,
        delaySeconds: row.delay_seconds,
        durationSeconds: row.duration_seconds,
        frames: decodeFingerprintFrames(row.fingerprint_blob),
      }
    }
    return {
      trackId: row.track_id,
      sourceSignature: row.source_signature,
      status: row.status,
      fingerprint,
      fingerprintDigest: row.fingerprint_digest,
      error: row.error,
      updatedAt: row.updated_at,
    }
  }

  getReusableFingerprint(
    trackId: number,
    expectedSourceSignature: string,
    algorithm: string,
    algorithmVersion: string,
  ): DuplicateAnalysisRecord | null {
    const analysis = this.getAnalysis(trackId)
    if (
      !analysis
      || analysis.status !== 'ready'
      || !analysis.fingerprint
      || analysis.sourceSignature !== expectedSourceSignature
      || analysis.fingerprint.algorithm !== algorithm
      || analysis.fingerprint.algorithmVersion !== algorithmVersion
    ) return null
    return analysis
  }

  beginAnalysis(source: FingerprintSource, signature: string, provider: {
    algorithm: string
    algorithmVersion: string
  }): void {
    const now = new Date().toISOString()
    const upsert = this.db.prepare(`
      INSERT INTO duplicate_track_analyses (
        track_id, source_provider, source_locator, source_file_size, source_modified,
        source_etag, source_signature, algorithm, algorithm_version, status,
        created_at, updated_at
      ) VALUES (
        @trackId, @provider, @locator, @fileSize, @dateModified,
        @etag, @signature, @algorithm, @algorithmVersion, 'running',
        @now, @now
      )
      ON CONFLICT(track_id) DO UPDATE SET
        source_provider = excluded.source_provider,
        source_locator = excluded.source_locator,
        source_file_size = excluded.source_file_size,
        source_modified = excluded.source_modified,
        source_etag = excluded.source_etag,
        source_signature = excluded.source_signature,
        algorithm = excluded.algorithm,
        algorithm_version = excluded.algorithm_version,
        status = 'running',
        fingerprint_blob = NULL,
        fingerprint_digest = NULL,
        frame_count = 0,
        frames_per_second = 0,
        delay_seconds = 0,
        duration_seconds = 0,
        error = NULL,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `)
    const markStale = this.db.prepare(`
      UPDATE duplicate_candidates
      SET status = 'stale', revision = revision + 1, updated_at = ?
      WHERE status IN ('pending', 'dismissed') AND (track_low_id = ? OR track_high_id = ?)
    `)
    this.db.transaction(() => {
      upsert.run({
        ...source,
        signature,
        algorithm: provider.algorithm,
        algorithmVersion: provider.algorithmVersion,
        now,
      })
      markStale.run(now, source.trackId, source.trackId)
    })()
  }

  saveAnalysis(source: FingerprintSource, signature: string, fingerprint: AudioFingerprint): string {
    if (fingerprint.frames.length === 0) throw new Error('A duplicate fingerprint cannot be empty.')
    const digest = fingerprintDigest(fingerprint.frames)
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO duplicate_track_analyses (
        track_id, source_provider, source_locator, source_file_size, source_modified,
        source_etag, source_signature, algorithm, algorithm_version, status,
        fingerprint_blob, fingerprint_digest, frame_count, frames_per_second,
        delay_seconds, duration_seconds, error, created_at, updated_at
      ) VALUES (
        @trackId, @provider, @locator, @fileSize, @dateModified,
        @etag, @signature, @algorithm, @algorithmVersion, 'ready',
        @blob, @digest, @frameCount, @framesPerSecond,
        @delaySeconds, @durationSeconds, NULL, @now, @now
      )
      ON CONFLICT(track_id) DO UPDATE SET
        source_provider = excluded.source_provider,
        source_locator = excluded.source_locator,
        source_file_size = excluded.source_file_size,
        source_modified = excluded.source_modified,
        source_etag = excluded.source_etag,
        source_signature = excluded.source_signature,
        algorithm = excluded.algorithm,
        algorithm_version = excluded.algorithm_version,
        status = 'ready',
        fingerprint_blob = excluded.fingerprint_blob,
        fingerprint_digest = excluded.fingerprint_digest,
        frame_count = excluded.frame_count,
        frames_per_second = excluded.frames_per_second,
        delay_seconds = excluded.delay_seconds,
        duration_seconds = excluded.duration_seconds,
        error = NULL,
        updated_at = excluded.updated_at
    `).run({
      ...source,
      signature,
      algorithm: fingerprint.algorithm,
      algorithmVersion: fingerprint.algorithmVersion,
      blob: encodeFingerprintFrames(fingerprint.frames),
      digest,
      frameCount: fingerprint.frames.length,
      framesPerSecond: fingerprint.framesPerSecond,
      delaySeconds: fingerprint.delaySeconds ?? 0,
      durationSeconds: fingerprint.durationSeconds,
      now,
    })
    return digest
  }

  failAnalysis(source: FingerprintSource, signature: string, provider: {
    algorithm: string
    algorithmVersion: string
  }, error: unknown): void {
    const now = new Date().toISOString()
    const message = error instanceof Error ? error.message : String(error)
    this.db.prepare(`
      INSERT INTO duplicate_track_analyses (
        track_id, source_provider, source_locator, source_file_size, source_modified,
        source_etag, source_signature, algorithm, algorithm_version, status,
        error, created_at, updated_at
      ) VALUES (
        @trackId, @provider, @locator, @fileSize, @dateModified,
        @etag, @signature, @algorithm, @algorithmVersion, 'error',
        @message, @now, @now
      )
      ON CONFLICT(track_id) DO UPDATE SET
        source_provider = excluded.source_provider,
        source_locator = excluded.source_locator,
        source_file_size = excluded.source_file_size,
        source_modified = excluded.source_modified,
        source_etag = excluded.source_etag,
        source_signature = excluded.source_signature,
        algorithm = excluded.algorithm,
        algorithm_version = excluded.algorithm_version,
        status = 'error',
        fingerprint_blob = NULL,
        fingerprint_digest = NULL,
        frame_count = 0,
        frames_per_second = 0,
        delay_seconds = 0,
        duration_seconds = 0,
        error = excluded.error,
        updated_at = excluded.updated_at
    `).run({
      ...source,
      signature,
      algorithm: provider.algorithm,
      algorithmVersion: provider.algorithmVersion,
      message,
      now,
    })
  }

  ensureIdentity(
    trackId: number,
    acousticDigest: string,
    algorithm: string,
    algorithmVersion: string,
  ): DuplicateIdentity {
    const now = new Date().toISOString()
    const current = this.identityByTrack.get(trackId) as IdentityRow | undefined
    if (current) {
      this.db.prepare(`
        UPDATE duplicate_track_identities
        SET acoustic_digest = ?, algorithm = ?, algorithm_version = ?, updated_at = ?
        WHERE track_id = ?
      `).run(acousticDigest, algorithm, algorithmVersion, now, trackId)
    } else {
      this.db.prepare(`
        INSERT INTO duplicate_track_identities (
          id, track_id, acoustic_digest, algorithm, algorithm_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), trackId, acousticDigest, algorithm, algorithmVersion, now, now)
    }
    return identity(this.identityByTrack.get(trackId) as IdentityRow)
  }

  getIdentity(trackId: number): DuplicateIdentity | null {
    const row = this.identityByTrack.get(trackId) as IdentityRow | undefined
    return row ? identity(row) : null
  }

  private canonicalDecisionPair(
    left: DuplicateIdentity,
    right: DuplicateIdentity,
  ): { low: DuplicateIdentity; high: DuplicateIdentity; pairKey: string } {
    const low = left.id < right.id ? left : right
    const high = left.id < right.id ? right : left
    return { low, high, pairKey: `${low.id}:${high.id}` }
  }

  hasMatchingKeepBothDecision(left: DuplicateIdentity, right: DuplicateIdentity): boolean {
    if (left.algorithm !== right.algorithm || left.algorithmVersion !== right.algorithmVersion) return false
    const pair = this.canonicalDecisionPair(left, right)
    return Boolean(this.db.prepare(`
      SELECT 1 FROM duplicate_pair_decisions
      WHERE pair_key = ?
        AND low_acoustic_digest = ? AND high_acoustic_digest = ?
        AND algorithm = ? AND algorithm_version = ?
    `).get(
      pair.pairKey,
      pair.low.acousticDigest,
      pair.high.acousticDigest,
      pair.low.algorithm,
      pair.low.algorithmVersion,
    ))
  }

  saveKeepBothDecision(input: DuplicatePairDecisionInput): string {
    const pair = this.canonicalDecisionPair(input.lowIdentity, input.highIdentity)
    if (
      pair.low.algorithm !== pair.high.algorithm
      || pair.low.algorithmVersion !== pair.high.algorithmVersion
    ) throw new Error('Cannot persist a decision for incompatible fingerprints.')
    const now = input.createdAt ?? new Date().toISOString()
    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO duplicate_pair_decisions (
        id, pair_key, low_identity_id, high_identity_id,
        low_acoustic_digest, high_acoustic_digest, algorithm, algorithm_version,
        reason, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pair_key) DO UPDATE SET
        low_acoustic_digest = excluded.low_acoustic_digest,
        high_acoustic_digest = excluded.high_acoustic_digest,
        algorithm = excluded.algorithm,
        algorithm_version = excluded.algorithm_version,
        reason = excluded.reason,
        source = excluded.source,
        updated_at = excluded.updated_at
    `).run(
      id,
      pair.pairKey,
      pair.low.id,
      pair.high.id,
      pair.low.acousticDigest,
      pair.high.acousticDigest,
      pair.low.algorithm,
      pair.low.algorithmVersion,
      input.reason,
      input.source ?? 'database',
      now,
      now,
    )
    return (this.db.prepare(`SELECT id FROM duplicate_pair_decisions WHERE pair_key = ?`)
      .get(pair.pairKey) as { id: string }).id
  }

  upsertCandidate(input: SaveDuplicateCandidateInput): { id: string; revision: number } {
    if (input.comparison.similarity <= 0.6) {
      throw new Error('Duplicate candidates must have similarity greater than 60%.')
    }
    const lowId = input.pair.lowTrack.id
    const highId = input.pair.highTrack.id
    if (lowId >= highId) throw new Error('Duplicate candidate track ids must be ordered.')
    const now = new Date().toISOString()
    const existing = this.db.prepare(`
      SELECT id, revision FROM duplicate_candidates
      WHERE track_low_id = ? AND track_high_id = ?
    `).get(lowId, highId) as { id: string; revision: number } | undefined
    const id = existing?.id ?? randomUUID()
    this.db.prepare(`
      INSERT INTO duplicate_candidates (
        id, track_low_id, track_high_id, revision, status, similarity,
        alignment_offset_frames, matching_frames, compared_frames, segments_json,
        acoustic_relation, editorial_relation, evidence_json,
        recommendation_reasons_json, recommended_track_id,
        low_fingerprint_digest, high_fingerprint_digest, prefilter_json,
        created_at, updated_at
      ) VALUES (
        @id, @lowId, @highId, 1, @status, @similarity,
        @offsetFrames, @matchingFrames, @comparedFrames, @segmentsJson,
        @acousticRelation, @editorialRelation, @evidenceJson,
        @recommendationReasonsJson, @recommendedTrackId,
        @lowFingerprintDigest, @highFingerprintDigest, @prefilterJson,
        @now, @now
      )
      ON CONFLICT(track_low_id, track_high_id) DO UPDATE SET
        revision = duplicate_candidates.revision + CASE WHEN
          duplicate_candidates.status IS NOT excluded.status
          OR duplicate_candidates.similarity IS NOT excluded.similarity
          OR duplicate_candidates.alignment_offset_frames IS NOT excluded.alignment_offset_frames
          OR duplicate_candidates.matching_frames IS NOT excluded.matching_frames
          OR duplicate_candidates.compared_frames IS NOT excluded.compared_frames
          OR duplicate_candidates.segments_json IS NOT excluded.segments_json
          OR duplicate_candidates.acoustic_relation IS NOT excluded.acoustic_relation
          OR duplicate_candidates.editorial_relation IS NOT excluded.editorial_relation
          OR duplicate_candidates.evidence_json IS NOT excluded.evidence_json
          OR duplicate_candidates.recommendation_reasons_json IS NOT excluded.recommendation_reasons_json
          OR duplicate_candidates.recommended_track_id IS NOT excluded.recommended_track_id
          OR duplicate_candidates.low_fingerprint_digest IS NOT excluded.low_fingerprint_digest
          OR duplicate_candidates.high_fingerprint_digest IS NOT excluded.high_fingerprint_digest
          OR duplicate_candidates.prefilter_json IS NOT excluded.prefilter_json
          THEN 1 ELSE 0 END,
        status = excluded.status,
        similarity = excluded.similarity,
        alignment_offset_frames = excluded.alignment_offset_frames,
        matching_frames = excluded.matching_frames,
        compared_frames = excluded.compared_frames,
        segments_json = excluded.segments_json,
        acoustic_relation = excluded.acoustic_relation,
        editorial_relation = excluded.editorial_relation,
        evidence_json = excluded.evidence_json,
        recommendation_reasons_json = excluded.recommendation_reasons_json,
        recommended_track_id = excluded.recommended_track_id,
        low_fingerprint_digest = excluded.low_fingerprint_digest,
        high_fingerprint_digest = excluded.high_fingerprint_digest,
        prefilter_json = excluded.prefilter_json,
        updated_at = excluded.updated_at
    `).run({
      id,
      lowId,
      highId,
      status: input.status ?? 'pending',
      similarity: input.comparison.similarity,
      offsetFrames: input.comparison.offsetFrames,
      matchingFrames: input.comparison.matchingFrames,
      comparedFrames: input.comparison.comparedFrames,
      segmentsJson: JSON.stringify(input.comparison.segments),
      acousticRelation: input.classification.acousticRelation,
      editorialRelation: input.classification.editorialRelation,
      evidenceJson: JSON.stringify(input.classification.evidence),
      recommendationReasonsJson: JSON.stringify(input.recommendation.reasons),
      recommendedTrackId: input.recommendation.recommendedTrackId,
      lowFingerprintDigest: input.lowFingerprintDigest,
      highFingerprintDigest: input.highFingerprintDigest,
      prefilterJson: JSON.stringify({
        normalizedArtist: input.pair.normalizedArtist,
        lowBaseTitle: input.pair.lowTitle.base,
        highBaseTitle: input.pair.highTitle.base,
        titleSimilarity: input.pair.titleSimilarity,
        durationDifferenceSeconds: input.pair.durationDifferenceSeconds,
        allowedDurationDifferenceSeconds: input.pair.allowedDurationDifferenceSeconds,
      }),
      now,
    })
    return this.db.prepare(`
      SELECT id, revision FROM duplicate_candidates
      WHERE track_low_id = ? AND track_high_id = ?
    `).get(lowId, highId) as { id: string; revision: number }
  }

  removeCandidatePair(lowTrackId: number, highTrackId: number): void {
    this.db.prepare(`
      DELETE FROM duplicate_candidates WHERE track_low_id = ? AND track_high_id = ?
    `).run(Math.min(lowTrackId, highTrackId), Math.max(lowTrackId, highTrackId))
  }

  markUnseenCandidatesStale(
    seenPairKeys: ReadonlySet<string>,
    scopedTrackIds?: ReadonlySet<number>,
  ): number {
    const candidates = this.db.prepare(`
      SELECT id, track_low_id, track_high_id FROM duplicate_candidates
      WHERE status IN ('pending', 'dismissed')
    `).all() as Array<{ id: string; track_low_id: number; track_high_id: number }>
    const update = this.db.prepare(`
      UPDATE duplicate_candidates
      SET status = 'stale', revision = revision + 1, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'dismissed')
    `)
    const now = new Date().toISOString()
    let changed = 0
    this.db.transaction(() => {
      for (const candidate of candidates) {
        if (
          scopedTrackIds
          && !scopedTrackIds.has(candidate.track_low_id)
          && !scopedTrackIds.has(candidate.track_high_id)
        ) continue
        const key = `${candidate.track_low_id}:${candidate.track_high_id}`
        if (seenPairKeys.has(key)) continue
        changed += update.run(now, candidate.id).changes
      }
    })()
    return changed
  }

  dismissCandidate(candidateId: string, expectedRevision: number): void {
    const result = this.db.prepare(`
      UPDATE duplicate_candidates
      SET status = 'dismissed', revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ? AND status = 'pending'
    `).run(new Date().toISOString(), candidateId, expectedRevision)
    if (result.changes !== 1) throw new Error('El caso cambió; actualizá la revisión antes de resolverlo.')
  }

  private candidateDetail(row: CandidateRow): DuplicateCandidateDetail | null {
    const low = this.getTrackFacts(row.track_low_id)
    const high = this.getTrackFacts(row.track_high_id)
    if (!low || !high || row.recommended_track_id == null) return null
    const recommendedIsLow = row.recommended_track_id === low.id
    const left = recommendedIsLow ? high : low
    const right = recommendedIsLow ? low : high
    const storedSegments = jsonArray<DuplicateSegment>(row.segments_json)
    const segments = recommendedIsLow
      ? storedSegments.map(segment => ({
          ...segment,
          leftStartSec: segment.rightStartSec,
          rightStartSec: segment.leftStartSec,
        }))
      : storedSegments
    const lowAnalysis = this.getAnalysis(low.id)
    const fps = lowAnalysis?.fingerprint?.framesPerSecond ?? 1
    return {
      id: row.id,
      revision: row.revision,
      status: row.status,
      similarity: row.similarity,
      acousticRelation: row.acoustic_relation,
      editorialRelation: row.editorial_relation,
      recommendedTrackId: right.id,
      left: trackView(left),
      right: trackView(right),
      recommendationReasons: jsonArray<string>(row.recommendation_reasons_json),
      updatedAt: row.updated_at,
      alignmentOffsetSeconds: (recommendedIsLow ? -1 : 1) * row.alignment_offset_frames / fps,
      matchingFrames: row.matching_frames,
      comparedFrames: row.compared_frames,
      segments,
      evidence: jsonArray<DuplicateEvidence>(row.evidence_json),
      leftFingerprintDigest: recommendedIsLow
        ? row.high_fingerprint_digest
        : row.low_fingerprint_digest,
      rightFingerprintDigest: recommendedIsLow
        ? row.low_fingerprint_digest
        : row.high_fingerprint_digest,
    }
  }

  getCandidate(candidateId: string): DuplicateCandidateDetail | null {
    const row = this.candidateById.get(candidateId) as CandidateRow | undefined
    return row ? this.candidateDetail(row) : null
  }

  listCandidates(request: DuplicateListRequest = {}): DuplicateCandidateSummary[] {
    const status = request.status ?? 'pending'
    const limit = Math.max(1, Math.min(200, Math.floor(request.limit ?? 50)))
    const offset = Math.max(0, Math.floor(request.offset ?? 0))
    const rows = this.db.prepare(`
      SELECT * FROM duplicate_candidates
      WHERE status = ?
      ORDER BY similarity DESC, updated_at DESC, id
      LIMIT ? OFFSET ?
    `).all(status, limit, offset) as CandidateRow[]
    return rows.flatMap(row => {
      const detail = this.candidateDetail(row)
      if (!detail) return []
      const {
        alignmentOffsetSeconds: _alignmentOffsetSeconds,
        matchingFrames: _matchingFrames,
        comparedFrames: _comparedFrames,
        segments: _segments,
        evidence: _evidence,
        leftFingerprintDigest: _leftFingerprintDigest,
        rightFingerprintDigest: _rightFingerprintDigest,
        ...summary
      } = detail
      return [summary]
    })
  }

  summary(): DuplicateSummary {
    const candidates = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
        SUM(CASE WHEN status = 'dismissed' THEN 1 ELSE 0 END) AS dismissed_count,
        SUM(CASE WHEN status = 'stale' THEN 1 ELSE 0 END) AS stale_count
      FROM duplicate_candidates
    `).get() as { pending_count: number | null; dismissed_count: number | null; stale_count: number | null }
    const analyses = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS analyzed_count,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS queued_count,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running_count,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS failed_count,
        MAX(CASE WHEN status = 'ready' THEN updated_at END) AS last_analyzed_at
      FROM duplicate_track_analyses
    `).get() as {
      analyzed_count: number | null
      queued_count: number | null
      running_count: number | null
      failed_count: number | null
      last_analyzed_at: string | null
    }
    return {
      pendingCount: candidates.pending_count ?? 0,
      analyzedCount: analyses.analyzed_count ?? 0,
      queuedCount: analyses.queued_count ?? 0,
      running: (analyses.running_count ?? 0) > 0,
      dismissedCount: candidates.dismissed_count ?? 0,
      staleCount: candidates.stale_count ?? 0,
      analyzingCount: analyses.running_count ?? 0,
      failedCount: analyses.failed_count ?? 0,
      lastAnalyzedAt: analyses.last_analyzed_at,
    }
  }

  createResolutionRun(input: DuplicateResolutionRunInput): string {
    const id = input.id ?? randomUUID()
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO duplicate_resolution_runs (
        id, candidate_id, action, kept_track_id, removed_track_id,
        expected_revision, source_snapshot_json, device_intents_json,
        state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)
    `).run(
      id,
      input.candidateId,
      input.action,
      input.keptTrackId,
      input.removedTrackId,
      input.expectedRevision,
      JSON.stringify(input.sourceSnapshot),
      JSON.stringify(input.deviceIntents ?? []),
      now,
      now,
    )
    return id
  }

  markResolutionStorageDone(id: string, storageReceipt: unknown): void {
    const now = new Date().toISOString()
    const result = this.db.prepare(`
      UPDATE duplicate_resolution_runs
      SET state = 'storage_done', storage_receipt_json = ?, error = NULL,
          storage_done_at = ?, updated_at = ?
      WHERE id = ? AND state = 'planned'
    `).run(JSON.stringify(storageReceipt), now, now, id)
    if (result.changes !== 1) throw new Error('The duplicate resolution is not awaiting storage.')
  }

  markResolutionCommitted(id: string): void {
    const now = new Date().toISOString()
    const result = this.db.prepare(`
      UPDATE duplicate_resolution_runs
      SET state = 'committed', error = NULL, committed_at = ?, updated_at = ?
      WHERE id = ? AND state = 'storage_done'
    `).run(now, now, id)
    if (result.changes !== 1) throw new Error('The duplicate resolution storage step is incomplete.')
  }

  markResolutionFailed(id: string, error: unknown): void {
    this.db.prepare(`
      UPDATE duplicate_resolution_runs
      SET state = 'failed', error = ?, updated_at = ?
      WHERE id = ? AND state <> 'committed'
    `).run(error instanceof Error ? error.message : String(error), new Date().toISOString(), id)
  }

  listRecoverableResolutionRuns(): DuplicateResolutionRunRow[] {
    return this.db.prepare(`
      SELECT * FROM duplicate_resolution_runs
      WHERE state = 'storage_done'
      ORDER BY storage_done_at, id
    `).all() as DuplicateResolutionRunRow[]
  }
}
