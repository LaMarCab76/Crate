import { dirname, extname, join } from 'node:path'
import type { DbTrack } from '@shared/types/db'

export interface AlbumMoveDestinationPlan {
  directory: string
  filename: string
  destinationPath: string
  usesDiscPrefix: boolean
}

export interface AlbumMoveDuplicate {
  id: number
  title: string
  path: string
  reason: 'slot' | 'title'
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')                          // strip diacritics
    .replace(/[\u2018\u2019\u201a\u201b\u2032`\u00b4']/g, '') // drop straight/curly apostrophes
    .replace(/[\u201c\u201d\u201e\u2033"]/g, '')                  // drop straight/curly quotes
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

function positiveInt(value: number | null | undefined): number | null {
  return Number.isInteger(value) && (value as number) > 0 ? value as number : null
}

function normalizedDisc(value: number | null | undefined): number {
  return positiveInt(value) ?? 1
}

function padTrackNumber(trackNumber: number, totalTracks: number | null): string {
  const width = Math.max(2, String(Math.max(trackNumber, totalTracks ?? 0)).length)
  return String(trackNumber).padStart(width, '0')
}

export function sanitizeAlbumMoveFilenamePart(value: string): string {
  return value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 120)
    || 'Untitled'
}

export function albumMoveFilename(args: {
  title: string
  sourcePath: string
  trackNumber: number
  totalTracks: number | null
  discNumber: number | null
  totalDiscs: number | null
  singleDirectoryMultiDisc: boolean
}): string {
  const ext = extname(args.sourcePath) || '.audio'
  const track = padTrackNumber(args.trackNumber, args.totalTracks)
  const disc = normalizedDisc(args.discNumber)
  const discPrefix = args.singleDirectoryMultiDisc && (args.totalDiscs ?? 0) > 1
    ? `D${disc}-`
    : ''
  return `${discPrefix}${track} - ${sanitizeAlbumMoveFilenamePart(args.title)}${ext}`
}

function mostCommonDirectory(tracks: DbTrack[]): string {
  const counts = new Map<string, { dir: string; count: number }>()
  for (const track of tracks) {
    const dir = dirname(track.path)
    const key = dir.normalize('NFC').toLowerCase()
    const existing = counts.get(key)
    counts.set(key, { dir, count: (existing?.count ?? 0) + 1 })
  }
  const sorted = [...counts.values()].sort((a, b) => b.count - a.count || a.dir.localeCompare(b.dir))
  return sorted[0]?.dir ?? dirname(tracks[0]?.path ?? '.')
}

export function chooseAlbumMoveDirectory(targetTracks: DbTrack[], discNumber: number | null): string {
  if (targetTracks.length === 0) throw new Error('Target album has no local tracks.')
  const disc = positiveInt(discNumber)
  if (disc != null) {
    const sameDisc = targetTracks.filter(track => normalizedDisc(track.disc_number) === disc)
    if (sameDisc.length > 0) return mostCommonDirectory(sameDisc)
  }
  return mostCommonDirectory(targetTracks)
}

export function albumUsesSingleDirectory(targetTracks: DbTrack[]): boolean {
  return new Set(targetTracks.map(track => dirname(track.path).normalize('NFC').toLowerCase())).size <= 1
}

export function planAlbumMoveDestination(args: {
  sourcePath: string
  targetTracks: DbTrack[]
  title: string
  trackNumber: number
  totalTracks: number | null
  discNumber: number | null
  totalDiscs: number | null
}): AlbumMoveDestinationPlan {
  const directory = chooseAlbumMoveDirectory(args.targetTracks, args.discNumber)
  const singleDirectoryMultiDisc = albumUsesSingleDirectory(args.targetTracks) && (args.totalDiscs ?? 0) > 1
  const filename = albumMoveFilename({
    title: args.title,
    sourcePath: args.sourcePath,
    trackNumber: args.trackNumber,
    totalTracks: args.totalTracks,
    discNumber: args.discNumber,
    totalDiscs: args.totalDiscs,
    singleDirectoryMultiDisc,
  })
  return {
    directory,
    filename,
    destinationPath: join(directory, filename),
    usesDiscPrefix: singleDirectoryMultiDisc,
  }
}

export function albumMoveTitlesMatch(left: string | null | undefined, right: string | null | undefined): boolean {
  return normalizeText(left) === normalizeText(right)
}

// Maps the occupied track numbers on a given disc to the track sitting there.
// The source track is skipped, and the first row wins when bad data puts two
// tracks on the same number.
export function albumDiscOccupants(
  targetTracks: DbTrack[],
  sourceTrackId: number,
  discNumber: number | null,
): Map<number, DbTrack> {
  const disc = normalizedDisc(discNumber)
  const occupants = new Map<number, DbTrack>()
  for (const track of targetTracks) {
    if (track.id === sourceTrackId) continue
    if (normalizedDisc(track.disc_number) !== disc) continue
    const number = positiveInt(track.track_number)
    if (number != null && !occupants.has(number)) occupants.set(number, track)
  }
  return occupants
}

// First empty slot in 1..total. When the total is unknown we fall back to the
// highest occupied number, so a "gap" still surfaces but a full contiguous
// album returns null (no free slot — the caller must replace to add a track).
export function firstFreeAlbumSlot(occupants: Map<number, DbTrack>, totalTracks: number | null): number | null {
  const known = positiveInt(totalTracks)
  const max = known ?? (occupants.size > 0 ? Math.max(...occupants.keys()) : 0)
  for (let number = 1; number <= max; number++) {
    if (!occupants.has(number)) return number
  }
  return null
}

export interface AlbumMoveTracklistMatch {
  discNumber: number
  trackNumber: number
  title: string
  score: number
}

// Token overlap of two titles, both normalized. Mirrors tokenSimilarity in
// MetadataCompletionRules but is duplicated here so the planner stays free of
// cross-module runtime imports (it is loaded directly by node --test).
function titleTokenScore(left: string, right: string): number {
  const leftTokens = new Set(normalizeText(left).split(' ').filter(Boolean))
  const rightTokens = new Set(normalizeText(right).split(' ').filter(Boolean))
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0
  let matches = 0
  for (const token of leftTokens) {
    if (rightTokens.has(token)) matches++
  }
  return matches / Math.max(leftTokens.size, rightTokens.size)
}

// Locates the incoming title within an album's official tracklist so a move can
// land on the right slot — even one that is currently a gap in the library copy.
// An exact normalized title scores 1; otherwise we fall back to token overlap.
// Rows on the requested disc are preferred. Returns null below minScore.
export function findTracklistSlot(args: {
  tracklist: { discNumber: number; trackNumber: number; title: string }[]
  title: string
  discNumber: number | null
  minScore?: number
}): AlbumMoveTracklistMatch | null {
  const minScore = args.minScore ?? 0.6
  const preferredDisc = positiveInt(args.discNumber)
  const scored = args.tracklist
    .map(entry => ({
      discNumber: entry.discNumber,
      trackNumber: entry.trackNumber,
      title: entry.title,
      score: albumMoveTitlesMatch(entry.title, args.title) ? 1 : titleTokenScore(entry.title, args.title),
    }))
    .filter(entry => entry.score >= minScore)
  if (scored.length === 0) return null
  scored.sort((a, b) => {
    if (preferredDisc != null) {
      const aPref = a.discNumber === preferredDisc ? 1 : 0
      const bPref = b.discNumber === preferredDisc ? 1 : 0
      if (aPref !== bPref) return bPref - aPref
    }
    if (b.score !== a.score) return b.score - a.score
    return a.trackNumber - b.trackNumber
  })
  return scored[0]
}

export function findAlbumMoveDuplicate(args: {
  targetTracks: DbTrack[]
  sourceTrackId: number
  title: string
  trackNumber: number
  discNumber: number | null
}): AlbumMoveDuplicate | null {
  const targetTitle = normalizeText(args.title)
  const targetDisc = normalizedDisc(args.discNumber)
  for (const track of args.targetTracks) {
    if (track.id === args.sourceTrackId) continue
    const sameSlot = positiveInt(track.track_number) === args.trackNumber &&
      normalizedDisc(track.disc_number) === targetDisc
    if (sameSlot) {
      return { id: track.id, title: track.title, path: track.path, reason: 'slot' }
    }
    if (normalizeText(track.title) === targetTitle) {
      return { id: track.id, title: track.title, path: track.path, reason: 'title' }
    }
  }
  return null
}
