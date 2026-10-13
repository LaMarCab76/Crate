import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('./PlayerBottomBar.tsx', import.meta.url), 'utf8')
const app = await readFile(new URL('../App.tsx', import.meta.url), 'utf8')
const css = (await readFile(new URL('../styles/globals.css', import.meta.url), 'utf8')).replace(/\r\n/g, '\n')

function cssBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{(?<body>[^}]*)\\}`))
  assert.ok(match?.groups?.body, `Missing CSS block for ${selector}`)
  return match.groups.body
}

function containerBlock(maxWidth) {
  const match = css.match(new RegExp(`@container pb-island \\(max-width: ${maxWidth}px\\) \\{(?<body>(?:[^{}]*\\{[^}]*\\})*)\\s*\\}`))
  assert.ok(match?.groups?.body, `Missing @container pb-island (max-width: ${maxWidth}px)`)
  return match.groups.body
}

test('the island track menu and its dialogs are hosted by App, outside the dock', () => {
  // Saving / moving / trashing the playing track stops playback, which
  // unmounts the dock; dialogs hosted there would vanish mid-save.
  assert.doesNotMatch(source, /useTrackActions\(/)
  assert.match(app, /const islandTrackActions = useTrackActions\(\)/)
  assert.match(app, /onOpenTrackMenu=\{islandTrackActions\.openTrackMenu\}/)
  const dockStart = app.indexOf('<div className={`player-dock')
  const elements = app.indexOf('{islandTrackActions.elements}')
  const dockEnd = app.indexOf('</div>\n          </div>\n        )}', dockStart)
  assert.ok(dockStart > 0 && dockEnd > dockStart, 'dock markup found')
  assert.ok(elements > dockEnd, 'track dialogs render after (outside) the dock')
})

test('the sheet folds on navigation and acts as a modal layer', () => {
  assert.match(app, /viewKey=\{view\}/)
  assert.match(source, /setSheetOpen\(false\)\n {2}\}, \[viewKey\]\)/)
  assert.match(source, /role=\{sheetVisible \? 'dialog' : 'region'\}/)
  assert.match(source, /aria-modal=\{sheetVisible \|\| undefined\}/)
  assert.match(source, /isolateShellBackground\(dock\)/)
  assert.match(source, /onKeyDown=\{keepTabInSheet\}/)
})

test('the hidden sheet does not re-render its content on position ticks', () => {
  assert.match(source, /const sheetLive = sheetVisible \|\| morphing/)
  assert.match(source, /\{sheetLive && \(/)
  assert.match(source, /const sheetQueue = sheetLive && sheetTab === 'next'/)
  assert.match(source, /const SheetQueueRow = memo\(/)
})

test('the island only springs its size while morphing into the sheet', () => {
  const island = cssBlock('.pb-island')
  const morphing = cssBlock('.pb-island.morphing')
  assert.doesNotMatch(island, /\bwidth \d+ms/, 'resizes apply immediately outside the morph')
  assert.match(morphing, /width 560ms/)
  assert.match(morphing, /height 560ms/)
  assert.match(source, /\$\{morphing \? ' morphing' : ''\}/)
})

test('narrow docks keep the island and sheet contents inside the glass', () => {
  assert.match(cssBlock('.pb-island-frame'), /--pb-compact-w: min\(600px, max\(100cqw, 200px\)\)/)
  assert.match(containerBlock(360), /\.pb-island-prev \{\s*display: none;/)
  assert.match(containerBlock(300), /\.pb-island-next,/)
  assert.match(containerBlock(240), /\.pb-island-art \{\s*display: none;/)
  assert.match(containerBlock(400), /\.pb-sheet-transport \.play \{\s*width: 54px;/)
  assert.match(containerBlock(220), /\.pb-sheet-transport \.sub \{\s*display: none;/)
  assert.match(cssBlock('.pb-sheet-tabs-thumb'), /width: calc\(50% - 2px\);/)
  assert.match(source, /className="pb-island-btn pb-island-prev"/)
  assert.match(source, /className="pb-island-btn pb-island-next"/)
})

test('island and sheet artwork use soft shadows in the light theme', () => {
  for (const selector of ['.theme-light .pb-island-art', '.theme-light .pb-sheet-art', '.theme-light .up-next-toast .art']) {
    const block = cssBlock(selector)
    assert.match(block, /rgba\(0, 0, 0, 0\.08\)/, `${selector} uses a dark hairline`)
    assert.doesNotMatch(block, /rgba\(255, 255, 255/, `${selector} drops the white ring`)
  }
})
