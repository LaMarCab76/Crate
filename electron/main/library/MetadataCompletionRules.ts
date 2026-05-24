import { basename, extname } from 'node:path'
import type { MetadataCompletionField } from '@shared/types/ipc-contract'

const PLACEHOLDERS = new Set([
  '',
  'unknown',
  'unknown artist',
  'unknown album',
  'sin artista',
  'sin album',
  'sin álbum',
  'untitled',
])

export interface FilenameInference {
  title: string | null
  trackNumber: number | null
  discNumber: number | null
}

export function normalizeMetadataText(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function isPlaceholderMetadata(value: string | null | undefined): boolean {
  return PLACEHOLDERS.has(normalizeMetadataText(value))
}

export function isMissingText(value: string | null | undefined): boolean {
  return isPlaceholderMetadata(value)
}

export function isMissingNumber(value: number | null | undefined): boolean {
  return value == null || !Number.isFinite(value) || value <= 0
}

export function displayMetadataValue(value: string | number | null | undefined): string | null {
  if (value == null) return null
  const text = String(value).trim()
  return text || null
}

export function uniqueFields(fields: MetadataCompletionField[]): MetadataCompletionField[] {
  return [...new Set(fields)]
}

export function inferFromFilename(path: string): FilenameInference {
  const raw = basename(path, extname(path))
    .replace(/\s+/g, ' ')
    .trim()

  let rest = raw
  let trackNumber: number | null = null
  let discNumber: number | null = null

  const discTrack = /^(\d{1,2})[-_. ](\d{1,2})\s*[-_. ]+\s*(.+)$/.exec(rest)
  if (discTrack) {
    discNumber = Number.parseInt(discTrack[1], 10)
    trackNumber = Number.parseInt(discTrack[2], 10)
    rest = discTrack[3]
  } else {
    const track = /^(\d{1,3})\s*(?:[-_.]\s*|\s+-\s+|\s+)(.+)$/.exec(rest)
    if (track) {
      trackNumber = Number.parseInt(track[1], 10)
      rest = track[2]
    }
  }

  const discHint = /\b(?:cd|disc|disk)\s*(\d{1,2})\b/i.exec(raw)
  if (discHint) discNumber = Number.parseInt(discHint[1], 10)

  rest = rest
    .replace(/\b(?:official|audio|lyrics?|visualizer|remaster(?:ed)?|clean|explicit)\b/gi, '')
    .replace(/\[[^\]]+\]|\([^)]+\)/g, '')
    .replace(/\s*[-_.]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!rest || /^\d+$/.test(rest)) rest = raw

  return {
    title: rest || null,
    trackNumber: trackNumber != null && Number.isFinite(trackNumber) && trackNumber > 0 ? trackNumber : null,
    discNumber: discNumber != null && Number.isFinite(discNumber) && discNumber > 0 ? discNumber : null,
  }
}

function tokenSimilarity(a: string, b: string): number {
  const left = new Set(normalizeMetadataText(a).split(' ').filter(Boolean))
  const right = new Set(normalizeMetadataText(b).split(' ').filter(Boolean))
  if (left.size === 0 || right.size === 0) return 0
  let matches = 0
  for (const token of left) {
    if (right.has(token)) matches += 1
  }
  return matches / Math.max(left.size, right.size)
}

export function scoreMetadataCandidate(input: {
  title: string
  artist: string
  album?: string | null
  durationSeconds?: number | null
  candidateTitle: string
  candidateArtist: string
  candidateAlbum?: string | null
  candidateDurationSeconds?: number | null
}): number {
  const titleScore = tokenSimilarity(input.title, input.candidateTitle)
  const artistScore = tokenSimilarity(input.artist, input.candidateArtist)
  const albumScore =
    input.album && input.candidateAlbum
      ? tokenSimilarity(input.album, input.candidateAlbum)
      : 0.5
  let durationScore = 0.5
  if (input.durationSeconds && input.candidateDurationSeconds) {
    const delta = Math.abs(input.durationSeconds - input.candidateDurationSeconds)
    durationScore = delta <= 2 ? 1 : delta <= 6 ? 0.75 : delta <= 15 ? 0.45 : 0
  }

  return (titleScore * 0.42) + (artistScore * 0.34) + (albumScore * 0.14) + (durationScore * 0.10)
}
