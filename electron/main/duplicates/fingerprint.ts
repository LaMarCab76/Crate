import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import type {
  DuplicateAnalysisBlocker,
  DuplicateAnalysisBlockerCode,
  DuplicateSegment,
} from '@shared/types/duplicates'
import type { LibraryProvider } from '@shared/types/library-locations'

export const DUPLICATE_SIMILARITY_THRESHOLD = 0.6
export const DUPLICATE_MAX_ALIGNMENT_SECONDS = 30
export const DUPLICATE_FRAME_HAMMING_THRESHOLD = 2
export const DUPLICATE_SEGMENT_WINDOW_SECONDS = 5
export const DUPLICATE_SEGMENT_MATCH_THRESHOLD = 0.7
export const DUPLICATE_SEGMENT_MERGE_GAP_SECONDS = 2

const MAX_DECODED_FINGERPRINT_FRAMES = 1_000_000

export interface FingerprintSource {
  trackId: number
  provider: LibraryProvider
  locator: string
  fileSize: number | null
  dateModified: string | null
  etag: string | null
}

export interface AudioFingerprint {
  algorithm: string
  algorithmVersion: string
  framesPerSecond: number
  /** Position of the first raw item on the decoded-audio timeline. */
  delaySeconds?: number
  durationSeconds: number
  frames: Uint32Array
}

/** Native Chromaprint and deterministic test providers implement this seam. */
export interface FingerprintProvider {
  readonly algorithm: string
  readonly algorithmVersion: string
  /** Run-level readiness check. When blocked, callers must not mutate track analyses. */
  getBlocker?(): DuplicateAnalysisBlocker | null
  fingerprint(source: FingerprintSource, signal?: AbortSignal): Promise<AudioFingerprint>
}

export interface FingerprintComparisonOptions {
  maxAlignmentSeconds?: number
  maxHammingDistance?: number
  segmentWindowSeconds?: number
  segmentMatchThreshold?: number
  mergeGapSeconds?: number
}

export interface CooperativeFingerprintComparisonControl {
  /** Maximum CPU slice before yielding back to Electron's event loop. */
  budgetMs?: number
  now?: () => number
  yieldToEventLoop?: () => Promise<void>
  signal?: AbortSignal
}

export interface FingerprintComparison {
  similarity: number
  isCandidate: boolean
  offsetFrames: number
  offsetSeconds: number
  matchingFrames: number
  comparedFrames: number
  overlapFrames: number
  segments: DuplicateSegment[]
}

export class UnavailableFingerprintProvider implements FingerprintProvider {
  readonly algorithm: string
  readonly algorithmVersion: string
  private readonly detail: string
  private readonly blocker: DuplicateAnalysisBlocker

  constructor(
    algorithm = 'chromaprint',
    algorithmVersion = '1.6.0',
    detail = 'La huella acústica nativa no está disponible.',
    options: {
      code?: DuplicateAnalysisBlockerCode
      message?: string
      component?: string
    } = {},
  ) {
    this.algorithm = algorithm
    this.algorithmVersion = algorithmVersion
    this.detail = detail
    this.blocker = {
      code: options.code ?? 'fingerprint_provider_unavailable',
      message: options.message ?? detail,
      retryable: false,
      requiresRestart: true,
      component: options.component ?? algorithm,
      version: algorithmVersion,
      detail,
    }
  }

  getBlocker(): DuplicateAnalysisBlocker {
    return { ...this.blocker }
  }

  async fingerprint(): Promise<AudioFingerprint> {
    throw new Error(this.detail)
  }
}

export function sourceSignature(source: FingerprintSource): string {
  const stable = JSON.stringify({
    provider: source.provider,
    locator: source.locator,
    fileSize: source.fileSize,
    dateModified: source.dateModified,
    etag: source.etag,
  })
  return createHash('sha256').update(stable).digest('hex')
}

function framesToBuffer(frames: Uint32Array): Buffer {
  const buffer = Buffer.allocUnsafe(frames.length * 4)
  for (let index = 0; index < frames.length; index += 1) {
    buffer.writeUInt32LE(frames[index] >>> 0, index * 4)
  }
  return buffer
}

