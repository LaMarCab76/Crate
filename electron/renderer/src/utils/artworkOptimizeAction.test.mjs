import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { artworkOptimizeActionState } from './artworkOptimizeAction.ts'

function state(patch = {}) {
  return artworkOptimizeActionState({
    analyzing: false,
    optimizing: false,
    hasAnalysis: false,
    oversizedCount: 0,
    ...patch,
  })
}

test('initial artwork action analyzes the device', () => {
  assert.deepEqual(state(), {
    mode: 'analyze',
    label: 'Analizar artwork',
    icon: 'search',
    disabled: false,
    primary: false,
  })
})

test('analyzing state keeps one disabled analysis button', () => {
  assert.deepEqual(state({ analyzing: true }), {
    mode: 'analyze',
    label: 'Analizando...',
    icon: 'search',
    disabled: true,
    primary: false,
  })
})

test('analysis with selected oversized artwork turns the same action into apply', () => {
  assert.deepEqual(state({ hasAnalysis: true, oversizedCount: 5, selectedCount: 3 }), {
    mode: 'apply',
    label: 'Aplicar optimización (3)',
    icon: 'sparkle',
    disabled: false,
    primary: true,
  })
})

test('analysis with oversized artwork but no selection disables apply', () => {
  assert.deepEqual(state({ hasAnalysis: true, oversizedCount: 5, selectedCount: 0 }), {
    mode: 'apply',
    label: 'Aplicar optimización (0)',
    icon: 'sparkle',
    disabled: true,
    primary: true,
  })
})

test('optimizing state keeps one disabled apply button', () => {
  assert.deepEqual(state({ optimizing: true, hasAnalysis: true, oversizedCount: 3 }), {
    mode: 'apply',
    label: 'Optimizando...',
    icon: 'sparkle',
    disabled: true,
    primary: true,
  })
})

test('optimizing label wins until the replacement pass has finished', () => {
  assert.equal(
    state({ optimizing: true, refreshing: true, hasAnalysis: true, oversizedCount: 3 }).label,
    'Optimizando...',
  )
})

test('refreshing after optimization keeps the action disabled without saying it is still optimizing', () => {
  assert.deepEqual(state({ refreshing: true, hasAnalysis: true, oversizedCount: 3 }), {
    mode: 'analyze',
    label: 'Actualizando...',
    icon: 'search',
    disabled: true,
    primary: false,
  })
})

test('analysis without changes offers a new analysis instead of apply', () => {
  assert.deepEqual(state({ hasAnalysis: true, oversizedCount: 0 }), {
    mode: 'analyze',
    label: 'Volver a analizar',
    icon: 'search',
    disabled: false,
    primary: false,
  })
})
