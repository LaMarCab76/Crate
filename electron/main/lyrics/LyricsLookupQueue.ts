type TimerHandle = ReturnType<typeof setTimeout>

export interface LyricsLookupQueueOptions {
  spacingMs?: number
  now?: () => number
  setTimer?: (handler: () => void, ms: number) => TimerHandle
}

interface QueueItem<T> {
  run: () => Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

const DEFAULT_SPACING_MS = 60 * 1000

export class LyricsLookupQueue {
  private readonly spacingMs: number
  private readonly now: () => number
  private readonly setTimer: (handler: () => void, ms: number) => TimerHandle
  private queue: Array<QueueItem<unknown>> = []
  private running = false
  private lastStartedAt: number | null = null

  constructor(options: LyricsLookupQueueOptions = {}) {
    this.spacingMs = options.spacingMs ?? DEFAULT_SPACING_MS
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? ((handler, ms) => setTimeout(handler, ms))
  }

  enqueue<T>(run: () => Promise<T>): Promise<T> {
    const promise = new Promise<T>((resolve, reject) => {
      this.queue.push({ run, resolve, reject } as QueueItem<unknown>)
    })
    void this.drain()
    return promise
  }

  pendingCount(): number {
    return this.queue.length + (this.running ? 1 : 0)
  }

  nextAllowedAt(): number | null {
    if (this.lastStartedAt == null) return null
    return this.lastStartedAt + this.spacingMs
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length > 0) {
        const waitMs = this.waitMs()
        if (waitMs > 0) await this.sleep(waitMs)

        const item = this.queue.shift()
        if (!item) continue
        this.lastStartedAt = this.now()
        try {
          item.resolve(await item.run())
        } catch (error) {
          item.reject(error)
        }
      }
    } finally {
      this.running = false
      if (this.queue.length > 0) void this.drain()
    }
  }

  private waitMs(): number {
    if (this.lastStartedAt == null) return 0
    return Math.max(0, this.lastStartedAt + this.spacingMs - this.now())
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      this.setTimer(resolve, ms)
    })
  }
}

let instance: LyricsLookupQueue | null = null

export function getLyricsLookupQueue(): LyricsLookupQueue {
  if (!instance) instance = new LyricsLookupQueue()
  return instance
}
