import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('./ModalShell.tsx', import.meta.url), 'utf8')
const mediaActions = await readFile(new URL('./MediaActions.tsx', import.meta.url), 'utf8')

test('shared modal traps keyboard focus, handles Escape, and restores focus', () => {
  assert.match(source, /event\.key === 'Escape'/)
  assert.match(source, /event\.key !== 'Tab'/)
  assert.match(source, /document\.addEventListener\('focusin'/)
  assert.match(source, /previouslyFocused\?\.isConnected/)
  assert.match(source, /previouslyFocused\.focus\(\)/)
})

test('shared modal isolates background and exposes labelled dialog controls', () => {
  assert.match(source, /setAttribute\('inert', ''\)/)
  assert.match(source, /setAttribute\('aria-hidden', 'true'\)/)
  assert.match(source, /aria-labelledby=\{titleId\}/)
  assert.match(source, /aria-label=\{`Cerrar \$\{title\}`\}/)
})

test('media actions reuse the accessible modal implementation', () => {
  assert.match(mediaActions, /import \{ ModalShell \} from '\.\/ModalShell'/)
  assert.doesNotMatch(mediaActions, /function ModalShell\(/)
})
