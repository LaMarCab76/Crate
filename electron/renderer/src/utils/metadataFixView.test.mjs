import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

function read(relative) {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

const view = read('../views/MetadataFixView.tsx')
const css = read('../styles/globals.css')
const app = read('../App.tsx')
const navigation = read('../runtime/navigation.ts')
const toolbar = read('../components/Toolbar.tsx')
const libraryView = read('../views/LibraryView.tsx')
const importView = read('../views/ImportView.tsx')
const mediaActions = read('../components/MediaActions.tsx')

function cssBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`))
  assert.ok(match?.groups?.body, `Missing CSS block for ${selector}`)
  return match.groups.body
}

test('App registers the metadataFix view kind and routes to it', () => {
  assert.match(navigation, /kind: 'metadataFix'; trackIds: number\[\]/, 'View union missing metadataFix kind')
  assert.match(app, /case 'metadataFix':/, 'renderContent missing metadataFix case')
  assert.match(app, /<MetadataFixView[\s\S]*?trackIds=\{view\.trackIds\}[\s\S]*?onDone=\{goBack\}/, 'metadataFix case must render MetadataFixView with goBack')
})

test('App consumes the navigation intent once and clears it', () => {
  assert.match(app, /useMetadataFixIntent/, 'App must read the metadata-fix intent')
  assert.match(app, /clearMetadataFix\(\)/, 'App must clear the intent after navigating')
})

test('Toolbar exposes a title for the metadataFix view', () => {
  assert.match(toolbar, /metadataFix: 'Completar metadatos'/, 'titleMap missing metadataFix entry')
  assert.match(toolbar, /view\.kind === 'metadataFix'/, 'titleForView must handle the per-track title')
})

test('MetadataFixView renders the two-column current vs proposed comparison', () => {
  assert.match(view, /previewMetadataCompletion/, 'view must fetch the preview')
  assert.match(view, /applyMetadataCompletions/, 'view must apply the completions')
  assert.match(view, /metadata-fix-columns/, 'view must render the two-column header')
  assert.match(view, /Actual/, 'view must label the current column')
  assert.match(view, /Con cambios/, 'view must label the proposed column')
  assert.match(view, /metadata-fix-actual/, 'view must render the actual column body')
  assert.match(view, /metadata-fix-proposed/, 'view must render the proposed column body')
})

test('globals.css defines the two-column metadata-fix layout', () => {
  const columns = cssBlock('.metadata-fix-columns')
  assert.match(columns, /grid-template-columns:\s*1fr 1fr/, 'columns header must be two equal tracks')
  const body = cssBlock('.metadata-fix-track-body')
  assert.match(body, /grid-template-columns:\s*1fr 1fr/, 'track body must be two equal tracks')
  // The removed modal styles must be gone.
  assert.doesNotMatch(css, /\.meta-complete-/, 'orphan .meta-complete-* rules must be removed')
})

test('the floating modal is gone and every trigger routes via requestMetadataFix', () => {
  for (const [name, source] of [
    ['LibraryView', libraryView],
    ['ImportView', importView],
    ['MediaActions', mediaActions],
  ]) {
    assert.doesNotMatch(source, /MetadataCompletionModal/, `${name} must not reference the deleted modal`)
    assert.match(source, /requestMetadataFix/, `${name} must route through requestMetadataFix`)
  }
})
