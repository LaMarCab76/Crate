import type {
  DuplicateAnalysisBlocker,
  DuplicateAnalysisProgress,
  DuplicateCandidateDetail,
  DuplicateCandidateSummary,
  DuplicateListRequest,
  DuplicateSummary,
} from '@shared/types/duplicates'
import {
  buildDuplicatePrefilterPairs,
  type DuplicatePrefilterPair,
} from './candidatePrefilter.ts'
import { classifyDuplicatePair } from './classification.ts'
import type { DuplicateTrackFacts } from './domain.ts'
import {
  compareFingerprints,
  compareFingerprintsCooperative,
  sourceSignature,
  type AudioFingerprint,
  type FingerprintProvider,
  type FingerprintSource,
} from './fingerprint.ts'
import { DuplicateRepository } from './DuplicateRepository.ts'
import { recommendDuplicateKeeper } from './recommendation.ts'

export interface DuplicateMetadataEnrichment {
  left?: Partial<Pick<DuplicateTrackFacts,
    | 'releaseType'
    | 'compilation'
    | 'albumCompilation'
    | 'musicBrainzRecordingId'
    | 'musicBrainzReleaseId'
    | 'musicBrainzReleaseGroupId'
    | 'musicBrainzInferred'
  >>
  right?: Partial<Pick<DuplicateTrackFacts,
    | 'releaseType'
    | 'compilation'
    | 'albumCompilation'
    | 'musicBrainzRecordingId'
    | 'musicBrainzReleaseId'
    | 'musicBrainzReleaseGroupId'
    | 'musicBrainzInferred'
  >>
}

/** The implementation owns its cache and rate limit; calls are serial here. */
export interface DuplicateMetadataEnricher {
  beginRun?(): void
  enrichPair(
    left: DuplicateTrackFacts,
    right: DuplicateTrackFacts,
    signal?: AbortSignal,
  ): Promise<DuplicateMetadataEnrichment | null>
}

export interface DuplicateDetectionRunOptions {
  /** Limit reconciliation to pairs touching these tracks. Omit for a full pass. */
  trackIds?: readonly number[]
  /** Ignore a matching source/algorithm cache and regenerate involved fingerprints. */
  force?: boolean
  signal?: AbortSignal
}

export const DUPLICATE_COMPARISON_YIELD_BUDGET_MS = 12

export interface DuplicateDetectionServiceOptions {
  /** Maximum synchronous comparison slice before yielding the main loop. */
  comparisonYieldBudgetMs?: number
  /** Test seam; production uses setImmediate to let Electron service IPC/audio. */
  yieldToEventLoop?: () => Promise<void>
  now?: () => number
  /** Optional grouped root/provider readiness check, run before beginAnalysis. */
  preflight?: DuplicateAnalysisPreflight
}

export interface DuplicateAnalysisPreflightContext {
  tracks: readonly DuplicateTrackFacts[]
  signal?: AbortSignal
}

export type DuplicateAnalysisPreflight = (
  context: DuplicateAnalysisPreflightContext,
) => Promise<DuplicateAnalysisBlocker | null>

export interface DuplicateDetectionResult {
  candidatePairs: number
  fingerprintsCreated: number
  fingerprintsReused: number
  fingerprintFailures: number
  detected: number
  dismissed: number
  stale: number
}

export class DuplicateAnalysisUnavailableError extends Error {
  readonly blocker: DuplicateAnalysisBlocker

  constructor(blocker: DuplicateAnalysisBlocker) {
    super(blocker.message)
    this.name = 'DuplicateAnalysisUnavailableError'
    this.blocker = blocker
  }
}

interface LoadedFingerprint {
  fingerprint: AudioFingerprint
  digest: string
}

