import { normalizeName } from '../db/repositories/normalize'

// Strip version/edition noise that should NOT block a match. We deliberately do
// NOT strip "live"/"remix" here (they may be the real title); those are handled
// by the scoring penalties below, which only fire on a one-sided mismatch.
const NOISE_PAREN = /\s*[([](?:remaster(?:ed)?(?:\s*\d{2,4})?|\d{2,4}\s*remaster(?:ed)?|explicit|clean|deluxe(?:\s*edition)?|bonus track|mono|stereo|anniversary(?:\s*edition)?)[)\]]\s*/gi
const NOISE_TRAIL = /\s*-\s*(?:\d{2,4}\s*)?remaster(?:ed)?(?:\s*\d{2,4})?\s*$/i
const FEAT_RE = /\s*(?:feat\.?|ft\.?|featuring|with)\s+.*$/i

export function normalizeTitle(s: string): string {
  return normalizeName(s.replace(NOISE_PAREN, ' ').replace(NOISE_TRAIL, ''))
}

export function normalizeArtist(s: string): string {
  return normalizeName(s.replace(FEAT_RE, '').replace(/\//g, ' '))
}

export function normalizeAlbum(s: string): string {
  return normalizeName(s.replace(NOISE_PAREN, ' ').replace(NOISE_TRAIL, ''))
}

function hasWord(s: string, word: string): boolean {
  return new RegExp(`\\b${word}\\b`, 'i').test(s)
}

function tokenSet(s: string): Set<string> {
  return new Set(s.split(' ').filter(Boolean))
}

function shareToken(a: Set<string>, b: Set<string>): boolean {
  for (const t of a) if (b.has(t)) return true
  return false
}

export interface ScoreInput {
  fileTitle: string
  fileArtist: string
  fileAlbum: string | null
  fileDuration: number | null // seconds
  candTitle: string
  candArtist: string
  candAlbum: string | null
  candDuration: number | null // seconds
}

// Scoring per the feature spec.
export function scoreCandidate(i: ScoreInput): number {
  let score = 0

  const nFileTitle = normalizeTitle(i.fileTitle)
  const nCandTitle = normalizeTitle(i.candTitle)
  if (nFileTitle && nFileTitle === nCandTitle) score += 40

  const nFileArtist = normalizeArtist(i.fileArtist)
  const nCandArtist = normalizeArtist(i.candArtist)
  const artistMatch = nFileArtist !== '' && nFileArtist === nCandArtist
  if (artistMatch) score += 30

  if (i.fileAlbum && i.candAlbum && normalizeAlbum(i.fileAlbum) === normalizeAlbum(i.candAlbum)) {
    score += 15
  }

  if (i.fileDuration != null && i.candDuration != null) {
    const delta = Math.abs(i.fileDuration - i.candDuration)
    if (delta <= 2) score += 15
    else if (delta <= 5) score -= 20
    else score -= 50
  }

  for (const word of ['live', 'remix', 'karaoke']) {
    if (hasWord(i.candTitle, word) && !hasWord(i.fileTitle, word)) score -= 25
  }

  if (!artistMatch && !shareToken(tokenSet(nFileArtist), tokenSet(nCandArtist))) {
    score -= 50
  }

  return score
}

export const ACCEPT_AUTO = 80 // >= accept automatically
export const ACCEPT_REVIEW = 60 // 60..79 candidate, needs review; < 60 reject

// The /get endpoint already matched server-side; accept it when duration is
// compatible (within 3s) or unknown.
export function isExactDurationCompatible(fileDur: number | null, candDur: number | null): boolean {
  if (fileDur == null || candDur == null) return true
  return Math.abs(fileDur - candDur) <= 3
}

export function toConfidence(score: number): number {
  return Math.max(0, Math.min(1, score / 100))
}
