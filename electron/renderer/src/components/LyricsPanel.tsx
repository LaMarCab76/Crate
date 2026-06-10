import { Fragment, type CSSProperties, type DragEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { LYRICS_OFFSET_LIMIT_MS, clampLyricsOffsetMs, currentLineIndex as findCurrentLineIndex, isSyncedLrc, type LrcLine } from '@shared/lyrics/lrc'
import { setLyricsPanelVisible, useLyricsStore } from '@renderer/stores/lyricsStore'
import { usePlaybackStore } from '@renderer/stores/playbackStore'
import { useQueueStore } from '@renderer/stores/queueStore'
import { useTweakStore } from '@renderer/stores/settingsStore'
import { lyricsAutoScrollDecision, pauseLyricsAutoScroll } from '@renderer/utils/lyricsAutoScroll'
import { Icon } from './Icon'
import { ModalShell } from './ModalShell'

interface LyricsPanelProps {
  variant: 'pane' | 'inline' | 'current' | 'side' | 'full'
  showActions?: boolean
  showInlineHeader?: boolean
  sidePaneOpen?: boolean
  onToggleSidePane?: () => void
  active?: boolean
  focusedFlow?: boolean
  focusLinesAfter?: number
}

type SyncedWindow = 'all' | 'preview' | 'current' | 'flow'
type VisibleSyncedLine = { line: LrcLine; index: number }
type LyricsWaitRange = { key: string; startSec: number; endSec: number }
type LyricsLineSplit = { first: string; second: string }
type LyricsFlowSnapshot = {
  trackId: number | null
  parsed: object | null
  positionSec: number
  displayTimeSec: number
  totalOffsetMs: number
  activeIndex: number
  tops: Map<number, number>
}
type LyricsPlayheadSnapshot = {
  trackId: number | null
  parsed: object | null
  positionSec: number
  totalOffsetMs: number
  activeIndex: number
}
type LyricsFlowChainMeta = {
  activeGroup: number
  groupByLineIndex: Map<number, number>
}

const FLOW_LINES_BEFORE = 1
const FLOW_LINES_AFTER = 28
const LYRICS_FLOW_LEAD_MS = 700
const FLOW_SEEK_TIME_JUMP_SEC = 2.25
const FLOW_SEEK_LINE_JUMP = 4
const FLOW_OFFSET_JUMP_MS = 250
const FLOW_DURATION_MIN_MS = 520
const FLOW_DURATION_MAX_MS = 760
const FLOW_ENTER_OFFSET_PX = 18
const FLOW_CHAIN_DELAY_STEP_MS = 100
const FLOW_CHAIN_DELAY_MAX_MS = 800
const FLOW_SPRING_EASE = 'cubic-bezier(0.18, 0.9, 0.22, 1.02)'
const FLOW_TONE_DURATION_MS = 620
const FLOW_EXIT_TONE_DURATION_MS = 440
const LYRICS_WAIT_GAP_THRESHOLD_SEC = 1
// How far the first wrapped row may outgrow the second (as a fraction of the
// available width) before we stop favouring a fuller top line. Higher = fills
// the first row more greedily; 0 = perfectly balanced split.
const LYRICS_SPLIT_BALANCE_TOLERANCE = 0.4
const FLOW_INSTANT_VISUAL_TRANSITION = [
  `opacity var(--lyr-flow-tone-duration, ${FLOW_TONE_DURATION_MS}ms) ease var(--lyr-flow-tone-delay, 0ms)`,
  `color var(--lyr-flow-tone-duration, ${FLOW_TONE_DURATION_MS}ms) ease var(--lyr-flow-tone-delay, 0ms)`,
  `filter var(--lyr-flow-tone-duration, ${FLOW_TONE_DURATION_MS}ms) ease var(--lyr-flow-tone-delay, 0ms)`,
  `background ${Math.round(FLOW_TONE_DURATION_MS * 0.82)}ms ease`,
].join(', ')
const FLOW_MOTION_TRANSITION = [
  `transform var(--lyr-flow-duration) ${FLOW_SPRING_EASE} var(--lyr-flow-delay, 0ms)`,
  FLOW_INSTANT_VISUAL_TRANSITION,
].join(', ')

type LyricsFlowStyle = CSSProperties & Record<`--${string}`, string | number>

function windowForVariant(variant: LyricsPanelProps['variant']): SyncedWindow {
  if (variant === 'inline') return 'preview'
  if (variant === 'current') return 'current'
  if (variant === 'full') return 'flow'
  if (variant === 'side') return 'all'
  return 'all'
}

function visibleSyncedLines(lines: LrcLine[], currentLineIndex: number, mode: SyncedWindow, linesAfter = FLOW_LINES_AFTER): VisibleSyncedLine[] {
  if (mode === 'all') return lines.map((line, index) => ({ line, index }))

  const activeIndex = currentLineIndex >= 0 ? currentLineIndex : 0
  const start = Math.max(0, activeIndex - (mode === 'current' ? 0 : 1))
  const end =
    mode === 'current' ? activeIndex
    : Math.min(lines.length - 1, activeIndex + linesAfter)
  const visibleStart = mode === 'flow' ? Math.max(0, activeIndex - FLOW_LINES_BEFORE) : start

  return lines.slice(visibleStart, end + 1).map((line, offset) => ({ line, index: visibleStart + offset }))
}

function flowDurationMs(deltaY: number): number {
  return Math.min(FLOW_DURATION_MAX_MS, FLOW_DURATION_MIN_MS + Math.round(Math.abs(deltaY) * 0.9))
}

function visibleFlowChainMeta(visibleLines: VisibleSyncedLine[], activeIndex: number): LyricsFlowChainMeta {
  const groupByLineIndex = new Map<number, number>()
  const pendingGapIndices: number[] = []
  let groupIndex = 0

  for (const { line, index } of visibleLines) {
    if (!line.text.trim()) {
      pendingGapIndices.push(index)
      continue
    }

    for (const gapIndex of pendingGapIndices.splice(0)) {
      groupByLineIndex.set(gapIndex, groupIndex)
    }
    groupByLineIndex.set(index, groupIndex)
    groupIndex += 1
  }

  for (const gapIndex of pendingGapIndices) {
    groupByLineIndex.set(gapIndex, Math.max(0, groupIndex - 1))
  }

  const directActiveGroup = groupByLineIndex.get(activeIndex)
  if (directActiveGroup != null) return { activeGroup: directActiveGroup, groupByLineIndex }

  const nextVisibleLine = visibleLines.find(({ index }) => index >= activeIndex)
  const nextGroup = nextVisibleLine ? groupByLineIndex.get(nextVisibleLine.index) : undefined
  if (nextGroup != null) return { activeGroup: nextGroup, groupByLineIndex }

  const previousVisibleLine = visibleLines.at(-1)
  return {
    activeGroup: previousVisibleLine ? (groupByLineIndex.get(previousVisibleLine.index) ?? 0) : 0,
    groupByLineIndex,
  }
}

function flowChainDelayMs(meta: LyricsFlowChainMeta, lineIndex: number, direction: number): number {
  if (direction === 0) return 0

  const group = meta.groupByLineIndex.get(lineIndex)
  if (group == null) return 0

  // The active verse, the one that just left, and the one coming up next
  // all share the same anchor: they move together with no delay between
  // them. The cascade only kicks in for lines that sit further than one
  // group away from the new active — distance ±2 gets one step of delay,
  // ±3 gets two steps, and so on. That gives the perceived "drag" on the
  // second-next verse (and the older lines) without making the outgoing
  // or the immediately-following line look detached from the active.
  const distFromNew = group - meta.activeGroup
  const effectiveDistance = Math.max(0, Math.abs(distFromNew) - 1)
  return Math.min(FLOW_CHAIN_DELAY_MAX_MS, effectiveDistance * FLOW_CHAIN_DELAY_STEP_MS)
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function activeWaitRange(lines: LrcLine[], adjustedTimeSec: number, activeIndex: number): LyricsWaitRange | null {
  const first = lines[0]
  if (!first) return null

  if (activeIndex >= 0) return null
  if (first.timeSec <= LYRICS_WAIT_GAP_THRESHOLD_SEC || adjustedTimeSec >= first.timeSec) return null
  return { key: 'start', startSec: 0, endSec: first.timeSec }
}

function flowLineStyle(index: number, activeIndex: number, isActive: boolean, isFlow: boolean): LyricsFlowStyle | undefined {
  if (!isFlow) return undefined

  const futureDepth = Math.max(0, index - activeIndex)
  const pastDepth = Math.max(0, activeIndex - index)
  const opacity = isActive
    ? 1
    : Math.max(0.30, 0.82 - ((futureDepth || pastDepth) * 0.06))
  const blur = futureDepth > 1
    ? Math.min(1.35, (futureDepth - 1) * 0.16)
    : 0
  const toneDuration = !isActive && pastDepth > 0 ? FLOW_EXIT_TONE_DURATION_MS : FLOW_TONE_DURATION_MS

  return {
    '--lyr-flow-line-opacity': opacity.toFixed(2),
    '--lyr-flow-line-blur': `${blur.toFixed(2)}px`,
    '--lyr-flow-tone-delay': '0ms',
    '--lyr-flow-tone-duration': `${toneDuration}ms`,
  }
}

function waitLineStyle(range: LyricsWaitRange, adjustedTimeSec: number): LyricsFlowStyle {
  const duration = Math.max(0.001, range.endSec - range.startSec)
  const progress = clamp01((adjustedTimeSec - range.startSec) / duration) * 100
  return {
    '--lyr-wait-progress': `${progress.toFixed(2)}%`,
  }
}

function measureLyricsText(node: HTMLLIElement, text: string): number {
  node.textContent = text
  return node.getBoundingClientRect().width
}

type LyricsLineSplitCandidate = {
  split: LyricsLineSplit
  firstWidth: number
  secondWidth: number
  overflow: number
  balance: number
}

function splitLyricsLineForWidth(text: string, availableWidth: number, measureNode: HTMLLIElement): LyricsLineSplit | null {
  const normalized = text.trim().replace(/\s+/g, ' ')
  if (!normalized || availableWidth <= 0) return null
  if (measureLyricsText(measureNode, normalized) <= availableWidth) return null

  const words = normalized.split(' ')
  if (words.length < 2) return null

  const candidates: LyricsLineSplitCandidate[] = []
  for (let index = 1; index < words.length; index += 1) {
    const first = words.slice(0, index).join(' ')
    const second = words.slice(index).join(' ')
    const firstWidth = measureLyricsText(measureNode, first)
    const secondWidth = measureLyricsText(measureNode, second)
    const widest = Math.max(firstWidth, secondWidth)
    candidates.push({
      split: { first, second },
      firstWidth,
      secondWidth,
      overflow: Math.max(0, widest - availableWidth),
      balance: Math.abs(firstWidth - secondWidth),
    })
  }
  if (candidates.length === 0) return null

  const mostBalanced = (pool: LyricsLineSplitCandidate[]) =>
    pool.reduce((best, c) =>
      c.overflow < best.overflow || (c.overflow === best.overflow && c.balance < best.balance) ? c : best,
    )

  // When even the best two-row cut overflows (a line longer than two rows),
  // there's no slack to spend on aesthetics — take the least-overflowing,
  // most-balanced split and let the browser wrap whatever is left.
  const minOverflow = Math.min(...candidates.map(c => c.overflow))
  if (minOverflow > 0) return mostBalanced(candidates).split

  // Both rows fit. Favour the fullest first line so we actually use the width
  // available, but only while the top row doesn't outgrow the bottom one by
  // more than the tolerance — that keeps a near-full line from leaving an
  // orphan on the second row. Tolerance 0 collapses back to a balanced split.
  const fitting = candidates.filter(c => c.overflow === 0)
  const tolerance = availableWidth * LYRICS_SPLIT_BALANCE_TOLERANCE
  const relaxed = fitting.filter(c => c.firstWidth - c.secondWidth <= tolerance)
  if (relaxed.length === 0) return mostBalanced(fitting).split
  return relaxed.reduce((best, c) => (c.firstWidth > best.firstWidth ? c : best)).split
}

function lyricsLineAvailableWidth(listNode: HTMLOListElement): number {
  const listStyle = window.getComputedStyle(listNode)
  return Math.max(
    0,
    listNode.clientWidth -
      Number.parseFloat(listStyle.paddingLeft || '0') -
      Number.parseFloat(listStyle.paddingRight || '0'),
  )
}

function splitMapsEqual(left: Map<number, LyricsLineSplit>, right: Map<number, LyricsLineSplit>): boolean {
  if (left.size !== right.size) return false
  for (const [key, value] of left) {
    const other = right.get(key)
    if (!other || other.first !== value.first || other.second !== value.second) return false
  }
  return true
}

export function LyricsPanel({ active = true, ...props }: LyricsPanelProps) {
  const consumerRef = useRef(Symbol('lyrics-panel'))

  useEffect(() => {
    setLyricsPanelVisible(consumerRef.current, active)
    return () => setLyricsPanelVisible(consumerRef.current, false)
  }, [active])

  if (!active) return null
  return <LyricsPanelContent {...props} />
}

function LyricsPanelContent({
  variant,
  showActions = true,
  showInlineHeader = true,
  sidePaneOpen = false,
  onToggleSidePane,
  focusedFlow = false,
  focusLinesAfter,
}: Omit<LyricsPanelProps, 'active'>) {
  const status = useLyricsStore(s => s.status)
  const parsed = useLyricsStore(s => s.parsed)
  const plainLines = useLyricsStore(s => s.plainLines)
  const currentLineIndex = useLyricsStore(s => s.currentLineIndex)
  const error = useLyricsStore(s => s.error)
  const view = useLyricsStore(s => s.view)
  const busy = useLyricsStore(s => s.busy)
  const searching = useLyricsStore(s => s.searching)
  const currentTrack = usePlaybackStore(s => s.currentTrack)
  const positionSec = usePlaybackStore(s => s.positionSec)
  const playbackStatus = usePlaybackStore(s => s.status)
  const globalOffsetMs = useTweakStore(s => s.tweak.lyricsGlobalOffsetMs)

  const [dragOver, setDragOver] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [offsetOpen, setOffsetOpen] = useState(false)
  const [toolbarOpen, setToolbarOpen] = useState(false)
  const [measureTick, setMeasureTick] = useState(0)
  const [lineSplits, setLineSplits] = useState<Map<number, LyricsLineSplit>>(() => new Map())

  const activeLineRef = useRef<HTMLLIElement | null>(null)
  const syncedListRef = useRef<HTMLOListElement | null>(null)
  const activeMeasureRef = useRef<HTMLLIElement | null>(null)
  const flowListRef = useRef<HTMLOListElement | null>(null)
  const flowLineRefs = useRef(new Map<number, HTMLLIElement>())
  const previousFlowSnapshotRef = useRef<LyricsFlowSnapshot | null>(null)
  const playheadSnapshotRef = useRef<LyricsPlayheadSnapshot | null>(null)
  const pendingFlowResetRef = useRef(false)
  const flowFrameRef = useRef<number | null>(null)
  const flowCleanupTimersRef = useRef<number[]>([])
  const autoScrollPausedAtLineRef = useRef<number | null>(null)
  const reducedMotionRef = useRef(false)
  const syncedWindow: SyncedWindow = variant === 'side' && focusedFlow ? 'flow' : windowForVariant(variant)
  const animatedLyricsWindow = syncedWindow === 'flow' || syncedWindow === 'preview'
  const compactHeader = showInlineHeader && (variant === 'inline' || variant === 'current')
  const visualLeadSec = animatedLyricsWindow && playbackStatus === 'playing'
    ? LYRICS_FLOW_LEAD_MS / 1000
    : 0
  const totalOffsetMs = parsed
    ? Math.round(parsed.meta.offsetSec * 1000) + clampLyricsOffsetMs(globalOffsetMs)
    : clampLyricsOffsetMs(globalOffsetMs)
  const displayLyricsTimeSec = parsed
    ? positionSec + visualLeadSec - (totalOffsetMs / 1000)
    : positionSec
  const displayLineIndex = parsed ? findCurrentLineIndex(parsed.lines, displayLyricsTimeSec) : currentLineIndex
  const waitRange = parsed ? activeWaitRange(parsed.lines, displayLyricsTimeSec, displayLineIndex) : null
  const hasTrack = currentTrack?.dbId != null
  const hasLyrics = status === 'found_synced' || status === 'found_plain' || status === 'low_confidence'
  const showSynced = !!parsed && (status === 'found_synced' || status === 'low_confidence')
  const showPlain = !showSynced && !!plainLines && (status === 'found_plain' || status === 'low_confidence')
  // The intro wait bar visually occupies the "active verse" slot, so when it's
  // visible we render one fewer upcoming line to keep the total count constant.
  // The preview window only ever shows a single upcoming line, so it gets its
  // own base instead of the flow default (which would otherwise expand to 28).
  const baseLinesAfter = syncedWindow === 'preview' ? 1 : (focusLinesAfter ?? FLOW_LINES_AFTER)
  const effectiveLinesAfter = waitRange != null ? Math.max(0, baseLinesAfter - 1) : baseLinesAfter
  const visibleLines = useMemo(
    () => showSynced && parsed ? visibleSyncedLines(parsed.lines, displayLineIndex, syncedWindow, effectiveLinesAfter) : [],
    [displayLineIndex, effectiveLinesAfter, parsed, showSynced, syncedWindow],
  )
  // When the active verse is the very first line (or we're still on the intro
  // wait bar) there is no "previous" line to fill the slot above it. In the
  // animated windows we reserve that slot with an invisible placeholder so the
  // active verse keeps a stable vertical position from the start — no jump once
  // a real previous line appears.
  const activeIndexClamped = displayLineIndex >= 0 ? displayLineIndex : 0
  const reserveLeadingSlot =
    animatedLyricsWindow && showSynced && visibleLines.length > 0 &&
    visibleLines[0].index === activeIndexClamped
  const reserveActiveLineLayout = syncedWindow !== 'all'
  const activeLayoutClass = reserveActiveLineLayout ? ' lyr-line-layout-active' : ''
  const flowLineClass = animatedLyricsWindow ? ' lyr-flow-line' : ''
  const visibleChainMeta = useMemo(
    () => visibleFlowChainMeta(visibleLines, displayLineIndex >= 0 ? displayLineIndex : 0),
    [displayLineIndex, visibleLines],
  )

  const clearFlowAnimationTimers = () => {
    if (flowFrameRef.current != null) {
      window.cancelAnimationFrame(flowFrameRef.current)
      flowFrameRef.current = null
    }
    for (const timer of flowCleanupTimersRef.current) window.clearTimeout(timer)
    flowCleanupTimersRef.current = []
  }

  const captureFlowTops = () => {
    const tops = new Map<number, number>()
    for (const [index, node] of flowLineRefs.current) {
      if (node.isConnected) tops.set(index, node.getBoundingClientRect().top)
    }
    return tops
  }

  const resetFlowNodeMotion = (nodes: Iterable<HTMLLIElement>) => {
    for (const node of nodes) {
      node.style.transition = FLOW_INSTANT_VISUAL_TRANSITION
      node.style.transform = ''
      node.style.opacity = ''
      node.style.removeProperty('--lyr-flow-delay')
      node.style.removeProperty('--lyr-flow-duration')
      flowCleanupTimersRef.current.push(window.setTimeout(() => {
        if (node.isConnected) node.style.transition = ''
      }, FLOW_TONE_DURATION_MS + 40))
    }
  }

  useEffect(() => {
    reducedMotionRef.current = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  }, [])

  useEffect(() => () => {
    clearFlowAnimationTimers()
  }, [])

  useLayoutEffect(() => {
    previousFlowSnapshotRef.current = null
    playheadSnapshotRef.current = null
    pendingFlowResetRef.current = true
    autoScrollPausedAtLineRef.current = null
  }, [currentTrack?.dbId, parsed])

  const pauseAutoScrollForUserNavigation = useCallback(() => {
    if (syncedWindow !== 'all') return
    autoScrollPausedAtLineRef.current = pauseLyricsAutoScroll(displayLineIndex)
  }, [displayLineIndex, syncedWindow])

  // Autoscroll the active line into view, unless the user is browsing lyrics.
  useEffect(() => {
    const el = activeLineRef.current
    if (!el || syncedWindow !== 'all') return
    const decision = lyricsAutoScrollDecision(autoScrollPausedAtLineRef.current, displayLineIndex)
    autoScrollPausedAtLineRef.current = decision.pausedAtLineIndex
    if (!decision.shouldScroll) return
    const scrollTarget = (el.previousElementSibling as HTMLElement | null) ?? el
    scrollTarget.scrollIntoView({ block: 'start', behavior: reducedMotionRef.current ? 'auto' : 'smooth' })
  }, [displayLineIndex, syncedWindow])

  useLayoutEffect(() => {
    if (!animatedLyricsWindow) {
      playheadSnapshotRef.current = null
      pendingFlowResetRef.current = false
      return
    }

    const activeIndex = displayLineIndex >= 0 ? displayLineIndex : 0
    const trackId = currentTrack?.dbId ?? null
    const previous = playheadSnapshotRef.current
    const sameSource = previous?.trackId === trackId && previous.parsed === parsed
    const timeJump = previous ? Math.abs(positionSec - previous.positionSec) : 0
    const lineJump = previous ? Math.abs(activeIndex - previous.activeIndex) : 0
    const offsetJump = previous ? Math.abs(totalOffsetMs - previous.totalOffsetMs) : 0
    const offsetChangedLine = offsetJump >= FLOW_OFFSET_JUMP_MS && previous?.activeIndex !== activeIndex
    const hasDiscontinuity = !!previous && (!sameSource || timeJump > FLOW_SEEK_TIME_JUMP_SEC || lineJump > FLOW_SEEK_LINE_JUMP || offsetChangedLine)

    if (hasDiscontinuity) {
      clearFlowAnimationTimers()
      resetFlowNodeMotion(flowLineRefs.current.values())
      pendingFlowResetRef.current = true
      previousFlowSnapshotRef.current = {
        trackId,
        parsed,
        positionSec,
        displayTimeSec: displayLyricsTimeSec,
        totalOffsetMs,
        activeIndex,
        tops: captureFlowTops(),
      }
    }

    playheadSnapshotRef.current = { trackId, parsed, positionSec, totalOffsetMs, activeIndex }
  }, [animatedLyricsWindow, currentTrack?.dbId, displayLineIndex, displayLyricsTimeSec, parsed, positionSec, totalOffsetMs])

  useLayoutEffect(() => {
    if (!animatedLyricsWindow || !flowListRef.current) {
      previousFlowSnapshotRef.current = null
      pendingFlowResetRef.current = false
      return
    }

    clearFlowAnimationTimers()

    const nextTops = captureFlowTops()
    const activeIndex = displayLineIndex >= 0 ? displayLineIndex : 0
    const trackId = currentTrack?.dbId ?? null
    const nextSnapshot: LyricsFlowSnapshot = {
      trackId,
      parsed,
      positionSec,
      displayTimeSec: displayLyricsTimeSec,
      totalOffsetMs,
      activeIndex,
      tops: nextTops,
    }
    const previousSnapshot = previousFlowSnapshotRef.current
    const previousTops = previousSnapshot?.tops ?? new Map<number, number>()
    const previousActive = previousSnapshot?.activeIndex ?? activeIndex
    const direction = activeIndex - previousActive
    const sourceChanged = !previousSnapshot || previousSnapshot.trackId !== trackId || previousSnapshot.parsed !== parsed
    const lineJump = previousSnapshot ? Math.abs(activeIndex - previousSnapshot.activeIndex) : 0
    const offsetJump = previousSnapshot ? Math.abs(totalOffsetMs - previousSnapshot.totalOffsetMs) : 0
    const offsetChangedLine = offsetJump >= FLOW_OFFSET_JUMP_MS && previousSnapshot?.activeIndex !== activeIndex
    const shouldResetFlow =
      pendingFlowResetRef.current ||
      sourceChanged ||
      lineJump > FLOW_SEEK_LINE_JUMP ||
      offsetChangedLine

    if (previousTops.size === 0 || reducedMotionRef.current || shouldResetFlow) {
      resetFlowNodeMotion(flowLineRefs.current.values())
      previousFlowSnapshotRef.current = nextSnapshot
      pendingFlowResetRef.current = false
      return
    }

    const movingNodes: HTMLLIElement[] = []
    for (const [index, node] of flowLineRefs.current) {
      const nextTop = nextTops.get(index)
      if (nextTop == null) continue
      const previousTop = previousTops.get(index)

      if (previousTop == null) {
        const delay = flowChainDelayMs(visibleChainMeta, index, direction)
        node.style.transition = FLOW_INSTANT_VISUAL_TRANSITION
        node.style.opacity = '0'
        // Side relative to the anchor decides which way a freshly inserted
        // line slides in from: below-anchor lines drift up, above-anchor
        // lines drift down. Falling back to the global direction handles
        // the active line itself if it had no previous snapshot.
        const sideOffset =
          index > activeIndex ? FLOW_ENTER_OFFSET_PX
          : index < activeIndex ? -FLOW_ENTER_OFFSET_PX
          : direction < 0 ? -FLOW_ENTER_OFFSET_PX : FLOW_ENTER_OFFSET_PX
        node.style.transform = `translate3d(0, ${sideOffset}px, 0)`
        node.style.setProperty('--lyr-flow-delay', `${delay}ms`)
        node.style.setProperty('--lyr-flow-duration', `${FLOW_DURATION_MIN_MS}ms`)
        movingNodes.push(node)
        continue
      }

      const deltaY = previousTop - nextTop
      if (Math.abs(deltaY) < 0.5) continue

      const delay = flowChainDelayMs(visibleChainMeta, index, direction)
      node.style.transition = FLOW_INSTANT_VISUAL_TRANSITION
      node.style.transform = `translate3d(0, ${deltaY}px, 0)`
      node.style.setProperty('--lyr-flow-delay', `${delay}ms`)
      node.style.setProperty('--lyr-flow-duration', `${flowDurationMs(deltaY)}ms`)
      movingNodes.push(node)
    }

    if (movingNodes.length > 0) {
      void flowListRef.current.offsetHeight
      flowFrameRef.current = window.requestAnimationFrame(() => {
        flowFrameRef.current = null
        for (const node of movingNodes) {
          node.style.transition = FLOW_MOTION_TRANSITION
          node.style.transform = ''
          node.style.opacity = ''

          const cleanupDuration = Number.parseFloat(node.style.getPropertyValue('--lyr-flow-duration')) || FLOW_DURATION_MIN_MS
          const cleanupDelay = Number.parseFloat(node.style.getPropertyValue('--lyr-flow-delay')) || 0
          flowCleanupTimersRef.current.push(window.setTimeout(() => {
            node.style.transition = ''
          }, cleanupDelay + cleanupDuration + 40))
        }
      })
    }

    previousFlowSnapshotRef.current = nextSnapshot
    pendingFlowResetRef.current = false
  }, [displayLineIndex, animatedLyricsWindow, syncedWindow, parsed, currentTrack?.dbId, visibleChainMeta])

  const trackOffsetMs = parsed ? Math.round(parsed.meta.offsetSec * 1000) : 0
  const effectiveOffsetMs = totalOffsetMs

  const setSyncedListRef = useCallback((node: HTMLOListElement | null) => {
    syncedListRef.current = node
    flowListRef.current = animatedLyricsWindow ? node : null
  }, [animatedLyricsWindow])

  useEffect(() => {
    setOffsetOpen(false)
  }, [currentTrack?.dbId])

  useEffect(() => {
    if (!showSynced) setOffsetOpen(false)
  }, [showSynced])

  useEffect(() => {
    if (!showSynced) {
      setLineSplits(current => (current.size === 0 ? current : new Map()))
    }
  }, [showSynced])

  useLayoutEffect(() => {
    if (!showSynced || !parsed || visibleLines.length === 0) {
      setLineSplits(current => (current.size === 0 ? current : new Map()))
      return
    }

    const listNode = syncedListRef.current
    const measureNode = activeMeasureRef.current
    if (!listNode || !measureNode) return

    const availableWidth = lyricsLineAvailableWidth(listNode)
    const next = new Map<number, LyricsLineSplit>()

    for (const { line, index } of visibleLines) {
      if (!line.text) continue
      const split = splitLyricsLineForWidth(line.text, availableWidth, measureNode)
      if (split) next.set(index, split)
    }

    setLineSplits(current => (splitMapsEqual(current, next) ? current : next))
  }, [currentTrack?.dbId, displayLineIndex, measureTick, parsed, reserveActiveLineLayout, showSynced, syncedWindow, variant, visibleLines])

  useEffect(() => {
    const node = syncedListRef.current
    if (!node || typeof ResizeObserver === 'undefined') return

    let frame: number | null = null
    const observer = new ResizeObserver(() => {
      if (frame != null) window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        frame = null
        setMeasureTick(tick => tick + 1)
      })
    })
    observer.observe(node)

    return () => {
      observer.disconnect()
      if (frame != null) window.cancelAnimationFrame(frame)
    }
  }, [currentTrack?.dbId, showSynced, syncedWindow, variant])

  const onDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (!file || !/\.(lrc|txt)$/i.test(file.name)) return
    const text = await file.text()
    await useLyricsStore.getState().importFromText(text)
  }

  const seekToLine = (timeSec: number) => {
    const totalOffsetSec = (parsed?.meta.offsetSec ?? 0) + (clampLyricsOffsetMs(globalOffsetMs) / 1000)
    void useQueueStore.getState().seek(timeSec + totalOffsetSec)
  }

  const setSyncedLineRef = (index: number, isActive: boolean, isFlow: boolean) => (node: HTMLLIElement | null) => {
    if (isActive) activeLineRef.current = node
    if (!isFlow) return
    if (node) flowLineRefs.current.set(index, node)
    else flowLineRefs.current.delete(index)
  }

  const renderWaitLine = (range: LyricsWaitRange) => (
    <li
      key={`wait-${range.key}`}
      className={`lyr-line-wait${animatedLyricsWindow ? ' lyr-flow-line' : ''}`}
      style={waitLineStyle(range, displayLyricsTimeSec)}
      aria-hidden="true"
    >
      <span className="lyr-wait-track">
        <span className="lyr-wait-fill" />
      </span>
    </li>
  )

  const renderCompactHeader = () => {
    if (!compactHeader) return null
    return (
      <div className="lyr-inline-head">
        <span>Lyrics</span>
        {onToggleSidePane && (
          <button
            type="button"
            className={`tb-icon-btn ${sidePaneOpen ? 'active' : ''}`}
            title={sidePaneOpen ? 'Close lyrics sidebar' : 'Open lyrics sidebar'}
            aria-label={sidePaneOpen ? 'Close lyrics sidebar' : 'Open lyrics sidebar'}
            aria-pressed={sidePaneOpen}
            onClick={onToggleSidePane}
          >
            <Icon name="sidebarRight" size={13} />
          </button>
        )}
      </div>
    )
  }

  function renderBody() {
    if (!hasTrack) return <div className="lyr-empty"><div className="lyr-empty-title">Nada en reproducción</div></div>

    if (status === 'loading') {
      return (
        <div className="lyr-empty">
          <span className="lyr-spinner" aria-hidden="true" />
          <div className="lyr-empty-sub">Buscando letras…</div>
        </div>
      )
    }

    if (status === 'instrumental') {
      return (
        <div className="lyr-empty">
          <Icon name="note" size={26} />
          <div className="lyr-empty-title">Instrumental</div>
          {showActions && (
            <div className="lyr-empty-actions">
              <button type="button" className="btn sm" onClick={() => void useLyricsStore.getState().fetchOnline(true)}>Rebuscar</button>
            </div>
          )}
        </div>
      )
    }

    if (status === 'not_found' || status === 'none') {
      return (
        <div className="lyr-empty">
          <Icon name="lyrics" size={26} />
          <div className="lyr-empty-title">Sin letras</div>
          {showActions && (
            <div className="lyr-empty-actions">
              <button type="button" className="btn sm primary" disabled={searching} onClick={() => void useLyricsStore.getState().searchOnline()}>
                Buscar online
              </button>
              <button type="button" className="btn sm" disabled={busy} onClick={() => void useLyricsStore.getState().importFromFile()}>
                Importar .lrc
              </button>
            </div>
          )}
        </div>
      )
    }

    if (status === 'failed_provider' || status === 'error') {
      return (
        <div className="lyr-empty">
          <Icon name="info" size={24} />
          <div className="lyr-empty-title">{status === 'failed_provider' ? 'Proveedor no disponible' : 'Error'}</div>
          {error && <div className="lyr-empty-sub">{error}</div>}
          {showActions && (
            <div className="lyr-empty-actions">
              <button type="button" className="btn sm" onClick={() => void useLyricsStore.getState().fetchOnline(true)}>Reintentar</button>
            </div>
          )}
        </div>
      )
    }

    // found_synced / found_plain / low_confidence
    return (
      <>
        {status === 'low_confidence' && (
          <div className="lyr-warn">Coincidencia dudosa — ¿es la letra correcta?</div>
        )}
        {showSynced && parsed && (
          <ol
            ref={setSyncedListRef}
            className={`lyr-list ${syncedWindow === 'all' ? '' : 'lyr-list-window'} ${animatedLyricsWindow ? 'lyr-list-flow' : ''}`}
            onTouchMove={pauseAutoScrollForUserNavigation}
            onWheel={pauseAutoScrollForUserNavigation}
          >
            <li
              ref={activeMeasureRef}
              className={`lyr-measure lyr-line lyr-line-active${activeLayoutClass}${flowLineClass}`}
              aria-hidden="true"
            />
            {reserveLeadingSlot && (
              <li key="lyr-lead-pad" className="lyr-line lyr-line-lead-pad" aria-hidden="true">
                <span className="lyr-line-stack">
                  <span className="lyr-line-visible">{' '}</span>
                  <span className="lyr-line-ghost" aria-hidden="true">{' '}</span>
                </span>
              </li>
            )}
            {visibleLines.map(({ line, index: i }) => {
              const activeIndex = displayLineIndex >= 0 ? displayLineIndex : 0
              const isActive = i === displayLineIndex
              const split = lineSplits.get(i)
              const cls =
                isActive ? 'lyr-line lyr-line-active'
                : i < displayLineIndex ? 'lyr-line lyr-line-past'
                : 'lyr-line lyr-line-future'
              const waitBefore = waitRange && i === 0 ? renderWaitLine(waitRange) : null
              const lineNode = !line.text ? (
                <li
                  key={i}
                  ref={setSyncedLineRef(i, false, animatedLyricsWindow)}
                  className="lyr-line-gap"
                  aria-hidden="true"
                />
              ) : (
                <li
                  key={i}
                  ref={setSyncedLineRef(i, isActive, animatedLyricsWindow)}
                  className={`${cls}${activeLayoutClass}${flowLineClass}`}
                  style={flowLineStyle(i, activeIndex, isActive, animatedLyricsWindow)}
                  aria-current={isActive ? 'true' : undefined}
                  onClick={() => seekToLine(line.timeSec)}
                >
                  <span className="lyr-line-stack">
                    <span className="lyr-line-visible">
                      {split ? (
                        <span className="lyr-line-split">
                          <span className="lyr-line-split-part">{split.first}</span>
                          <span className="lyr-line-split-part">{split.second}</span>
                        </span>
                      ) : line.text}
                    </span>
                    <span className="lyr-line-ghost" aria-hidden="true">
                      {split ? (
                        <span className="lyr-line-split">
                          <span className="lyr-line-split-part">{split.first}</span>
                          <span className="lyr-line-split-part">{split.second}</span>
                        </span>
                      ) : line.text}
                    </span>
                  </span>
                </li>
              )
              if (!waitBefore) return lineNode
              return (
                <Fragment key={`line-with-wait-${i}`}>
                  {waitBefore}
                  {lineNode}
                </Fragment>
              )
            })}
          </ol>
        )}
        {showPlain && plainLines && (
          <div className="lyr-plain">
            {plainLines.map((l, i) => <p key={i} className="lyr-plain-line">{l || ' '}</p>)}
          </div>
        )}
      </>
    )
  }

  return (
    <div
      className={`lyr-panel lyr-${variant} lyr-status-${status}`}
      onDragOver={e => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => { void onDrop(e) }}
    >
      {dragOver && <div className="lyr-dropzone">Suelta el .lrc aquí</div>}

      {renderCompactHeader()}
      <div className="lyr-body">{renderBody()}</div>

      {showActions && hasTrack && hasLyrics && (
        <div className="lyr-bottom-bar">
          {toolbarOpen && offsetOpen && showSynced && parsed && (
            <LyricsOffsetControl
              trackOffsetMs={trackOffsetMs}
              globalOffsetMs={globalOffsetMs}
              busy={busy}
            />
          )}
          <div className="lyr-strip">
            {toolbarOpen && (
              <>
                <button type="button" className="tb-icon-btn" title="Buscar online" disabled={searching} onClick={() => void useLyricsStore.getState().searchOnline()}>
                  <Icon name="search" size={14} />
                </button>
                <button type="button" className="tb-icon-btn" title="Rebuscar" onClick={() => void useLyricsStore.getState().fetchOnline(true)}>
                  <Icon name="rotate" size={14} />
                </button>
                <button type="button" className="tb-icon-btn" title="Importar .lrc" disabled={busy} onClick={() => void useLyricsStore.getState().importFromFile()}>
                  <Icon name="download" size={14} />
                </button>
                <button type="button" className="tb-icon-btn" title="Editar" onClick={() => setEditorOpen(true)}>
                  <Icon name="edit" size={14} />
                </button>
                <button type="button" className="tb-icon-btn" title="Exportar .lrc" disabled={busy} onClick={() => void useLyricsStore.getState().exportToFile()}>
                  <Icon name="save" size={14} />
                </button>
                <button type="button" className="tb-icon-btn" title="Quitar letras" disabled={busy} onClick={() => void useLyricsStore.getState().remove()}>
                  <Icon name="trash" size={14} />
                </button>
                {showSynced && parsed && (
                  <button
                    type="button"
                    className={`lyr-offset-btn${offsetOpen ? ' active' : ''}`}
                    title={offsetOpen ? 'Ocultar desfasaje' : 'Mostrar desfasaje'}
                    onClick={() => setOffsetOpen(o => !o)}
                  >
                    <Icon name="sliders" size={11} />
                    <span>{formatOffsetMs(effectiveOffsetMs)}</span>
                  </button>
                )}
              </>
            )}
            <div className="lyr-strip-spacer" />
            <button
              type="button"
              className="tb-icon-btn lyr-strip-toggle"
              title={toolbarOpen ? 'Ocultar controles' : 'Mostrar controles'}
              onClick={() => {
                if (toolbarOpen) setOffsetOpen(false)
                setToolbarOpen(o => !o)
              }}
            >
              <Icon name={toolbarOpen ? 'chevD' : 'chevU'} size={11} />
            </button>
          </div>
        </div>
      )}

      {error && hasLyrics && <div className="lyr-error">{error}</div>}

      {editorOpen && (
        <LyricsEditor
          initial={view?.syncedLyricsLrc ?? view?.plainLyrics ?? ''}
          onClose={() => setEditorOpen(false)}
        />
      )}
    </div>
  )
}

