import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { Track } from '@shared/types/library'
import { useVirtualRows } from '@renderer/utils/useVirtualRows'
import { Artwork } from './Artwork'
import { CodecStrip } from './CodecStrip'
import { Icon } from './Icon'
import { fmtFileSize, fmtTime } from '@renderer/utils/format'
import { extractDominantColor } from '@renderer/utils/colorExtract'
import {
  TRACK_DELETE_ROW_EASE,
  TRACK_DELETE_ROW_MS,
  useAlbums,
  useDeletingTrackIds,
} from '@renderer/stores/libraryStore'
import { toggleTrackFavorite } from '@renderer/stores/libraryStore'
import { useQueueStore } from '@renderer/stores/queueStore'
import { usePlaybackStore } from '@renderer/stores/playbackStore'
import { useTrackActions } from './MediaActions'
import { SourceBadge } from './SourceBadge'

export interface TrackTableProps {
  tracks: Track[]
  playbackTracks?: Track[]
  showArt?: boolean
  showAlbum?: boolean
  showFmt?: boolean
  showSize?: boolean
  showPlays?: boolean
  showPath?: boolean
  showTrackNo?: boolean
  showSource?: boolean
  // Tighter, fixed row height — used by art-less listings (album/artist tracks)
  // so they don't read like the full-height library/playlist rows.
  compact?: boolean
  onRefreshMetadata?: (track: Track) => void
}

interface DiscTrackGroup {
  key: string
  label: string
  discNumber: number | null
  tracks: Track[]
}

function normalizedDiscNumber(track: Track): number | null {
  return track.discNumber != null && track.discNumber > 0 ? track.discNumber : null
}

function buildDiscTrackGroups(tracks: Track[]): DiscTrackGroup[] {
  const validDiscs = [...new Set(tracks.map(normalizedDiscNumber).filter((disc): disc is number => disc != null))]
  if (validDiscs.length <= 1) return []

  const groups = new Map<string, DiscTrackGroup>()
  for (const track of tracks) {
    const discNumber = normalizedDiscNumber(track)
    const key = discNumber == null ? 'unknown' : String(discNumber)
    let group = groups.get(key)
    if (!group) {
      group = {
        key,
        label: discNumber == null ? 'Sin disco' : `Disco ${discNumber}`,
        discNumber,
        tracks: [],
      }
      groups.set(key, group)
    }
    group.tracks.push(track)
  }

  return [...groups.values()].sort((a, b) => {
    if (a.discNumber == null && b.discNumber == null) return 0
    if (a.discNumber == null) return 1
    if (b.discNumber == null) return -1
    return a.discNumber - b.discNumber
  })
}

export function DiscGroupedTrackTable({ tracks, ...props }: TrackTableProps) {
  const groups = buildDiscTrackGroups(tracks)
  if (groups.length === 0) return <TrackTable tracks={tracks} {...props} />

  return (
    <div className="disc-track-groups">
      {groups.map(group => (
        <section className="disc-track-section" key={group.key}>
          <div className="disc-track-heading">{group.label}</div>
          <TrackTable
            {...props}
            tracks={group.tracks}
            playbackTracks={tracks}
          />
        </section>
      ))}
    </div>
  )
}

