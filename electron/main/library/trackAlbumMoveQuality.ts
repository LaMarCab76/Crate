import type { DbTrack } from '@shared/types/db'
import type { TrackAlbumMoveQuality } from '@shared/types/ipc-contract'

// Formats/codecs that preserve the original signal bit-for-bit. Anything not in
// this set is treated as lossy (mp3, aac, ogg/vorbis, opus, wma...).
const LOSSLESS_TOKENS = new Set([
  'flac', 'alac', 'wav', 'wave', 'aiff', 'aif', 'aifc', 'pcm', 'lpcm',
  'ape', 'wavpack', 'wv', 'tak', 'tta', 'als', 'dsd', 'dsf', 'dff', 'mlp', 'truehd',
])

function token(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

export function isLosslessAudio(format: string | null | undefined, codec?: string | null): boolean {
  // ALAC ships inside an .m4a/mp4 container, so the codec is more reliable than
  // the container format when both are present.
  const c = token(codec)
  if (c) {
    if (LOSSLESS_TOKENS.has(c)) return true
    if (c.includes('alac') || c.includes('pcm') || c.includes('flac')) return true
  }
  const f = token(format)
  if (LOSSLESS_TOKENS.has(f)) return true
  return f.includes('flac') || f.includes('alac') || f.includes('aiff') || f.includes('wav')
}

type QualityRow = Pick<DbTrack, 'format' | 'codec' | 'sample_rate' | 'bit_depth'>

export function summarizeTrackQuality(track: QualityRow): TrackAlbumMoveQuality {
  return {
    format: track.format,
    lossless: isLosslessAudio(track.format, track.codec),
    sampleRate: track.sample_rate ?? null,
    bitDepth: track.bit_depth ?? null,
  }
}

// >0 → incoming wins, <0 → existing wins, 0 → tie.
// Ranking per product decision: lossless beats lossy, then higher sample rate,
// then higher bit depth. Bitrate is intentionally ignored (it isn't comparable
// across codecs and says nothing useful for lossless files).
export function compareTrackQuality(
  incoming: TrackAlbumMoveQuality,
  existing: TrackAlbumMoveQuality,
): number {
  if (incoming.lossless !== existing.lossless) return incoming.lossless ? 1 : -1
  const sampleRateDelta = (incoming.sampleRate ?? 0) - (existing.sampleRate ?? 0)
  if (sampleRateDelta !== 0) return sampleRateDelta > 0 ? 1 : -1
  const bitDepthDelta = (incoming.bitDepth ?? 0) - (existing.bitDepth ?? 0)
  if (bitDepthDelta !== 0) return bitDepthDelta > 0 ? 1 : -1
  return 0
}

// Compact human label like "FLAC lossless 96kHz 24bit" for warnings/UI copy.
export function describeTrackQuality(quality: TrackAlbumMoveQuality): string {
  const parts = [
    quality.format ? quality.format.toUpperCase() : null,
    quality.lossless ? 'lossless' : 'lossy',
    quality.sampleRate ? `${+(quality.sampleRate / 1000).toFixed(1)}kHz` : null,
    quality.bitDepth ? `${quality.bitDepth}bit` : null,
  ]
  return parts.filter(Boolean).join(' ')
}