export function fingerprintDigest(frames: Uint32Array): string {
  return createHash('sha256').update(framesToBuffer(frames)).digest('hex')
}

export function encodeFingerprintFrames(frames: Uint32Array): Buffer {
  if (frames.length === 0) throw new Error('A duplicate fingerprint cannot be empty.')
  if (frames.length > MAX_DECODED_FINGERPRINT_FRAMES) {
    throw new Error('Duplicate fingerprint payload exceeds the safety limit.')
  }
  // Node emits a deterministic gzip header; keeping the options to the
  // documented surface also makes this compile against every supported Node.
  return gzipSync(framesToBuffer(frames), { level: 9 })
}

export function decodeFingerprintFrames(blob: Buffer): Uint32Array {
  const buffer = gunzipSync(blob)
  if (buffer.length === 0 || buffer.length % 4 !== 0) {
    throw new Error('Invalid duplicate fingerprint payload.')
  }
  const count = buffer.length / 4
  if (count > MAX_DECODED_FINGERPRINT_FRAMES) {
    throw new Error('Duplicate fingerprint payload exceeds the safety limit.')
  }
  const frames = new Uint32Array(count)
  for (let index = 0; index < count; index += 1) {
    frames[index] = buffer.readUInt32LE(index * 4)
  }
  return frames
}

