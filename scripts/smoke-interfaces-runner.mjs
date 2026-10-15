// Loaded only by smoke-interfaces.mjs, inside a real Electron browser process.
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, webContents } from 'electron'

const profile = process.env.CRATE_UI_SMOKE_PROFILE
const evidence = process.env.CRATE_UI_SMOKE_EVIDENCE
const root = process.env.CRATE_UI_SMOKE_ROOT
const restarting = process.env.CRATE_UI_SMOKE_RESTART === '1'
const resultName = restarting ? 'results-restart.json' : 'results.json'
assert.ok(profile?.includes('crate-interface-ui-profile-') && evidence?.includes('crate-interface-ui-evidence-') && root, 'Use the isolated smoke launcher')
assert.equal(resolve(process.env.CRATE_USER_DATA_DIR), join(profile, 'userData'))
let nextPicker = join(profile, 'Music')
let pickerCalls = 0
// Only the OS picker is deterministic. The renderer uses the real preload,
// authorization token issuance, import worker, package validation and storage.
dialog.showOpenDialog = async () => { pickerCalls++; return { canceled: false, filePaths: [nextPicker] } }
const sleep = milliseconds => new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds))
const deadline = Date.now() + 120_000
const steps = []
const rendererErrors = []
let win
const js = (source, target = win.webContents) => target.executeJavaScript(source, true)
async function until(predicate, label, duration = 15_000) {
  const end = Math.min(deadline, Date.now() + duration)
  let lastError
  while (Date.now() < end) {
    try { if (await predicate()) return } catch (error) { lastError = error }
    await sleep(200)
  }
  throw new Error(`Timed out: ${label}${lastError ? ` (${lastError.message})` : ''}`)
}
async function click(text, selector = 'button, [role="button"]', target = win.webContents) {
  await js(`(() => { const text=${JSON.stringify(text)};const elements=[...document.querySelectorAll(${JSON.stringify(selector)})];const element=elements.find(item=>item.textContent.trim()===text)||elements.find(item=>item.getAttribute('aria-label')===text)||elements.find(item=>item.textContent.trim().includes(text))||(elements.length===1?elements[0]:null);if(!element)throw Error('Missing control: '+text);if(element.disabled)throw Error('Disabled control: '+text);element.scrollIntoView({block:'center'});element.click();return true })()`, target)
  await sleep(120)
}
async function fill(selector, value, target = win.webContents) {
  await js(`(() => {const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw Error('Missing field: '+${JSON.stringify(selector)});const prototype=element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:element instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event(element instanceof HTMLSelectElement?'change':'input',{bubbles:true}));return element.value})()`, target)
  await sleep(100)
}
async function field(label, value) {
  const selector = await js(`(() => {const field=[...document.querySelectorAll('.if-editor-inspector label')].find(element=>element.firstChild?.textContent.trim()===${JSON.stringify(label)});if(!field)throw Error('Missing inspector label');const input=field.querySelector('input');input.setAttribute('data-smoke-field','active');return '[data-smoke-field="active"]'})()`)
  await fill(selector, value)
  await js(`document.querySelector('[data-smoke-field="active"]')?.removeAttribute('data-smoke-field')`)
}
function pass(label, details) { steps.push({ label, details }); console.log(`PASS: ${label}${details ? ` ${JSON.stringify(details)}` : ''}`) }
async function capture(name, target = win.webContents) {
  // macOS occlusion can retain an old compositor frame while DOM/IPC continue
  // updating. Give the real window focus and wait for fresh animation frames;
  // these test-only settings do not alter the app's persisted configuration.
  win.show(); app.focus({ steal: true }); win.focus()
  {
    const [width, height] = win.getSize()
    win.setSize(width, height + 1)
    await sleep(300)
    win.setSize(width, height)
    await sleep(300)
    const surface = { nativeViews: win.contentView.children.map(view => ({ visible: view.getVisible(), bounds: view.getBounds() })), covered: await js(`[...document.querySelectorAll('.modal-backdrop,[aria-modal="true"],.context-menu,.activity-center.fullscreen,.np-full')].map(element=>({className:element.className,display:getComputedStyle(element).display,visibility:getComputedStyle(element).visibility,width:element.getBoundingClientRect().width,height:element.getBoundingClientRect().height}))`) }
    writeFileSync(join(evidence, `${name}-surface.json`), JSON.stringify(surface, null, 2))
  }
  await js(`Promise.race([new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true)))),new Promise(resolve=>setTimeout(()=>resolve(false),1500))])`, target)
  await sleep(250)
  const path = join(evidence, `${name}.png`)
  try { writeFileSync(path, (await target.capturePage(undefined, { stayAwake: true, stayHidden: false })).toPNG()) }
  catch (error) {
    console.error('Capture surface:', JSON.stringify({ target: target.getURL(), windowVisible: win.isVisible(), windowFocused: win.isFocused(), visibility: await js('document.visibilityState', target), views: win.contentView.children.map(view => ({ visible: view.getVisible(), bounds: view.getBounds() })) }))
    throw error
  }
  return path
}
async function audio() { return js('window.api.audio.getStatus()') }
async function queue() { return js('window.api.queue.load()') }
async function selection() { return js('window.api.interfaces.getSelection()') }
async function manager() {
  if (await js(`Boolean(document.querySelector('.if-host-controls'))`)) await click('Interfaces', '.if-host-controls button')
  else await click('Preferences', '[aria-label="Preferences"]')
  await until(() => js(`Boolean(document.querySelector('.if-gallery .if-card'))`), 'interface gallery')
  await js(`document.querySelector('.if-manager').scrollIntoView({block:'start'})`)
}
async function design(base) {
  await js(`(() => {const card=[...document.querySelectorAll('.if-card')].find(item=>item.querySelector('.if-miniature-${base}'));const button=[...card.querySelectorAll('button')].find(item=>item.textContent.includes('Usar diseño'));if(!button)throw Error('Missing builtin selection');button.click()})()`)
  await until(async () => (await selection()).activeId === `crate-${base}`, `${base} selected`)
}

