import { Artwork } from './Artwork'
import { CodecStrip } from './CodecStrip'
import { Icon } from './Icon'
import { fmtTime } from '@renderer/utils/format'
import { useAlbumByUiId } from '@renderer/stores/libraryStore'
import { usePlaybackStore } from '@renderer/stores/playbackStore'
import { useQueueStore } from '@renderer/stores/queueStore'

const LYRICS = [
  'Lyrics will appear here once the track has synced lyrics.',
  '',
  '(Lyrics fetching arrives in a later session.)',
]

function Visualizer({ bars = 48 }: { bars?: number }) {
  return (
    <div className="viz">
      {Array.from({ length: bars }).map((_, i) => (
        <i
          key={i}
          style={{
            height: '100%',
            animationDelay: `${(i * 0.04) % 1.4}s`,
            animationDuration: `${0.8 + (i % 5) * 0.18}s`,
          }}
        />
      ))}
    </div>
  )
}

interface NowPlayingFullProps {
  showLyrics: boolean
  setShowLyrics: (v: boolean) => void
  onCollapse: () => void
}

export function NowPlayingFull({ showLyrics, setShowLyrics, onCollapse }: NowPlayingFullProps) {
  const track = usePlaybackStore(s => s.currentTrack)
  const status = usePlaybackStore(s => s.status)
  const positionSec = usePlaybackStore(s => s.positionSec)
  const durationSec = usePlaybackStore(s => s.durationSec)
  const album = useAlbumByUiId(track?.albumId)
  const togglePlay = useQueueStore(s => s.togglePlay)
  const next = useQueueStore(s => s.next)
  const previous = useQueueStore(s => s.previous)

  if (!track) return null

  const playing = status === 'playing'
  const progress = durationSec > 0 ? positionSec / durationSec : 0

  return (
    <div className="np-full">
      <div className="np-full-head">
        <div style={{ width: 70 }} />
        <div style={{ flex: 1, textAlign: 'center', fontSize: 12.5, color: 'var(--text-secondary)', fontWeight: 500 }}>
          Playing from album · {album?.title ?? '—'}
        </div>
        <button className="tb-icon-btn" title="Mini player"><Icon name="album" size={16} /></button>
        <button className="tb-icon-btn" onClick={onCollapse} title="Close"><Icon name="contract" size={14} /></button>
      </div>

      <div className="np-full-body">
        <div className="np-full-left">
          <div className="np-full-art"><Artwork album={album} radius={10} /></div>
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
            <button className={`btn ${showLyrics ? 'primary' : 'ghost'} sm`} onClick={() => setShowLyrics(true)}>Lyrics</button>
            <button className={`btn ${showLyrics ? 'ghost' : 'primary'} sm`} onClick={() => setShowLyrics(false)}>Visualizer</button>
            <div style={{ flex: 1 }} />
            <button className="btn ghost sm"><Icon name="tag" size={12} /> Metadata</button>
          </div>

          {showLyrics ? (
            <div className="lyrics">
              {LYRICS.map((l, i) => (
                l === '' ? <div key={i} style={{ height: 16 }} /> : <div key={i} className="line">{l}</div>
              ))}
            </div>
          ) : (
            <Visualizer bars={64} />
          )}
        </div>
      </div>
    </div>
  )
}
