import { useCallback, useEffect, useRef, useState } from 'react'

// Dependency-free row windowing for a fixed-height, `table-layout: fixed` <tbody>.
// Only the rows overlapping the scroll viewport (plus overscan) are rendered; the
// scrolled-away rows are replaced by two spacer rows so the scrollbar geometry and
// the sticky <thead> stay exactly as if every row were present.
//
// Safety: if the scroll parent or a positive row height can't be determined it
// falls back to rendering every row, so it can never hide content by mistake.

export interface VirtualWindow {
  start: number // first row index to render (inclusive)
  end: number // one past the last row index to render (exclusive)
  padTop: number // px of spacer above the rendered rows
  padBottom: number // px of spacer below the rendered rows
}

const fullWindow = (count: number, rowHeight: number): VirtualWindow => ({
  start: 0,
  end: count,
  padTop: 0,
  padBottom: 0 * rowHeight,
})

// Best-effort first paint: assume the list starts at the top (true on mount /
// navigation) and render roughly a viewport's worth so we never paint all N rows.
function initialWindow(count: number, rowHeight: number, overscan: number): VirtualWindow {
  if (rowHeight <= 0) return fullWindow(count, rowHeight)
  const viewportH = typeof window !== 'undefined' ? window.innerHeight : 900
  const end = Math.min(count, Math.ceil(viewportH / rowHeight) + overscan * 2)
  return { start: 0, end, padTop: 0, padBottom: Math.max(0, (count - end) * rowHeight) }
}

function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null
  while (node) {
    const oy = getComputedStyle(node).overflowY
    if (oy === 'auto' || oy === 'scroll') return node
    node = node.parentElement
  }
  return null
}

export function useVirtualRows(
  count: number,
  rowHeight: number,
  overscan = 10,
): { setBody: (el: HTMLTableSectionElement | null) => void; window: VirtualWindow } {
  const [win, setWin] = useState<VirtualWindow>(() => initialWindow(count, rowHeight, overscan))
  const bodyRef = useRef<HTMLTableSectionElement | null>(null)
  const scrollRef = useRef<HTMLElement | null>(null)
  const frame = useRef(0)
  // Latest values read inside the (stable) recompute callback without re-creating it.
  const stateRef = useRef({ count, rowHeight, overscan })
  stateRef.current = { count, rowHeight, overscan }

  const recompute = useCallback(() => {
    const { count, rowHeight, overscan } = stateRef.current
    const body = bodyRef.current
    const scroller = scrollRef.current
    if (!body || !scroller || rowHeight <= 0) {
      setWin(fullWindow(count, rowHeight))
      return
    }
    const scrollRect = scroller.getBoundingClientRect()
    // The <tbody> top stays anchored to the virtual content top (the top spacer
    // occupies scrolled-past space), so this measurement is stable while scrolling.
    const bodyTop = body.getBoundingClientRect().top
    const offsetAbove = scrollRect.top - bodyTop
    const start = Math.max(0, Math.floor(offsetAbove / rowHeight) - overscan)
    const visible = Math.ceil(scrollRect.height / rowHeight) + overscan * 2
    const end = Math.min(count, start + visible)
    const safeStart = Math.min(start, end)
    setWin({
      start: safeStart,
      end,
      padTop: safeStart * rowHeight,
      padBottom: Math.max(0, (count - end) * rowHeight),
    })
  }, [])

  const schedule = useCallback(() => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      recompute()
    })
  }, [recompute])

  const setBody = useCallback((el: HTMLTableSectionElement | null) => {
    bodyRef.current = el
    scrollRef.current = findScrollParent(el)
  }, [])

  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    scroller.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    const ro = new ResizeObserver(schedule)
    ro.observe(scroller)
    recompute()
    return () => {
      scroller.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      ro.disconnect()
      if (frame.current) {
        cancelAnimationFrame(frame.current)
        frame.current = 0
      }
    }
  }, [schedule, recompute])

  // Re-window when the data set or row height changes (filter / sort / density).
  useEffect(() => {
    schedule()
  }, [count, rowHeight, schedule])

  return { setBody, window: win }
}
