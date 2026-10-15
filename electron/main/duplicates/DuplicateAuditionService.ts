import { open as openFile, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import type {
  DuplicateAuditionCompareSegmentRequest,
  DuplicateAuditionOpenRequest,
  DuplicateAuditionSeekRequest,
  DuplicateAuditionSide,
  DuplicateAuditionState,
  DuplicateCandidateDetail,
  DuplicateTrackView,
} from '@shared/types/duplicates'
import { getAudioEngine } from '../audio/AudioEngine'
import { CA_PLAYER_PLAYING, Decoder, NativePlayer } from '../audio/native/crateAudio'
import { getOneDriveClient } from '../cloud/OneDriveClient'
import { getRepos } from '../db/repositories'
import { broadcast } from '../ipc/events'
import { getLocalFileAccessService } from '../security/localFileAccessRuntime'
import { DuplicateRepository } from './DuplicateRepository'
import { getDatabase } from '../db/database'
import { comparableSegmentPlayback } from './auditionSegments'
import {
  captureMainPlayback,
  MainPlaybackSessionGate,
  restoreMainPlayback,
  type MainPlaybackSnapshot,
} from './mainPlaybackSession'

const PROGRESS_INTERVAL_MS = 150
const MAX_TEMP_SOURCE_BYTES = 2 * 1024 * 1024 * 1024

// Each side is its own native player, mixed at whatever format the device
// runs (the main deck is paused for the whole session).
interface AuditionStream {
  player: NativePlayer
  decoder: Decoder
  duration: number
  localPath: string
}

interface AuditionLoadSession {
  generation: number
  controller: AbortController
  tempRoot: string | null
  transferred: boolean
  settled: Promise<void>
  settle: () => void
}

function closedState(): DuplicateAuditionState {
  return {
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
}

function clamp(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(max, value))
}

function abortError(message = 'Audición reemplazada.'): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

export class DuplicateAuditionService {
  private readonly repo: DuplicateRepository
  private detail: DuplicateCandidateDetail | null = null
  private streams: Partial<Record<DuplicateAuditionSide, AuditionStream>> = {}
  private state: DuplicateAuditionState = closedState()
  private mainSnapshot: MainPlaybackSnapshot | null = null
  private tempRoot: string | null = null
  private progressTimer: NodeJS.Timeout | null = null
  private comparisonTimers: NodeJS.Timeout[] = []
  private generation = 0
  private pendingLoad: AuditionLoadSession | null = null
  private readonly mainSessionGate = new MainPlaybackSessionGate()

  constructor(repo = new DuplicateRepository(getDatabase())) {
    this.repo = repo
  }

  getState(): DuplicateAuditionState {
    return { ...this.state }
  }

  /**
   * Begin duplicate-review mode without opening a pair. This is deliberately
   * idempotent so list -> detail -> list navigation retains one authoritative
   * snapshot until close().
   */
  async beginSession(): Promise<DuplicateAuditionState> {
    const pendingClose = this.mainSessionGate.pendingClose
    if (pendingClose) await pendingClose
    if (!this.mainSnapshot) {
      this.mainSnapshot = captureMainPlayback(getAudioEngine())
    }
    return this.getState()
  }

  async open(request: DuplicateAuditionOpenRequest, owner?: unknown): Promise<DuplicateAuditionState> {
    const detail = this.repo.getCandidate(request.candidateId)
    if (!detail || detail.status !== 'pending' || detail.revision !== request.expectedRevision) {
      throw new Error('El caso cambió; actualizá la revisión antes de escucharlo.')
    }
    await this.beginSession()
    const generation = ++this.generation
    await this.cancelPendingLoad()
    if (generation !== this.generation) throw abortError()
    await this.releaseCandidate(false)
    if (generation !== this.generation) throw abortError()
    const session = this.createLoadSession(generation)
    this.pendingLoad = session
    this.detail = detail
    this.state = {
      ...closedState(),
      candidateId: detail.id,
      status: 'loading',
      leftDurationSec: detail.left.duration,
      rightDurationSec: detail.right.duration,
    }
    this.publish()
    try {
      getAudioEngine().ensureInit()
      const leftPath = await this.materialize(detail.left, 'left', session, owner)
      if (generation !== this.generation) throw abortError()
      this.streams.left = await this.createStream(leftPath, detail.left.duration)
      const rightPath = await this.materialize(detail.right, 'right', session, owner)
      if (generation !== this.generation) throw abortError()
      this.streams.right = await this.createStream(rightPath, detail.right.duration)
      if (generation !== this.generation) throw abortError()
      if (session.tempRoot) {
        this.tempRoot = session.tempRoot
        session.transferred = true
      }
      this.state = {
        ...this.state,
        status: 'paused',
        leftDurationSec: this.streams.left.duration,
        rightDurationSec: this.streams.right.duration,
        error: null,
      }
      this.startProgress()
      this.publish()
      return this.getState()
    } catch (error) {
      if (generation === this.generation) {
        await this.releaseCandidate(false)
        this.state = {
          ...this.state,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        }
        this.publish()
      }
      throw error
    } finally {
      if (!session.transferred && session.tempRoot) {
        await rm(session.tempRoot, { recursive: true, force: true }).catch(() => undefined)
      }
      session.settle()
      if (this.pendingLoad === session) this.pendingLoad = null
    }
  }

  play(side: DuplicateAuditionSide): DuplicateAuditionState {
    this.requireOpen()
    this.cancelComparison()
    const stream = this.streams[side]
    if (!stream) throw new Error('La pista todavía no está lista para escuchar.')
    const previousSide = this.state.activeSide
    if (previousSide && previousSide !== side) {
      const previous = this.streams[previousSide]
      if (previous) {
        this.updatePositions()
        previous.player.pause()
        const previousPosition = previousSide === 'left'
          ? this.state.leftPositionSec
          : this.state.rightPositionSec
        const equivalent = previousSide === 'left'
          ? previousPosition + (this.detail?.alignmentOffsetSeconds ?? 0)
          : previousPosition - (this.detail?.alignmentOffsetSeconds ?? 0)
        this.seekStream(stream, equivalent)
      }
    }
    try {
      stream.player.play()
    } catch (error) {
      throw new Error(`No se pudo iniciar la audición: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.state = {
      ...this.state,
      activeSide: side,
      status: 'playing',
      comparingSegmentIndex: null,
      error: null,
    }
    this.publish()
    return this.getState()
  }

  pause(): DuplicateAuditionState {
    this.cancelComparison()
    for (const stream of Object.values(this.streams)) {
      if (stream) stream.player.pause()
    }
    this.updatePositions()
    if (this.state.status !== 'closed' && this.state.status !== 'loading') {
      this.state = { ...this.state, status: 'paused', comparingSegmentIndex: null }
      this.publish()
    }
    return this.getState()
  }

  seek(request: DuplicateAuditionSeekRequest): DuplicateAuditionState {
    this.requireOpen()
    this.cancelComparison()
    const stream = this.streams[request.side]
    if (!stream) throw new Error('La pista todavía no está lista para buscar.')
    this.seekStream(stream, request.positionSec)
    this.updatePositions()
    this.state = { ...this.state, comparingSegmentIndex: null }
    this.publish()
    return this.getState()
  }

  compareSegment(request: DuplicateAuditionCompareSegmentRequest): DuplicateAuditionState {
    this.requireOpen()
    const segment = this.detail?.segments[request.segmentIndex]
    if (!segment) throw new Error('El segmento elegido ya no existe.')
    const left = this.streams.left
    const right = this.streams.right
    if (!left || !right) throw new Error('Las pistas todavía no están listas.')
    const playback = comparableSegmentPlayback(segment, left.duration, right.duration)
    if (!playback) {
      throw new Error('Este tramo no tiene audio en ambos lados para comparar.')
    }
    this.pause()
    const durationMs = Math.max(1, Math.round(playback.durationSec * 1000))
    this.seekStream(left, playback.leftStartSec)
    this.seekStream(right, playback.rightStartSec)
    left.player.play()
    this.state = {
      ...this.state,
      activeSide: 'left',
      status: 'playing',
      comparingSegmentIndex: request.segmentIndex,
    }
    this.publish()
    const first = setTimeout(() => {
      left.player.pause()
      right.player.play()
      this.state = { ...this.state, activeSide: 'right', status: 'playing' }
      this.publish()
      const second = setTimeout(() => {
        right.player.pause()
        this.updatePositions()
        this.state = { ...this.state, status: 'paused', comparingSegmentIndex: null }
        this.publish()
      }, durationMs)
      this.comparisonTimers.push(second)
    }, durationMs)
    this.comparisonTimers.push(first)
    return this.getState()
  }

  /** Release the current A/B case but retain the main-player snapshot while the
   * review view moves to the next candidate. */
  async invalidateCandidate(candidateId: string): Promise<void> {
    if (this.state.candidateId !== candidateId) return
    ++this.generation
    await this.cancelPendingLoad()
    await this.releaseCandidate(false)
    this.state = closedState()
    this.publish()
  }

  async close(): Promise<DuplicateAuditionState> {
    await this.mainSessionGate.runClose(async () => {
      ++this.generation
      await this.cancelPendingLoad()
      const snapshot = this.mainSnapshot
      await this.releaseCandidate(true)
      this.mainSnapshot = null
      this.detail = null
      this.state = closedState()
      const engine = getAudioEngine()
      if (snapshot?.path) {
        const stillExists = Boolean(getRepos().tracks.getByPath(snapshot.path))
        restoreMainPlayback(engine, snapshot, stillExists)
      }
      this.publish()
    })
    return this.getState()
  }

  private requireOpen(): void {
    if (!this.detail || !this.state.candidateId || this.state.status === 'loading') {
      throw new Error('Abrí un caso de duplicados antes de usar la audición.')
    }
  }

  private async createStream(path: string, expectedDuration: number): Promise<AuditionStream> {
    let decoder: Decoder
    try {
      // UTF-8 paths work on every platform, Windows included.
      decoder = await Decoder.openFileAsync(path, { exactDuration: true })
    } catch (error) {
      throw new Error(`No se pudo abrir ${path}: ${error instanceof Error ? error.message : String(error)}.`)
    }
    const measuredDuration = decoder.info.duration
    if (!(measuredDuration > 0) && !(expectedDuration > 0)) {
      decoder.close()
      throw new Error(`La duración de ${path} no se pudo determinar.`)
    }
    const player = new NativePlayer(false)
    try {
      await player.setSource(decoder, 1, 1)
    } catch (error) {
      player.destroy()
      decoder.close()
      throw error
    }
    return {
      player,
      decoder,
      duration: Number.isFinite(measuredDuration) && measuredDuration > 0
        ? measuredDuration
        : Math.max(0.01, expectedDuration),
      localPath: path,
    }
  }

  private position(stream: AuditionStream): number {
    return clamp(stream.player.status().position, stream.duration)
  }

  private seekStream(stream: AuditionStream, seconds: number): void {
    stream.player.seek(clamp(seconds, stream.duration))
  }

  private updatePositions(): void {
    const left = this.streams.left
    const right = this.streams.right
    this.state = {
      ...this.state,
      leftPositionSec: left ? this.position(left) : 0,
      rightPositionSec: right ? this.position(right) : 0,
    }
    const active = this.state.activeSide ? this.streams[this.state.activeSide] : null
    if (
      active
      && this.state.status === 'playing'
      && active.player.status().state !== CA_PLAYER_PLAYING
      && this.state.comparingSegmentIndex == null
    ) this.state = { ...this.state, status: 'paused' }
  }

  private startProgress(): void {
    this.stopProgress()
    this.progressTimer = setInterval(() => {
      if (this.state.status === 'closed' || this.state.status === 'loading') return
      this.updatePositions()
      this.publish()
    }, PROGRESS_INTERVAL_MS)
    this.progressTimer.unref?.()
  }

  private stopProgress(): void {
    if (this.progressTimer) clearInterval(this.progressTimer)
    this.progressTimer = null
  }

  private cancelComparison(): void {
    for (const timer of this.comparisonTimers) clearTimeout(timer)
    this.comparisonTimers = []
  }

  private async releaseCandidate(clearSnapshot: boolean): Promise<void> {
    this.cancelComparison()
    this.stopProgress()
    for (const stream of Object.values(this.streams)) {
      if (!stream) continue
      stream.player.detach()
      stream.player.destroy()
      stream.decoder.close()
    }
    this.streams = {}
    if (this.tempRoot) await rm(this.tempRoot, { recursive: true, force: true }).catch(() => undefined)
    this.tempRoot = null
    this.detail = null
    if (clearSnapshot) this.mainSnapshot = null
  }

  private createLoadSession(generation: number): AuditionLoadSession {
    let settle: () => void = () => undefined
    const settled = new Promise<void>(resolve => { settle = resolve })
    return {
      generation,
      controller: new AbortController(),
      tempRoot: null,
      transferred: false,
      settled,
      settle,
    }
  }

  private async cancelPendingLoad(): Promise<void> {
    const pending = this.pendingLoad
    if (!pending) return
    pending.controller.abort(abortError('Audición cancelada.'))
    await pending.settled
    if (this.pendingLoad === pending) this.pendingLoad = null
  }

  private async materialize(
    track: DuplicateTrackView,
    side: DuplicateAuditionSide,
    session: AuditionLoadSession,
    owner?: unknown,
  ): Promise<string> {
    const signal = session.controller.signal
    signal.throwIfAborted()
    if (track.provider === 'local') {
      const facts = this.repo.getTrackFacts(track.id)
      const folder = facts ? getRepos().folders.getById(facts.folderId) : undefined
      if (
        !facts || facts.provider !== 'local' || facts.libraryRole !== 'library'
        || facts.path !== track.path || !folder || folder.provider !== 'local' || folder.role !== 'library'
      ) throw new Error('La pista local cambió o ya no pertenece a una biblioteca principal.')
      await getLocalFileAccessService().runWithAccess(
        folder.path,
        'read',
        async () => {
          const file = await stat(facts.path)
          if (!file.isFile() || (facts.fileSize != null && file.size !== facts.fileSize)) {
            throw new Error('El archivo local cambió desde el análisis de duplicados.')
          }
        },
        { owner, retryOnce: false },
      )
      signal.throwIfAborted()
      return facts.path
    }
    const facts = this.repo.getTrackFacts(track.id)
    if (!facts?.driveId || !facts.itemId) throw new Error('La pista de OneDrive no tiene identidad remota.')
    const client = getOneDriveClient()
    const item = await client.getItem(facts.driveId, facts.itemId, signal)
    const size = item.size ?? facts.fileSize
    if (size == null || size <= 0 || size > MAX_TEMP_SOURCE_BYTES) {
      throw new Error('El tamaño de la pista remota no permite una audición temporal segura.')
    }
    session.tempRoot ??= await mkdtemp(join(tmpdir(), `crate-duplicate-audition-${session.generation}-`))
    signal.throwIfAborted()
    const rawSuffix = extname(item.name ?? facts.path)
    const suffix = /^\.[a-zA-Z0-9]{1,12}$/.test(rawSuffix) ? rawSuffix : '.audio'
    const path = join(session.tempRoot, `${side}${suffix}`)
    const file = await openFile(path, 'wx', 0o600)
    try {
      let offset = 0
      for await (const chunk of client.downloadChunks({
        driveId: facts.driveId,
        itemId: facts.itemId,
        sizeBytes: size,
        signal,
      })) {
        signal.throwIfAborted()
        let chunkOffset = 0
        while (chunkOffset < chunk.byteLength) {
          signal.throwIfAborted()
          const result = await file.write(
            chunk,
            chunkOffset,
            chunk.byteLength - chunkOffset,
            offset + chunkOffset,
          )
          if (result.bytesWritten <= 0) throw new Error('La descarga temporal no avanzó.')
          chunkOffset += result.bytesWritten
        }
        offset += chunk.byteLength
      }
      await file.sync()
      signal.throwIfAborted()
      if (offset !== size) throw new Error(`La descarga temporal quedó incompleta (${offset}/${size} bytes).`)
    } finally {
      await file.close()
    }
    const current = await client.getItem(facts.driveId, facts.itemId, signal)
    const expectedEtag = item.eTag ?? item.cTag ?? facts.etag
    const currentEtag = current.eTag ?? current.cTag
    if (current.id !== item.id || current.size !== size || (expectedEtag && currentEtag !== expectedEtag)) {
      throw new Error('La pista de OneDrive cambió durante la descarga de audición.')
    }
    return path
  }

  private publish(): void {
    broadcast('duplicates:auditionState', this.getState())
  }
}

let service: DuplicateAuditionService | null = null

export function getDuplicateAuditionService(): DuplicateAuditionService {
  service ??= new DuplicateAuditionService()
  return service
}
