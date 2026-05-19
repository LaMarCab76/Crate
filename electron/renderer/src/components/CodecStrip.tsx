import type { CodecTier, Track } from '@shared/types/library'

interface CodecInfo {
  codec: string
  bitDepth: number | null
  sampleRate: number | null
  bitrate: number | null
  tier: CodecTier
}

function tierFor(input: { bit?: number; kHz?: number; br?: number; lossless: boolean }): CodecTier {
  const { bit = 0, kHz = 0, br = 0, lossless } = input
  if (lossless) {
    if (bit >= 24 && kHz >= 176) return 'ref'
    if (bit >= 24 && kHz >= 96)  return 'master'
    if (bit >= 24)               return 'studio'
    return 'cd'
  }
  if (br >= 320) return 'high'
  if (br >= 256) return 'mid'
  return 'low'
}

function codecInfo(track: Track | null | undefined): CodecInfo {
  if (!track) return { codec: '', bitDepth: null, sampleRate: null, bitrate: null, tier: 'low' }
  const fmt = track.fmt
  const q = track.q || ''

  if (fmt === 'FLAC' && q.includes('/')) {
    const [bit, kHz] = q.split('/').map(Number)
    const bitrate = Math.round(bit * kHz * 2 * 0.6)
    return { codec: 'FLAC', bitDepth: bit, sampleRate: kHz, bitrate, tier: tierFor({ bit, kHz, lossless: true }) }
  }
  if (fmt === 'M4A' && q === 'ALAC') {
    const bitrate = Math.round(16 * 44.1 * 2 * 0.6)
    return { codec: 'ALAC', bitDepth: 16, sampleRate: 44.1, bitrate, tier: tierFor({ bit: 16, kHz: 44.1, lossless: true }) }
  }
  if (fmt === 'M4A' && q.startsWith('AAC')) {
    const br = parseInt(q.split(' ')[1] || '256', 10)
    return { codec: 'AAC', bitDepth: 16, sampleRate: 44.1, bitrate: br, tier: tierFor({ br, lossless: false }) }
  }
  if (fmt === 'MP3') {
    const br = parseInt(q, 10) || 320
    return { codec: 'MP3', bitDepth: 16, sampleRate: 44.1, bitrate: br, tier: tierFor({ br, lossless: false }) }
  }
  return { codec: fmt, bitDepth: 16, sampleRate: 44.1, bitrate: null, tier: 'low' }
}

export function CodecStrip({ track, compact = false }: { track: Track | null | undefined; compact?: boolean }) {
  const c = codecInfo(track)
  const resText = c.bitDepth && c.sampleRate
    ? (compact ? `${c.bitDepth}/${c.sampleRate}` : `${c.bitDepth}-bit / ${c.sampleRate} kHz`)
    : null
  const brText = c.bitrate != null
    ? (compact ? `${Math.round(c.bitrate)}k` : `${c.bitrate.toLocaleString()} kbps`)
    : null
  return (
    <div className={`codec-strip tier-${c.tier}${compact ? ' compact' : ''}`}>
      {resText && (
        <>
          <span className="res">{resText}</span>
          <span className="sep">·</span>
        </>
      )}
      <span className="codec">{c.codec}</span>
      {brText && (
        <>
          <span className="sep">·</span>
          <span>{brText}</span>
        </>
      )}
    </div>
  )
}

export { codecInfo, tierFor }
