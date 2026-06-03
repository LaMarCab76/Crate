export const LYRICS_AUTOSCROLL_RESUME_LINE_DELTA = 4

export interface LyricsAutoScrollDecision {
  shouldScroll: boolean
  pausedAtLineIndex: number | null
}

export function pauseLyricsAutoScroll(currentLineIndex: number): number {
  return Number.isFinite(currentLineIndex) ? Math.trunc(currentLineIndex) : -1
}

export function lyricsAutoScrollDecision(
  pausedAtLineIndex: number | null,
  currentLineIndex: number,
  resumeLineDelta = LYRICS_AUTOSCROLL_RESUME_LINE_DELTA,
): LyricsAutoScrollDecision {
  if (pausedAtLineIndex == null) return { shouldScroll: true, pausedAtLineIndex: null }

  const safeCurrent = Number.isFinite(currentLineIndex) ? Math.trunc(currentLineIndex) : -1
  const safePaused = Number.isFinite(pausedAtLineIndex) ? Math.trunc(pausedAtLineIndex) : -1
  const safeDelta = Math.max(1, Math.trunc(resumeLineDelta))

  if (Math.abs(safeCurrent - safePaused) >= safeDelta) {
    return { shouldScroll: true, pausedAtLineIndex: null }
  }

  return { shouldScroll: false, pausedAtLineIndex: safePaused }
}