function abortError(): Error {
  const error = new Error('Duplicate analysis cancelled.')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

function sourceForTrack(track: DuplicateTrackFacts): FingerprintSource {
  return {
    trackId: track.id,
    provider: track.provider,
    locator: track.path,
    fileSize: track.fileSize,
    dateModified: track.dateModified,
    etag: track.etag,
  }
}

function scopedIds(ids: readonly number[] | undefined): Set<number> | undefined {
  if (!ids) return undefined
  return new Set(ids.filter(id => Number.isInteger(id) && id > 0))
}

export class DuplicateDetectionService {
  private readonly repo: DuplicateRepository
  private readonly fingerprintProvider: FingerprintProvider
  private readonly metadataEnricher?: DuplicateMetadataEnricher
  private readonly comparisonYieldBudgetMs: number
  private readonly yieldToEventLoop: () => Promise<void>
  private readonly now: () => number
  private readonly preflight?: DuplicateAnalysisPreflight
  private readonly progressListeners = new Set<(progress: DuplicateAnalysisProgress) => void>()
  private active: Promise<DuplicateDetectionResult> | null = null
  private currentProgress: DuplicateAnalysisProgress | null = null
  private currentBlocker: DuplicateAnalysisBlocker | undefined
  private pending: DuplicateDetectionRunOptions | null = null

  constructor(
    repo: DuplicateRepository,
    fingerprintProvider: FingerprintProvider,
    metadataEnricher?: DuplicateMetadataEnricher,
    options: DuplicateDetectionServiceOptions = {},
  ) {
    this.repo = repo
    this.fingerprintProvider = fingerprintProvider
    this.metadataEnricher = metadataEnricher
    const configuredBudget = options.comparisonYieldBudgetMs ?? DUPLICATE_COMPARISON_YIELD_BUDGET_MS
    this.comparisonYieldBudgetMs = Number.isFinite(configuredBudget)
      ? Math.max(0, configuredBudget)
      : DUPLICATE_COMPARISON_YIELD_BUDGET_MS
    this.yieldToEventLoop = options.yieldToEventLoop
      ?? (() => new Promise<void>(resolve => setImmediate(resolve)))
    this.now = options.now ?? (() => performance.now())
    this.preflight = options.preflight
  }

  onProgress(listener: (progress: DuplicateAnalysisProgress) => void): () => void {
    this.progressListeners.add(listener)
    return () => this.progressListeners.delete(listener)
  }

  private emit(progress: DuplicateAnalysisProgress): void {
    this.currentProgress = progress
    for (const listener of this.progressListeners) listener(progress)
  }

  private getBlocker(): DuplicateAnalysisBlocker | undefined {
    return this.fingerprintProvider.getBlocker?.() ?? this.currentBlocker
  }

  getSummary(): DuplicateSummary {
    const summary = this.repo.summary()
    const blocker = this.getBlocker()
    if (blocker) {
      return {
        ...summary,
        // A missing application component is not a collection of damaged
        // tracks. Hide stale per-track counters left by older builds and expose
        // the single run-level cause instead.
        queuedCount: 0,
        running: false,
        analyzingCount: 0,
        failedCount: 0,
        progress: undefined,
        blocker,
      }
    }
    if (!this.currentProgress || !this.active) return summary
    return {
      ...summary,
      running: true,
      progress: {
        completed: this.currentProgress.completed,
        total: this.currentProgress.total,
        currentTitle: this.currentProgress.message,
      },
    }
  }

  listCandidates(request: DuplicateListRequest = {}): DuplicateCandidateSummary[] {
    return this.repo.listCandidates(request)
  }

  getCandidate(candidateId: string): DuplicateCandidateDetail | null {
    return this.repo.getCandidate(candidateId)
  }

  analyze(options: DuplicateDetectionRunOptions = {}): Promise<DuplicateDetectionResult> {
    this.enqueue(options)
    if (this.active) return this.active
    this.active = Promise.resolve().then(() => this.drain()).catch(error => {
      const blocker = error instanceof DuplicateAnalysisUnavailableError
        ? error.blocker
        : undefined
      this.emit({
        phase: 'error',
        completed: this.currentProgress?.completed ?? 0,
        total: this.currentProgress?.total ?? 0,
        message: error instanceof Error ? error.message : String(error),
        blocker,
      })
      throw error
    }).finally(() => {
      this.active = null
      this.currentProgress = null
    })
    return this.active
  }

  reanalyze(trackIds?: readonly number[], signal?: AbortSignal): Promise<DuplicateDetectionResult> {
    return this.analyze({ trackIds, force: true, signal })
  }

  private enqueue(options: DuplicateDetectionRunOptions): void {
    if (!this.pending) {
      this.pending = {
        trackIds: options.trackIds ? [...options.trackIds] : undefined,
        force: options.force,
        signal: options.signal,
      }
      return
    }
    const fullRun = !this.pending.trackIds || !options.trackIds
    this.pending = {
      trackIds: fullRun
        ? undefined
        : [...new Set([...this.pending.trackIds!, ...options.trackIds!])],
      force: this.pending.force === true || options.force === true,
      // Preserve the first request's cancellation boundary. Callers that need
      // an independent abortable pass should wait for the active pass first.
      signal: this.pending.signal ?? options.signal,
    }
  }

  private async drain(): Promise<DuplicateDetectionResult> {
    let result: DuplicateDetectionResult = {
      candidatePairs: 0,
      fingerprintsCreated: 0,
      fingerprintsReused: 0,
      fingerprintFailures: 0,
      detected: 0,
      dismissed: 0,
      stale: 0,
    }
    while (this.pending) {
      const options = this.pending
      this.pending = null
      result = await this.run(options)
    }
    return result
  }

  private async loadFingerprint(
    track: DuplicateTrackFacts,
    force: boolean,
    signal?: AbortSignal,
  ): Promise<{ loaded: LoadedFingerprint | null; reused: boolean }> {
    throwIfAborted(signal)
    const source = sourceForTrack(track)
    const signature = sourceSignature(source)
    if (!force) {
      const cached = this.repo.getReusableFingerprint(
        track.id,
        signature,
        this.fingerprintProvider.algorithm,
        this.fingerprintProvider.algorithmVersion,
      )
      if (cached?.fingerprint && cached.fingerprintDigest) {
        this.repo.ensureIdentity(
          track.id,
          cached.fingerprintDigest,
          cached.fingerprint.algorithm,
          cached.fingerprint.algorithmVersion,
        )
        return {
          loaded: { fingerprint: cached.fingerprint, digest: cached.fingerprintDigest },
          reused: true,
        }
      }
    }

    this.repo.beginAnalysis(source, signature, this.fingerprintProvider)
    try {
      const fingerprint = await this.fingerprintProvider.fingerprint(source, signal)
      throwIfAborted(signal)
      if (
        fingerprint.algorithm !== this.fingerprintProvider.algorithm
        || fingerprint.algorithmVersion !== this.fingerprintProvider.algorithmVersion
      ) {
        throw new Error('Fingerprint provider returned an unexpected algorithm version.')
      }
      const digest = this.repo.saveAnalysis(source, signature, fingerprint)
      this.repo.ensureIdentity(track.id, digest, fingerprint.algorithm, fingerprint.algorithmVersion)
      return { loaded: { fingerprint, digest }, reused: false }
    } catch (error) {
      this.repo.failAnalysis(source, signature, this.fingerprintProvider, error)
      if ((error as Error)?.name === 'AbortError') throw error
      return { loaded: null, reused: false }
    }
  }

  private needsFingerprint(track: DuplicateTrackFacts, force: boolean): boolean {
    if (force) return true
    const source = sourceForTrack(track)
    return !this.repo.getReusableFingerprint(
      track.id,
      sourceSignature(source),
      this.fingerprintProvider.algorithm,
      this.fingerprintProvider.algorithmVersion,
    )
  }

  private async enrichIfNeeded(
    pair: DuplicatePrefilterPair<DuplicateTrackFacts>,
    similarity: number,
    segments: FingerprintComparisonSegments,
    signal?: AbortSignal,
  ): Promise<{ left: DuplicateTrackFacts; right: DuplicateTrackFacts }> {
    let left = pair.lowTrack
    let right = pair.highTrack
    if (!this.metadataEnricher) return { left, right }
    const initial = classifyDuplicatePair({ left, right, similarity, segments })
    if (!initial.needsMetadataEnrichment) return { left, right }
    try {
      const enrichment = await this.metadataEnricher.enrichPair(left, right, signal)
      if (enrichment?.left) left = { ...left, ...enrichment.left }
      if (enrichment?.right) right = { ...right, ...enrichment.right }
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') throw error
      // Metadata enrichment is advisory. Acoustic detection remains usable
      // when MusicBrainz is offline or rate-limited.
    }
    return { left, right }
  }

  private async run(options: DuplicateDetectionRunOptions): Promise<DuplicateDetectionResult> {
    const providerBlocker = this.fingerprintProvider.getBlocker?.()
    if (providerBlocker) throw new DuplicateAnalysisUnavailableError(providerBlocker)

    this.metadataEnricher?.beginRun?.()
    const scope = scopedIds(options.trackIds)
    const allTracks = this.repo.listEligibleTracks()
    this.emit({ phase: 'prefiltering', completed: 0, total: allTracks.length })
    let pairs = buildDuplicatePrefilterPairs(allTracks)
    if (scope) {
      pairs = pairs.filter(pair => scope.has(pair.lowTrack.id) || scope.has(pair.highTrack.id))
    }
    this.emit({ phase: 'prefiltering', completed: allTracks.length, total: allTracks.length })
    throwIfAborted(options.signal)

    const involvedTracks = new Map<number, DuplicateTrackFacts>()
    for (const pair of pairs) {
      involvedTracks.set(pair.lowTrack.id, pair.lowTrack)
      involvedTracks.set(pair.highTrack.id, pair.highTrack)
    }
    this.currentBlocker = undefined
    const tracksNeedingFingerprint = [...involvedTracks.values()].filter(track =>
      this.needsFingerprint(track, options.force === true))
    const preflightBlocker = await this.preflight?.({
      tracks: tracksNeedingFingerprint,
      signal: options.signal,
    })
    throwIfAborted(options.signal)
    if (preflightBlocker) {
      this.currentBlocker = preflightBlocker
      throw new DuplicateAnalysisUnavailableError(preflightBlocker)
    }

    const fingerprints = new Map<number, LoadedFingerprint>()
    let fingerprintsCreated = 0
    let fingerprintsReused = 0
    let fingerprintFailures = 0
    let fingerprintIndex = 0
    for (const track of involvedTracks.values()) {
      this.emit({
        phase: 'fingerprinting',
        completed: fingerprintIndex,
        total: involvedTracks.size,
        trackId: track.id,
        message: track.title,
      })
      const result = await this.loadFingerprint(track, options.force === true, options.signal)
      if (result.loaded) {
        fingerprints.set(track.id, result.loaded)
        if (result.reused) fingerprintsReused += 1
        else fingerprintsCreated += 1
      } else {
        fingerprintFailures += 1
      }
      fingerprintIndex += 1
    }
    this.emit({ phase: 'fingerprinting', completed: involvedTracks.size, total: involvedTracks.size })

    let detected = 0
    let dismissed = 0
    const currentPairKeys = new Set<string>()
    let comparisonSliceStartedAt = this.now()
    for (let index = 0; index < pairs.length; index += 1) {
      const pair = pairs[index]
      this.emit({
        phase: 'comparing',
        completed: index,
        total: pairs.length,
        message: `${pair.lowTrack.title} / ${pair.highTrack.title}`,
      })
      throwIfAborted(options.signal)
      const lowFingerprint = fingerprints.get(pair.lowTrack.id)
      const highFingerprint = fingerprints.get(pair.highTrack.id)
      if (!lowFingerprint || !highFingerprint) continue

      const comparison = await compareFingerprintsCooperative(
        lowFingerprint.fingerprint,
        highFingerprint.fingerprint,
        {},
        {
          budgetMs: this.comparisonYieldBudgetMs,
          now: this.now,
          yieldToEventLoop: this.yieldToEventLoop,
          signal: options.signal,
        },
      )
      if (this.now() - comparisonSliceStartedAt >= this.comparisonYieldBudgetMs) {
        await this.yieldToEventLoop()
        throwIfAborted(options.signal)
        comparisonSliceStartedAt = this.now()
      }
      if (!comparison.isCandidate) {
        this.repo.removeCandidatePair(pair.lowTrack.id, pair.highTrack.id)
        continue
      }

      const enriched = await this.enrichIfNeeded(
        pair,
        comparison.similarity,
        comparison.segments,
        options.signal,
      )
      const classification = classifyDuplicatePair({
        left: enriched.left,
        right: enriched.right,
        similarity: comparison.similarity,
        segments: comparison.segments,
      })
      const recommendation = recommendDuplicateKeeper(enriched.left, enriched.right)
      const lowIdentity = this.repo.ensureIdentity(
        pair.lowTrack.id,
        lowFingerprint.digest,
        lowFingerprint.fingerprint.algorithm,
        lowFingerprint.fingerprint.algorithmVersion,
      )
      const highIdentity = this.repo.ensureIdentity(
        pair.highTrack.id,
        highFingerprint.digest,
        highFingerprint.fingerprint.algorithm,
        highFingerprint.fingerprint.algorithmVersion,
      )
      const isDismissed = this.repo.hasMatchingKeepBothDecision(lowIdentity, highIdentity)
      this.repo.upsertCandidate({
        pair,
        comparison,
        classification,
        recommendation,
        lowFingerprintDigest: lowFingerprint.digest,
        highFingerprintDigest: highFingerprint.digest,
        status: isDismissed ? 'dismissed' : 'pending',
      })
      currentPairKeys.add(`${pair.lowTrack.id}:${pair.highTrack.id}`)
      if (isDismissed) dismissed += 1
      else detected += 1
    }

    const stale = this.repo.markUnseenCandidatesStale(currentPairKeys, scope)
    const result = {
      candidatePairs: pairs.length,
      fingerprintsCreated,
      fingerprintsReused,
      fingerprintFailures,
      detected,
      dismissed,
      stale,
    }
    this.emit({ phase: 'complete', completed: pairs.length, total: pairs.length })
    return result
  }
}

type FingerprintComparisonSegments = ReturnType<typeof compareFingerprints>['segments']
