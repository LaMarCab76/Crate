import { getRepos, type Repos } from '../db/repositories'
import { broadcast } from '../ipc/events'
import { shouldBackfill } from './backfillCandidate'
import { getLyricsService } from './LyricsService'
import { getLyricsSettings } from './LyricsSettings'

// How many tracks we fetch lyrics for at once. Kept <= the provider's own
// MAX_CONCURRENT so we never build a deep backlog inside its rate limiter.
const BACKFILL_CONCURRENCY = 2
// Pause between fetches per worker so a large initial sweep drips rather than
// saturating LRCLIB even within the provider's limits.
const BACKFILL_GAP_MS = 250

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// Proactively fills in missing lyrics in the background. Two entry points:
//   - enqueue(trackId): called from the import path for each freshly-added track
//   - sweepExistingLibrary(): one-time pass over the existing catalog on startup
// Distinct from the renderer's lyricsAutoFetch, which fetches on playback. This
// service is main-driven and never tied to playback. Both honor the same
// LyricsSettings.backgroundFetch toggle. Gating happens at drain time, so
// flipping the setting off stops network activity immediately.
export class LyricsBackfillService {
  private repos: Repos
  private queue: number[] = []
  private queued = new Set<number>() // ids currently in the queue or in flight
  private seen = new Set<number>() // ids attempted this session (skip on retry)
  private workers = 0
  private stopped = false
  private sweepDone = false
  private total = 0
  private done = 0
  private found = 0

  constructor() {
    this.repos = getRepos()
  }

  start(): void {
    this.stopped = false
  }

  stop(): void {
    this.stopped = true
    this.queue.length = 0
    this.queued.clear()
  }

  // Called for every newly-imported track. Cheap no-op when the feature is off
  // (avoids accumulating an unbounded queue during long disabled sessions; the
  // toggle-on path re-sweeps the whole library anyway).
  enqueue(trackId: number): void {
    if (trackId <= 0 || this.stopped) return
    if (!getLyricsSettings().get().backgroundFetch) return
    if (this.queued.has(trackId) || this.seen.has(trackId)) return
    this.queued.add(trackId)
    this.queue.push(trackId)
    this.ensureWorkers()
  }

  // One-time sweep over the existing library. Enqueues only tracks with no
  // lyrics anywhere (status 'none'). Idempotent per session via sweepDone.
  sweepExistingLibrary(): void {
    if (this.stopped || this.sweepDone) return
    if (!getLyricsSettings().get().backgroundFetch) return
    this.sweepDone = true
    const svc = getLyricsService()
    for (const folder of this.repos.folders.list()) {
      for (const track of this.repos.tracks.getByFolder(folder.id)) {
        if (this.queued.has(track.id) || this.seen.has(track.id)) continue
        if (!shouldBackfill(svc.getForTrack(track.id).status)) continue
        this.queued.add(track.id)
        this.queue.push(track.id)
      }
    }
    this.total = this.queue.length
    this.done = 0
    this.found = 0
    this.ensureWorkers()
  }

  private ensureWorkers(): void {
    while (this.workers < BACKFILL_CONCURRENCY && this.queue.length > 0) {
      this.workers++
      void this.drain()
    }
  }

  private async drain(): Promise<void> {
    const svc = getLyricsService()
    try {
      while (!this.stopped) {
        // Re-read the toggle every iteration: turning it off drops the queue and
        // halts further network calls at once. Clear sweepDone so re-enabling
        // resumes the sweep over whatever was left unprocessed (the `seen` set
        // still prevents re-attempting tracks already tried this session).
        if (!getLyricsSettings().get().backgroundFetch) {
          this.queue.length = 0
          this.queued.clear()
          this.sweepDone = false
          break
        }
        const id = this.queue.shift()
        if (id === undefined) break
        this.queued.delete(id)
        this.seen.add(id)
        try {
          // A sidecar may have appeared between enqueue and now; re-check so we
          // never spend a request on a track that already resolved.
          if (shouldBackfill(svc.getForTrack(id).status)) {
            const view = await svc.fetchOnline(id)
            if (
              view.status === 'found_synced' ||
              view.status === 'found_plain' ||
              view.status === 'instrumental'
            ) {
              this.found++
              broadcast('lyrics:changed', { trackId: id })
            }
          }
        } catch {
          // best-effort: a failed fetch just moves on
        }
        this.done++
        broadcast('lyrics:backfill:progress', {
          done: this.done,
          total: this.total,
          found: this.found,
          queued: this.queue.length,
        })
        if (this.queue.length > 0) await sleep(BACKFILL_GAP_MS)
      }
    } finally {
      this.workers--
    }
  }
}

let instance: LyricsBackfillService | null = null

export function getLyricsBackfillService(): LyricsBackfillService {
  if (!instance) instance = new LyricsBackfillService()
  return instance
}
