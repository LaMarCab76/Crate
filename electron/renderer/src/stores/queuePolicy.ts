export type QueueRepeatMode = 'off' | 'one' | 'all'

export interface QueueNextSelection<T> {
  tracks: T[]
  currentIndex: number
  repeat: QueueRepeatMode
  shuffle: boolean
  history: T[]
  key(track: T): string
  random?: () => number
}

export function selectQueueNextIndex<T>({
  tracks,
  currentIndex,
  repeat,
  shuffle,
  history,
  key,
  random = Math.random,
}: QueueNextSelection<T>): number | null {
  if (tracks.length === 0 || currentIndex < 0 || currentIndex >= tracks.length) return null
  if (repeat === 'one') return currentIndex

  if (!shuffle) {
    if (currentIndex + 1 < tracks.length) return currentIndex + 1
    return repeat === 'all' ? 0 : null
  }

  const visited = new Set(history.map(key))
  visited.add(key(tracks[currentIndex]))
  let candidates = tracks
    .map((_, index) => index)
    .filter(index => !visited.has(key(tracks[index])))

  if (candidates.length === 0 && repeat === 'all') {
    candidates = tracks.map((_, index) => index).filter(index => index !== currentIndex)
  }

  if (candidates.length === 0) return null
  const randomIndex = Math.max(0, Math.min(candidates.length - 1, Math.floor(random() * candidates.length)))
  return candidates[randomIndex] ?? null
}