export function TrackTable({
  tracks,
  playbackTracks = tracks,
  showArt = false,
  showAlbum = true,
  showFmt = true,
  showSize = false,
  showPlays = true,
  showPath = false,
  showTrackNo = false,
  showSource = true,
  compact = false,
  onRefreshMetadata,
}: TrackTableProps) {
  const albums = useAlbums()
  const deletingIds = useDeletingTrackIds()
  const rowRefs = useRef(new Map<number, HTMLTableRowElement>())
  const animatedRowsRef = useRef(new Map<number, { row: HTMLTableRowElement; cells: HTMLTableCellElement[] }>())

  // Collapse-to-zero animation for deleted rows. CSS alone can't shrink table
  // row layout space, so we drive height + cell height + cell padding with JS
  // transitions. Each <td>'s height must be locked and transitioned to 0
  // alongside the <tr>; otherwise the cell content keeps the row at its
  // natural content height and the row only "half-collapses", which causes a
  // visible jump when the row is finally removed from the DOM.
  // The <tr> cannot be animated reliably with pure CSS-only transitions in every
  // table layout, so we lock geometry in one frame and apply the animated state
  // in the next frame to avoid mid-frame style thrash.
  useEffect(() => {
    const restoreRowDeletionAnimation = (row: HTMLTableRowElement, cells: HTMLTableCellElement[]) => {
      for (const td of cells) {
        td.style.transition = ''
        td.style.height = ''
        td.style.paddingTop = ''
        td.style.paddingBottom = ''
        td.style.overflow = ''
        td.style.boxSizing = ''
      }
      row.style.transition = ''
      row.style.height = ''
      row.style.opacity = ''
      row.style.removeProperty('--track-delete-row-duration')
      row.style.removeProperty('--track-delete-row-ease')
      row.removeAttribute('data-animating')
    }

    for (const [dbId, animated] of animatedRowsRef.current) {
      if (deletingIds.has(dbId)) continue
      restoreRowDeletionAnimation(animated.row, animated.cells)
      animatedRowsRef.current.delete(dbId)
    }

    if (deletingIds.size === 0) return

    for (const dbId of deletingIds) {
      const row = rowRefs.current.get(dbId)
      if (!row || row.dataset.animating === 'true' || animatedRowsRef.current.has(dbId)) continue
      row.dataset.animating = 'true'

      const h = row.getBoundingClientRect().height
      const cells = Array.from(row.cells)
      animatedRowsRef.current.set(dbId, { row, cells })
      cells.forEach(td => {
        const cs = window.getComputedStyle(td)
        td.style.boxSizing = 'border-box'
        td.style.height = `${td.getBoundingClientRect().height}px`
        td.style.paddingTop = cs.paddingTop
        td.style.paddingBottom = cs.paddingBottom
        td.style.overflow = 'hidden'
      })
      row.style.height = `${h}px`
      // Force layout flush so the browser registers the locked values.
      void row.offsetHeight

      row.style.setProperty('--track-delete-row-duration', `${TRACK_DELETE_ROW_MS}ms`)
      row.style.setProperty('--track-delete-row-ease', TRACK_DELETE_ROW_EASE)
      row.style.opacity = '1'

      let finished = false
      const finalize = () => {
        if (finished) return
        finished = true
        row.style.height = '0'
        row.style.opacity = '0'
        cells.forEach(td => {
          td.style.height = '0'
          td.style.paddingTop = '0'
          td.style.paddingBottom = '0'
        })
      }

      const cleanupTransition = () => {
        row.removeEventListener('transitionend', onTransitionEnd)
        window.clearTimeout(fallback)
        finalize()
      }

      const onTransitionEnd = (event: TransitionEvent) => {
        if (event.target !== row || event.propertyName !== 'height') return
        cleanupTransition()
      }

      const fallback = window.setTimeout(cleanupTransition, TRACK_DELETE_ROW_MS + 80)
      row.addEventListener('transitionend', onTransitionEnd, { once: true })

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          row.style.height = '0'
          row.style.opacity = '0'
          cells.forEach(td => {
            td.style.transition = `height var(--track-delete-row-duration) var(--track-delete-row-ease), padding-top var(--track-delete-row-duration) var(--track-delete-row-ease), padding-bottom var(--track-delete-row-duration) var(--track-delete-row-ease)`
            td.style.height = '0'
            td.style.paddingTop = '0'
            td.style.paddingBottom = '0'
          })
          row.style.transition = `height var(--track-delete-row-duration) var(--track-delete-row-ease), opacity var(--track-delete-row-duration) var(--track-delete-row-ease)`
        })
      })
    }
  }, [deletingIds])

  // O(1) album lookups instead of an albums.find() scan per rendered row.
  const albumById = useMemo(() => {
    const m = new Map<string, (typeof albums)[number]>()
    for (const a of albums) m.set(a.id, a)
    return m
  }, [albums])
  const playNow = useQueueStore(s => s.playNow)
  const togglePlay = useQueueStore(s => s.togglePlay)
  const currentTrack = usePlaybackStore(s => s.currentTrack)
  const status = usePlaybackStore(s => s.status)
  const playingId = currentTrack?.id
  const playing = status === 'playing'
  const showRefreshAction = onRefreshMetadata != null
  const trackActions = useTrackActions()
  const playingAlbum = currentTrack ? albumById.get(currentTrack.albumId) : undefined
  const playingArtworkPath = currentTrack?.artworkPath ?? playingAlbum?.artworkPath ?? null
  const playingFallbackTint = playingAlbum?.palette[1] ?? 'var(--color-playing)'
  const [playingTint, setPlayingTint] = useState<string | null>(null)
  const playingRowStyle = {
    '--track-playing-tint': playingTint ?? playingFallbackTint,
  } as CSSProperties

  useEffect(() => {
    setPlayingTint(null)
    if (!playingArtworkPath) return

    let cancelled = false
    const src = `crate://artwork/${encodeURIComponent(playingArtworkPath)}`
    void extractDominantColor(src).then(hex => {
      if (!cancelled && hex) setPlayingTint(hex)
    })

    return () => { cancelled = true }
  }, [playingArtworkPath])

  // Row virtualization. table-layout is fixed and every row is the same height, so
  // we measure one real row and replace off-screen rows with two spacer rows —
  // keeping the scrollbar geometry and the sticky <thead> intact.
  const [measuredRowH, setMeasuredRowH] = useState(0)
  const rowHeight = measuredRowH || (compact ? 40 : 56)
  const { setBody, window: vwin } = useVirtualRows(tracks.length, rowHeight)
  const measureRow = useCallback((el: HTMLTableRowElement | null) => {
    if (!el) return
    const h = el.offsetHeight
    if (h > 0) setMeasuredRowH(prev => (prev === h ? prev : h))
  }, [])
  const colCount =
    3 + [showArt, showAlbum, showPath, showSource, showPlays, showFmt, showSize, showRefreshAction].filter(Boolean).length

  return (
    <>
      <table className={`tbl${compact ? ' compact' : ''}`}>
        <thead>
          <tr>
            <th className="num">{showTrackNo ? '#' : null}</th>
            {showArt && <th className="art" />}
            <th className="title">Title</th>
            {showAlbum && <th>Album</th>}
            {showPath && <th className="path">Ruta</th>}
            {showSource && <th className="source">Fuente</th>}
            {showPlays && <th className="plays">Plays</th>}
            {showFmt && <th className="fmt">Format</th>}
            {showSize && <th className="size">Size</th>}
            <th className="dur">Time</th>
            {showRefreshAction && <th className="actions" />}
          </tr>
        </thead>
        <tbody ref={setBody}>
          {vwin.padTop > 0 && (
            <tr aria-hidden style={{ height: vwin.padTop, background: 'none' }}>
              <td colSpan={colCount} style={{ height: vwin.padTop, padding: 0, border: 0 }} />
            </tr>
          )}
          {tracks.slice(vwin.start, vwin.end).map((t, k) => {
            const i = vwin.start + k
            const isP = t.id === playingId
            const album = showArt ? albumById.get(t.albumId) : undefined
            const pathValue = t.path ?? ''
            const canRefresh = t.dbId != null && t.provider !== 'onedrive'
            const displayTrackNumber = showTrackNo ? (t.no || i + 1) : null
            const isDeleting = t.dbId != null && deletingIds.has(t.dbId)
            return (
              <tr
                ref={el => {
                  if (k === 0) measureRow(el)
                  if (t.dbId != null) {
                    if (el) rowRefs.current.set(t.dbId, el)
                    else rowRefs.current.delete(t.dbId)
                  }
                }}
                key={t.id}
                className={[isP ? 'playing' : '', isDeleting ? 'deleting' : ''].filter(Boolean).join(' ')}
                style={isP ? playingRowStyle : undefined}
                onContextMenu={e => trackActions.openTrackMenu(e, t)}
                onDoubleClick={() => { void playNow(t, playbackTracks) }}
              >
                <td className={`num ${t.dbId != null ? 'has-like' : ''}`}>
                  <span className="track-index">
                    {isP ? (
                      <button
                        type="button"
                        className="tb-icon-btn"
                        style={{
                          width: '100%',
                          height: 22,
                          color: 'inherit',
                          padding: 0,
                          justifyContent: 'center',
                        }}
                        title={playing ? 'Pause' : 'Play'}
                        aria-label={playing ? 'Pause' : 'Play'}
                        onClick={e => {
                          e.stopPropagation()
                          void togglePlay()
                        }}
                        onDoubleClick={e => e.stopPropagation()}
                      >
                        <Icon name={playing ? 'pause' : 'play'} size={13} />
                      </button>
                    ) : displayTrackNumber}
                  </span>
                  {t.dbId != null && (
                    <button
                      type="button"
                      className="tb-icon-btn track-like"
                      onClick={e => {
                        e.stopPropagation()
                        void toggleTrackFavorite(t.dbId!, !t.loved)
                      }}
                      onDoubleClick={e => e.stopPropagation()}
                      title={t.loved ? 'Remove from favorites' : 'Mark as favorite'}
                    >
                      <Icon name={t.loved ? 'heartF' : 'heart'} size={13} />
                    </button>
                  )}
                </td>
                {showArt && (
                  <td className="art">
                    <div className="mini-art">
                      <Artwork album={album} radius={3} />
                    </div>
                  </td>
                )}
                <td className="title">
                  <span className="title-main">{t.t}</span>
                  {!showArt && showAlbum && <span className="title-sub">{t.artist}</span>}
                </td>
                {showAlbum && <td className="sec">{t.albumTitle}</td>}
                {showPath && <td className="path" title={t.path}>{pathValue}</td>}
                {showSource && <td className="source"><SourceBadge folderId={t.folderId} provider={t.provider} compact /></td>}
                {showPlays && <td className="plays">{t.plays}</td>}
                {showFmt && <td className="fmt"><CodecStrip track={t} compact /></td>}
                {showSize && <td className="size">{fmtFileSize(t.fileSize)}</td>}
                <td className="dur">{fmtTime(t.d)}</td>
                {showRefreshAction && (
                  <td className="actions">
                    <button
                      type="button"
                      className="tb-icon-btn"
                      onClick={e => {
                        e.stopPropagation()
                        if (canRefresh) onRefreshMetadata(t)
                      }}
                      onDoubleClick={e => e.stopPropagation()}
                      title="Actualizar metadatos"
                      disabled={!canRefresh}
                    >
                      <Icon name="rotate" size={13} />
                    </button>
                  </td>
                )}
              </tr>
            )
          })}
          {vwin.padBottom > 0 && (
            <tr aria-hidden style={{ height: vwin.padBottom, background: 'none' }}>
              <td colSpan={colCount} style={{ height: vwin.padBottom, padding: 0, border: 0 }} />
            </tr>
          )}
        </tbody>
      </table>
      {trackActions.elements}
    </>
  )
}