try {
  await import(pathToFileURL(join(root, 'out/main/index.js')).href)
  await until(() => { win = BrowserWindow.getAllWindows()[0]; return Boolean(win) }, 'main window')
  win.webContents.on('console-message', event => { if (event.level === 'error') rendererErrors.push(event.message) })
  if (restarting) {
    await until(() => js(`Boolean(window.api && document.querySelector('.if-host-controls'))`), 'confirmed programmable interface after cold app restart')
    assert.equal((await selection()).activeId, 'nightdesk')
    assert.equal((await selection()).trial, false)
    assert.equal(await js('window.api.library.trackCount()'), 2)
    let guest
    await until(() => { guest = webContents.getAllWebContents().find(item => item.getURL().startsWith('crate-interface://')); return Boolean(guest) }, 'cold-start programmable renderer')
    await until(() => js(`document.querySelectorAll('.track-card').length===2`, guest), 'cold-start library query waits for the real library to load')
    const snapshot = await js(`new Promise((resolve,reject)=>{let off;const timer=setTimeout(()=>{off?.();reject(Error('No cold state snapshot'))},5000);off=window.crateInterface.onState(state=>{if(state.queue?.total===2){clearTimeout(timer);off?.();resolve(state)}})})`, guest)
    assert.equal(snapshot.queue.total, 2)
    assert.equal(snapshot.playback.status, 'stopped')
    await capture('09-programmed-cold-restart', guest)
    pass('Confirmed programmed interface survives a full app restart and renders the real library and queue')
    await click('Preferencias', '#settings', guest)
    await until(() => js(`Boolean(document.querySelector('.settings'))`), 'trusted preferences on cold restart')
    await click('Restaurar diseño incluido', '.if-host-controls button')
    await until(async () => (await selection()).activeId === 'crate-glass', 'builtin restored after cold restart')
    assert.deepEqual(rendererErrors, [])
    pass('Native host controls recover the included interface after cold start')
    writeFileSync(join(evidence, resultName), JSON.stringify({ passed: true, steps, rendererErrors }, null, 2))
    app.quit()
  } else {
  await until(() => js(`Boolean(window.api && document.querySelector('.library-setup-overlay'))`), 'first-run library wizard')
  assert.equal(app.getPath('userData'), join(profile, 'userData'))
  await click('Elegir carpeta')
  await until(() => js(`document.body.innerText.includes('Continuar sin backup')`), 'authorized source picker result')
  await click('Continuar sin backup')
  await click('Entrar a Crate')
  await until(async () => await js('window.api.library.trackCount()') === 2, 'two real WAV files imported')
  await until(() => js(`document.querySelectorAll('table tbody tr').length >= 2`), 'rendered track rows')
  pass('Real library setup, native path authorization and WAV import', { tracks: 2, pickerCalls })
  await js(`document.querySelector('table tbody tr').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`)
  await until(async () => (await audio()).status === 'playing' && (await audio()).positionSec > 0.5, 'native audio playing')
  const initialAudio = await audio()
  const initialTrack = (await js('window.api.library.tracks()')).find(track => track.path === initialAudio.currentPath)
  assert.ok(initialTrack)
  const initialQueue = await queue()
  assert.equal(initialQueue.trackIds.length, 2)
  await manager()
  await design('classic')
  assert.equal((await audio()).currentPath, initialAudio.currentPath)
  await capture('01-classic-gallery')
  await design('glass')
  assert.equal((await audio()).status, 'playing')
  assert.equal((await audio()).currentPath, initialAudio.currentPath)
  assert.deepEqual((await queue()).trackIds, initialQueue.trackIds)
  assert.ok((await audio()).positionSec >= initialAudio.positionSec)
  await capture('02-glass-gallery')
  pass('Classic and Glass changes preserve real playback, position and queue')

  await click('Crear interfaz', '.if-manager button')
  await until(() => js(`Boolean(document.querySelector('.if-editor'))`), 'visual editor mounted')
  await field('Nombre', 'Interfaz QA')
  await js(`document.querySelector('.if-brief').open=true`)
  await fill('[aria-label="Requisitos de diseño"]', 'Biblioteca QA con navegación propia y tarjetas accesibles.')
  await click('+ Pantalla', '.if-editor-tree button')
  await until(() => js(`document.querySelector('.if-editor-tree').innerText.includes('Pantalla 2')`), 'new screen')
  await fill('[aria-label="Tipo de componente"]', 'tracks')
  await click('+ Agregar', '.if-add-component button')
  assert.equal(await js(`document.querySelectorAll('.if-editor-tree .if-tree-item').length`), 4)
  await click('Deshacer', '.if-editor-toolbar button')
  assert.equal(await js(`document.querySelectorAll('.if-editor-tree .if-tree-item').length`), 3)
  await click('Rehacer', '.if-editor-toolbar button')
  assert.equal(await js(`document.querySelectorAll('.if-editor-tree .if-tree-item').length`), 4)
  await click('Inicio', '.if-editor-tree .if-screen-row button')
  await fill('.if-inline-label select', 'ready')
  await capture('03-editor-tree-preview')
  await sleep(450)
  const draftId = await js(`Object.values(JSON.parse(localStorage.getItem('crate.interfaces.drafts.v1'))).find(pkg=>pkg.manifest.name==='Interfaz QA').manifest.id`)
  assert.ok(draftId)
  await click('Instalar y probar', '.modal-foot button')
  await until(async () => (await selection()).activeId === draftId && (await selection()).trial, 'editor revision installed and provisional')
  await click('Cerrar', '[aria-label^="Cerrar Editor de interfaces"]')
  await click('Conservar', '.if-host-controls button')
  assert.equal((await selection()).trial, false)
  if (await js(`document.querySelector('.if-host-controls')?.innerText.includes('Volver a mi interfaz')`)) await click('Volver a mi interfaz', '.if-host-controls button')
  await until(() => js(`document.querySelector('.if-host-canvas .if-runtime')?.innerText.includes('01 Interface smoke') || document.querySelectorAll('.if-host-canvas .if-album').length>0`), 'declarative interface renders real library')
  assert.equal((await audio()).currentPath, initialAudio.currentPath)
  await capture('04-declarative-real-library')
  pass('Visual editor screen/component operations, undo/redo, autosave, install and confirmation', { draftId })

  win.webContents.reload()
  await until(() => js(`Boolean(document.querySelector('.if-host-canvas .if-runtime'))`), 'confirmed interface restored after renderer reload')
  assert.equal((await selection()).activeId, draftId)
  assert.equal((await selection()).trial, false)
  await until(() => js(`document.querySelector('.if-host-canvas .if-player-info > strong')?.textContent===${JSON.stringify(initialTrack.title)}`), 'playing track metadata restored without restarting audio')
  assert.equal((await audio()).currentPath, initialAudio.currentPath)
  assert.ok((await audio()).positionSec >= initialAudio.positionSec)
  assert.ok(await js(`JSON.parse(localStorage.getItem('crate.interfaces.drafts.v1'))[${JSON.stringify(draftId)}]`))
  pass('Confirmed declarative selection and recoverable draft survive real renderer reload')

  await manager()
  await js(`document.querySelector('.if-drafts').open=true`)
  await click('Continuar', '.if-drafts button')
  await until(() => js(`Boolean(document.querySelector('.if-editor'))`), 'recoverable draft reopened')
  assert.ok(await js(`document.querySelector('.if-editor-tree').innerText.includes('Pantalla 2')`))
  assert.equal(await js(`document.querySelector('[aria-label="Requisitos de diseño"]').value`), 'Biblioteca QA con navegación propia y tarjetas accesibles.')
  await click('Cerrar', '[aria-label^="Cerrar Editor de interfaces"]')
  pass('Recoverable draft reopens its screens in the real editor after reload')
  nextPicker = join(root, 'examples/interfaces/nightdesk.crate-interface')
  await click('Importar', '.if-manager button')
  await until(() => js(`document.querySelector('.if-gallery')?.innerText.includes('Nightdesk')`), 'imported Nightdesk appears in gallery')
  await until(() => js(`document.querySelector('.modal-panel')?.innerText.includes('Activar en prueba')`), 'package capabilities review')
  await click('Activar en prueba', '.modal-foot button')
  await until(async () => (await selection()).activeId === 'nightdesk', 'Nightdesk activated')
  await click('Conservar', '.if-host-controls button')
  if (await js(`document.querySelector('.if-host-controls')?.innerText.includes('Volver a mi interfaz')`)) await click('Volver a mi interfaz', '.if-host-controls button')
  let guest
  await until(() => { guest = webContents.getAllWebContents().find(item => item.getURL().startsWith('crate-interface://')); return Boolean(guest) }, 'programmable guest webContents')
  await until(() => js(`document.querySelectorAll('.track-card').length===2`, guest), 'real library cards in programmed interface')
  assert.deepEqual(await js(`({api:typeof window.api,node:typeof require,sdk:typeof window.crateInterface})`, guest), { api: 'undefined', node: 'undefined', sdk: 'object' })
  const guestTrack = await js(`new Promise((resolve,reject)=>{let off;const timer=setTimeout(()=>{off?.();reject(Error('No current track snapshot'))},5000);off=window.crateInterface.onState(state=>{if(state.playback?.currentTrack){clearTimeout(timer);off?.();resolve(state.playback.currentTrack)}})})`, guest)
  assert.equal(guestTrack.id, initialTrack.id)
  assert.equal(guestTrack.title, initialTrack.title)
  const beforeToggle = await audio()
  await click('Pausar', '#toggle', guest)
  await until(async () => (await audio()).status === 'paused', 'guest playback pause reached the real audio engine')
  await click('Reproducir', '#toggle', guest)
  await until(async () => (await audio()).status === 'playing', 'guest playback resumed')
  assert.equal((await audio()).currentPath, initialAudio.currentPath)
  assert.ok((await audio()).positionSec >= beforeToggle.positionSec)
  const queuePage = await js(`window.crateInterface.request('queue.list',{offset:1,limit:1})`, guest)
  assert.equal(queuePage.items.length, 1)
  assert.equal(queuePage.items[0].id, initialQueue.trackIds[1])
  await click('+ Cola', '.track-card:first-child button', guest)
  await until(async () => (await queue()).trackIds.length === 3, 'guest card added a real queue entry')
  await capture('05-programmed-collection', guest)
  await click('Escuchando', '[data-screen]', guest)
  assert.equal(await js(`document.querySelector('#listening').hidden`, guest), false)
  await capture('06-programmed-listening', guest)
  await click('Cola', '[data-screen]', guest)
  await until(() => js(`document.querySelectorAll('.queue-row').length===3`, guest), 'programmed queue screen')
  await click('Quitar', '.queue-row:last-child button', guest)
  await until(async () => (await queue()).trackIds.length === 2, 'guest queue removal persisted')
  assert.equal((await audio()).currentPath, initialAudio.currentPath)
  assert.equal((await audio()).status, 'playing')
  assert.deepEqual((await queue()).trackIds, initialQueue.trackIds)
  await click('Preferencias', '#settings', guest)
  await until(() => js(`Boolean(document.querySelector('.settings')) && document.querySelector('.if-host-controls')?.innerText.includes('Volver a mi interfaz')`), 'guest navigation opened trusted preferences')
  await click('Volver a mi interfaz', '.if-host-controls button')
  await until(() => js(`!document.querySelector('.if-host-controls')?.innerText.includes('Volver a mi interfaz')`), 'return from preferences to guest')
  pass('UI import review, native package storage, isolated custom component, screens and real queue', { pickerCalls })

  await click('Restaurar diseño incluido', '.if-host-controls button')
  await until(async () => (await selection()).activeId === 'crate-glass', 'builtin recovery')
  await manager()
  win.setSize(900, 600)
  await click('Light', '[role="button"]')
  await until(() => js(`document.body.classList.contains('theme-light')`), 'light theme')
  await js(`document.querySelector('.if-manager').scrollIntoView({block:'start'})`)
  await capture('07-gallery-900-light')
  await click('Dark', '[role="button"]')
  await until(() => js(`!document.body.classList.contains('theme-light')`), 'dark theme')
  await js(`document.querySelector('.if-manager').scrollIntoView({block:'start'})`)
  await capture('08-gallery-900-dark')
  assert.ok(await js(`document.querySelector('.if-gallery').scrollWidth <= document.querySelector('.if-gallery').clientWidth+2`))
  assert.equal((await audio()).status, 'playing')
  pass('Builtin recovery, 900×600 gallery, light/dark and playback remain functional')
  assert.deepEqual(rendererErrors, [], 'The real renderer must not emit console errors')
  await js(`(() => {const card=[...document.querySelectorAll('.if-card')].find(item=>item.querySelector('h4')?.textContent==='Nightdesk');[...card.querySelectorAll('button')].find(item=>item.textContent==='Probar diseño').click()})()`)
  await until(() => js(`document.querySelector('.modal-panel')?.innerText.includes('Activar en prueba')`), 'Nightdesk reviewed for cold restart')
  await click('Activar en prueba', '.modal-foot button')
  await until(async () => (await selection()).activeId === 'nightdesk', 'Nightdesk reactivated for restart')
  await click('Conservar', '.if-host-controls button')
  assert.equal((await selection()).trial, false)
  pass('Confirmed programmed selection prepared for a separate cold process')
  writeFileSync(join(evidence, resultName), JSON.stringify({ passed: true, steps, rendererErrors }, null, 2))
  console.log(`PASS: all ${steps.length} actual UI smoke stages completed`)
  app.quit()
  }
} catch (error) {
  console.error(error)
  try {
    if (win && !win.isDestroyed()) {
      await capture('failure-host')
      writeFileSync(join(evidence, 'failure-dom.txt'), await js('document.body.innerText'))
    }
    for (const [index, guest] of webContents.getAllWebContents().filter(item => item.getURL().startsWith('crate-interface://')).entries()) await capture(`failure-guest-${index}`, guest)
  } catch (captureError) { console.error('Failure capture:', captureError.message) }
  writeFileSync(join(evidence, resultName), JSON.stringify({ passed: false, error: error.stack, steps, rendererErrors }, null, 2))
  app.exit(1)
}
