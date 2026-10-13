import { accessSync, constants as fsConstants, copyFileSync, existsSync } from 'node:fs'
import { ByteVector, File, Picture, PictureType, TagTypes, XiphComment, type IPicture, type Tag } from 'node-taglib-sharp'
import type { TrackMetadataUpdatePayload } from '@shared/types/ipc-contract'

export interface MetadataArtworkPayload {
  data: Buffer
  mimeType: string
}

// Release-level identity of the album a track belongs to. Moving a track out of
// a compilation must not drag the compilation along: its COMPILATION flag,
// MusicBrainz release ids and album ReplayGain all describe the OLD album, and
// the importer would copy them onto the new album row. For each id, a string
// sets it, null clears it and undefined leaves the file untouched.
export interface MetadataReleaseTags {
  isCompilation: boolean
  musicBrainzReleaseId?: string | null
  musicBrainzReleaseGroupId?: string | null
  musicBrainzReleaseArtistId?: string | null
  musicBrainzReleaseType?: string | null
  musicBrainzReleaseStatus?: string | null
  musicBrainzReleaseCountry?: string | null
  // The disc id is a CD TOC fingerprint of the old release; always stale.
  clearMusicBrainzDiscId?: boolean
  // Album gain/peak were measured over the old album.
  clearAlbumReplayGain?: boolean
}

export interface MetadataWriteOptions {
  artwork?: MetadataArtworkPayload | null
  createBackup?: boolean
  release?: MetadataReleaseTags | null
}

export interface MetadataWriteResult {
  backupPath: string | null
}

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

function extensionForMime(mimeType: string): string {
  const cleaned = mimeType.toLowerCase()
  if (cleaned === 'image/png') return 'png'
  if (cleaned === 'image/webp') return 'webp'
  return 'jpg'
}

function backupOnce(path: string): string {
  const backupPath = `${path}.cratebak`
  if (!existsSync(backupPath)) copyFileSync(path, backupPath)
  return backupPath
}

function ensureWritable(path: string): void {
  accessSync(path, fsConstants.W_OK)
}

function artworkPicture(artwork: MetadataArtworkPayload): IPicture {
  const extension = extensionForMime(artwork.mimeType)
  const picture = Picture.fromFullData(
    ByteVector.fromByteArray(artwork.data),
    PictureType.FrontCover,
    artwork.mimeType,
    'cover',
  )
  picture.filename = `cover.${extension}`
  return picture
}

function hasTextPayload(payload: TrackMetadataUpdatePayload): boolean {
  return Object.values(payload).some(value => value !== undefined)
}

// taglib removes the frame/field when given undefined (its typings say string).
function releaseText(value: string | null): string {
  return (value?.trim() || undefined) as unknown as string
}

function xiphComments(file: File): XiphComment[] {
  const tag: unknown = file.getTag(TagTypes.Xiph, false)
  if (tag instanceof XiphComment) return [tag]
  // Ogg containers group one comment per stream.
  const grouped = (tag as { comments?: unknown } | null | undefined)?.comments
  return Array.isArray(grouped) ? grouped.filter((comment): comment is XiphComment => comment instanceof XiphComment) : []
}

function applyReleaseTags(file: File, tag: Tag, release: MetadataReleaseTags): void {
  tag.isCompilation = release.isCompilation
  if (release.musicBrainzReleaseId !== undefined) tag.musicBrainzReleaseId = releaseText(release.musicBrainzReleaseId)
  if (release.musicBrainzReleaseGroupId !== undefined) tag.musicBrainzReleaseGroupId = releaseText(release.musicBrainzReleaseGroupId)
  if (release.musicBrainzReleaseArtistId !== undefined) tag.musicBrainzReleaseArtistId = releaseText(release.musicBrainzReleaseArtistId)
  if (release.musicBrainzReleaseType !== undefined) tag.musicBrainzReleaseType = releaseText(release.musicBrainzReleaseType)
  if (release.musicBrainzReleaseStatus !== undefined) tag.musicBrainzReleaseStatus = releaseText(release.musicBrainzReleaseStatus)
  if (release.musicBrainzReleaseCountry !== undefined) tag.musicBrainzReleaseCountry = releaseText(release.musicBrainzReleaseCountry)
  if (release.clearMusicBrainzDiscId) tag.musicBrainzDiscId = releaseText(null)
  if (release.clearAlbumReplayGain) {
    tag.replayGainAlbumGain = Number.NaN
    tag.replayGainAlbumPeak = Number.NaN
  }
  // taglib writes Vorbis release type/status under the legacy
  // MUSICBRAINZ_ALBUM* names, while Picard and our reader (music-metadata) use
  // RELEASETYPE/RELEASESTATUS. Keep both in sync so a stale "compilation" type
  // can't survive. The release-track id is per-release, so it always goes.
  for (const comment of xiphComments(file)) {
    if (release.musicBrainzReleaseType !== undefined) {
      comment.setFieldAsStrings('RELEASETYPE', ...(release.musicBrainzReleaseType?.trim() ? [release.musicBrainzReleaseType.trim()] : []))
    }
    if (release.musicBrainzReleaseStatus !== undefined) {
      comment.setFieldAsStrings('RELEASESTATUS', ...(release.musicBrainzReleaseStatus?.trim() ? [release.musicBrainzReleaseStatus.trim()] : []))
    }
    comment.removeField('MUSICBRAINZ_RELEASETRACKID')
  }
}

export function writeTrackMetadata(
  filePath: string,
  payload: TrackMetadataUpdatePayload,
  options: MetadataWriteOptions = {},
): MetadataWriteResult {
  if (options.createBackup) ensureWritable(filePath)

  const shouldMutate = hasTextPayload(payload) || options.artwork != null || options.release != null
  const backupPath = shouldMutate && options.createBackup ? backupOnce(filePath) : null
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
    if (options.artwork) {
      const nextFront = artworkPicture(options.artwork)
      const existing = tag.pictures ?? []
      tag.pictures = [
        nextFront,
        ...existing.filter(picture => picture.type !== PictureType.FrontCover),
      ]
    }
    if (options.release) applyReleaseTags(file, tag, options.release)

    if (shouldMutate) file.save()
  } finally {
    file.dispose()
  }

  return { backupPath }
}
