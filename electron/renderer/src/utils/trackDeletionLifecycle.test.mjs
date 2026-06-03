import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { runTrackDeletionLifecycle } from './trackDeletionLifecycle.ts'

function deferred() {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}

test('settles the UI before the disk deletion finishes', async () => {
  const events = []
  const visual = deferred()
  const disk = deferred()

  const { settled, completed } = runTrackDeletionLifecycle({
    visualDelayMs: 304,
    wait: async ms => {
      events.push(`wait:${ms}`)
      await visual.promise
      events.push('visual:done')
    },
    settleUi: () => {
      events.push('settle')
    },
    deleteTracks: async () => {
      events.push('delete:start')
      await disk.promise
      events.push('delete:end')
      return { trashedTrackIds: [10], failed: [] }
    },
    afterDelete: result => {
      events.push(`prune:${result.trashedTrackIds.join(',')}`)
    },
    reconcile: async () => {
      events.push('reconcile')
    },
  })

  await Promise.resolve()
  assert.deepEqual(events, ['wait:304'])

  visual.resolve()
  await settled
  // The UI has settled while the disk deletion is still in flight (the `disk`
  // promise is unresolved) — proving the visual phase does not wait on the drive.
  assert.deepEqual(events, ['wait:304', 'visual:done', 'settle', 'delete:start'])

  disk.resolve()
  await completed
  assert.deepEqual(events, [
    'wait:304',
    'visual:done',
    'settle',
    'delete:start',
    'delete:end',
    'prune:10',
    'reconcile',
  ])
})

test('runs playback shutdown before settling and deleting', async () => {
  const events = []

  const { completed } = runTrackDeletionLifecycle({
    visualDelayMs: 304,
    wait: async ms => {
      events.push(`wait:${ms}`)
    },
    prepareBeforeDelete: async () => {
      events.push('fade')
      events.push('stop')
      events.push('clear-next')
      events.push('player-close')
    },
    settleUi: () => {
      events.push('settle')
    },
    deleteTracks: async () => {
      events.push('delete')
      return { trashedTrackIds: [11], failed: [] }
    },
    reconcile: async () => {
      events.push('reconcile')
    },
  })

  await completed

  const settleIndex = events.indexOf('settle')
  const deleteIndex = events.indexOf('delete')
  assert.ok(settleIndex > events.indexOf('wait:304'))
  assert.ok(settleIndex > events.indexOf('fade'))
  assert.ok(settleIndex > events.indexOf('player-close'))
  assert.ok(deleteIndex > settleIndex)
  assert.deepEqual(events.slice(deleteIndex), ['delete', 'reconcile'])
})

test('reconciles without rejecting when the disk deletion fails', async () => {
  const events = []

  const { settled, completed } = runTrackDeletionLifecycle({
    visualDelayMs: 0,
    wait: async ms => {
      events.push(`wait:${ms}`)
    },
    settleUi: () => {
      events.push('settle')
    },
    deleteTracks: async () => {
      events.push('delete')
      throw new Error('trash failed')
    },
    reconcile: async () => {
      events.push('reconcile')
    },
  })

  await settled
  // `completed` must resolve (not reject) even though deleteTracks threw.
  await completed

  assert.deepEqual(events, ['settle', 'delete', 'reconcile'])
})
