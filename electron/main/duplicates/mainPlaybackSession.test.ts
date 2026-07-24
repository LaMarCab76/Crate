import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { PlaybackStatus } from '@shared/types/ipc-contract'
import {
  captureMainPlayback,
  MainPlaybackSessionGate,
  restoreMainPlayback,
  type MainPlaybackSessionEngine,
} from './mainPlaybackSession.ts'

class FakeEngine implements MainPlaybackSessionEngine {
  calls: string[] = []
  private path: string | null
  private position: number
  private status: PlaybackStatus

  constructor(
    path: string | null,
    position: number,
    status: PlaybackStatus,
  ) {
    this.path = path
    this.position = position
    this.status = status
  }

  getCurrentPath(): string | null { return this.path }
  getPosition(): number { return this.position }
  getStatus(): PlaybackStatus { return this.status }
  pause(): void {
    this.calls.push('pause')
    this.status = 'paused'
  }
  seek(positionSec: number): void {
    this.calls.push(`seek:${positionSec}`)
    this.position = positionSec
  }
  play(): void {
    this.calls.push('play')
    this.status = 'playing'
  }
  unload(): void {
    this.calls.push('unload')
    this.path = null
    this.position = 0
    this.status = 'stopped'
  }
}

test('a playing main track is paused on entry and resumed at its exact position', () => {
  const engine = new FakeEngine('/music/song.flac', 42.25, 'playing')

  const snapshot = captureMainPlayback(engine)
  assert.deepEqual(snapshot, {
    path: '/music/song.flac',
    positionSec: 42.25,
    status: 'playing',
  })
  assert.deepEqual(engine.calls, ['pause'])

  restoreMainPlayback(engine, snapshot, true)
  assert.deepEqual(engine.calls, ['pause', 'seek:42.25', 'play'])
  assert.equal(engine.getStatus(), 'playing')
})

test('a paused main track stays paused and returns to its captured position', () => {
  const engine = new FakeEngine('/music/song.flac', 18.5, 'paused')

  const snapshot = captureMainPlayback(engine)
  assert.deepEqual(engine.calls, [])

  restoreMainPlayback(engine, snapshot, true)
  assert.deepEqual(engine.calls, ['seek:18.5', 'pause'])
  assert.equal(engine.getStatus(), 'paused')
})

test('a track deleted during review is unloaded without advancing playback', () => {
  const engine = new FakeEngine('/music/deleted.flac', 9, 'playing')
  const snapshot = captureMainPlayback(engine)

  restoreMainPlayback(engine, snapshot, false)
  assert.deepEqual(engine.calls, ['pause', 'unload'])
  assert.equal(engine.getCurrentPath(), null)
  assert.equal(engine.getStatus(), 'stopped')
})

test('closing review never replaces an unrelated main track', () => {
  const engine = new FakeEngine('/music/original.flac', 9, 'paused')
  const snapshot = captureMainPlayback(engine)
  const otherEngine = new FakeEngine('/music/other.flac', 3, 'playing')

  restoreMainPlayback(otherEngine, snapshot, true)
  assert.deepEqual(otherEngine.calls, [])
})

test('enter after an overlapping leave waits for restoration before recapturing', async () => {
  const gate = new MainPlaybackSessionGate()
  const events: string[] = []
  let finishClose: () => void = () => undefined
  const closeCanFinish = new Promise<void>(resolve => { finishClose = resolve })

  const leave = gate.runClose(async () => {
    events.push('leave:start')
    await closeCanFinish
    events.push('leave:restored')
  })
  const enter = (async () => {
    const pendingClose = gate.pendingClose
    if (pendingClose) await pendingClose
    events.push('enter:captured')
  })()

  await Promise.resolve()
  assert.deepEqual(events, ['leave:start'])
  finishClose()
  await Promise.all([leave, enter])
  assert.deepEqual(events, ['leave:start', 'leave:restored', 'enter:captured'])
  assert.equal(gate.pendingClose, null)
})
