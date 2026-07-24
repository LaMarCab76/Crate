import type { LibraryProvider, LibraryRole } from '@shared/types/library-locations'
import {
  diceTokenSimilarity,
  isUnknownArtist,
  normalizeDuplicateTitle,
  normalizePrimaryArtist,
  type NormalizedDuplicateTitle,
} from './normalization.ts'

export const DUPLICATE_TITLE_SIMILARITY_THRESHOLD = 0.8
export const DUPLICATE_UNKNOWN_ARTIST_DURATION_SECONDS = 3
export const DUPLICATE_DURATION_HARD_CAP_SECONDS = 30

export interface DuplicatePrefilterTrack {
  id: number
  artist: string
  primaryArtist?: string | null
  title: string
  duration: number
  provider: LibraryProvider
  libraryRole: LibraryRole
}

export interface DuplicatePrefilterPair<T extends DuplicatePrefilterTrack = DuplicatePrefilterTrack> {
  lowTrack: T
  highTrack: T
  normalizedArtist: string
  lowTitle: NormalizedDuplicateTitle
  highTitle: NormalizedDuplicateTitle
  titleSimilarity: number
  durationDifferenceSeconds: number
  allowedDurationDifferenceSeconds: number
}

interface PreparedTrack<T extends DuplicatePrefilterTrack> {
  track: T
  normalizedArtist: string
  normalizedTitle: NormalizedDuplicateTitle
  unknownArtist: boolean
}

export function allowedDurationDifference(leftSeconds: number, rightSeconds: number): number {
  const longer = Math.max(0, leftSeconds, rightSeconds)
  return Math.min(
    DUPLICATE_DURATION_HARD_CAP_SECONDS,
    Math.max(6, longer * 0.05),
  )
}

export function isDuplicatePrefilterPair<T extends DuplicatePrefilterTrack>(
  left: T,
  right: T,
): DuplicatePrefilterPair<T> | null {
  if (left.id === right.id) return null
  if (left.libraryRole !== 'library' || right.libraryRole !== 'library') return null
  if (!['local', 'onedrive'].includes(left.provider) || !['local', 'onedrive'].includes(right.provider)) {
    return null
  }
  if (!Number.isFinite(left.duration) || !Number.isFinite(right.duration)) return null
  if (left.duration < 0 || right.duration < 0) return null

  const leftArtist = normalizePrimaryArtist(left.primaryArtist ?? left.artist)
  const rightArtist = normalizePrimaryArtist(right.primaryArtist ?? right.artist)
  const leftUnknown = isUnknownArtist(leftArtist)
  const rightUnknown = isUnknownArtist(rightArtist)
  if (leftUnknown !== rightUnknown) return null
  if (!leftUnknown && leftArtist !== rightArtist) return null

  const unknownArtist = leftUnknown && rightUnknown
  const lowTrack = left.id < right.id ? left : right
  const highTrack = left.id < right.id ? right : left
  const leftTitle = normalizeDuplicateTitle(left.title)
  const rightTitle = normalizeDuplicateTitle(right.title)
  const lowTitle = left.id < right.id ? leftTitle : rightTitle
  const highTitle = left.id < right.id ? rightTitle : leftTitle
  const titleSimilarity = leftTitle.base === rightTitle.base
    ? 1
    : diceTokenSimilarity(leftTitle.tokens, rightTitle.tokens)
  if (unknownArtist && leftTitle.base !== rightTitle.base) return null
  if (!unknownArtist && titleSimilarity < DUPLICATE_TITLE_SIMILARITY_THRESHOLD) return null

  const durationDifferenceSeconds = Math.abs(left.duration - right.duration)
  const allowedDurationDifferenceSeconds = unknownArtist
    ? DUPLICATE_UNKNOWN_ARTIST_DURATION_SECONDS
    : allowedDurationDifference(left.duration, right.duration)
  if (durationDifferenceSeconds > allowedDurationDifferenceSeconds) return null

  return {
    lowTrack,
    highTrack,
    normalizedArtist: unknownArtist ? '__unknown_artist__' : leftArtist,
    lowTitle,
    highTitle,
    titleSimilarity,
    durationDifferenceSeconds,
    allowedDurationDifferenceSeconds,
  }
}

/**
 * Builds pairs inside artist buckets and a 30-second duration window. This
 * avoids comparing unrelated artists or the entire library cartesian product.
 */
