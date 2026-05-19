import { File } from 'node-taglib-sharp'
import type { TrackMetadataUpdatePayload } from '@shared/types/ipc-contract'

function cleanString(value: string | null | undefined): string | undefined {
  if (value == null) return undefined
  return value.trim()
}

function tagList(value: string | null | undefined): string[] | undefined {
  if (value === undefined) return undefined
  const cleaned = (value ?? '').trim()
  if (!cleaned) return []
  return cleaned
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
}

function normalizedYear(value: string | null | undefined): number | undefined {
  if (value === undefined) return undefined
  const cleaned = (value ?? '').trim()
  if (!cleaned) return 0
  const parsed = Number.parseInt(cleaned, 10)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 9999) {
    throw new Error('Year must be a number between 0 and 9999.')
  }
  return parsed
}

function normalizedPosition(value: number | null | undefined, label: string): number | undefined {
  if (value === undefined) return undefined
  if (value == null) return 0
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a positive integer.`)
  }
  return value
}

export function writeTrackMetadata(filePath: string, payload: TrackMetadataUpdatePayload): void {
  const file = File.createFromPath(filePath)
  try {
    if (file.isPossiblyCorrupt) {
      throw new Error(`File is marked as possibly corrupt: ${file.corruptionReasons.join(', ')}`)
    }
    if (!file.isWritable) {
      throw new Error('This file format is not writable by the metadata engine.')
    }

    const tag = file.tag
    const title = cleanString(payload.title)
    const album = cleanString(payload.album)
    const artist = tagList(payload.artist)
    const albumArtist = tagList(payload.albumArtist)
    const composers = tagList(payload.composer)
    const genres = tagList(payload.genre)
    const year = normalizedYear(payload.year)
    const track = normalizedPosition(payload.trackNumber, 'Track number')
    const trackCount = normalizedPosition(payload.totalTracks, 'Total tracks')
    const disc = normalizedPosition(payload.discNumber, 'Disc number')
    const discCount = normalizedPosition(payload.totalDiscs, 'Total discs')

    if (title !== undefined) tag.title = title
    if (artist !== undefined) tag.performers = artist
    if (album !== undefined) tag.album = album
    if (albumArtist !== undefined) tag.albumArtists = albumArtist
    if (composers !== undefined) tag.composers = composers
    if (genres !== undefined) tag.genres = genres
    if (year !== undefined) tag.year = year
    if (track !== undefined) tag.track = track
    if (trackCount !== undefined) tag.trackCount = trackCount
    if (disc !== undefined) tag.disc = disc
    if (discCount !== undefined) tag.discCount = discCount

    file.save()
  } finally {
    file.dispose()
  }
}
