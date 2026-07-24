import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

function read(relative) {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

const app = read('../App.tsx')
const sidebar = read('../components/Sidebar.tsx')
const activity = read('../stores/activityCenterStore.ts')
const store = read('../stores/duplicateStore.ts')
const view = read('../views/DuplicateReviewView.tsx')
const css = read('../styles/globals.css')

function cssBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`))
  assert.ok(match?.groups?.body, `Missing CSS block for ${selector}`)
  return match.groups.body
}

test('App routes duplicate review and suppresses every main playback surface', () => {
  assert.match(app, /kind: 'duplicates'; candidateId\?: string/, 'View union must support a deep-linked candidate')
  assert.match(app, /case 'duplicates':\s*return <DuplicateReviewView/, 'renderContent must render duplicate review')
  assert.match(app, /!duplicateReviewOpen && \(playerPaneVisible \|\| lyricsSidePaneVisible\)/, 'lateral player must be hidden')
  assert.match(app, /!duplicateReviewOpen && bottomPlayerVisible/, 'bottom player must be hidden')
  assert.match(app, /!duplicateReviewOpen && expanded && nowTrack/, 'fullscreen player must be hidden')
})

test('sidebar and persistent activity both navigate to duplicate review', () => {
  assert.match(sidebar, /id="duplicates"[\s\S]*?badge=\{duplicateCount/, 'sidebar must expose pending badge')
  assert.match(activity, /id: 'duplicates:pending'/, 'activity must use one stable backend-derived id')
  assert.match(activity, /actionIds: \['open-duplicates'\]/, 'activity must be actionable')
})

test('missing acoustic engine is shown as one system blocker, not damaged tracks', () => {
  assert.match(activity, /summary\.blocker/, 'activity must consume the run-level availability reason')
  assert.match(activity, /progress: null/, 'blocked activity must explicitly clear previous progress')
  assert.match(view, /summary\.blocker\.message/, 'review must explain why analysis cannot start')
  assert.match(view, /No se marcó ninguna pista como dañada/, 'empty state must not blame library files')
  assert.match(view, /summary\.blocker && !summary\.blocker\.retryable/, 'only restart-required blockers disable reanalysis')
  assert.match(view, /Volver a intentar/, 'a disconnected root must expose a same-process retry')
})

test('review uses isolated A/B controls and explicit destructive decisions', () => {
  assert.match(view, /window\.api|useDuplicateStore/, 'review must use the real duplicate API through its store')
  assert.match(view, /side="left"/, 'review must render the candidate on the left')
  assert.match(view, /side="right"/, 'review must render the recommended track on the right')
  assert.match(view, /Conservar ambos/, 'review must expose keep-both')
  assert.match(view, /Entiendo que esta es la copia recomendada/, 'deleting the recommendation needs reinforced confirmation')
  assert.match(view, /aria-valuetext/, 'audition progress must expose accessible time text')
  assert.match(store, /duplicates\.audition\.open/, 'entering a pair must use the isolated audition service')
  assert.match(store, /duplicates\.audition\.close/, 'leaving must close audition so main playback can be restored')
  assert.doesNotMatch(store, /api\.audio\.(?:load|play|seek)/, 'duplicate audition must not mutate the global player')
})

test('duplicate route opens as a pending list and each row enters the existing review', () => {
  assert.match(store, /if \(!candidateId\) \{[\s\S]*?detail: null[\s\S]*?loading: false/, 'plain navigation must stop at the list')
  assert.match(view, /function DuplicateCandidateList/, 'review must expose a dedicated pending-list surface')
  assert.match(view, /<ol className="duplicate-candidate-list"/, 'the cases must use ordered-list semantics')
  assert.match(view, /data-candidate-id=\{candidate\.id\}/, 'every candidate must have a focus-return target')
  assert.match(view, /onOpen=\{id => \{ void selectCandidate\(id\) \}\}/, 'a row must open its candidate detail')
  assert.match(view, /Ver todos/, 'detail must provide an explicit return to the complete list')
  assert.match(view, /ArrowDown[\s\S]*?ArrowUp[\s\S]*?Home[\s\S]*?End/, 'the list must support spatial keyboard navigation')
  assert.match(view, /Pendientes de revisión/, 'the list must identify the remaining review workload')
  assert.match(view, /Recomendado conservar/, 'the right-hand list column must identify the recommendation')
})

test('pending rows use unselected artwork choices and confirm a direct keep decision safely', () => {
  assert.match(view, /<li[\s\S]*?className=\{`duplicate-candidate-row/, 'each comparison must be a semantic list item')
  assert.doesNotMatch(view, /<button[^>]*className="duplicate-candidate-row"/, 'the row must not wrap its actions in a button')
  assert.doesNotMatch(view, /Conservar esta/, 'the old keep pills must not remain in either track column')
  assert.equal(view.match(/className=\{`duplicate-list-track-choice/g)?.length, 2, 'both track identities must be direct choices')
  assert.match(view, /onKeep\(candidate\.id, 'left'\)/, 'the left track must be independently selectable')
  assert.match(view, /onKeep\(candidate\.id, 'right'\)/, 'the recommended right track must be independently selectable')
  assert.match(view, /aria-pressed=\{selectedSide === 'left'\}/, 'the left artwork choice must expose selection state')
  assert.match(view, /aria-pressed=\{selectedSide === 'right'\}/, 'the right artwork choice must expose selection state')
  assert.equal(view.match(/aria-haspopup="dialog"/g)?.length, 2, 'both artwork choices must announce their confirmation dialog')
  assert.match(view, /selectedChoice=\{trashDecision\?\.source === 'list'[\s\S]*?: null\}/, 'neither side may be selected without an active list decision')
  assert.equal(view.match(/selectedSide === '(?:left|right)' && \([\s\S]*?duplicate-list-selection-mark/g)?.length, 2, 'a check overlay must only render for the actively chosen side')
  assert.match(view, /<span className="duplicate-list-keeper">Recomendado<\/span>/, 'the recommendation must remain textual without a permanent check')
  assert.doesNotMatch(css, /\.duplicate-list-track\.recommended/, 'the recommended track must not retain a selected-looking background')
  assert.match(cssBlock('.duplicate-list-selection-mark'), /position:\s*absolute[\s\S]*?border-radius:\s*50%/, 'the active check must overlay the artwork')
  assert.match(view, /candidate\.left\.album[\s\S]*?candidate\.right\.album/, 'accessible choice labels must distinguish same-title album versions')
  assert.match(store, /keepCandidate\(candidateId, expectedRevision, side\)/, 'direct resolution must retain the captured candidate revision')
  assert.match(store, /duplicateResolutionActionForKeptSide\(side\)/, 'the keep choice must map through the tested opposite-side action')
  assert.match(view, /keepCandidate\(\s*decision\.candidate\.id,\s*decision\.candidate\.revision,\s*keptSide/, 'list and detail confirmations must resolve the captured pair and revision')
  assert.doesNotMatch(view, /decision\.source === 'list'[\s\S]*?: trash\(/, 'detail confirmation must not fall back to the mutable current detail')
  assert.match(view, /Se conserva[\s\S]*?Va a la Papelera/, 'confirmation must make both outcomes explicit')
  assert.match(view, /Entiendo que esta es la copia recomendada/, 'keeping the left alternative must retain reinforced confirmation')
  assert.match(view, /if \(!success\)[\s\S]*?setDecisionError/, 'failed deletion must keep an actionable error inside the modal')
  assert.match(view, /role="alert">\{error\}/, 'modal errors must remain available while the background is inert')
  assert.match(view, /onCancel=\{\(\) => \{[\s\S]*?setTrashDecision\(null\)/, 'cancelling confirmation must clear the transient artwork selection')
  assert.match(view, /remaining\[Math\.min\(decision\.listIndex/, 'focus must advance from the removed row at a stable list index')
  assert.match(view, /resolvingCandidateId=\{resolvingCandidateId\}/, 'the list must expose per-row resolution progress')
})

test('list arrow navigation preserves the focused action and side', () => {
  assert.match(view, /data-list-action="keep-left"/, 'the left keep action needs a stable navigation identity')
  assert.match(view, /data-list-action="keep-right"/, 'the right keep action needs a stable navigation identity')
  assert.match(view, /data-list-action="open"/, 'the detail action needs a stable navigation identity')
  assert.match(
    view,
    /querySelector<HTMLButtonElement>\(`button\[data-list-action="\$\{listAction\}"\]:not\(:disabled\)`\)/,
    'vertical navigation must retain the current action instead of switching to detail',
  )
})

test('resolving a pair returns to the list with an auditable result and remaining count', () => {
  assert.match(store, /removedTrack\?\.title[\s\S]*?removedFileName[\s\S]*?se envió a la Papelera/, 'trash notice must identify title and file')
  assert.match(store, /detail: null, loading: true[\s\S]*?await refreshActiveView\(\)/, 'a completed decision must return to the list')
  assert.match(store, /Queda 1 comparación pendiente[\s\S]*?Quedan \$\{remaining\.toLocaleString\(\)\} comparaciones pendientes/, 'notice must report remaining work')
  assert.match(store, /if \(!state\.detail && !preferredId\)/, 'background refreshes must preserve list mode')
  assert.match(store, /if \(useDuplicateStore\.getState\(\)\.resolving\) return/, 'resolution events must not race into the following audition')
})

test('duplicate layout remains two-column at a 900px window', () => {
  const grid = cssBlock('.duplicate-track-grid')
  assert.match(grid, /grid-template-columns:\s*minmax\(0, 1fr\) 0 minmax\(0, 1fr\)/)
  const listRow = cssBlock('.duplicate-candidate-row')
  assert.match(listRow, /grid-template-columns:\s*28px minmax\(0, 1fr\)[\s\S]*?minmax\(0, 1fr\) 22px/, 'list rows must present both tracks side by side')
  const responsive = css.match(/@media \(max-width: (?<breakpoint>\d+)px\) \{\s*\.duplicate-review-head[\s\S]*?\.duplicate-track-grid \{ grid-template-columns: 1fr; \}/)
  assert.ok(responsive?.groups?.breakpoint, 'single-column fallback must have an explicit breakpoint')
  assert.ok(Number(responsive.groups.breakpoint) < 900, '900px windows must keep the side-by-side comparison')
})

test('timeline communicates state with text as well as color', () => {
  assert.match(view, /Coincidencia/, 'matching segments need a text label')
  assert.match(view, /Diferencia/, 'different segments need a text label')
  assert.match(view, /aria-label="Filtrar tramos"/, 'timeline filters need an accessible group name')
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.duplicate-spin/, 'duplicate motion must honor reduced motion')
})
