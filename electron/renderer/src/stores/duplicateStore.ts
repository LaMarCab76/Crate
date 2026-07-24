import { create } from 'zustand'
import type {
  DuplicateAnalysisProgress,
  DuplicateAuditionSide,
  DuplicateAuditionState,
  DuplicateCandidateDetail,
  DuplicateCandidateSummary,
  DuplicateKeepBothReason,
  DuplicateResolutionAction,
  DuplicateSummary,
} from '@shared/types/duplicates'
import { isExpectedAuditionCancellation } from '@renderer/utils/duplicateAuditionErrors'
import { duplicateResolutionActionForKeptSide } from '@renderer/utils/duplicateReview'

const EMPTY_SUMMARY: DuplicateSummary = {
  pendingCount: 0,
  analyzedCount: 0,
  queuedCount: 0,
  running: false,
  dismissedCount: 0,
  staleCount: 0,
  analyzingCount: 0,
  failedCount: 0,
  lastAnalyzedAt: null,
}

const CLOSED_AUDITION: DuplicateAuditionState = {
  candidateId: null,
  activeSide: null,
  status: 'closed',
  leftPositionSec: 0,
  rightPositionSec: 0,
  leftDurationSec: 0,
  rightDurationSec: 0,
  comparingSegmentIndex: null,
  error: null,
}

interface DuplicateStoreState {
  summary: DuplicateSummary
  candidates: DuplicateCandidateSummary[]
  detail: DuplicateCandidateDetail | null
  selectedIndex: number
  loading: boolean
  reanalyzing: boolean
  resolving: boolean
  resolvingCandidateId: string | null
  active: boolean
  error: string | null
  notice: string | null
  audition: DuplicateAuditionState

  loadSummary(): Promise<void>
  enter(candidateId?: string): Promise<void>
  leave(): Promise<void>
  selectCandidate(candidateId: string): Promise<void>
  selectRelative(offset: number): Promise<void>
  showList(): Promise<void>
  reanalyze(): Promise<void>
  keepBoth(reason: DuplicateKeepBothReason): Promise<boolean>
  keepCandidate(
    candidateId: string,
    expectedRevision: number,
    side: DuplicateAuditionSide,
  ): Promise<boolean>
  togglePlay(side: DuplicateAuditionSide): Promise<void>
  pause(): Promise<void>
  seek(side: DuplicateAuditionSide, positionSec: number): Promise<void>
  compareSegment(segmentIndex: number): Promise<void>
  clearNotice(): void
}

let viewGeneration = 0
let listeners: Array<() => void> | null = null
let changedRefresh: Promise<void> | null = null

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function selectedCandidate(
  candidates: DuplicateCandidateSummary[],
  requestedId: string | undefined,
  fallbackIndex: number,
): { candidate: DuplicateCandidateSummary | null; index: number } {
  if (candidates.length === 0) return { candidate: null, index: 0 }
  const requestedIndex = requestedId ? candidates.findIndex(item => item.id === requestedId) : -1
  const index = requestedIndex >= 0
    ? requestedIndex
    : Math.max(0, Math.min(fallbackIndex, candidates.length - 1))
  return { candidate: candidates[index], index }
}

async function listAllPendingCandidates(): Promise<DuplicateCandidateSummary[]> {
  const candidates: DuplicateCandidateSummary[] = []
  const seen = new Set<string>()
  const pageSize = 200
  for (let offset = 0; ; offset += pageSize) {
    const page = await window.api.duplicates.list({ status: 'pending', limit: pageSize, offset })
    for (const candidate of page) {
      if (seen.has(candidate.id)) continue
      seen.add(candidate.id)
      candidates.push(candidate)
    }
    if (page.length < pageSize) break
  }
  return candidates
}

async function openCandidate(
  candidate: DuplicateCandidateSummary,
  generation: number,
): Promise<DuplicateCandidateDetail | null> {
  const detail = await window.api.duplicates.detail(candidate.id)
  if (generation !== viewGeneration || !useDuplicateStore.getState().active) return null
  await window.api.duplicates.audition.open({
    candidateId: candidate.id,
    expectedRevision: candidate.revision,
  })
  if (generation !== viewGeneration || !useDuplicateStore.getState().active) return null
  return detail
}

