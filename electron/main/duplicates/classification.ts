import type {
  DuplicateAcousticRelation,
  DuplicateEditorialRelation,
  DuplicateEvidence,
  DuplicateSegment,
} from '@shared/types/duplicates'
import type { DuplicateTrackFacts } from './domain.ts'
import { duplicateReleaseClass } from './recommendation.ts'
import { normalizeDuplicateText, normalizeDuplicateTitle } from './normalization.ts'

export interface DuplicateClassificationInput {
  left: DuplicateTrackFacts
  right: DuplicateTrackFacts
  similarity: number
  segments: readonly DuplicateSegment[]
}

export interface DuplicateClassification {
  acousticRelation: DuplicateAcousticRelation
  editorialRelation: DuplicateEditorialRelation
  evidence: DuplicateEvidence[]
  needsMetadataEnrichment: boolean
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function knownAlbum(value: string): string | null {
  const normalized = normalizeDuplicateText(value)
  if (!normalized || normalized === 'unknown album' || normalized === 'album desconocido') return null
  return normalized
}

function classifyEditorial(
  left: DuplicateTrackFacts,
  right: DuplicateTrackFacts,
): DuplicateEditorialRelation {
  if (
    left.musicBrainzReleaseId
    && right.musicBrainzReleaseId
  ) {
    // Explicit release identities take precedence over album/year heuristics.
    // Different releases frequently share both display title and release year.
    return left.musicBrainzReleaseId === right.musicBrainzReleaseId
      ? 'same_release'
      : 'different_releases'
  }

  const leftAlbum = knownAlbum(left.album)
  const rightAlbum = knownAlbum(right.album)
  if (
    leftAlbum
    && leftAlbum === rightAlbum
    && (!left.year || !right.year || left.year === right.year)
  ) {
    return 'same_release'
  }

  const leftClass = duplicateReleaseClass(left)
  const rightClass = duplicateReleaseClass(right)
  const classes = new Set([leftClass, rightClass])
  if (
    classes.has('compilation')
    && (classes.has('artist_album') || classes.has('artist_release'))
  ) return 'album_vs_compilation'
  if (
    classes.has('single_ep')
    && (classes.has('artist_album') || classes.has('artist_release'))
  ) return 'album_vs_single_ep'

  if (
    leftAlbum && rightAlbum && leftAlbum !== rightAlbum
  ) {
    return 'different_releases'
  }
  return 'unknown'
}

export function classifyDuplicatePair(input: DuplicateClassificationInput): DuplicateClassification {
  const { left, right, similarity, segments } = input
  const evidence: DuplicateEvidence[] = []
  const durationDifference = Math.abs(left.duration - right.duration)
  const longestDifference = segments
    .filter(segment => segment.kind === 'difference')
    .reduce((longest, segment) => Math.max(longest, segment.endSec - segment.startSec), 0)
  const leftQualifiers = normalizeDuplicateTitle(left.title).qualifiers.sort()
  const rightQualifiers = normalizeDuplicateTitle(right.title).qualifiers.sort()
  const qualifierMismatch = !sameStrings(leftQualifiers, rightQualifiers)
  const recordingIdMismatch = Boolean(
    left.musicBrainzRecordingId
    && right.musicBrainzRecordingId
    && left.musicBrainzRecordingId !== right.musicBrainzRecordingId,
  )

  if (durationDifference > 3) {
    evidence.push({
      kind: 'duration',
      message: `Las duraciones difieren ${durationDifference.toFixed(1)} segundos.`,
      confidence: 0.9,
      source: 'catalog',
    })
  }
  if (longestDifference >= 10) {
    evidence.push({
      kind: 'audio_difference',
      message: `Existe una diferencia de audio sostenida de ${longestDifference.toFixed(1)} segundos.`,
      confidence: 0.95,
      source: 'audio',
    })
  }
  if (qualifierMismatch) {
    evidence.push({
      kind: 'title_qualifier',
      message: 'Los títulos indican versiones o ediciones distintas.',
      confidence: 0.8,
      source: 'tags',
    })
  }
  if (recordingIdMismatch) {
    evidence.push({
      kind: 'musicbrainz',
      message: 'Los MusicBrainz Recording IDs no coinciden.',
      confidence: 1,
      source: 'tags',
    })
  }

  const possibleDifferentEdition = durationDifference > 3
    || longestDifference >= 10
    || qualifierMismatch
    || recordingIdMismatch
  const acousticRelation: DuplicateAcousticRelation = possibleDifferentEdition
    ? 'possible_different_edition'
    : similarity >= 0.85
      ? 'near_identical'
      : 'uncertain'
  const editorialRelation = classifyEditorial(left, right)

  if (editorialRelation === 'album_vs_compilation') {
    evidence.push({
      kind: 'compilation',
      message: 'Una copia pertenece a un álbum del artista y la otra a una recopilación.',
      confidence: 0.9,
      source: 'catalog',
    })
  } else if (editorialRelation === 'album_vs_single_ep') {
    evidence.push({
      kind: 'release_type',
      message: 'Una copia pertenece a un álbum y la otra a un single o EP.',
      confidence: 0.9,
      source: 'catalog',
    })
  } else if (editorialRelation === 'different_releases') {
    const inferred = left.musicBrainzInferred || right.musicBrainzInferred
    evidence.push({
      kind: 'release_type',
      message: 'Las copias parecen pertenecer a lanzamientos diferentes.',
      confidence: left.musicBrainzReleaseId && right.musicBrainzReleaseId ? 1 : 0.75,
      source: inferred
        ? 'musicbrainz'
        : left.musicBrainzReleaseId && right.musicBrainzReleaseId ? 'tags' : 'inference',
    })
  }

  return {
    acousticRelation,
    editorialRelation,
    evidence,
    needsMetadataEnrichment: editorialRelation === 'unknown'
      || acousticRelation === 'uncertain',
  }
}
