import { type CSSProperties, type DragEvent, type MouseEvent, useEffect, useMemo, useState } from 'react'
import { Artwork } from './Artwork'
import { EQBars } from './EQBars'
import { Icon } from './Icon'
import { ContextMenu } from './ContextMenu'
import {
  TRACK_DELETE_ROW_EASE,
  TRACK_DELETE_ROW_MS,
  useAlbumByUiId,
  useDeletingTrackIds,
} from '@renderer/stores/libraryStore'
import { usePlaybackStore } from '@renderer/stores/playbackStore'
import {
  useQueueIndex,
  useQueueReorderMode,
  useQueueStore,
  useQueueTracks,
  useQueueUpNext,
} from '@renderer/stores/queueStore'
import { fmtTime, formatFeatured, splitArtist } from '@renderer/utils/format'
import type { Track } from '@shared/types/library'

export function FullScreenQueue() {
  const track = usePlaybackStore(s => s.currentTrack)
  const status = usePlaybackStore(s => s.status)
  const queueTracks = useQueueTracks()
  const currentIndex = useQueueIndex()
  const upNext = useQueueUpNext()
  const jumpTo = useQueueStore(s => s.jumpTo)
  const moveQueueTrack = useQueueStore(s => s.moveQueueTrack)
  const moveTrackToNext = useQueueStore(s => s.moveTrackToNext)
  const moveTrackToEnd = useQueueStore(s => s.moveTrackToEnd)
  const queueReorderMode = useQueueReorderMode()
  const displayAlbum = useAlbumByUiId(track?.albumId)
  const queueLength = queueTracks.length
  const queueMinMoveIndex = Math.max(currentIndex + 1, 0)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; index: number } | null>(null)
  const [draggingQueueIndex, setDraggingQueueIndex] = useState<number | null>(null)
  const [dragOverQueueIndex, setDragOverQueueIndex] = useState<number | null>(null)
  const clearQueueDragState = () => {
    setDraggingQueueIndex(null)
    setDragOverQueueIndex(null)
  }

  useEffect(() => {
    if (!queueReorderMode || draggingQueueIndex == null) return

    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') clearQueueDragState()
    }
    window.addEventListener('keydown', onEscape)
    return () => {
      window.removeEventListener('keydown', onEscape)
    }
  }, [queueReorderMode, draggingQueueIndex])

  const totalRemainingSec = useMemo(() => upNext.reduce((sum, t) => sum + (t.d ?? 0), 0), [upNext])
  const totalRemainingText = totalRemainingSec > 0 ? fmtTime(totalRemainingSec) : null
  const queueDeleteStyle = {
    '--track-delete-row-duration': `${TRACK_DELETE_ROW_MS}ms`,
    '--track-delete-row-ease': TRACK_DELETE_ROW_EASE,
  } as CSSProperties

  const clampQueueDropIndex = (value: number): number => {
    const maxIndex = Math.max(0, queueLength)
    return Number.isFinite(value)
      ? Math.max(queueMinMoveIndex, Math.min(maxIndex, value))
      : queueMinMoveIndex
  }

  const normalizedDropIndex = (fromIndex: number, targetIndex: number): number => {
    return targetIndex > fromIndex ? targetIndex - 1 : targetIndex
  }

  const shouldPushDown = (index: number): boolean => {
    if (draggingQueueIndex == null || dragOverQueueIndex == null) return false

    const normalizedTarget = normalizedDropIndex(draggingQueueIndex, dragOverQueueIndex)
    if (normalizedTarget === draggingQueueIndex) return false

    if (draggingQueueIndex < normalizedTarget) {
      return index > draggingQueueIndex && index <= normalizedTarget
    }

    return index >= normalizedTarget && index < draggingQueueIndex
  }

  const commitQueueMove = (fromIndex: number, overIndex: number | null) => {
    const clampedTarget = clampQueueDropIndex(overIndex ?? fromIndex)
    const normalized = normalizedDropIndex(fromIndex, clampedTarget)

    if (normalized === fromIndex || normalized < queueMinMoveIndex || normalized >= queueLength) {
      clearQueueDragState()
      return
    }

    moveQueueTrack(fromIndex, normalized)
    clearQueueDragState()
  }

  const confirmQueueReorder = (action: () => void) => {
    action()
  }

  const moveAsNext = (index: number) => {
    confirmQueueReorder(() => {
      moveTrackToNext(index)
    })
    setContextMenu(null)
  }

  const moveAsEnd = (index: number) => {
    confirmQueueReorder(() => {
      moveTrackToEnd(index)
    })
    setContextMenu(null)
  }

  const handleQueueDragStart = (event: DragEvent<HTMLButtonElement>, index: number) => {
    if (!queueReorderMode) return
    if (index <= currentIndex) return

    setDraggingQueueIndex(index)
    setDragOverQueueIndex(clampQueueDropIndex(index))
    event.dataTransfer.setData('text/queue-item', String(index))
    event.dataTransfer.effectAllowed = 'move'
  }

  const handleQueueDragOver = (event: DragEvent<HTMLDivElement>, index: number) => {
    if (!queueReorderMode || draggingQueueIndex == null) return
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const isAfter = event.clientY > rect.top + (rect.height / 2)
    setDragOverQueueIndex(clampQueueDropIndex(index + (isAfter ? 1 : 0)))
  }

  const handleQueueDrop = (event: DragEvent<HTMLDivElement>, index: number) => {
    event.preventDefault()
    if (draggingQueueIndex == null) return
    commitQueueMove(draggingQueueIndex, dragOverQueueIndex ?? index)
  }

  const handleQueueListDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!queueReorderMode || draggingQueueIndex == null) return
    event.preventDefault()
    if (event.currentTarget === event.target) {
      setDragOverQueueIndex(queueLength)
    }
  }

  const handleQueueListDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (event.currentTarget !== event.target) return
    if (!queueReorderMode || draggingQueueIndex == null) return
    clearQueueDragState()
  }

  const handleQueueDragEnd = () => {
    clearQueueDragState()
  }

  const handleQueueListDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    if (draggingQueueIndex == null) return
    commitQueueMove(draggingQueueIndex, dragOverQueueIndex ?? queueLength)
  }

  const openContextMenu = (event: MouseEvent<HTMLDivElement>, index: number) => {
    event.preventDefault()
    setContextMenu({ x: event.clientX, y: event.clientY, index })
  }

  if (!track) {
    return (
      <div className="np-queue-side">
        <div className="np-queue-empty">Nada en reproducción</div>
      </div>
    )
  }

  const { primary: artistPrimary, featured: artistFeatured } = splitArtist(track.artist)

  return (
    <div className="np-queue-side">
      <div className="np-queue-head">
        <h3>A continuación</h3>
        {totalRemainingText && (
          <span className="np-queue-remaining">{totalRemainingText} restantes</span>
        )}
      </div>
      <div
        className={`np-queue-list${queueReorderMode ? ' reorder-mode' : ''}`}
        style={queueDeleteStyle}
        onDragOver={handleQueueListDragOver}
        onDragLeave={handleQueueListDragLeave}
        onDrop={handleQueueListDrop}
        onDragEnd={handleQueueDragEnd}
      >
        <div className="np-queue-section">Reproduciendo</div>
        <div className="np-queue-item now">
          <div className="np-queue-art"><Artwork album={displayAlbum} /></div>
          <div className="np-queue-meta">
            <div className="np-queue-title">{track.t}</div>
            <div className="np-queue-artist">{artistPrimary}</div>
            {artistFeatured.length > 0 && (
              <div className="np-queue-feat">{formatFeatured(artistFeatured)}</div>
            )}
          </div>
          <EQBars active={status === 'playing'} style={{ color: 'var(--text-primary)' }} />
        </div>

        {upNext.length === 0 ? (
          <div className="np-queue-section dim">La cola está vacía</div>
        ) : (
          <>
            <div className="np-queue-section">Próximas</div>
            {upNext.map((t, offset) => {
              const queueIndex = currentIndex + 1 + offset
              return (
                <FullScreenQueueItem
                  key={`${t.id}-${queueIndex}`}
                  track={t}
                  reorderMode={queueReorderMode}
                  dragging={queueIndex === draggingQueueIndex}
                  pushDown={shouldPushDown(queueIndex)}
                  onDoubleClick={() => { void jumpTo(queueIndex) }}
                  onContextMenu={event => openContextMenu(event, queueIndex)}
                  onDragStart={event => handleQueueDragStart(event, queueIndex)}
                  onDragOver={event => handleQueueDragOver(event, queueIndex)}
                  onDrop={event => handleQueueDrop(event, queueIndex)}
                  onDragEnd={handleQueueDragEnd}
                />
              )
            })}
          </>
        )}
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={[
            {
              id: 'move-next',
              label: 'Mover como siguiente',
              icon: 'chevD',
              onSelect: () => moveAsNext(contextMenu.index),
            },
            {
              id: 'move-end',
              label: 'Mover al final',
              icon: 'chevR',
              onSelect: () => moveAsEnd(contextMenu.index),
            },
          ]}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}

