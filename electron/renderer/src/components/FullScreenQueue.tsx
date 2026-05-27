import { useMemo } from 'react'
import { Artwork } from './Artwork'
import { EQBars } from './EQBars'
import { useAlbumByUiId } from '@renderer/stores/libraryStore'
import { usePlaybackStore } from '@renderer/stores/playbackStore'
import { useQueueIndex, useQueueStore, useQueueTracks, useQueueUpNext } from '@renderer/stores/queueStore'
import { fmtTime } from '@renderer/utils/format'
import type { Track } from '@shared/types/library'

// Right-column queue view for the fullscreen player. Mirrors the queue tab in
// PlayerPane but with bigger spacing and no history strip, so the listener can
// scan what's coming up without leaving the immersive view.
export function FullScreenQueue() {
  const track = usePlaybackStore(s => s.currentTrack)
  const status = usePlaybackStore(s => s.status)
  const queueTracks = useQueueTracks()
  const currentIndex = useQueueIndex()
  const upNext = useQueueUpNext()
  const jumpTo = useQueueStore(s => s.jumpTo)
  const displayAlbum = useAlbumByUiId(track?.albumId)

  const totalRemainingSec = useMemo(() => upNext.reduce((sum, t) => sum + (t.d ?? 0), 0), [upNext])
  const totalRemainingText = totalRemainingSec > 0 ? fmtTime(totalRemainingSec) : null

  if (!track) {
    return (
      <div className="np-queue-side">
        <div className="np-queue-empty">Nada en reproducción</div>
      </div>
    )
  }

  return (
    <div className="np-queue-side">
      <div className="np-queue-head">
        <h3>A continuación</h3>
        {totalRemainingText && (
          <span className="np-queue-remaining">{totalRemainingText} restantes</span>
        )}
      </div>
      <div className="np-queue-list">
        <div className="np-queue-section">Reproduciendo</div>
        <div className="np-queue-item now">
          <div className="np-queue-art"><Artwork album={displayAlbum} /></div>
          <div className="np-queue-meta">
            <div className="np-queue-title">{track.t}</div>
            <div className="np-queue-artist">{track.artist}</div>
          </div>
          <EQBars active={status === 'playing'} style={{ color: 'var(--text-primary)' }} />
        </div>

        {upNext.length === 0 ? (
          <div className="np-queue-section dim">La cola está vacía</div>
        ) : (
          <>
            <div className="np-queue-section">Próximas</div>
            {upNext.map((t, offset) => (
              <FullScreenQueueItem
                key={`${t.id}-${currentIndex + 1 + offset}`}
                track={t}
                onSelect={() => { void jumpTo(currentIndex + 1 + offset) }}
              />
            ))}
          </>
        )}
      </div>
    </div>
  )
}

function FullScreenQueueItem({ track, onSelect }: { track: Track; onSelect: () => void }) {
  const album = useAlbumByUiId(track.albumId)
  return (
    <button type="button" className="np-queue-item" onClick={onSelect}>
      <div className="np-queue-art"><Artwork album={album} /></div>
      <div className="np-queue-meta">
        <div className="np-queue-title">{track.t}</div>
        <div className="np-queue-artist">{track.artist}</div>
      </div>
      <span className="np-queue-dur">{fmtTime(track.d)}</span>
    </button>
  )
}
