import { useEffect, useRef, useState } from 'react'
import { useLyrics, useLyricsStore, type LyricLine } from '@renderer/stores/lyricsStore'
import { usePlaybackStore } from '@renderer/stores/playbackStore'
import type { Track } from '@shared/types/library'

interface Props {
  track: Track
  variant?: 'full' | 'sidebar'
}

function findCurrentLineIdx(lines: LyricLine[], positionSec: number): number {
  if (lines.length === 0) return -1
  const posMs = positionSec * 1000
  let lo = 0
  let hi = lines.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (lines[mid].ms <= posMs) lo = mid + 1
    else hi = mid
  }
  return lo - 1
}

export function LyricsPanel({ track, variant = 'full' }: Props) {
  const trackId = track.dbId
  const fetch = useLyricsStore(s => s.fetch)
  const entry = useLyrics(trackId)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const currentLineIdxRef = useRef(-1)
  const [currentLineIdx, setCurrentLineIdx] = useState(-1)
  const isSidebar = variant === 'sidebar'

  useEffect(() => {
    if (trackId == null) return
    void fetch(trackId)
  }, [trackId, fetch])

  useEffect(() => {
    const publishLine = (next: number) => {
      if (currentLineIdxRef.current === next) return
      currentLineIdxRef.current = next
      setCurrentLineIdx(next)
    }

    if (!entry.synced || entry.lines.length === 0) {
      publishLine(-1)
      return
    }

    publishLine(findCurrentLineIdx(entry.lines, usePlaybackStore.getState().positionSec))
    return usePlaybackStore.subscribe((state, prev) => {
      if (state.positionSec === prev.positionSec) return
      publishLine(findCurrentLineIdx(entry.lines, state.positionSec))
    })
  }, [entry.synced, entry.lines])

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
