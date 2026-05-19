import { type CSSProperties, useEffect, useState } from 'react'
import { Artwork } from './Artwork'
import { CodecStrip } from './CodecStrip'
import { EqVisualizerPanel } from './EqVisualizerPanel'
import { Icon } from './Icon'
import { fmtTime } from '@renderer/utils/format'
import { useAlbumByUiId } from '@renderer/stores/libraryStore'
import { usePlaybackStore } from '@renderer/stores/playbackStore'
import { useQueueStore } from '@renderer/stores/queueStore'
import { useTweakStore } from '@renderer/stores/settingsStore'
import { extractDominantColor } from '@renderer/utils/colorExtract'

interface NowPlayingFullProps {
  onCollapse: () => void
}

export function NowPlayingFull({ onCollapse }: NowPlayingFullProps) {
  const track = usePlaybackStore(s => s.currentTrack)
  const status = usePlaybackStore(s => s.status)
  const positionSec = usePlaybackStore(s => s.positionSec)
  const durationSec = usePlaybackStore(s => s.durationSec)
  const album = useAlbumByUiId(track?.albumId)
  const togglePlay = useQueueStore(s => s.togglePlay)
  const next = useQueueStore(s => s.next)
  const previous = useQueueStore(s => s.previous)
  const playerTintSource = useTweakStore(s => s.tweak.playerTintSource)
  const playerTintColor = useTweakStore(s => s.tweak.playerTintColor)
  const artworkPath = track?.artworkPath ?? album?.artworkPath ?? null
  const [artworkTint, setArtworkTint] = useState<string | null>(null)

  useEffect(() => {
    if (playerTintSource !== 'artwork' || !artworkPath) {
      setArtworkTint(null)
      return
    }
    let cancelled = false
    const src = `hifi://artwork/${encodeURIComponent(artworkPath)}`
    void extractDominantColor(src).then(hex => {
      if (!cancelled) setArtworkTint(hex)
    })
    return () => { cancelled = true }
  }, [playerTintSource, artworkPath])

  const tint =
    playerTintSource === 'artwork' ? artworkTint
    : playerTintSource === 'preset' || playerTintSource === 'custom' ? playerTintColor
    : null

  if (!track) return null

  const playing = status === 'playing'
  const progress = durationSec > 0 ? positionSec / durationSec : 0

  return (
    <div className="np-full" style={{ '--np-tint': tint ?? 'transparent' } as CSSProperties}>
      <div className="np-full-head">
        <div style={{ width: 70 }} />
        <div style={{ flex: 1, textAlign: 'center', fontSize: 12.5, color: 'var(--text-secondary)', fontWeight: 500 }}>
          Playing from album · {album?.title ?? '—'}
        </div>
        <button className="np-full-close" onClick={onCollapse} title="Close fullscreen">
          <Icon name="close" size={14} />
        </button>
      </div>

      <div className="np-full-body">
        <div className="np-full-left">
          <div className="np-full-art"><Artwork album={album} radius={10} objectFit="contain" /></div>
          <div className="np-full-title">
            <h2>{track.t}</h2>
            <p>{track.artist} — {track.albumTitle}</p>
            <div style={{ marginTop: 10, display: 'flex', justifyContent: 'center' }}>
              <CodecStrip track={track} />
            </div>
          </div>

          <div className="np-progress" style={{ maxWidth: '90%' }}>
            <span className="time">{fmtTime(positionSec)}</span>
            <div className="np-bar-track"><div className="np-bar-fill" style={{ width: `${progress * 100}%` }} /></div>
            <span className="time">-{fmtTime(Math.max(0, durationSec - positionSec))}</span>
          </div>

          <div className="np-buttons">
            <button className="sub" title="Shuffle"><Icon name="shuffle" size={18} /></button>
            <button title="Previous" onClick={() => { void previous() }}><Icon name="prev" size={22} /></button>
            <button className="play" style={{ width: 44, height: 44 }} onClick={() => { void togglePlay() }} title={playing ? 'Pause' : 'Play'}>
              <Icon name={playing ? 'pause' : 'play'} size={18} />
            </button>
            <button title="Next" onClick={() => { void next() }}><Icon name="next" size={22} /></button>
            <button className="sub active" title="Repeat"><Icon name="repeat" size={18} /></button>
          </div>
        </div>

        <div className="np-full-right">
          <div className="np-full-tabs">
            <div style={{ flex: 1 }} />
            <button className="btn ghost sm"><Icon name="tag" size={12} /> Metadata</button>
          </div>

          <EqVisualizerPanel track={track} />
        </div>
      </div>
    </div>
  )
}