async function refreshActiveView(preferredId?: string): Promise<void> {
  const generation = viewGeneration
  const state = useDuplicateStore.getState()
  const [summary, candidates] = await Promise.all([
    window.api.duplicates.summary(),
    listAllPendingCandidates(),
  ])
  if (generation !== viewGeneration || !useDuplicateStore.getState().active) {
    useDuplicateStore.setState({ summary })
    return
  }

  const currentId = preferredId ?? state.detail?.id
  const selection = selectedCandidate(candidates, currentId, state.selectedIndex)
  if (!selection.candidate) {
    useDuplicateStore.setState({ summary, candidates, detail: null, selectedIndex: 0, loading: false })
    return
  }

  // A refresh must preserve the user's place. When they are looking at the
  // pending list, background analysis or another resolved pair may update the
  // rows, but must never pull them into an arbitrary comparison.
  if (!state.detail && !preferredId) {
    useDuplicateStore.setState({
      summary,
      candidates,
      detail: null,
      selectedIndex: Math.max(0, Math.min(state.selectedIndex, candidates.length - 1)),
      loading: false,
    })
    return
  }

  if (
    state.detail?.id === selection.candidate.id
    && state.detail.revision === selection.candidate.revision
  ) {
    useDuplicateStore.setState({
      summary,
      candidates,
      selectedIndex: selection.index,
      loading: false,
    })
    return
  }

  const detail = await openCandidate(selection.candidate, generation)
  if (!detail || generation !== viewGeneration || !useDuplicateStore.getState().active) return
  useDuplicateStore.setState({
    summary,
    candidates,
    detail,
    selectedIndex: selection.index,
    loading: false,
  })
}

async function resolveCandidate(
  candidate: DuplicateCandidateSummary,
  action: DuplicateResolutionAction,
  reason?: DuplicateKeepBothReason,
): Promise<boolean> {
  const state = useDuplicateStore.getState()
  if (state.resolving) return false
  const candidateIndex = state.candidates.findIndex(item => item.id === candidate.id)
  // Retire any background refresh that started before the user confirmed the
  // resolution. Its candidate/open result is no longer authoritative.
  ++viewGeneration
  useDuplicateStore.setState({
    resolving: true,
    resolvingCandidateId: candidate.id,
    selectedIndex: candidateIndex >= 0 ? candidateIndex : state.selectedIndex,
    error: null,
    notice: null,
  })
  try {
    const result = action === 'keep_both'
      ? await window.api.duplicates.resolve({
          candidateId: candidate.id,
          expectedRevision: candidate.revision,
          action,
          reason: reason!,
        })
      : await window.api.duplicates.resolve({
          candidateId: candidate.id,
          expectedRevision: candidate.revision,
          action,
        })
    const removedTrack = action === 'trash_left'
      ? candidate.left
      : action === 'trash_right'
        ? candidate.right
        : null
    const removedFileName = removedTrack?.path.split(/[\\/]/).pop() || removedTrack?.path
    const base = action === 'keep_both'
      ? `Se conservaron “${candidate.left.title}” y “${candidate.right.title}”.`
      : `“${removedTrack?.title}” (${removedFileName}) se envió a la Papelera y la biblioteca quedó actualizada.`
    const warning = result.warnings.length > 0 ? ` ${result.warnings.join(' ')}` : ''
    // Resolution returns to the overview so the remaining workload and every
    // still-pending pair are visible. The audition service invalidates the
    // resolved candidate in the main process.
    useDuplicateStore.setState({ notice: base + warning, detail: null, loading: true })
    await refreshActiveView()
    const remaining = useDuplicateStore.getState().candidates.length
    useDuplicateStore.setState({
      notice: `${base} ${remaining === 1 ? 'Queda 1 comparación pendiente.' : `Quedan ${remaining.toLocaleString()} comparaciones pendientes.`}${warning}`,
    })
    return true
  } catch (error) {
    useDuplicateStore.setState(isExpectedAuditionCancellation(error)
      ? { loading: false }
      : { error: errorMessage(error), loading: false })
    return false
  } finally {
    useDuplicateStore.setState({ resolving: false, resolvingCandidateId: null })
  }
}

async function resolveCurrent(
  action: DuplicateResolutionAction,
  reason?: DuplicateKeepBothReason,
): Promise<boolean> {
  const detail = useDuplicateStore.getState().detail
  if (!detail) return false
  return resolveCandidate(detail, action, reason)
}

