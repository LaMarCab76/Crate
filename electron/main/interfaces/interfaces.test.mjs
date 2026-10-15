import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'

// The app uses bundler resolution and TypeScript parameter properties. Compile
// these pure modules in memory using the same project compiler, without loading
// Electron or touching the real userData directory.
function moduleUrl(relativePath, substitutions = {}) {
  let source = ts.transpileModule(readFileSync(new URL(relativePath, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  for (const [specifier, target] of Object.entries(substitutions)) source = source.replaceAll(`'${specifier}'`, `'${target}'`).replaceAll(`"${specifier}"`, `"${target}"`)
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
}
const typesUrl = moduleUrl('../../../shared/types/interfaces.ts')
const validationUrl = moduleUrl('../../../shared/interfaces/validation.ts', { '../types/interfaces': typesUrl })
const { validateInterfacePackage } = await import(validationUrl)
const { InterfaceRepository } = await import(moduleUrl('./InterfaceRepository.ts', { '../../../shared/interfaces/validation': validationUrl }))
const { validateGuestRequest, boundedJson } = await import(moduleUrl('./guestPolicy.ts'))

function packageFixture(kind = 'declarative') {
  return {
    manifest: {
      schemaVersion: 1, id: 'my-interface', name: 'My interface', version: '1.0.0', kind, base: 'glass', capabilities: ['library.read'],
      screens: [{ id: 'home', title: 'Home', root: { id: 'root', type: 'column', children: [{ id: 'tracks', type: 'tracks', props: { limit: 100 } }] } }],
      navigation: [{ id: 'nav-home', label: 'Home', screenId: 'home' }],
      ...(kind === 'code' ? { entry: 'index.html' } : {}),
    },
    ...(kind === 'code' ? { files: [{ path: 'index.html', content: '<!doctype html><h1>Custom interface</h1>', encoding: 'utf8' }] } : {}),
  }
}

function repositoryFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'crate-interface-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return { directory, repository: new InterfaceRepository(directory) }
}

test('package validation accepts composable and self-contained programmable interfaces', () => {
  assert.equal(validateInterfacePackage(packageFixture()).manifest.kind, 'declarative')
  assert.equal(validateInterfacePackage(packageFixture('code')).files[0].path, 'index.html')
})

test('package validation rejects traversal, incomplete entry points and oversized content', () => {
  for (const path of ['../index.html', '/index.html', 'assets/../index.html', 'assets\\index.html', 'a%2findex.html', 'https:index.html', '.secret']) {
    const pkg = packageFixture('code')
    pkg.files[0].path = path
    assert.throws(() => validateInterfacePackage(pkg), /path/i)
  }
  const missing = packageFixture('code')
  missing.files = []
  assert.throws(() => validateInterfacePackage(missing), /entry file/)
  const large = packageFixture('code')
  large.files[0].content = 'x'.repeat(16 * 1024 * 1024)
  assert.throws(() => validateInterfacePackage(large), /16 MiB/)
})

test('package validation rejects capabilities, duplicate identifiers and invalid navigation', () => {
  const capability = packageFixture()
  capability.manifest.capabilities.push('filesystem.write')
  assert.throws(() => validateInterfacePackage(capability), /capabilities/)
  const duplicate = packageFixture()
  duplicate.manifest.screens[0].root.children.push({ id: 'tracks', type: 'text' })
  assert.throws(() => validateInterfacePackage(duplicate), /Duplicate component/)
  const route = packageFixture()
  route.manifest.navigation[0].screenId = 'missing'
  assert.throws(() => validateInterfacePackage(route), /missing screen/)
  const injection = packageFixture()
  injection.manifest.theme = { accent: 'red; background:url(https://example.com)' }
  assert.throws(() => validateInterfacePackage(injection), /theme value/)
})

test('revisions are immutable, deduplicate exact content and keep earlier versions readable', t => {
  const { repository } = repositoryFixture(t)
  const pkg = packageFixture()
  const first = repository.save(pkg)
  assert.deepEqual(repository.save(pkg), first)
  pkg.manifest.name = 'Changed interface'
  const second = repository.save(pkg)
  assert.notEqual(first.revision, second.revision)
  assert.equal(repository.list().filter(item => item.manifest.id === 'my-interface').length, 2)
  assert.equal(repository.read('my-interface', first.revision).manifest.name, 'My interface')
  assert.equal(repository.read('my-interface', second.revision).manifest.name, 'Changed interface')
  assert.equal(repository.read('my-interface').manifest.name, 'Changed interface')
  assert.throws(() => repository.save({ manifest: { ...pkg.manifest, id: 'crate-glass' } }), /included interface/)
})

test('activation is provisional, restart restores the previous confirmed interface', t => {
  const { directory, repository } = repositoryFixture(t)
  const installed = repository.save(packageFixture('code'))
  repository.activate('crate-classic')
  const selection = repository.activate(installed.manifest.id, installed.revision)
  assert.equal(selection.trial, true)
  assert.equal(selection.previousId, 'crate-classic')
  const recovered = new InterfaceRepository(directory).getSelection()
  assert.equal(recovered.activeId, 'crate-classic')
  assert.equal(recovered.trial, false)
  assert.match(recovered.reason, /not confirmed/)
  assert.equal(repository.read(installed.manifest.id, installed.revision).manifest.kind, 'code')
})

test('confirmed interfaces survive restart, active revisions cannot be deleted', t => {
  const { directory, repository } = repositoryFixture(t)
  const installed = repository.save(packageFixture())
  repository.activate(installed.manifest.id, installed.revision)
  repository.confirm()
  assert.equal(new InterfaceRepository(directory).getSelection().activeRevision, installed.revision)
  assert.throws(() => repository.remove(installed.manifest.id), /Switch to another/)
  repository.activate('crate-glass')
  repository.remove(installed.manifest.id)
  assert.throws(() => repository.read(installed.manifest.id), /not installed/)
})

test('a valid manifest-heavy package remains readable when the stored manifest is duplicated', t => {
  const { directory, repository } = repositoryFixture(t)
  const pkg = packageFixture()
  // A 9 MiB manifest is within the 16 MiB package limit, but its persistence
  // envelope exceeds that limit because the display manifest is also stored.
  pkg.manifest.screens[0].root.children = Array.from({ length: 900 }, (_, index) => ({
    id: `large-${index}`, type: 'text', props: { text: 'x'.repeat(5000), title: 'y'.repeat(5000) },
  }))
  // Keep each component's child count within the editor's structural limit.
  const children = pkg.manifest.screens[0].root.children
  pkg.manifest.screens[0].root.children = Array.from({ length: 9 }, (_, index) => ({
    id: `group-${index}`, type: 'column', children: children.slice(index * 100, (index + 1) * 100),
  }))
  validateInterfacePackage(pkg)
  const installed = repository.save(pkg)
  const storedPath = join(directory, 'revisions', installed.manifest.id, `${installed.revision}.json`)
  assert.ok(readFileSync(storedPath).byteLength > 16 * 1024 * 1024)
  assert.equal(repository.read(installed.manifest.id, installed.revision).manifest.screens[0].root.children.length, 9)
  assert.equal(repository.list().find(item => item.manifest.id === installed.manifest.id)?.revision, installed.revision)
  assert.equal(repository.save(pkg).revision, installed.revision)
})

test('tampered revisions and corrupt selection recover to included UI without deleting packages', t => {
  const { directory, repository } = repositoryFixture(t)
  const installed = repository.save(packageFixture())
  repository.activate(installed.manifest.id, installed.revision)
  repository.confirm()
  const file = join(directory, 'revisions', installed.manifest.id, `${installed.revision}.json`)
  const stored = JSON.parse(readFileSync(file, 'utf8'))
  stored.package.manifest.name = 'Tampered'
  writeFileSync(file, JSON.stringify(stored))
  const recovered = new InterfaceRepository(directory)
  assert.equal(recovered.getSelection().activeId, 'crate-glass')
  assert.throws(() => recovered.read(installed.manifest.id, installed.revision), /integrity/)
  writeFileSync(join(directory, 'selection.json'), '{invalid')
  assert.equal(new InterfaceRepository(directory).getSelection().activeId, 'crate-glass')
})

test('SDK broker requires exact methods, declared capabilities and bounded JSON queries', () => {
  assert.deepEqual(validateGuestRequest({ method: 'library.tracks', params: { limit: 50, offset: 0 } }, ['library.read']), { method: 'library.tracks', params: { limit: 50, offset: 0 } })
  assert.throws(() => validateGuestRequest({ method: 'library.tracks' }, []), /not declared/)
  assert.throws(() => validateGuestRequest({ method: 'audio.load' }, ['playback.control']), /unavailable/)
  assert.throws(() => validateGuestRequest({ method: 'constructor' }, ['library.read']), /unavailable/)
  assert.throws(() => validateGuestRequest({ method: 'library.tracks', params: { limit: 251 } }, ['library.read']), /limit/)
  assert.throws(() => validateGuestRequest({ method: 'library.tracks', params: { offset: -1 } }, ['library.read']), /offset/)
  assert.throws(() => boundedJson({ data: 'x'.repeat(1024) }, 100), /size limit/)
  assert.throws(() => boundedJson(JSON.parse('{"__proto__":{"admin":true}}'), 1024), /serializable JSON/)
  assert.equal(validateGuestRequest({ method: 'queue.list', params: { offset: 250, limit: 100 } }, ['library.read']).method, 'queue.list')
  assert.throws(() => validateGuestRequest({ method: 'queue.list' }, ['queue.control']), /not declared library.read/)
})
