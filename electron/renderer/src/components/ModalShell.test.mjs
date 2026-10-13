import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('./ModalShell.tsx', import.meta.url), 'utf8')
const mediaActions = await readFile(new URL('./MediaActions.tsx', import.meta.url), 'utf8')
const contextMenu = await readFile(new URL('./ContextMenu.tsx', import.meta.url), 'utf8')
const css = await readFile(new URL('../styles/globals.css', import.meta.url), 'utf8')

function cssBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{(?<body>[^}]*)\\}`))
  assert.ok(match?.groups?.body, `Missing CSS block for ${selector}`)
  return match.groups.body
}

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

test('modals and context menus portal out of the floating glass cards', () => {
  // A transformed / backdrop-filtered ancestor would otherwise trap position: fixed.
  assert.match(source, /createPortal\(/)
  assert.match(source, /document\.body/)
  assert.match(contextMenu, /createPortal\(/)
  // Only the app root and modals stacked below go inert, not every body child.
  assert.match(source, /sibling\.id !== 'root' && !sibling\.classList\.contains\('modal-backdrop'\)/)
})

test('modal and context menu chrome use the shared glass tokens', () => {
  const panel = cssBlock('.modal-panel')
  assert.match(panel, /border-radius:\s*var\(--gl-r-modal\)/)
  assert.match(panel, /background:\s*var\(--gl-modal-fill\)/)
  assert.match(panel, /backdrop-filter:\s*var\(--gl-modal-filter\)/)
  assert.match(cssBlock('.modal-backdrop'), /background:\s*var\(--gl-scrim\)/)
  const menu = cssBlock('.context-menu')
  assert.match(menu, /border-radius:\s*var\(--gl-r-pop\)/)
  assert.match(menu, /background:\s*var\(--gl-pop-fill\)/)
  assert.match(menu, /backdrop-filter:\s*var\(--gl-pop-filter\)/)
})

test('portaled modals and menus stack above the activity center they make inert', () => {
  const zIndex = selector => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const blocks = [...css.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'g'))]
    const value = blocks.map(block => block[1].match(/z-index:\s*(\d+)/)?.[1]).find(Boolean)
    assert.ok(value, `Missing z-index for ${selector}`)
    return Number(value)
  }
  const activityTop = Math.max(zIndex('.activity-center'), zIndex('.activity-center.fullscreen'))
  assert.ok(zIndex('.modal-backdrop') > activityTop, 'modal scrim must cover the (inert) activity center')
  assert.ok(zIndex('.context-menu') > activityTop, 'context menus must not open under the activity panel')
  assert.ok(zIndex('.modal-backdrop') < zIndex('.library-setup-overlay'), 'the first-run wizard stays on top')
  // The scrim sits over drag regions (toolbar pill, card headers): clicks there must reach it.
  assert.match(cssBlock('.modal-backdrop'), /-webkit-app-region:\s*no-drag/)
})

test('dialog content keeps its tokens after the portal to <body>', () => {
  // Library-location dialogs and the duplicate decision dialogs no longer
  // descend from their sections, so their colour tokens must reach them.
  assert.match(css, /:root\s*\{\s*--loc-blue:/)
  assert.match(css, /\.duplicate-review,\s*\.duplicate-decision-dialog\s*\{\s*--duplicate-match:/)
  assert.match(css, /\.theme-light \.duplicate-review,\s*\.theme-light \.duplicate-decision-dialog\s*\{/)
  assert.match(cssBlock('.library-log-modal .set-card'), /background:\s*transparent/)
})

test('track and album context menus show an identity header', () => {
  assert.match(contextMenu, /header\?: ContextMenuHeader/)
  assert.equal(mediaActions.match(/header=\{header\}/g)?.length, 2)
})