export const useDuplicateStore = create<DuplicateStoreState>((set, get) => ({
  summary: EMPTY_SUMMARY,
  candidates: [],
  detail: null,
  selectedIndex: 0,
  loading: false,
  reanalyzing: false,
  resolving: false,
  resolvingCandidateId: null,
  active: false,
  error: null,
  notice: null,
  audition: CLOSED_AUDITION,

  async loadSummary() {
    try {
      const summary = await window.api.duplicates.summary()
      set({ summary })
    } catch (error) {
      if (get().active) set({ error: errorMessage(error) })
    }
  },

  async enter(candidateId) {
    const generation = ++viewGeneration
    set({ active: true, loading: true, error: null, notice: null })
    try {
      // Duplicate review owns one main-player snapshot for its entire route,
      // including the list overview before any A/B streams are opened.
      await window.api.duplicates.audition.beginSession()
      if (generation !== viewGeneration || !get().active) return
      const [summary, candidates] = await Promise.all([
        window.api.duplicates.summary(),
        listAllPendingCandidates(),
      ])
      if (generation !== viewGeneration || !get().active) return
      if (!candidateId) {
        set({
          summary,
          candidates,
          detail: null,
          selectedIndex: Math.max(0, Math.min(get().selectedIndex, candidates.length - 1)),
          loading: false,
        })
        return
      }
      const selection = selectedCandidate(candidates, candidateId, get().selectedIndex)
      set({ summary, candidates, selectedIndex: selection.index })
      if (!selection.candidate) {
        set({ detail: null, loading: false })
        return
      }
      const detail = await openCandidate(selection.candidate, generation)
      if (!detail || generation !== viewGeneration || !get().active) return
      set({ detail, loading: false })
    } catch (error) {
      if (generation === viewGeneration) {
        set(isExpectedAuditionCancellation(error)
          ? { loading: false }
          : { loading: false, error: errorMessage(error) })
      }
    }
  },

  async leave() {
    ++viewGeneration
    set({ active: false, error: null, notice: null, audition: CLOSED_AUDITION })
    try {
      await window.api.duplicates.audition.close()
    } catch {
      // The main-process service still cleans up on window teardown. Leaving the
      // view must not trap the user because a temporary source disappeared.
    }
  },

  async selectCandidate(candidateId) {
    const state = get()
    if (!state.active || state.loading || state.resolving || state.detail?.id === candidateId) return
    const candidate = state.candidates.find(item => item.id === candidateId)
    if (!candidate) return
    const generation = ++viewGeneration
    set({
      loading: true,
      selectedIndex: Math.max(0, state.candidates.findIndex(item => item.id === candidateId)),
      error: null,
      notice: null,
    })
    try {
      const detail = await openCandidate(candidate, generation)
      if (!detail || generation !== viewGeneration || !get().active) return
      set({
        detail,
        selectedIndex: Math.max(0, get().candidates.findIndex(item => item.id === candidateId)),
        loading: false,
      })
    } catch (error) {
      if (generation === viewGeneration) {
        set(isExpectedAuditionCancellation(error)
          ? { loading: false }
          : { loading: false, error: errorMessage(error) })
      }
    }
  },

  async selectRelative(offset) {
    const state = get()
    if (state.candidates.length === 0) return
    const next = Math.max(0, Math.min(state.candidates.length - 1, state.selectedIndex + offset))
    if (next === state.selectedIndex) return
    await get().selectCandidate(state.candidates[next].id)
  },

  async showList() {
    const state = get()
    if (!state.active || !state.detail) return
    ++viewGeneration
    set({ detail: null, loading: false, error: null })
    try {
      // Keep the main-player snapshot owned by the audition service until the
      // user leaves Duplicates. This only silences the A/B deck.
      await window.api.duplicates.audition.pause()
    } catch (error) {
      if (get().active) set({ error: errorMessage(error) })
    }
  },

  async reanalyze() {
    if (get().reanalyzing) return
    const blocker = get().summary.blocker
    if (blocker && !blocker.retryable) {
      set({ error: blocker.message, notice: null })
      return
    }
    set({ reanalyzing: true, error: null, notice: null })
    try {
      await window.api.duplicates.reanalyze()
      await get().loadSummary()
      set({ notice: 'El análisis se ejecutará en segundo plano.' })
    } catch (error) {
      set({ error: errorMessage(error) })
    } finally {
      set({ reanalyzing: false })
    }
  },

  keepBoth: reason => resolveCurrent('keep_both', reason),
  async keepCandidate(candidateId, expectedRevision, side) {
    const state = get()
    if (!state.active || state.resolving) return false
    const candidate = state.detail?.id === candidateId
      ? state.detail
      : state.candidates.find(item => item.id === candidateId)
    if (!candidate || candidate.revision !== expectedRevision) {
      set({
        error: 'Esta comparación cambió mientras estaba abierta. Revisá los datos actualizados antes de decidir.',
      })
      return false
    }
    return resolveCandidate(candidate, duplicateResolutionActionForKeptSide(side))
  },

  async togglePlay(side) {
    const { audition } = get()
    set({ error: null })
    try {
      if (audition.activeSide === side && audition.status === 'playing') {
        await window.api.duplicates.audition.pause()
      } else {
        await window.api.duplicates.audition.play(side)
      }
    } catch (error) {
      set({ error: errorMessage(error) })
    }
  },

  async pause() {
    try {
      await window.api.duplicates.audition.pause()
    } catch (error) {
      set({ error: errorMessage(error) })
    }
  },

  async seek(side, positionSec) {
    const audition = get().audition
    const key = side === 'left' ? 'leftPositionSec' : 'rightPositionSec'
    const max = side === 'left' ? audition.leftDurationSec : audition.rightDurationSec
    const safePosition = Math.max(0, Math.min(max || Number.POSITIVE_INFINITY, positionSec))
    set({ audition: { ...audition, [key]: safePosition } })
    try {
      await window.api.duplicates.audition.seek({ side, positionSec: safePosition })
    } catch (error) {
      set({ error: errorMessage(error) })
    }
  },

  async compareSegment(segmentIndex) {
    try {
      await window.api.duplicates.audition.compareSegment({ segmentIndex })
    } catch (error) {
      set({ error: errorMessage(error) })
    }
  },

  clearNotice() {
    set({ notice: null })
  },
}))

