// Content identity of a track, used to decide whether it "changed" between PC
// and device. Only stable musical metadata is included: two copies of the same
// track (with a different mtime/size after being copied or having its artwork
// optimized) must produce the SAME fingerprint and count as common. When the
// duration or a relevant tag differs, the tracks are treated as different
// (replace/update). relativePath (already the match key), fileSize and
// dateModified are deliberately omitted because they are volatile across copies.
export interface FingerprintInput {
  duration: number
  title: string
  artist: string
  album: string
  albumArtist: string | null
  format: string
}

export function trackFingerprint(track: FingerprintInput): string {
  return [
    Math.round(track.duration || 0),
    track.title.trim().toLowerCase(),
    track.artist.trim().toLowerCase(),
    track.album.trim().toLowerCase(),
    (track.albumArtist ?? '').trim().toLowerCase(),
    track.format.trim().toLowerCase(),
  ].join('|')
}
