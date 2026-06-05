import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const queueStoreSource = readFileSync(new URL('./queueStore.ts', import.meta.url), 'utf8')
const playerPaneSource = readFileSync(new URL('../components/PlayerPane.tsx', import.meta.url), 'utf8')
const fullScreenSource = readFileSync(new URL('../components/FullScreenQueue.tsx', import.meta.url), 'utf8')
const globalsSource = readFileSync(new URL('../styles/globals.css', import.meta.url), 'utf8')

test('queue store exposes reorder actions', () => {
  assert.ok(queueStoreSource.includes('queueReorderMode: boolean'), 'state includes queueReorderMode')
  assert.ok(queueStoreSource.includes('setQueueReorderMode(enabled: boolean)'), 'store exposes setQueueReorderMode action')
  assert.ok(queueStoreSource.includes('moveQueueTrack(fromIndex: number, toIndex: number)'), 'store exposes moveQueueTrack action')
  assert.ok(queueStoreSource.includes('moveTrackToNext(index: number)'), 'store exposes moveTrackToNext action')
  assert.ok(queueStoreSource.includes('moveTrackToEnd(index: number)'), 'store exposes moveTrackToEnd action')
  assert.ok(queueStoreSource.includes('moveQueueTrackWithValidation'), 'store keeps helper for bounds validation')
})

test('PlayerPane binds next-up double click and reorder intent handlers', () => {
  assert.ok(playerPaneSource.includes('onDoubleClick={() => { void jumpTo(queueIndex) }}'), 'PlayerPane uses jumpTo on queue row double click')
  assert.ok(playerPaneSource.includes('Reordenar cola'), 'PlayerPane exposes queue reorder toggle menu item')
  assert.ok(playerPaneSource.includes('Mover como siguiente'), 'PlayerPane context menu has mover como siguiente option')
  assert.ok(playerPaneSource.includes('Mover al final'), 'PlayerPane context menu has mover al final option')
  assert.ok(playerPaneSource.includes('confirmQueueReorder'), 'PlayerPane wraps queue reorder actions')
  assert.ok(playerPaneSource.includes('queue-drag-handle'), 'PlayerPane adds drag handle for reorder mode')
  assert.ok(playerPaneSource.includes('onDragOver={handleQueueListDragOver}'), 'PlayerPane binds queue list drag-over')
  assert.ok(playerPaneSource.includes('onDragStart={event => handleQueueDragStart'), 'PlayerPane binds drag start on queue rows')
})

test('FullScreenQueue mirrors queue reorder interactions', () => {
  assert.ok(fullScreenSource.includes('Reordenar'), 'Fullscreen queue row render includes reorder affordance wiring')
  assert.ok(fullScreenSource.includes('Mover como siguiente'), 'Fullscreen queue context menu has mover como siguiente option')
  assert.ok(fullScreenSource.includes('Mover al final'), 'Fullscreen queue context menu has mover al final option')
  assert.ok(fullScreenSource.includes('onDoubleClick={() => { void jumpTo(queueIndex) }}'), 'Fullscreen queue uses double click jump')
  assert.ok(fullScreenSource.includes('queue-drag-handle'), 'Fullscreen queue shows drag handle class')
  assert.ok(fullScreenSource.includes('onDragOver={event => handleQueueDragOver'), 'Fullscreen queue wires row drag over')
})

test('queue reorder visuals include push animation classes', () => {
  assert.ok(globalsSource.includes('.queue-item-push-down'), 'queue push animation class exists')
  assert.ok(globalsSource.includes('.np-queue-item-push-down'), 'fullscreen queue push animation class exists')
  assert.ok(globalsSource.includes('.queue-drag-handle'), 'queue drag handle style exists')
  assert.ok(globalsSource.includes('.np-queue-drag-handle'), 'fullscreen queue drag handle style exists')
  assert.ok(globalsSource.includes('transform: translateY(6px)'), 'push animation uses translateY')
})
