import { isLosslessAudio } from '../library/trackAlbumMoveQuality.ts'
import type { DuplicateTrackFacts } from './domain.ts'
import { normalizeDuplicateText, normalizePrimaryArtist } from './normalization.ts'

export type DuplicateReleaseClass =
  | 'artist_album'
  | 'single_ep'
  | 'artist_release'
  | 'compilation'
  | 'unknown'

const RELEASE_RANK: Record<DuplicateReleaseClass, number> = {
  artist_album: 0,
  single_ep: 1,
  artist_release: 2,
  compilation: 3,
  unknown: 4,
}

const UNKNOWN_ALBUMS = new Set(['', 'unknown album', 'album desconocido', 'sin album'])

function releaseTypeTokens(value: string | null): string[] {
  return normalizeDuplicateText(value).split(' ').filter(Boolean)
}

function isVariousArtists(value: string | null | undefined): boolean {
  const normalized = normalizeDuplicateText(value)
  return normalized === 'various artists' || normalized === 'varios artistas'
}

function albumArtistMatches(track: DuplicateTrackFacts): boolean {
  const primaryArtist = normalizePrimaryArtist(track.primaryArtist ?? track.artist)
  const albumArtist = normalizePrimaryArtist(track.albumArtist)
  // A missing album artist is not positive evidence that this is the artist's
  // own release. Treat it as unknown so incomplete tags cannot outrank a
  // release whose provenance is explicit.
  if (!primaryArtist || !albumArtist) return false
  return albumArtist === primaryArtist
}

export function duplicateReleaseClass(track: DuplicateTrackFacts): DuplicateReleaseClass {
  const types = releaseTypeTokens(track.releaseType)
  const compilation = track.compilation
    || track.albumCompilation
    || isVariousArtists(track.albumArtist)
    || types.includes('compilation')
    || types.includes('recopilacion')
  if (compilation) return 'compilation'

  const knownAlbum = !UNKNOWN_ALBUMS.has(normalizeDuplicateText(track.album))
  const primaryArtist = normalizePrimaryArtist(track.primaryArtist ?? track.artist)
  const albumArtist = normalizePrimaryArtist(track.albumArtist)
  const contradictoryAlbumArtist = Boolean(
    primaryArtist && albumArtist && primaryArtist !== albumArtist,
  )
  // An explicit Single/EP tag is the second preservation class in its own
  // right. A missing album-artist tag does not erase it, but a contradictory
  // credit does keep the release in the unknown bucket.
  if (
    knownAlbum
    && primaryArtist
    && !contradictoryAlbumArtist
    && types.some(type => type === 'single' || type === 'ep')
  ) return 'single_ep'
  const ownArtistRelease = knownAlbum && albumArtistMatches(track)
  if (ownArtistRelease && types.includes('album')) return 'artist_album'
  if (ownArtistRelease) return 'artist_release'
  return 'unknown'
}

function compareNullableNumber(left: number | null, right: number | null): number {
  const delta = (left ?? 0) - (right ?? 0)
  return delta === 0 ? 0 : delta > 0 ? 1 : -1
}

interface TrackRank {
  releaseClass: DuplicateReleaseClass
  lossless: boolean
}

function rankTrack(track: DuplicateTrackFacts): TrackRank {
  return {
    releaseClass: duplicateReleaseClass(track),
    lossless: isLosslessAudio(track.format, track.codec),
  }
}

function comparableLossyCodec(left: DuplicateTrackFacts, right: DuplicateTrackFacts): boolean {
  const leftCodec = normalizeDuplicateText(left.codec || left.format)
  const rightCodec = normalizeDuplicateText(right.codec || right.format)
  return leftCodec !== '' && leftCodec === rightCodec
}

function releaseReason(releaseClass: DuplicateReleaseClass): string {
  switch (releaseClass) {
    case 'artist_album': return 'Pertenece a un álbum propio del artista.'
    case 'single_ep': return 'Pertenece a un single o EP del artista.'
    case 'artist_release': return 'El lanzamiento no figura como recopilación y coincide con el artista.'
    case 'compilation': return 'Tiene metadatos editoriales más claros que la otra copia, aunque pertenece a una recopilación.'
    case 'unknown': return 'La información editorial no permite distinguir los lanzamientos.'
  }
}

export interface DuplicateRecommendation {
  recommendedTrackId: number
  otherTrackId: number
  reasons: string[]
}

/** Positive means left should be kept, negative means right, zero is impossible. */
export function compareDuplicateKeeper(left: DuplicateTrackFacts, right: DuplicateTrackFacts): number {
  const leftRank = rankTrack(left)
  const rightRank = rankTrack(right)
  const releaseDelta = RELEASE_RANK[rightRank.releaseClass] - RELEASE_RANK[leftRank.releaseClass]
  if (releaseDelta !== 0) return releaseDelta > 0 ? 1 : -1

  if (leftRank.lossless !== rightRank.lossless) return leftRank.lossless ? 1 : -1
  const sampleRate = compareNullableNumber(left.sampleRate, right.sampleRate)
  if (sampleRate !== 0) return sampleRate
  const bitDepth = compareNullableNumber(left.bitDepth, right.bitDepth)
  if (bitDepth !== 0) return bitDepth
  if (!leftRank.lossless && !rightRank.lossless && comparableLossyCodec(left, right)) {
    const bitrate = compareNullableNumber(left.bitrate, right.bitrate)
    if (bitrate !== 0) return bitrate
  }

  const leftAdded = Date.parse(left.dateAdded)
  const rightAdded = Date.parse(right.dateAdded)
  if (Number.isFinite(leftAdded) && Number.isFinite(rightAdded) && leftAdded !== rightAdded) {
    return leftAdded < rightAdded ? 1 : -1
  }
  return left.id <= right.id ? 1 : -1
}

export function recommendDuplicateKeeper(
  left: DuplicateTrackFacts,
  right: DuplicateTrackFacts,
): DuplicateRecommendation {
  const comparison = compareDuplicateKeeper(left, right)
  const recommended = comparison > 0 ? left : right
  const other = comparison > 0 ? right : left
  const recommendedRank = rankTrack(recommended)
  const otherRank = rankTrack(other)
  const reasons: string[] = []

  if (recommendedRank.releaseClass !== otherRank.releaseClass) {
    reasons.push(releaseReason(recommendedRank.releaseClass))
  } else if (recommendedRank.lossless !== otherRank.lossless) {
    reasons.push('Conserva audio lossless frente a una copia con pérdida.')
  } else if ((recommended.sampleRate ?? 0) !== (other.sampleRate ?? 0)) {
    reasons.push(`Tiene mayor frecuencia de muestreo (${recommended.sampleRate ?? 0} Hz).`)
  } else if ((recommended.bitDepth ?? 0) !== (other.bitDepth ?? 0)) {
    reasons.push(`Tiene mayor profundidad de bits (${recommended.bitDepth ?? 0} bit).`)
  } else if (
    !recommendedRank.lossless
    && comparableLossyCodec(recommended, other)
    && (recommended.bitrate ?? 0) !== (other.bitrate ?? 0)
  ) {
    reasons.push(`Tiene mayor bitrate (${Math.round((recommended.bitrate ?? 0) / 1000)} kbps).`)
  } else if (recommended.id !== other.id) {
    reasons.push('Es la copia más antigua de la biblioteca; se usa como desempate estable.')
  }

  return {
    recommendedTrackId: recommended.id,
    otherTrackId: other.id,
    reasons,
  }
}
