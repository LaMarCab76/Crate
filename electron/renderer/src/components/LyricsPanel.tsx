import { useEffect, useMemo, useRef } from 'react'
import { useLyrics, useLyricsStore } from '@renderer/stores/lyricsStore'
import { usePlaybackStore } from '@renderer/stores/playbackStore'
import type { Track } from '@shared/types/library'

interface Props {
  track: Track
  variant?: 'full' | 'sidebar'
}

export function LyricsPanel({ track, variant = 'full' }: Props) {
  const trackId = track.dbId
  const fetch = useLyricsStore(s => s.fetch)
  const entry = useLyrics(trackId)
  const positionSec = usePlaybackStore(s => s.positionSec)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const isSidebar = variant === 'sidebar'

  useEffect(() => {
    if (trackId == null) return
    void fetch(trackId)
  }, [trackId, fetch])

  // Binary search for the latest line whose start time is <= the playhead.
  const currentLineIdx = useMemo(() => {
    if (!entry.synced || entry.lines.length === 0) return -1
    const posMs = positionSec * 1000
    let lo = 0
    let hi = entry.lines.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (entry.lines[mid].ms <= posMs) lo = mid + 1
      else hi = mid
    }
    return lo - 1
  }, [positionSec, entry])

  useEffect(() => {
    if (currentLineIdx < 0) return
    const scroller = scrollerRef.current
    if (!scroller) return
    const lineEl = scroller.querySelector<HTMLElement>(`[data-idx="${currentLineIdx}"]`)
    if (!lineEl) return

    if (isSidebar) {
      const previousLineEl = currentLineIdx > 0
        ? scroller.querySelector<HTMLElement>(`[data-idx="${currentLineIdx - 1}"]`)
        : null
      const targetEl = previousLineEl ?? lineEl
      const target = targetEl.offsetTop - 8
      scroller.scrollTo({ top: target, behavior: 'smooth' })
      return
    }

    const target = lineEl.offsetTop - scroller.clientHeight / 2 + lineEl.clientHeight / 2
    scroller.scrollTo({ top: target, behavior: 'smooth' })
  }, [currentLineIdx, isSidebar])

  if (entry.status === 'loading' || entry.status === 'idle') {
    return (
      <div className={`lyrics ${isSidebar ? 'lyrics-sidebar' : ''}`}>
        <div className="line" style={{ color: 'var(--text-tertiary)' }}>Loading lyrics…</div>
      </div>
    )
  }
  if (entry.status === 'missing' || entry.status === 'error' || entry.lines.length === 0) {
    return (
      <div className={`lyrics ${isSidebar ? 'lyrics-sidebar' : ''}`}>
        <div className="line" style={{ color: 'var(--text-tertiary)' }}>
          No lyrics found for this track.
        </div>
      </div>
    )
  }

  return (
    <div className={`lyrics ${isSidebar ? 'lyrics-sidebar' : ''}`} ref={scrollerRef}>
      {entry.lines.map((l, i) => {
        const distance = entry.synced ? i - currentLineIdx : 0
        if (l.text === '') {
          return <div key={i} className="line spacer" data-idx={i} data-distance={distance} />
        }

        let cls = 'line'
        if (entry.synced) {
          if (distance === 0) cls = 'line now'
          else if (distance === -1) cls = 'line past previous'
          else if (distance < 0) cls = 'line past'
          else if (isSidebar) cls = `line future future-${Math.min(distance, 5)}`
        }

        return (
          <div key={i} className={cls} data-idx={i} data-distance={distance}>{l.text}</div>
        )
      })}
    </div>
  )
}
