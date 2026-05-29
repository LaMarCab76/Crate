import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { runTrackDeletionLifecycle } from './trackDeletionLifecycle.ts'

function deferred() {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}

test('does not delete tracks until the visual deletion phase finishes', async () => {
  const events = []
  const visual = deferred()

  const lifecycle = runTrackDeletionLifecycle({
    visualDelayMs: 240,
    wait: async ms => {
      events.push(`wait:${ms}`)
      await visual.promise
      events.push('visual:done')
    },
    deleteTracks: async () => {
      events.push('delete')
      return { trashedTrackIds: [10], failed: [] }
    },
    afterDelete: result => {
      events.push(`prune:${result.trashedTrackIds.join(',')}`)
    },
    refresh: async () => {
      events.push('refresh')
    },
    cleanup: () => {
      events.push('cleanup')
    },
  })

  await Promise.resolve()
  assert.deepEqual(events, ['wait:240'])

  visual.resolve()
  const result = await lifecycle

  assert.deepEqual(result.trashedTrackIds, [10])
  assert.deepEqual(events, [
    'wait:240',
    'visual:done',
    'delete',
    'prune:10',
    'refresh',
    'cleanup',
  ])
})

test('waits for playback shutdown before deleting the current track without a next item', async () => {
  const events = []

  await runTrackDeletionLifecycle({
    visualDelayMs: 240,
    wait: async ms => {
      events.push(`wait:${ms}`)
    },
    prepareBeforeDelete: async () => {
      events.push('fade')
      events.push('stop')
      events.push('clear-next')
      events.push('player-close')
    },
    deleteTracks: async () => {
      events.push('delete')
      return { trashedTrackIds: [11], failed: [] }
    },
    refresh: async () => {
      events.push('refresh')
    },
    cleanup: () => {
      events.push('cleanup')
    },
  })

  const deleteIndex = events.indexOf('delete')
  assert.ok(deleteIndex > events.indexOf('wait:240'))
  assert.ok(deleteIndex > events.indexOf('fade'))
  assert.ok(deleteIndex > events.indexOf('stop'))
  assert.ok(deleteIndex > events.indexOf('clear-next'))
  assert.ok(deleteIndex > events.indexOf('player-close'))
  assert.deepEqual(events.slice(deleteIndex), ['delete', 'refresh', 'cleanup'])
})

test('refreshes and cleans up when deletion fails', async () => {
  const events = []

  await assert.rejects(
    runTrackDeletionLifecycle({
      visualDelayMs: 0,
      wait: async ms => {
        events.push(`wait:${ms}`)
      },
      deleteTracks: async () => {
        events.push('delete')
        throw new Error('trash failed')
      },
      refresh: async () => {
        events.push('refresh')
      },
      cleanup: () => {
        events.push('cleanup')
      },
    }),
    /trash failed/,
  )

  assert.deepEqual(events, ['delete', 'refresh', 'cleanup'])
})
