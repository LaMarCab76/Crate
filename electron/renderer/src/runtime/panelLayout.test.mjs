import { test } from 'node:test'
import assert from 'node:assert/strict'
import { panelLayout } from './panelLayout.ts'

test('minimum desktop width keeps content accessible with lyrics and a player requested', () => {
  const input = { width: 900, sidebarWidth: 248, sidebarOpen: true, playerOpen: true, lyricsOpen: true, lyricsWidth: 380 }
  const layout = panelLayout(input)
  assert.equal(layout.playerOpen, false)
  assert.ok(900 - (layout.sidebarOpen ? input.sidebarWidth : 0) - layout.lyricsWidth >= 280)
  assert.equal(input.playerOpen, true, 'saved choices must not be changed')
})

test('wide desktops restore all requested panels and bounded lyrics width', () => {
  assert.deepEqual(panelLayout({ width: 1600, sidebarWidth: 248, sidebarOpen: true, playerOpen: true, lyricsOpen: true, lyricsWidth: 380 }), { sidebarOpen: true, playerOpen: true, lyricsWidth: 380 })
  for (const width of [900, 1024, 1280]) {
    const layout = panelLayout({ width, sidebarWidth: 420, sidebarOpen: true, playerOpen: true, lyricsOpen: true, lyricsWidth: 620 })
    assert.ok(width - (layout.sidebarOpen ? 420 : 0) - (layout.playerOpen ? 340 : 0) - layout.lyricsWidth >= 280)
  }
})