export function hammingDistance32(left: number, right: number): number {
  let bits = (left ^ right) >>> 0
  bits = bits - ((bits >>> 1) & 0x55555555)
  bits = (bits & 0x33333333) + ((bits >>> 2) & 0x33333333)
  return (((bits + (bits >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}

function assertComparable(left: AudioFingerprint, right: AudioFingerprint): {
  framesPerSecond: number
  delaySeconds: number
} {
  if (left.frames.length === 0 || right.frames.length === 0) {
    throw new Error('Cannot compare an empty duplicate fingerprint.')
  }
  if (left.algorithm !== right.algorithm || left.algorithmVersion !== right.algorithmVersion) {
    throw new Error('Duplicate fingerprints use incompatible algorithm versions.')
  }
  if (!Number.isFinite(left.framesPerSecond) || left.framesPerSecond <= 0) {
    throw new Error('Duplicate fingerprint has an invalid frame rate.')
  }
  if (Math.abs(left.framesPerSecond - right.framesPerSecond) > 0.000001) {
    throw new Error('Duplicate fingerprints use incompatible frame rates.')
  }
  const leftDelay = left.delaySeconds ?? 0
  const rightDelay = right.delaySeconds ?? 0
  if (!Number.isFinite(leftDelay) || leftDelay < 0 || !Number.isFinite(rightDelay) || rightDelay < 0) {
    throw new Error('Duplicate fingerprint has an invalid algorithm delay.')
  }
  if (Math.abs(leftDelay - rightDelay) > 0.000001) {
    throw new Error('Duplicate fingerprints use incompatible algorithm delays.')
  }
  return { framesPerSecond: left.framesPerSecond, delaySeconds: leftDelay }
}

interface Alignment {
  offset: number
  matches: number
  overlap: number
}

function alignmentForOffset(
  left: Uint32Array,
  right: Uint32Array,
  offset: number,
  maxHammingDistance: number,
): Alignment {
  // offset is defined as rightIndex - leftIndex for corresponding frames.
  const leftStart = Math.max(0, -offset)
  const rightStart = leftStart + offset
  const overlap = Math.min(left.length - leftStart, right.length - rightStart)
  if (overlap <= 0) return { offset, matches: 0, overlap: 0 }

  let matches = 0
  for (let index = 0; index < overlap; index += 1) {
    if (hammingDistance32(left[leftStart + index], right[rightStart + index]) <= maxHammingDistance) {
      matches += 1
    }
  }
  return { offset, matches, overlap }
}

function betterAlignment(candidate: Alignment, current: Alignment | null): boolean {
  if (!current) return true
  if (candidate.matches !== current.matches) return candidate.matches > current.matches
  const candidateOverlapScore = candidate.overlap > 0 ? candidate.matches / candidate.overlap : 0
  const currentOverlapScore = current.overlap > 0 ? current.matches / current.overlap : 0
  if (candidateOverlapScore !== currentOverlapScore) return candidateOverlapScore > currentOverlapScore
  if (Math.abs(candidate.offset) !== Math.abs(current.offset)) {
    return Math.abs(candidate.offset) < Math.abs(current.offset)
  }
  return candidate.offset < current.offset
}

interface MutableSegment extends DuplicateSegment {
  frameCount: number
}

function sideStartSeconds(
  timelineStartFrame: number,
  timelineEndFrame: number,
  sideStartFrame: number,
  sideLength: number,
  framesPerSecond: number,
): number | null {
  const sideEndFrame = sideStartFrame + sideLength
  if (timelineEndFrame <= sideStartFrame || timelineStartFrame >= sideEndFrame) return null
  return Math.max(0, timelineStartFrame - sideStartFrame) / framesPerSecond
}

function combineSegments(left: MutableSegment, right: MutableSegment): MutableSegment {
  const totalFrames = left.frameCount + right.frameCount
  return {
    ...left,
    id: `segment-${Math.round(left.startSec * 1000)}-${Math.round(right.endSec * 1000)}`,
    endSec: right.endSec,
    score: totalFrames > 0
      ? ((left.score * left.frameCount) + (right.score * right.frameCount)) / totalFrames
      : 0,
    frameCount: totalFrames,
  }
}

function coalesceSegments(segments: MutableSegment[]): MutableSegment[] {
  const result: MutableSegment[] = []
  for (const segment of segments) {
    const previous = result.at(-1)
    if (previous?.kind === segment.kind) result[result.length - 1] = combineSegments(previous, segment)
    else result.push(segment)
  }
  return result
}

function buildSegments(
  left: Uint32Array,
  right: Uint32Array,
  offset: number,
  framesPerSecond: number,
  maxHammingDistance: number,
  windowSeconds: number,
  matchThreshold: number,
  mergeGapSeconds: number,
  delaySeconds: number,
): DuplicateSegment[] {
  const leftTimelineStart = Math.max(0, offset)
  const rightTimelineStart = Math.max(0, -offset)
  const timelineFrames = Math.max(
    leftTimelineStart + left.length,
    rightTimelineStart + right.length,
  )
  const windowFrames = Math.max(1, Math.round(windowSeconds * framesPerSecond))
  const rawMatches = new Uint8Array(timelineFrames)
  const prefixMatches = new Uint32Array(timelineFrames + 1)
  for (let timelineIndex = 0; timelineIndex < timelineFrames; timelineIndex += 1) {
    const leftIndex = timelineIndex - leftTimelineStart
    const rightIndex = timelineIndex - rightTimelineStart
    if (
      leftIndex >= 0 && rightIndex >= 0
      && leftIndex < left.length && rightIndex < right.length
      && hammingDistance32(left[leftIndex], right[rightIndex]) <= maxHammingDistance
    ) rawMatches[timelineIndex] = 1
    prefixMatches[timelineIndex + 1] = prefixMatches[timelineIndex] + rawMatches[timelineIndex]
  }

  // Classify each frame from a centered five-second neighborhood. This keeps
  // segment boundaries at Chromaprint-frame precision, so short transition
  // jitter can actually be merged instead of being quantized to five seconds.
  const kinds = new Array<DuplicateSegment['kind']>(timelineFrames)
  const halfWindow = Math.floor(windowFrames / 2)
  for (let index = 0; index < timelineFrames; index += 1) {
    let start = Math.max(0, index - halfWindow)
    let end = Math.min(timelineFrames, start + windowFrames)
    start = Math.max(0, end - windowFrames)
    const count = end - start
    const score = count > 0 ? (prefixMatches[end] - prefixMatches[start]) / count : 0
    kinds[index] = score >= matchThreshold ? 'match' : 'difference'
  }

  const initial: MutableSegment[] = []
  for (let start = 0; start < timelineFrames;) {
    let end = start + 1
    while (end < timelineFrames && kinds[end] === kinds[start]) end += 1
    const frameCount = end - start
    const score = frameCount > 0
      ? (prefixMatches[end] - prefixMatches[start]) / frameCount
      : 0
    initial.push({
      id: `segment-${start}-${end}`,
      kind: kinds[start],
      startSec: delaySeconds + start / framesPerSecond,
      endSec: delaySeconds + end / framesPerSecond,
      leftStartSec: (() => {
        const value = sideStartSeconds(start, end, leftTimelineStart, left.length, framesPerSecond)
        return value == null ? null : delaySeconds + value
      })(),
      rightStartSec: (() => {
        const value = sideStartSeconds(start, end, rightTimelineStart, right.length, framesPerSecond)
        return value == null ? null : delaySeconds + value
      })(),
      score,
      frameCount,
    })
    start = end
  }

  // A very short transition surrounded by the other state is treated as
  // fingerprint jitter. The original scores remain in the weighted merge.
  for (let index = 1; index < initial.length - 1; index += 1) {
    const segment = initial[index]
    if (
      segment.endSec - segment.startSec < mergeGapSeconds
      && initial[index - 1].kind === initial[index + 1].kind
      && segment.kind !== initial[index - 1].kind
    ) {
      segment.kind = initial[index - 1].kind
    }
  }

  return coalesceSegments(initial).map(({ frameCount: _frameCount, ...segment }) => segment)
}

export function compareFingerprints(
  left: AudioFingerprint,
  right: AudioFingerprint,
  options: FingerprintComparisonOptions = {},
): FingerprintComparison {
  const { framesPerSecond, delaySeconds } = assertComparable(left, right)
  const maxAlignmentSeconds = options.maxAlignmentSeconds ?? DUPLICATE_MAX_ALIGNMENT_SECONDS
  const maxHammingDistance = options.maxHammingDistance ?? DUPLICATE_FRAME_HAMMING_THRESHOLD
  const segmentWindowSeconds = options.segmentWindowSeconds ?? DUPLICATE_SEGMENT_WINDOW_SECONDS
  const segmentMatchThreshold = options.segmentMatchThreshold ?? DUPLICATE_SEGMENT_MATCH_THRESHOLD
  const mergeGapSeconds = options.mergeGapSeconds ?? DUPLICATE_SEGMENT_MERGE_GAP_SECONDS
  if (!Number.isFinite(maxAlignmentSeconds) || maxAlignmentSeconds < 0) {
    throw new Error('maxAlignmentSeconds must be a non-negative number.')
  }
  if (!Number.isInteger(maxHammingDistance) || maxHammingDistance < 0 || maxHammingDistance > 32) {
    throw new Error('maxHammingDistance must be an integer between 0 and 32.')
  }
  if (!Number.isFinite(segmentWindowSeconds) || segmentWindowSeconds <= 0) {
    throw new Error('segmentWindowSeconds must be greater than zero.')
  }
  if (!Number.isFinite(segmentMatchThreshold) || segmentMatchThreshold < 0 || segmentMatchThreshold > 1) {
    throw new Error('segmentMatchThreshold must be between zero and one.')
  }

  const maxShift = Math.min(
    Math.max(left.frames.length, right.frames.length) - 1,
    Math.round(maxAlignmentSeconds * framesPerSecond),
  )
  let best: Alignment | null = null
  for (let offset = -maxShift; offset <= maxShift; offset += 1) {
    const candidate = alignmentForOffset(left.frames, right.frames, offset, maxHammingDistance)
    if (betterAlignment(candidate, best)) best = candidate
  }
  const alignment = best ?? { offset: 0, matches: 0, overlap: 0 }
  const comparedFrames = Math.max(left.frames.length, right.frames.length)
  const similarity = alignment.matches / comparedFrames
  return {
    similarity,
    isCandidate: similarity > DUPLICATE_SIMILARITY_THRESHOLD,
    offsetFrames: alignment.offset,
    offsetSeconds: alignment.offset / framesPerSecond,
    matchingFrames: alignment.matches,
    comparedFrames,
    overlapFrames: alignment.overlap,
    segments: buildSegments(
      left.frames,
      right.frames,
      alignment.offset,
      framesPerSecond,
      maxHammingDistance,
      segmentWindowSeconds,
      segmentMatchThreshold,
      mergeGapSeconds,
      delaySeconds,
    ),
  }
}

/**
 * Result-equivalent comparison for the Electron main process. Unlike the pure
 * synchronous helper, this yields while evaluating a single long alignment,
 * so one unusually long recording cannot monopolize IPC or playback control.
 */
export async function compareFingerprintsCooperative(
  left: AudioFingerprint,
  right: AudioFingerprint,
  options: FingerprintComparisonOptions = {},
  control: CooperativeFingerprintComparisonControl = {},
): Promise<FingerprintComparison> {
  const { framesPerSecond, delaySeconds } = assertComparable(left, right)
  const maxAlignmentSeconds = options.maxAlignmentSeconds ?? DUPLICATE_MAX_ALIGNMENT_SECONDS
  const maxHammingDistance = options.maxHammingDistance ?? DUPLICATE_FRAME_HAMMING_THRESHOLD
  const segmentWindowSeconds = options.segmentWindowSeconds ?? DUPLICATE_SEGMENT_WINDOW_SECONDS
  const segmentMatchThreshold = options.segmentMatchThreshold ?? DUPLICATE_SEGMENT_MATCH_THRESHOLD
  const mergeGapSeconds = options.mergeGapSeconds ?? DUPLICATE_SEGMENT_MERGE_GAP_SECONDS
  if (!Number.isFinite(maxAlignmentSeconds) || maxAlignmentSeconds < 0) {
    throw new Error('maxAlignmentSeconds must be a non-negative number.')
  }
  if (!Number.isInteger(maxHammingDistance) || maxHammingDistance < 0 || maxHammingDistance > 32) {
    throw new Error('maxHammingDistance must be an integer between 0 and 32.')
  }
  if (!Number.isFinite(segmentWindowSeconds) || segmentWindowSeconds <= 0) {
    throw new Error('segmentWindowSeconds must be greater than zero.')
  }
  if (!Number.isFinite(segmentMatchThreshold) || segmentMatchThreshold < 0 || segmentMatchThreshold > 1) {
    throw new Error('segmentMatchThreshold must be between zero and one.')
  }

  const now = control.now ?? Date.now
  const yieldToEventLoop = control.yieldToEventLoop
    ?? (() => new Promise<void>(resolve => setImmediate(resolve)))
  const budgetMs = Math.max(1, control.budgetMs ?? 12)
  let sliceStartedAt = now()
  const cooperate = async (): Promise<void> => {
    control.signal?.throwIfAborted()
    if (now() - sliceStartedAt < budgetMs) return
    await yieldToEventLoop()
    control.signal?.throwIfAborted()
    sliceStartedAt = now()
  }

  const maxShift = Math.min(
    Math.max(left.frames.length, right.frames.length) - 1,
    Math.round(maxAlignmentSeconds * framesPerSecond),
  )
  let best: Alignment | null = null
  for (let offset = -maxShift; offset <= maxShift; offset += 1) {
    const leftStart = Math.max(0, -offset)
    const rightStart = leftStart + offset
    const overlap = Math.min(left.frames.length - leftStart, right.frames.length - rightStart)
    let matches = 0
    if (overlap > 0) {
      for (let index = 0; index < overlap; index += 1) {
        if (
          hammingDistance32(left.frames[leftStart + index], right.frames[rightStart + index])
          <= maxHammingDistance
        ) matches += 1
        if ((index & 0x0fff) === 0x0fff) await cooperate()
      }
    }
    const candidate = { offset, matches, overlap: Math.max(0, overlap) }
    if (betterAlignment(candidate, best)) best = candidate
    await cooperate()
  }

  const alignment = best ?? { offset: 0, matches: 0, overlap: 0 }
  const comparedFrames = Math.max(left.frames.length, right.frames.length)
  const similarity = alignment.matches / comparedFrames
  return {
    similarity,
    isCandidate: similarity > DUPLICATE_SIMILARITY_THRESHOLD,
    offsetFrames: alignment.offset,
    offsetSeconds: alignment.offset / framesPerSecond,
    matchingFrames: alignment.matches,
    comparedFrames,
    overlapFrames: alignment.overlap,
    segments: buildSegments(
      left.frames,
      right.frames,
      alignment.offset,
      framesPerSecond,
      maxHammingDistance,
      segmentWindowSeconds,
      segmentMatchThreshold,
      mergeGapSeconds,
      delaySeconds,
    ),
  }
}