function FullScreenQueueItem({
  track,
  reorderMode,
  dragging,
  pushDown,
  onDoubleClick,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  track: Track
  reorderMode?: boolean
  dragging?: boolean
  pushDown?: boolean
  onDoubleClick: () => void
  onContextMenu: (event: MouseEvent<HTMLDivElement>) => void
  onDragStart: (event: DragEvent<HTMLButtonElement>) => void
  onDragOver: (event: DragEvent<HTMLDivElement>) => void
  onDrop: (event: DragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
}) {
  const album = useAlbumByUiId(track.albumId)
  const deletingIds = useDeletingTrackIds()
  const isDeleting = track.dbId != null && deletingIds.has(track.dbId)
  const { primary: artistPrimary, featured: artistFeatured } = splitArtist(track.artist)

  return (
    <div
      className={`np-queue-item${isDeleting ? ' deleting' : ''}${reorderMode ? ' reorder-mode' : ''}${dragging ? ' np-queue-item-dragging' : ''}${pushDown ? ' np-queue-item-push-down' : ''}`}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      style={isDeleting ? { opacity: 0.55 } : undefined}
    >
      {reorderMode && (
        <button
          type="button"
          className="np-queue-drag-handle"
          title="Reordenar"
          draggable
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onMouseDown={event => {
            event.stopPropagation()
          }}
        >
          <Icon name="list" size={12} />
        </button>
      )}
      <div className="np-queue-art"><Artwork album={album} /></div>
      <div className="np-queue-meta">
        <div className="np-queue-title">{track.t}</div>
        <div className="np-queue-artist">{artistPrimary}</div>
        {artistFeatured.length > 0 && (
          <div className="np-queue-feat">{formatFeatured(artistFeatured)}</div>
        )}
      </div>
      <span className="np-queue-dur">{fmtTime(track.d)}</span>
    </div>
  )
}
