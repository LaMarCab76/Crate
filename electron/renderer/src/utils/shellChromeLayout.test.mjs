import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const css = readFileSync(new URL('../styles/globals.css', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const toolbarSource = readFileSync(new URL('../components/Toolbar.tsx', import.meta.url), 'utf8')
const activitySource = readFileSync(new URL('../components/ActivityCenter.tsx', import.meta.url), 'utf8')

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function cssBlock(selector, source = css) {
  const match = source.match(new RegExp(`(?:^|\\n|\\})\\s*${escape(selector)}\\s*\\{(?<body>[^}]*)\\}`))
  assert.ok(match?.groups?.body, `Missing CSS block for ${selector}`)
  return match.groups.body
}

function declaration(block, property) {
  const match = block.match(new RegExp(`(?:^|[\\s;{])${escape(property)}\\s*:\\s*(?<value>[^;]+);`))
  assert.ok(match?.groups?.value, `Missing ${property} declaration`)
  return match.groups.value.trim()
}

// Body of an @container tb (max-width: Npx) { ... } rule (one nesting level).
function containerTier(maxWidth) {
  const match = css.match(new RegExp(`@container tb \\(max-width: ${maxWidth}px\\)\\s*\\{(?<body>(?:[^{}]*\\{[^}]*\\})*[^{}]*)\\}`))
  assert.ok(match?.groups?.body, `Missing @container tb (max-width: ${maxWidth}px) tier`)
  return match.groups.body
}

test('the tightest toolbar tier fits inside the minimum pill width the shell guarantees', () => {
  const toolbar = cssBlock('.toolbar')
  const tight = containerTier(320)
  const tightButtons = cssBlock('.tb-search:not(:focus-within)', tight)
  const buttonWidth = Number.parseFloat(declaration(tightButtons, 'width'))
  const gap = Number.parseFloat(declaration(toolbar, 'gap'))
  const padding = Number.parseFloat(declaration(toolbar, 'padding'))
  const minPill = Number.parseFloat(declaration(cssBlock('.window'), '--gl-tb-min'))

  assert.match(tight, /\.tb-nav-btn,\s*\.toolbar \.tb-icon-btn,\s*\.tb-search:not\(:focus-within\)\s*\{/,
    'the tight tier should shrink the nav buttons, the icon buttons and the folded search together')
  // 7 buttons + the folded search, 8 gaps between the 9 flex items (the
  // divider is hidden from 400px down), plus the pill padding.
  const needed = 8 * buttonWidth + 8 * gap + 2 * padding
  assert.ok(needed <= minPill, `the tight tier needs ${needed}px but --gl-tb-min is ${minPill}px`)
  assert.match(containerTier(400), /\.tb-divider\s*\{\s*display:\s*none;/)
})

test('the sidebar gives way on narrow windows instead of squeezing the toolbar pill', () => {
  const shell = cssBlock('.window')
  assert.match(css, /@property --gl-sb-cap \{ syntax: '<length>';/, 'the cap should be a typed var so App can read it in px')
  assert.equal(
    declaration(shell, '--gl-sb-cap'),
    'calc(100vw - var(--gl-content-r) - var(--gl-tb-min) - 30px)',
  )
  assert.equal(declaration(shell, '--sb-w'), 'clamp(180px, var(--gl-sb-pref, 248px), var(--gl-sb-cap))')
  assert.match(appSource, /const SIDEBAR_WIDTH_MIN = 180\b/, 'the CSS floor mirrors SIDEBAR_WIDTH_MIN')

  assert.ok(appSource.includes("'--gl-sb-pref': `${sidebarWidth}px`"), 'App should publish the user width')
  assert.ok(!/'--sb-w':/.test(appSource), 'App should not override the derived --sb-w inline')
  assert.ok(
    appSource.includes("'--gl-content-l': sidebarOpen ? `calc(var(--sb-w) + ${SIDEBAR_CONTENT_GAP}px)` : '0px'"),
    'the content inset should follow the effective sidebar width',
  )
  assert.ok(appSource.includes("style={{ left: 'var(--sb-w)' }}"), 'the resize handle should ride the effective edge')
  assert.ok(appSource.includes("getPropertyValue('--gl-sb-cap')"), 'a sidebar drag should stop at the cap')
})

test('window resizes drop the shell layout transitions so nothing trails the sidebar', () => {
  assert.ok(appSource.includes("isResizingWindow && 'layout-resizing-window'"))
  assert.ok(appSource.includes("window.addEventListener('resize', onResize)"))
  for (const selector of ['.content', '.gl-scroll-edge', '.toolbar', '.activity-center', '.player-dock']) {
    assert.match(css, new RegExp(`\\.window\\.layout-resizing-window ${escape(selector)},`), `${selector} should not animate during window resizes`)
  }
})

test('the folded search unfolds on click so the Todos/Aquí scope stays reachable', () => {
  assert.ok(toolbarSource.includes('ref={scopeRef}'), 'the scope switch should be measurable')
  assert.match(
    toolbarSource,
    /const scopeHidden = scopeRef\.current != null && scopeRef\.current\.offsetWidth === 0\s*\n\s*if \(isViewMode \|\| isSearchView \|\| scopeHidden\) \{\s*\n\s*searchInputRef\.current\?\.focus\(\)/,
    'a click on the folded well should focus (unfold) instead of navigating',
  )
  const fold = containerTier(480)
  assert.match(fold, /\.toolbar:has\(\.tb-search:focus-within\) > :not\(\.tb-search\)\s*\{\s*display:\s*none;/,
    'the unfolded search should get the whole pill')
  assert.match(fold, /\.tb-search\.has-query:not\(:focus-within\)::after\s*\{/, 'a folded well with a query should be marked')
  assert.ok(toolbarSource.includes("isActive && activeQuery ? ' has-query' : ''"))
})

test('the search shortcut is ignored behind every overlay that covers the toolbar', () => {
  for (const blocker of ['.np-full', '.modal-backdrop', '[aria-modal="true"]', '.pb-island-scrim.show', '.activity-center.fullscreen', '.context-menu']) {
    assert.ok(toolbarSource.includes(`'${blocker}'`), `⌘F should be blocked by ${blocker}`)
  }
  assert.ok(toolbarSource.includes('document.querySelector(SEARCH_SHORTCUT_BLOCKERS)'))
})

test('the band beside the traffic lights drags the window when the sidebar is hidden', () => {
  assert.ok(appSource.includes('<div className="gl-drag-corner" aria-hidden="true" />'))
  const corner = cssBlock('.gl-drag-corner')
  assert.equal(declaration(corner, '-webkit-app-region'), 'drag')
  assert.equal(declaration(corner, 'width'), 'var(--gl-tb-l)')
  assert.match(declaration(corner, 'height'), /^58px/)
  assert.match(css, /\.window\.gl-sidebar-open \.gl-drag-corner \{ display: none; \}/)
})

test('the activity center stays on screen and only glides with the dock', () => {
  const center = cssBlock('.activity-center')
  assert.match(css, /@property --gl-ac-r \{ syntax: '<length>';/)
  assert.equal(declaration(center, '--gl-ac-r'), 'clamp(16px, var(--gl-tb-r, 16px), calc(100vw - 446px))')
  assert.equal(declaration(center, 'right'), 'var(--gl-ac-r)')
  assert.match(declaration(center, 'transition'), /^--gl-ac-r 420ms/, 'leaving fullscreen must not animate right')
  assert.ok(activitySource.includes("right: 'var(--gl-ac-r, 16px)'"), 'the inline style should use the clamped offset')
  assert.ok(!activitySource.includes("right: 'var(--gl-tb-r"), 'the inline style should not bypass the clamp')
})

test('the favourites toolbar title matches its in-content heading', () => {
  assert.match(toolbarSource, /favoriteTracks: 'Temas favoritos'/)
  assert.match(appSource, /name: 'Temas favoritos'/)
})
