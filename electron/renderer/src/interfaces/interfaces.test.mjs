import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

function moduleUrl(relativePath, substitutions = {}) {
  let source = ts.transpileModule(readFileSync(new URL(relativePath, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  for (const [specifier, target] of Object.entries(substitutions)) source = source.replaceAll(`'${specifier}'`, `'${target}'`).replaceAll(`"${specifier}"`, `"${target}"`)
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
}
const typesUrl = moduleUrl('../../../../shared/types/interfaces.ts')
const validationUrl = moduleUrl('../../../../shared/interfaces/validation.ts', { '../types/interfaces': typesUrl })
const { validateInterfacePackage } = await import(validationUrl)
const { createInterface, duplicatePackage, findNode, updateNode, removeNode, moveNode, reparentNode, removeScreen, readDrafts, writeDraft, readBriefs, writeBrief, pushHistory, DRAFT_KEY, MAX_HISTORY_BYTES } = await import(moduleUrl('./model.ts', { '@shared/interfaces/validation': validationUrl }))

function tree() {
  return { id: 'root', type: 'column', children: [
    { id: 'panel-a', type: 'panel', children: [{ id: 'song', type: 'tracks' }] },
    { id: 'panel-b', type: 'panel', children: [] },
    { id: 'text', type: 'text', props: { text: 'Hello' } },
  ] }
}
function storage(initial = null) {
  let saved = initial
  return { getItem: () => saved, setItem: (_, value) => { saved = value } }
}

test('editor reorders and reparents nested components immutably, without cycles or lost nodes', () => {
  const original = tree()
  const moved = reparentNode(original, 'song', 'panel-b')
  assert.equal(findNode(moved, 'panel-a').children.length, 0)
  assert.equal(findNode(moved, 'panel-b').children[0].id, 'song')
  assert.equal(findNode(original, 'panel-a').children.length, 1)
  assert.equal(reparentNode(original, 'panel-a', 'song'), original)
  assert.equal(reparentNode(original, 'root', 'panel-b'), original)
  assert.equal(reparentNode(original, 'panel-a', 'panel-a'), original)
  const reordered = moveNode(original, 'panel-b', -1)
  assert.deepEqual(reordered.children.map(item => item.id), ['panel-b', 'panel-a', 'text'])
  assert.deepEqual(original.children.map(item => item.id), ['panel-a', 'panel-b', 'text'])
  assert.equal(findNode(removeNode(original, 'song'), 'song'), undefined)
  assert.equal(findNode(updateNode(original, 'text', node => ({ ...node, props: { text: 'Updated' } })), 'text').props.text, 'Updated')
})

test('removing a screen cleans its navigation and preserves at least one screen', () => {
  const pkg = createInterface()
  assert.equal(removeScreen(pkg.manifest, 'home'), pkg.manifest)
  pkg.manifest.screens.push({ id: 'other', title: 'Other', root: { id: 'other-root', type: 'column' } })
  pkg.manifest.navigation.push({ id: 'other-nav', label: 'Other', screenId: 'other' })
  const result = removeScreen(pkg.manifest, 'home')
  assert.deepEqual(result.screens.map(item => item.id), ['other'])
  assert.deepEqual(result.navigation.map(item => item.screenId), ['other'])
  validateInterfacePackage({ manifest: result })
})

test('duplicate interfaces get independent identities and mutable compositions', () => {
  const pkg = createInterface('classic')
  const duplicated = duplicatePackage(pkg)
  assert.notEqual(duplicated.manifest.id, pkg.manifest.id)
  duplicated.manifest.screens[0].root.props.padding = 99
  assert.equal(pkg.manifest.screens[0].root.props.padding, 24)
  validateInterfacePackage(duplicated)
})

test('draft recovery ignores damaged, invalid and oversized data and retains newest twenty drafts', () => {
  assert.deepEqual(readDrafts(storage('{')), {})
  assert.deepEqual(readDrafts(storage(JSON.stringify({ broken: { manifest: { schemaVersion: 1, id: 'broken', kind: 'declarative', screens: [{ root: { type: 'column' } }] } } }))), {})
  assert.deepEqual(readDrafts(storage('x'.repeat(2_000_001))), {})
  const db = storage()
  for (let i = 0; i < 25; i++) {
    const pkg = createInterface()
    pkg.manifest.id = `draft-${i}`
    writeDraft(db, pkg)
  }
  const recovered = readDrafts(db)
  assert.equal(Object.keys(recovered).length, 20)
  assert.equal(recovered['draft-0'], undefined)
  assert.equal(recovered['draft-24'].manifest.id, 'draft-24')
  const giant = createInterface()
  giant.files = [{ path: 'large.txt', content: 'x'.repeat(2_000_000), encoding: 'utf8' }]
  assert.throws(() => writeDraft(db, giant), /2 MB/)
  assert.equal(Object.keys(readDrafts(db)).length, 20)
})

test('undo history is bounded by both steps and payload size', () => {
  const pkg = createInterface()
  let history = []
  for (let i = 0; i < 60; i++) history = pushHistory(history, pkg)
  assert.equal(history.length, 50)
  const large = { ...pkg, files: [{ path: 'large.txt', content: 'x'.repeat(1_000_000), encoding: 'utf8' }] }
  for (let i = 0; i < 10; i++) history = pushHistory(history, large)
  assert.ok(history.reduce((total, item) => total + JSON.stringify(item).length, 0) <= MAX_HISTORY_BYTES)
  assert.ok(history.length < 5)
})

test('drafts preserve unfinished form labels and versions without accepting malformed trees', () => {
  const pkg = createInterface()
  pkg.manifest.name = ''
  pkg.manifest.version = '2.'
  pkg.manifest.screens[0].title = ''
  pkg.manifest.navigation[0].label = ''
  const db = storage()
  writeDraft(db, pkg)
  const recovered = readDrafts(db)[pkg.manifest.id]
  assert.equal(recovered.manifest.name, '')
  assert.equal(recovered.manifest.version, '2.')
  assert.equal(recovered.manifest.screens[0].title, '')
  assert.throws(() => validateInterfacePackage(recovered))
})

test('shipped declarative and programmable examples validate as real import packages', () => {
  for (const name of ['collection', 'nightdesk']) {
    const pkg = JSON.parse(readFileSync(new URL(`../../../../examples/interfaces/${name}.crate-interface`, import.meta.url), 'utf8'))
    assert.equal(validateInterfacePackage(pkg).manifest.id, name === 'collection' ? 'collection-example' : name)
  }
})

test('design briefs persist independently of manifest limits with bounded size and recoverable corruption', () => {
  const db = storage()
  const full = 'Requisito detallado. '.repeat(200)
  writeBrief(db, 'my-interface', full)
  assert.equal(readBriefs(db)['my-interface'], full)
  assert.throws(() => writeBrief(db, 'my-interface', 'x'.repeat(64_001)), /64 KB/)
  assert.equal(readBriefs(db)['my-interface'], full)
  for (let i = 0; i < 25; i++) writeBrief(db, `interface-${i}`, 'Brief')
  assert.equal(Object.keys(readBriefs(db)).length, 20)
  assert.equal(readBriefs(db)['interface-24'], 'Brief')
  assert.deepEqual(readBriefs(storage('{')), {})
})

test('selection store ignores stale reads and keeps the active tree mounted during confirmation', async () => {
  const zustandUrl = `data:text/javascript;base64,${Buffer.from(`export function create(factory){let state;const store=selector=>selector(state);store.getState=()=>state;store.setState=partial=>{state={...state,...(typeof partial==='function'?partial(state):partial)}};state=factory(store.setState,store.getState);return store}`).toString('base64')}`
  const { useInterfaceStore } = await import(moduleUrl('./interfaceStore.ts', { zustand: zustandUrl }))
  let resolveOld
  const fresh = createInterface()
  fresh.manifest.id = 'fresh'
  globalThis.window = { api: { interfaces: {
    activate: async id => ({ activeId: id, activeRevision: 'revision', trial: true }),
    read: id => id === 'old' ? new Promise(resolve => { resolveOld = resolve }) : Promise.resolve(fresh),
    confirm: async () => ({ activeId: 'fresh', activeRevision: 'revision', trial: false }),
  } } }
  const oldRead = useInterfaceStore.getState().activate('old')
  await Promise.resolve(); await Promise.resolve()
  await useInterfaceStore.getState().activate('fresh')
  resolveOld(createInterface())
  await oldRead
  assert.equal(useInterfaceStore.getState().activePackage, fresh)
  await useInterfaceStore.getState().confirm()
  assert.equal(useInterfaceStore.getState().activePackage, fresh)
  assert.equal(useInterfaceStore.getState().selection.trial, false)
  delete globalThis.window
})