function formatOffsetMs(value: number): string {
  return `${value > 0 ? '+' : ''}${value} ms`
}

function LyricsOffsetControl({
  trackOffsetMs,
  globalOffsetMs,
  busy,
}: {
  trackOffsetMs: number
  globalOffsetMs: number
  busy: boolean
}) {
  const [draft, setDraft] = useState(String(trackOffsetMs))
  const effectiveOffsetMs = trackOffsetMs + clampLyricsOffsetMs(globalOffsetMs)

  useEffect(() => {
    setDraft(String(trackOffsetMs))
  }, [trackOffsetMs])

  const commit = (nextValue?: number) => {
    if (nextValue == null && draft.trim() === '') {
      setDraft(String(trackOffsetMs))
      return
    }
    const next = clampLyricsOffsetMs(nextValue ?? Number(draft))
    setDraft(String(next))
    void useLyricsStore.getState().setTrackOffset(next)
  }

  return (
    <div className="lyr-offset">
      <div className="lyr-offset-readout">
        <span>Canción</span>
        <strong>{formatOffsetMs(trackOffsetMs)}</strong>
        <span>Total</span>
        <strong>{formatOffsetMs(effectiveOffsetMs)}</strong>
      </div>
      <div className="lyr-offset-controls">
        <button type="button" className="btn sm" title="Adelantar letra 250 ms" disabled={busy} onClick={() => commit(trackOffsetMs - 250)}>-250</button>
        <input
          type="number"
          className="number-input lyr-offset-input"
          min={-LYRICS_OFFSET_LIMIT_MS}
          max={LYRICS_OFFSET_LIMIT_MS}
          step={50}
          value={draft}
          disabled={busy}
          onChange={e => setDraft(e.target.value)}
          onBlur={() => commit()}
          onKeyDown={e => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              setDraft(String(trackOffsetMs))
              e.currentTarget.blur()
            }
          }}
          aria-label="Desfasaje de esta canción en milisegundos"
        />
        <button type="button" className="btn sm" title="Retrasar letra 250 ms" disabled={busy} onClick={() => commit(trackOffsetMs + 250)}>+250</button>
        <button type="button" className="btn sm ghost" title="Resetear desfasaje de esta canción" disabled={busy || trackOffsetMs === 0} onClick={() => commit(0)}>0</button>
      </div>
    </div>
  )
}

function LyricsEditor({ initial, onClose }: { initial: string; onClose: () => void }) {
  const [text, setText] = useState(initial)
  const [saving, setSaving] = useState(false)

  const onSave = async () => {
    setSaving(true)
    const synced = isSyncedLrc(text)
    await useLyricsStore.getState().saveEdited(synced ? null : text, synced ? text : null)
    setSaving(false)
    onClose()
  }

  return (
    <ModalShell
      title="Editar letras"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose} disabled={saving}>Cancelar</button>
          <button type="button" className="btn primary" onClick={() => { void onSave() }} disabled={saving}>Guardar</button>
        </>
      )}
    >
      <textarea
        className="lyr-editor-area"
        value={text}
        onChange={e => setText(e.target.value)}
        spellCheck={false}
        placeholder={'Pegá la letra. Para sincronizada, usá líneas tipo [00:12.00]texto'}
      />
    </ModalShell>
  )
}
