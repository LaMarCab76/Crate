// LRC parsing / serialization and the current-line sync primitive.
// Pure module (no React, no IPC, no Node APIs) so it is safe to import from both
// the main process (detect synced vs plain, serialize for export) and the
// renderer (drive karaoke highlight + autoscroll).

export interface LrcLine {
  timeSec: number
  text: string
}

export interface LrcMeta {
  ti?: string
  ar?: string
  al?: string
  by?: string
  offsetSec: number // [offset:ms] converted to seconds; global time shift
  raw: Record<string, string> // any other [key:value] tags, verbatim
}

export interface ParsedLrc {
  lines: LrcLine[] // sorted ascending by timeSec; [] when no timed lines
  meta: LrcMeta
  hasTimestamps: boolean // true => synced; false => caller falls back to plain
}

// One timestamp tag: [mm:ss], [mm:ss.xx] or [mm:ss.xxx]. Global so a single line
// can carry several (e.g. "[00:12.00][00:15.00]text").
const TIME_TAG_RE = /\[(\d+):(\d{1,2}(?:[.:]\d{1,3})?)\]/g
// A metadata tag occupies the whole line: [ti:...], [ar:...], [offset:...], etc.
const META_TAG_RE = /^\[([a-zA-Z][a-zA-Z0-9_]*):(.*)\]$/
const OFFSET_TAG_LINE_RE = /^\s*\[offset:\s*([+-]?\d+)\s*\]\s*$/i

export const LYRICS_OFFSET_LIMIT_MS = 30_000

export function clampLyricsOffsetMs(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(-LYRICS_OFFSET_LIMIT_MS, Math.min(LYRICS_OFFSET_LIMIT_MS, Math.round(n)))
}

function parseTime(minStr: string, secStr: string): number {
  const min = Number.parseInt(minStr, 10)
  const sepIdx = secStr.search(/[.:]/)
  if (sepIdx === -1) return min * 60 + Number.parseInt(secStr, 10)
  const sec = Number.parseInt(secStr.slice(0, sepIdx), 10)
  const fracStr = secStr.slice(sepIdx + 1)
  const frac = Number.parseInt(fracStr, 10) / Math.pow(10, fracStr.length)
  return min * 60 + sec + frac
}

export function parseLrc(text: string): ParsedLrc {
  const meta: LrcMeta = { offsetSec: 0, raw: {} }
  const lines: LrcLine[] = []

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue

    // Collect every timestamp tag on the line.
    const times: number[] = []
    for (const m of line.matchAll(TIME_TAG_RE)) {
      times.push(parseTime(m[1], m[2]))
    }

    if (times.length > 0) {
      const lyricText = line.replace(TIME_TAG_RE, '').trim()
      for (const t of times) lines.push({ timeSec: t, text: lyricText })
      continue
    }

    // No timestamps: maybe a metadata tag. Untimed lyric lines are ignored for
    // synced parsing (they are recovered via plainTextLines when unsynced).
    const metaMatch = line.match(META_TAG_RE)
    if (!metaMatch) continue
    const key = metaMatch[1].toLowerCase()
    const value = metaMatch[2].trim()
    switch (key) {
      case 'ti': meta.ti = value; break
      case 'ar': meta.ar = value; break
      case 'al': meta.al = value; break
      case 'by': meta.by = value; break
      case 'offset': {
        const ms = Number.parseInt(value, 10)
        if (Number.isFinite(ms)) meta.offsetSec = ms / 1000
        break
      }
      default: meta.raw[key] = value
    }
  }

  lines.sort((a, b) => a.timeSec - b.timeSec)
  return { lines, meta, hasTimestamps: lines.length > 0 }
}

// Index of the active line for a given (offset-adjusted) playhead time, via
// binary search. Returns -1 before the first line. O(log n) per tick.
export function currentLineIndex(lines: LrcLine[], adjustedTimeSec: number): number {
  if (lines.length === 0 || adjustedTimeSec < lines[0].timeSec) return -1
  let lo = 0
  let hi = lines.length - 1
  let ans = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].timeSec <= adjustedTimeSec) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

// Split plain (unsynced) lyrics into display lines, preserving blank lines.
export function plainTextLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n').map(l => l.replace(/\s+$/, ''))
}

// Cheap check: does this text contain at least one [mm:ss] timestamp tag?
// search() ignores the global flag's lastIndex, so it never mutates TIME_TAG_RE.
export function isSyncedLrc(text: string): boolean {
  return text.search(TIME_TAG_RE) !== -1
}

function pad(n: number, len = 2): string {
  return String(n).padStart(len, '0')
}

export function formatLrcTime(timeSec: number): string {
  const totalCs = Math.round(Math.max(0, timeSec) * 100)
  const min = Math.floor(totalCs / 6000)
  const sec = Math.floor((totalCs % 6000) / 100)
  const cs = totalCs % 100
  return `[${pad(min)}:${pad(sec)}.${pad(cs)}]`
}

// Upper bound on a single lyrics blob (plain or synced). Real LRC/text lyrics are
// a few KB; this cap defends the DB and main process against a hostile or MITM'd
// provider response — or a pasted megabyte — without rejecting anything genuine.
export const MAX_LYRICS_CHARS = 512_000

export function isLyricsSizeOk(text: string | null | undefined): boolean {
  return text == null || (typeof text === 'string' && text.length <= MAX_LYRICS_CHARS)
}

function offsetInsertIndex(lines: string[]): number {
  let idx = 0
  while (idx < lines.length) {
    const line = lines[idx].trim()
    if (!line) {
      idx++
      continue
    }
    if (line.search(TIME_TAG_RE) !== -1) break
    if (!line.match(META_TAG_RE)) break
    idx++
  }
  return idx
}

export function setLrcOffset(text: string, offsetMsValue: unknown): string {
  const offsetMs = clampLyricsOffsetMs(offsetMsValue)
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const next: string[] = []
  let wroteOffset = false

  for (const line of lines) {
    if (OFFSET_TAG_LINE_RE.test(line)) {
      if (offsetMs !== 0 && !wroteOffset) {
        next.push(`[offset:${offsetMs}]`)
        wroteOffset = true
      }
      continue
    }
    next.push(line)
  }

  if (offsetMs !== 0 && !wroteOffset) {
    next.splice(offsetInsertIndex(next), 0, `[offset:${offsetMs}]`)
  }

  return next.join(newline)
}

export function serializeLrc(parsed: ParsedLrc): string {
  const out: string[] = []
  if (parsed.meta.ti) out.push(`[ti:${parsed.meta.ti}]`)
  if (parsed.meta.ar) out.push(`[ar:${parsed.meta.ar}]`)
  if (parsed.meta.al) out.push(`[al:${parsed.meta.al}]`)
  if (parsed.meta.by) out.push(`[by:${parsed.meta.by}]`)
  if (parsed.meta.offsetSec) out.push(`[offset:${Math.round(parsed.meta.offsetSec * 1000)}]`)
  for (const [k, v] of Object.entries(parsed.meta.raw)) out.push(`[${k}:${v}]`)
  for (const line of parsed.lines) out.push(`${formatLrcTime(line.timeSec)}${line.text}`)
  return out.join('\n')
}
