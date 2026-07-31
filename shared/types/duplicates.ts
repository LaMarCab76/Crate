import type { LibraryProvider } from './library-locations'

export type DuplicateAnalysisStatus = 'pending' | 'running' | 'ready' | 'error'

export type DuplicateAcousticRelation =
  | 'near_identical'
  | 'possible_different_edition'
  | 'uncertain'

export type DuplicateEditorialRelation =
  | 'same_release'
  | 'album_vs_single_ep'
  | 'album_vs_compilation'
  | 'different_releases'
  | 'unknown'

export type DuplicateCandidateStatus = 'pending' | 'dismissed' | 'stale'

export type DuplicateKeepBothReason = 'different_versions' | 'not_duplicates'

export type DuplicateResolutionAction = 'keep_both' | 'trash_left' | 'trash_right'

export type DuplicateSegmentKind = 'match' | 'difference'

/**
 * A segment on the common, aligned comparison timeline. A null side means the
 * segment falls outside that recording (for example, an unmatched intro).
 */
export interface DuplicateSegment {
  id: string
  kind: DuplicateSegmentKind
  startSec: number
  endSec: number
  leftStartSec: number | null
  rightStartSec: number | null
  score: number
}

export interface DuplicateTrackView {
  id: number
  folderId: number
  provider: LibraryProvider
  title: string
  artist: string
  album: string
  albumArtist: string | null
  year: string
  duration: number
  trackNumber: number | null
  discNumber: number | null
  format: string
  codec: string | null
  bitrate: number | null
  sampleRate: number | null
  bitDepth: number | null
  channels: number | null
  fileSize: number | null
  libraryName: string
  path: string
  artworkPath: string | null
  releaseType: string | null
  isCompilation: boolean
  dateAdded: string
}

export interface DuplicateCandidateSummary {
  id: string
  revision: number
  status: DuplicateCandidateStatus
  similarity: number
  acousticRelation: DuplicateAcousticRelation
  editorialRelation: DuplicateEditorialRelation
  recommendedTrackId: number
  /** Always the non-recommended copy for presentation. */
  left: DuplicateTrackView
  /** Always the recommended copy for presentation. */
  right: DuplicateTrackView
  recommendationReasons: string[]
  updatedAt: string
}

export interface DuplicateEvidence {
  kind:
    | 'title_qualifier'
    | 'duration'
    | 'release_type'
    | 'compilation'
    | 'musicbrainz'
    | 'quality'
    | 'audio_difference'
  message: string
  confidence: number
  source: 'tags' | 'catalog' | 'audio' | 'musicbrainz' | 'inference'
}

export interface DuplicateCandidateDetail extends DuplicateCandidateSummary {
  alignmentOffsetSeconds: number
  matchingFrames: number
  comparedFrames: number
  segments: DuplicateSegment[]
  evidence: DuplicateEvidence[]
  leftFingerprintDigest: string
  rightFingerprintDigest: string
}

export type DuplicateAnalysisBlockerCode =
  | 'native_component_missing'
  | 'native_component_incompatible'
  | 'native_component_load_failed'
  | 'fingerprint_provider_unavailable'
  | 'local_library_unavailable'
  | 'local_library_permission_required'

export interface DuplicateAnalysisBlockedFolder {
  folderId: number
  name: string
  path: string
  state: 'unavailable' | 'permission_required'
}

/**
 * A run-level condition that prevents acoustic analysis from starting. This is
 * intentionally separate from per-track failures: no track should look corrupt
 * when the application itself is missing a native component.
 */
export interface DuplicateAnalysisBlocker {
  code: DuplicateAnalysisBlockerCode
  message: string
  /** True when the same process can retry after the user fixes external state. */
  retryable: boolean
  /** True when replacing/loading the component requires a process restart. */
  requiresRestart: boolean
  component?: string
  version?: string
  affectedFolders?: DuplicateAnalysisBlockedFolder[]
  /** Diagnostic detail for support/logging; renderer copy should prefer message. */
  detail?: string
}

export interface DuplicateSummary {
  pendingCount: number
  analyzedCount: number
  queuedCount: number
  running: boolean
  progress?: {
    completed: number
    total: number
    currentTitle?: string
  }
  dismissedCount: number
  staleCount: number
  analyzingCount: number
  failedCount: number
  lastAnalyzedAt: string | null
  /** Present while a runtime pass is active so Activity Center can recover late subscription state. */
  activityOrigin?: 'startup' | 'background'
  /** Additive IPC field; absent means the analysis engine is available. */
  blocker?: DuplicateAnalysisBlocker
}

export interface DuplicateListRequest {
  status?: DuplicateCandidateStatus
  limit?: number
  offset?: number
}

export type DuplicateResolutionRequest =
  | {
      candidateId: string
      expectedRevision: number
      action: 'keep_both'
      reason: DuplicateKeepBothReason
    }
  | {
      candidateId: string
      expectedRevision: number
      action: 'trash_left' | 'trash_right'
      reason?: never
    }

export interface DuplicateResolutionResult {
  candidateId: string
  action: DuplicateResolutionAction
  keptTrackId: number | null
  deletedTrackId: number | null
  warnings: string[]
}

export type DuplicateAnalysisPhase =
  | 'prefiltering'
  | 'fingerprinting'
  | 'comparing'
  | 'complete'
  | 'error'

export interface DuplicateAnalysisProgress {
  /** Activity Center visibility; omitted by the detector and assigned by the runtime. */
  activityOrigin?: 'startup' | 'background'
  phase: DuplicateAnalysisPhase
  completed: number
  total: number
  trackId?: number
  message?: string
  blocker?: DuplicateAnalysisBlocker
}

export type DuplicateAuditionSide = 'left' | 'right'

export interface DuplicateAuditionOpenRequest {
  candidateId: string
  expectedRevision: number
}

export interface DuplicateAuditionSeekRequest {
  side: DuplicateAuditionSide
  positionSec: number
}

export interface DuplicateAuditionCompareSegmentRequest {
  segmentIndex: number
}

export interface DuplicateAuditionState {
  candidateId: string | null
  activeSide: DuplicateAuditionSide | null
  status: 'closed' | 'loading' | 'playing' | 'paused' | 'error'
  leftPositionSec: number
  rightPositionSec: number
  leftDurationSec: number
  rightDurationSec: number
  comparingSegmentIndex: number | null
  error: string | null
}
