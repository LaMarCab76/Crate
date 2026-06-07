import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

function read(relative) {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

const mediaActions = read('../components/MediaActions.tsx')
const store = read('../stores/libraryStore.ts')
const preload = read('../../../preload/index.ts')
const ipcTypes = read('../../../../shared/types/ipc-contract.ts')
const css = read('../styles/globals.css')

function cssBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`))
  assert.ok(match?.groups?.body, `Missing CSS block for ${selector}`)
  return match.groups.body
}

test('track context menu exposes the single-track move to album action', () => {
  assert.match(mediaActions, /id: 'move-album'/)
  assert.match(mediaActions, /label: 'Mover a álbum\.\.\.'/)
  assert.match(mediaActions, /kind: 'moveAlbum'; track: Track/)
  assert.match(mediaActions, /<TrackAlbumMoveModal track=\{dialog\.track\}/)
})

test('album move modal defines local normalization and ranking helpers', () => {
  assert.match(mediaActions, /function normalizeAlbumSuggestionText/)
  assert.match(mediaActions, /function wordsForAlbumSuggestion/)
  assert.match(mediaActions, /function wordMatchScore/)
  assert.match(mediaActions, /function isAlbumSuggestionTextEqual/)
  assert.match(mediaActions, /function isAlbumSuggestionTextIncluded/)
  assert.match(mediaActions, /function albumMoveSuggestionScore/)
  assert.match(mediaActions, /function albumMoveSuggestionLabel/)
  assert.match(mediaActions, /type AlbumSuggestion = /)
})

test('album move suggestions are scored by artist/year/genre and text similarity', () => {
  assert.match(mediaActions, /albumMoveSuggestionScore\(args: \{ track: Track; album: Album \}\)/)
  assert.match(mediaActions, /if \(trackAlbumArtist && isAlbumSuggestionTextEqual\(albumArtist, trackAlbumArtist\)\)/)
  assert.match(mediaActions, /score \+= 70/)
  assert.match(mediaActions, /trackArtist\) \{/)
  assert.match(mediaActions, /score \+= 50/)
  assert.match(mediaActions, /albumYear === trackYear[\s\S]*score \+= 28/)
  assert.match(mediaActions, /score \+= wordMatchScore\(trackTitle, albumTitle\)/)
  assert.match(mediaActions, /bestAlbumTrackTitleScore\(trackTitle, args\.album\)/)
})

test('album move modal orders candidates by score and preselects first ranked candidate', () => {
  assert.match(mediaActions, /const bySource = albums[\s\S]*\.filter\(album => albumDbId\(album\) != null && album\.id !== track\.albumId\)/)
  assert.match(mediaActions, /\.map\(album => \(\{ album, score: albumMoveSuggestionScore\(\{ track, album \}\) \}\)/)
  assert.match(mediaActions, /bySource\.sort\([\s\S]*const scoreDelta = b\.score - a\.score/)
  assert.match(mediaActions, /const title = a\.album\.title\.localeCompare\(b\.album\.title\)/)
  assert.match(mediaActions, /const firstAlbumId = candidates\.map\(candidate => albumDbId\(candidate\.album\)\)\.find\(\(id\): id is number => id != null\)/)
  assert.match(mediaActions, /const \[targetAlbumId, setTargetAlbumId\] = useState<number \| null>\(firstAlbumId \?\? null\)/)
  assert.match(mediaActions, /if \(targetAlbumId != null && candidates\.some\(candidate => albumDbId\(candidate\.album\) === targetAlbumId\)\) return/)
  assert.match(mediaActions, /className="album-move-percent"/)
  assert.match(mediaActions, /albumMoveSuggestionPercent\(score\)/)
})

test('move modal calls preview and apply APIs and blocks the apply button unless preview is ready', () => {
  assert.match(mediaActions, /previewTrackAlbumMove\(\{ trackId: track\.dbId, targetAlbumId, trackNumber: trackNumberOverride \}\)/)
  assert.match(mediaActions, /applyTrackAlbumMove\(preview, confirmLower\)/)
  assert.match(mediaActions, /preview\?\.status === 'ready'/)
  assert.match(mediaActions, /Validando en MusicBrainz\.\.\./)
  assert.match(mediaActions, /preview\?\.errors\.map/)
})

test('move modal exposes a track-number slot picker and quality-based replacement', () => {
  assert.match(mediaActions, /function albumMoveSuggestionPercent/)
  assert.match(mediaActions, /function albumMoveQualityLabel/)
  assert.match(mediaActions, /const \[trackNumberOverride, setTrackNumberOverride\]/)
  assert.match(mediaActions, /className="album-move-columns"/)
  assert.match(mediaActions, /preview\.slots\.map/)
  assert.match(mediaActions, /setTrackNumberOverride\(slot\.trackNumber\)/)
  assert.match(mediaActions, /preview\?\.replacement/)
  assert.match(mediaActions, /willReplace \? 'Reemplazar'/)
  assert.match(ipcTypes, /interface TrackAlbumMoveReplacement/)
  assert.match(ipcTypes, /interface TrackAlbumMoveSlot/)
  assert.match(ipcTypes, /slots: TrackAlbumMoveSlot\[\]/)
})

test('renderer store, preload and IPC contract expose album move preview/apply', () => {
  assert.match(store, /export async function previewTrackAlbumMove/)
  assert.match(store, /export async function applyTrackAlbumMove/)
  assert.match(store, /stopPlaybackIfCurrentTrack\(\[preview\.source\.id\]\)/)
  assert.match(preload, /previewAlbumMove: \(payload: TrackAlbumMovePreviewRequest\)/)
  assert.match(preload, /applyAlbumMove: \(payload: TrackAlbumMoveApplyRequest\)/)
  assert.match(preload, /track:albumMove:preview/)
  assert.match(preload, /track:albumMove:apply/)
  assert.match(ipcTypes, /previewAlbumMove\(payload: TrackAlbumMovePreviewRequest\)/)
  assert.match(ipcTypes, /applyAlbumMove\(payload: TrackAlbumMoveApplyRequest\)/)
  assert.match(ipcTypes, /interface TrackAlbumMovePreview/)
})

test('album move modal styles define searchable album picker and two-column preview', () => {
  assert.match(cssBlock('.album-move-modal'), /display:\s*grid/)
  assert.match(cssBlock('.album-move-search'), /grid-template-columns:\s*18px minmax\(0, 1fr\)/)
  assert.match(cssBlock('.album-move-picker'), /max-height:\s*206px/)
  assert.match(cssBlock('.album-move-preview'), /grid-template-columns:\s*1fr 1fr/)
  assert.match(cssBlock('.album-move-facts'), /repeat\(3, minmax\(0, 1fr\)\)/)
  // The album list shows a confidence percentage on the right, not a text pill.
  assert.match(cssBlock('.album-move-percent'), /tabular-nums/)
})

test('album move modal styles define the slot picker and replacement comparison', () => {
  assert.match(cssBlock('.album-move-slots'), /flex-wrap:\s*wrap/)
  assert.match(cssBlock('.album-move-slot'), /cursor:\s*pointer/)
  assert.match(cssBlock('.album-move-replace-grid'), /minmax\(0, 1fr\) auto minmax\(0, 1fr\)/)
  // Inner surfaces are translucent so they read on the glass panel.
  assert.match(cssBlock('.album-move-preview > div'), /color-mix\(in oklab, var\(--bg-active\)/)
})

test('library store skips normalized albums with no tracks after a move', () => {
  assert.match(store, /if \(albumTracks\.length === 0\) continue/, 'empty DB albums must not be added to albumsById')
  assert.match(store, /dbAlbums\.flatMap/, 'album list must only include albums materialized in albumsById')
  assert.doesNotMatch(
    store,
    /dbAlbums\.map\(a => albumsById\.get\(`a\$\{a\.id\}`\) \?\? dbToUiAlbum/,
    'album list must not synthesize empty albums from stale DB rows',
  )
})
