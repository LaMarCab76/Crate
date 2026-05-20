import { type CSSProperties, type MouseEvent, useEffect, useState } from 'react'
import { Artwork } from './Artwork'
import { Icon } from './Icon'
import { SpectrumVisualizer } from './SpectrumVisualizer'
import { TrackMetaTable } from './TrackMetaTable'
import { VuMeters } from './VuMeters'
import { Waveform } from './Waveform'
import { fmtTime } from '@renderer/utils/format'
import { usePlaybackStore } from '@renderer/stores/playbackStore'
import { useQueueStore } from '@renderer/stores/queueStore'
import type { WaveformResult } from '@shared/types/ipc-contract'
import type { Album, Track } from '@shared/types/library'

interface Props {
  track: Track
  album: Album | undefined
  onToggleMode: () => void
}

// "Studio" fullscreen layout: metadata + artwork (left), spectrum + waveform
// (center), VU meters (right), transport (bottom). The single getWaveform()
// fetch lives here so its peaks feed the waveform and its DR feeds the table.
export function StudioView({ track, album, onToggleMode }: Props) {
  const status = usePlaybackStore(s => s.status)
  const positionSec = usePlaybackStore(s => s.positionSec)
  const durationSec = usePlaybackStore(s => s.durationSec)
  const volume = usePlaybackStore(s => s.volume)
  const togglePlay = useQueueStore(s => s.togglePlay)
  const next = useQueueStore(s => s.next)
  const previous = useQueueStore(s => s.previous)
  const setVolume = useQueueStore(s => s.setVolume)

  const [wave, setWave] = useState<WaveformResult | null>(null)
  const [waveLoading, setWaveLoading] = useState(false)

  useEffect(() => {
    const path = track.path
    if (!path) { setWave(null); return }
    let cancelled = false
    setWave(null)
    setWaveLoading(true)
    void window.api.audio.getWaveform(path)
      .then(res => { if (!cancelled) setWave(res) })
      .catch(() => { if (!cancelled) setWave(null) })
      .finally(() => { if (!cancelled) setWaveLoading(false) })
    return () => { cancelled = true }
  }, [track.path])

  const playing = status === 'playing'

  const onVolumeMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const clamp = (clientX: number) => Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    void setVolume(clamp(e.clientX))
    const onMove = (ev: globalThis.MouseEvent) => void setVolume(clamp(ev.clientX))
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  return (
    <div className="studio-view">
      <div className="studio-grid">
        <div className="studio-left">
          <div className="studio-art-box">
            <div className="studio-art"><Artwork album={album} radius={10} objectFit="contain" /></div>
          </div>
          <div className="studio-id">
            <h2>{track.t}</h2>
            <p className="artist">{track.artist}</p>
            <p className="album">{track.albumTitle}{track.year ? ` · ${track.year}` : ''}</p>
          </div>
          <TrackMetaTable track={track} drApprox={wave?.drApprox ?? null} />
          <button className="mode-pill" onClick={onToggleMode} title="Cambiar a vista Ambient">
            <Icon name="visualizer" size={12} /> STUDIO
          </button>
        </div>

        <div className="studio-center">
          <SpectrumVisualizer mode="full" />
          <div className="studio-wave-block">
            <Waveform peaks={wave?.peaks ?? null} durationSec={durationSec} loading={waveLoading} />
            <div className="studio-wave-times">
              <span>{fmtTime(positionSec)}</span>
              <span>{fmtTime(durationSec)}</span>
            </div>
          </div>
        </div>

        <div className="studio-right">
          <VuMeters track={track} />
        </div>
      </div>

      <div className="studio-transport">
        <div className="studio-transport-side" />
        <div className="studio-transport-center">
          <div className="np-buttons">
            <button className="sub" title="Shuffle"><Icon name="shuffle" size={16} /></button>
            <button title="Previous" onClick={() => { void previous() }}><Icon name="prev" size={20} /></button>
            <button className="play" style={{ width: 44, height: 44 }} onClick={() => { void togglePlay() }} title={playing ? 'Pause' : 'Play'}>
              <Icon name={playing ? 'pause' : 'play'} size={18} />
            </button>
            <button title="Next" onClick={() => { void next() }}><Icon name="next" size={20} /></button>
            <button className="sub active" title="Repeat"><Icon name="repeat" size={16} /></button>
          </div>
          <div className="studio-time">{fmtTime(positionSec)} / {fmtTime(durationSec)}</div>
        </div>
        <div className="studio-transport-side studio-volume pp-volume">
          <span className="ic"><Icon name={volume === 0 ? 'volumeM' : 'volume'} size={15} /></span>
          <div className="slider-wrap" style={{ '--pct': `${volume * 100}%` } as CSSProperties}>
            <div className="track" onMouseDown={onVolumeMouseDown} role="slider" tabIndex={0}>
              <div className="fill" style={{ width: `${volume * 100}%` }} />
            </div>
            <div className="dot" aria-hidden="true" />
          </div>
        </div>
      </div>
    </div>
  )
}
