// Per-track lyrics state. We fetch on demand (track id → IPC → LRCLIB +
// SQLite cache) and parse the LRC format into time-indexed lines for the
// scrolling display.

import { create } from 'zustand'

export interface LyricLine {
  ms: number       // start time in ms; -1 for static plain-text lines
  text: string
}

export type LyricsStatus = 'idle' | 'loading' | 'ready' | 'missing' | 'error'

interface CacheEntry {
  status: LyricsStatus
  lines: LyricLine[]
  plain?: string
  synced: boolean
}

interface LyricsStoreState {
  byTrackId: Record<number, CacheEntry>
  fetch(trackId: number): Promise<void>
}

// LRC stamp regex: [mm:ss], [mm:ss.xx], or [mm:ss.xxx]. Multiple stamps per
// line are allowed (LRCLIB returns them for repeated choruses).
const LRC_STAMP = /\[(\d{1,3}):(\d{1,2})(?:\.(\d{1,3}))?\]/g

function parseLrc(content: string): { lines: LyricLine[]; synced: boolean } {
  const out: LyricLine[] = []
  let synced = false
  const rawLines = content.split(/\r?\n/)
  for (const raw of rawLines) {
    const stamps: number[] = []
    let lastEnd = 0
    LRC_STAMP.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = LRC_STAMP.exec(raw)) !== null) {
      const min = parseInt(m[1], 10)
      const sec = parseInt(m[2], 10)
      const fracStr = m[3] ?? '0'
      const frac = parseInt(fracStr.padEnd(3, '0').slice(0, 3), 10)
      stamps.push(min * 60_000 + sec * 1000 + frac)
      lastEnd = m.index + m[0].length
    }
    const text = raw.slice(lastEnd).trim()
    if (stamps.length === 0) {
      // Pure metadata tag like [ti:Title] or empty line — skip metadata,
      // keep blanks so the layout breathes between paragraphs.
      if (text && !/^\[\w+:/i.test(raw)) {
        out.push({ ms: -1, text })
      }
      continue
    }
    synced = true
    for (const ms of stamps) out.push({ ms, text })
  }
  if (synced) out.sort((a, b) => a.ms - b.ms)
  return { lines: out, synced }
}

export const useLyricsStore = create<LyricsStoreState>((set, get) => ({
  byTrackId: {},

  async fetch(trackId: number) {
    const current = get().byTrackId[trackId]
    if (current && current.status !== 'idle') return
    set(state => ({
      byTrackId: { ...state.byTrackId, [trackId]: { status: 'loading', lines: [], synced: false } },
    }))
    try {
      const result = await window.api.lyrics.getForTrack(trackId)
      if (!result) {
        set(state => ({
          byTrackId: { ...state.byTrackId, [trackId]: { status: 'missing', lines: [], synced: false } },
        }))
        return
      }
      if (result.synced) {
        const parsed = parseLrc(result.lrcContent)
        set(state => ({
          byTrackId: {
            ...state.byTrackId,
            [trackId]: { status: 'ready', lines: parsed.lines, synced: parsed.synced },
          },
        }))
      } else {
        const plainLines = result.lrcContent.split(/\r?\n/).map(t => ({ ms: -1, text: t }))
        set(state => ({
          byTrackId: {
            ...state.byTrackId,
            [trackId]: {
              status: 'ready',
              lines: plainLines,
              plain: result.lrcContent,
              synced: false,
            },
          },
        }))
      }
    } catch {
      set(state => ({
        byTrackId: { ...state.byTrackId, [trackId]: { status: 'error', lines: [], synced: false } },
      }))
    }
  },
}))

export function useLyrics(trackId: number | undefined): CacheEntry {
  const entry = useLyricsStore(s => (trackId != null ? s.byTrackId[trackId] : undefined))
  return entry ?? { status: 'idle', lines: [], synced: false }
}