export function buildDuplicatePrefilterPairs<T extends DuplicatePrefilterTrack>(
  tracks: readonly T[],
): DuplicatePrefilterPair<T>[] {
  const groups = new Map<string, Array<PreparedTrack<T>>>()
  for (const track of tracks) {
    if (track.libraryRole !== 'library') continue
    if (!Number.isInteger(track.id) || track.id <= 0 || !Number.isFinite(track.duration)) continue
    const primaryArtist = normalizePrimaryArtist(track.primaryArtist ?? track.artist)
    const unknownArtist = isUnknownArtist(primaryArtist)
    const normalizedArtist = unknownArtist ? '__unknown_artist__' : primaryArtist
    const prepared: PreparedTrack<T> = {
      track,
      normalizedArtist,
      normalizedTitle: normalizeDuplicateTitle(track.title),
      unknownArtist,
    }
    const group = groups.get(normalizedArtist)
    if (group) group.push(prepared)
    else groups.set(normalizedArtist, [prepared])
  }

  const results: DuplicatePrefilterPair<T>[] = []
  const seen = new Set<string>()
  for (const group of groups.values()) {
    group.sort((left, right) => left.track.duration - right.track.duration || left.track.id - right.track.id)
    const tokenFrequency = new Map<string, number>()
    for (const item of group) {
      for (const token of item.normalizedTitle.tokens) {
        tokenFrequency.set(token, (tokenFrequency.get(token) ?? 0) + 1)
      }
    }
    const prefixTokens = new Map<PreparedTrack<T>, string[]>()
    for (const item of group) {
      const ordered = [...item.normalizedTitle.tokens].sort((left, right) =>
        (tokenFrequency.get(left) ?? 0) - (tokenFrequency.get(right) ?? 0)
        || left.localeCompare(right),
      )
      // At Dice >= .8 the smaller title can contain at most one third
      // unmatched tokens. Global-frequency prefix filtering guarantees that a
      // valid pair shares at least one indexed token, while common words such
      // as "song" no longer create a quadratic scan.
      const requiredOverlapFloor = Math.ceil(2 * ordered.length / 3)
      const prefixLength = Math.max(0, ordered.length - requiredOverlapFloor + 1)
      prefixTokens.set(item, ordered.slice(0, prefixLength))
    }
    const byBase = new Map<string, Set<PreparedTrack<T>>>()
    const byToken = new Map<string, Set<PreparedTrack<T>>>()
    let activeStart = 0

    const updateIndex = (
      index: Map<string, Set<PreparedTrack<T>>>,
      key: string,
      item: PreparedTrack<T>,
      add: boolean,
    ) => {
      if (add) {
        const values = index.get(key)
        if (values) values.add(item)
        else index.set(key, new Set([item]))
        return
      }
      const values = index.get(key)
      values?.delete(item)
      if (values?.size === 0) index.delete(key)
    }

    for (const current of group) {
      const cap = current.unknownArtist
        ? DUPLICATE_UNKNOWN_ARTIST_DURATION_SECONDS
        : DUPLICATE_DURATION_HARD_CAP_SECONDS
      while (
        activeStart < group.length
        && current.track.duration - group[activeStart].track.duration > cap
      ) {
        const expired = group[activeStart++]
        updateIndex(byBase, expired.normalizedTitle.base, expired, false)
        for (const token of prefixTokens.get(expired) ?? []) updateIndex(byToken, token, expired, false)
      }

      // Exact-title and token inverted indexes make the prefilter
      // output-sensitive: unrelated titles do not create a cartesian scan.
      const possible = new Set(byBase.get(current.normalizedTitle.base) ?? [])
      if (!current.unknownArtist) {
        for (const token of prefixTokens.get(current) ?? []) {
          for (const item of byToken.get(token) ?? []) possible.add(item)
        }
      }
      for (const previous of possible) {
        const pair = isDuplicatePrefilterPair(previous.track, current.track)
        if (!pair) continue
        const key = `${pair.lowTrack.id}:${pair.highTrack.id}`
        if (seen.has(key)) continue
        seen.add(key)
        results.push(pair)
      }

      updateIndex(byBase, current.normalizedTitle.base, current, true)
      for (const token of prefixTokens.get(current) ?? []) updateIndex(byToken, token, current, true)
    }
  }

  return results.sort((left, right) =>
    left.lowTrack.id - right.lowTrack.id || left.highTrack.id - right.highTrack.id,
  )
}