function refreshFromChangedEvent(): void {
  if (changedRefresh) return
  // resolveCurrent performs its own refresh after switching back to the list.
  // Starting another refresh from the backend event can otherwise reopen the
  // following candidate while the previous audition is being invalidated.
  if (useDuplicateStore.getState().resolving) return
  changedRefresh = (async () => {
    try {
      if (useDuplicateStore.getState().active) await refreshActiveView()
      else await useDuplicateStore.getState().loadSummary()
    } catch (error) {
      if (
        useDuplicateStore.getState().active
        && !isExpectedAuditionCancellation(error)
      ) {
        useDuplicateStore.setState({ error: errorMessage(error), loading: false })
      } else if (useDuplicateStore.getState().active) {
        useDuplicateStore.setState({ loading: false })
      }
    } finally {
      changedRefresh = null
    }
  })()
}

function recordProgress(progress: DuplicateAnalysisProgress): void {
  useDuplicateStore.setState(state => ({
    summary: {
      ...state.summary,
      running: progress.phase !== 'complete' && progress.phase !== 'error',
      progress: progress.phase === 'error'
        ? undefined
        : {
            completed: progress.completed,
            total: progress.total,
            currentTitle: progress.message,
          },
      blocker: progress.phase === 'error'
        ? (progress.blocker ?? state.summary.blocker)
        : undefined,
    },
  }))
  if (progress.phase === 'complete') refreshFromChangedEvent()
}

export function initializeDuplicateStore(): () => void {
  if (typeof window === 'undefined' || !window.api?.duplicates) return () => undefined
  if (listeners) return () => undefined

  listeners = [
    window.api.duplicates.onChanged(refreshFromChangedEvent),
    window.api.duplicates.onProgress(recordProgress),
    window.api.duplicates.onAuditionState(audition => {
      useDuplicateStore.setState({ audition })
    }),
  ]
  void useDuplicateStore.getState().loadSummary()

  return () => {
    if (!listeners) return
    for (const off of listeners) off()
    listeners = null
  }
}

if (typeof window !== 'undefined') initializeDuplicateStore()

if (typeof import.meta !== 'undefined' && (import.meta as { hot?: { dispose: (cb: () => void) => void } }).hot) {
  (import.meta as { hot: { dispose: (cb: () => void) => void } }).hot.dispose(() => {
    if (listeners) {
      for (const off of listeners) off()
      listeners = null
    }
  })
}
