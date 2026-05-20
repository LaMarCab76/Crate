import { useEffect, useState } from 'react'
import type { Track } from '@shared/types/library'
import { usePlaybackStore } from '@renderer/stores/playbackStore'
import { channelLayoutLabel, drLabel, fmtGain, replayGainFromLufs } from '@renderer/utils/audioMath'

// kHz label from a sample rate in Hz: integers stay whole (96), fractional
// rates keep one decimal (44.1, 88.2).
function khz(hz: number | null | undefined): string | null {
  if (!hz) return null
  const k = hz / 1000
  return k % 1 === 0 ? `${k}` : k.toFixed(1)
}

// kbps from the real bitrate (bits/sec). Falls back to a PCM-derived estimate
// from the *real* bit depth / sample rate / channels for lossless files that
// don't carry a stored bitrate.
function bitrateKbps(track: Track): number | null {
  if (track.bitrate != null && track.bitrate > 0) return Math.round(track.bitrate / 1000)
  if (track.bitDepth && track.sampleRate && track.channels) {
    return Math.round((track.bitDepth * track.sampleRate * track.channels * 0.6) / 1000)
  }
  return null
}

// Read-only spec sheet for the playing track. Values come straight from the
// real Track fields (NOT CodecStrip's q-string parsing, which fabricates
// 16-bit/44.1 for lossy formats). DR comes from the waveform decode pass.
export function TrackMetaTable({ track, drApprox }: { track: Track; drApprox: number | null }) {
  const streamFreq = usePlaybackStore(s => s.streamInfo?.freq)
  const [device, setDevice] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.api.audio.getOutputDevice()
      .then(d => { if (!cancelled) setDevice(d?.name ?? null) })
      .catch(() => { /* main not ready */ })
    return () => { cancelled = true }
  }, [])

  const sr = khz(track.sampleRate)
  const br = bitrateKbps(track)
  const outFreq = khz(streamFreq ?? track.sampleRate)
  const outFormat = track.bitDepth && outFreq ? `${track.bitDepth}/${outFreq}` : null
  const output = device
    ? (outFormat ? `${device} · ${outFormat}` : device)
    : (outFormat ?? '—')

  const rows: Array<[string, string]> = [
    ['Codec', track.codec || track.fmt || '—'],
    ['Bit depth', track.bitDepth ? `${track.bitDepth}-bit` : '—'],
    ['Sample rate', sr ? `${sr} kHz` : '—'],
    ['Bitrate', br != null ? `${br.toLocaleString()} kbps` : '—'],
    ['Channels', channelLayoutLabel(track.channels)],
    ['Dynamic range', drLabel(drApprox)],
    ['Replay gain', fmtGain(replayGainFromLufs(track.loudness))],
    ['Output', output],
  ]

  return (
    <dl className="track-meta-table">
      {rows.map(([k, v]) => (
        <div className="track-meta-row" key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}
