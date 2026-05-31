import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const settingsSource = readFileSync(new URL('../views/SettingsView.tsx', import.meta.url), 'utf8')
const sidebarSource = readFileSync(new URL('../components/Sidebar.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../styles/globals.css', import.meta.url), 'utf8')

test('settings tabs live in the top chrome with device-style icons', () => {
  assert.ok(appSource.includes('function SettingsSectionTabs'), 'App should own the Settings top tabs')
  assert.ok(appSource.includes('className="device-section-tabs settings-section-tabs"'), 'Settings tabs should reuse the device tab row')
  assert.ok(appSource.includes("icon: 'moon'"), 'Apariencia tab should render an icon')
  assert.ok(appSource.includes("icon: 'play'"), 'Reproduccion tab should render an icon')
  assert.ok(appSource.includes("icon: 'folder'"), 'Bibliotecas tab should render an icon')
  assert.ok(appSource.includes("icon: 'sync'"), 'Actualizaciones tab should render an icon')
  assert.ok(appSource.includes('SETTINGS_PLAYBACK_SUBTABS'), 'Playback subtabs should be rendered from App')
})

test('settings view no longer owns internal nav or device settings', () => {
  assert.ok(settingsSource.includes("export type SettingsMainTab = 'apariencia' | 'reproduccion' | 'bibliotecas' | 'actualizaciones'"))
  assert.ok(!settingsSource.includes("'dispositivos'"), 'Preferencias should not include a Dispositivos tab')
  assert.ok(!settingsSource.includes('Almacenamiento local'), 'Almacenamiento local should be renamed')
  assert.ok(settingsSource.includes('<h2>Bibliotecas</h2>'), 'Bibliotecas section should replace local storage')
  assert.ok(!settingsSource.includes('settings-nav'), 'SettingsView should not render the old internal tab nav')
  assert.ok(!settingsSource.includes('Default device artwork limit'), 'Device-specific defaults should not live in Preferences')
})

test('libraries section classifies local libraries and MP3 volumes', () => {
  assert.ok(settingsSource.includes('function LibraryVolumeClassificationPanel'), 'Bibliotecas should include volume classification')
  assert.ok(settingsSource.includes('Rutas de MP3 y volúmenes'), 'Bibliotecas should show MP3 and volume routes')
  assert.ok(settingsSource.includes('No hay MP3 vinculados.'), 'Linked MP3 routes should be shown separately')
  assert.ok(settingsSource.includes('No hay MP3 candidatos.'), 'Detected MP3 candidates should be shown separately')
  assert.ok(settingsSource.includes('Volúmenes sin clasificar'), 'Unknown volumes should be shown in Bibliotecas')
  assert.ok(settingsSource.includes('Biblioteca'), 'Unknown volumes should support adding as a library')
  assert.ok(settingsSource.includes('Ignorar'), 'Unknown volumes should support ignore from Bibliotecas')
})

test('updates section exposes GitHub release controls', () => {
  assert.ok(settingsSource.includes('function UpdatesSection'), 'Preferences should include an updates section')
  assert.ok(settingsSource.includes('<h2>Actualizaciones</h2>'), 'Updates should live in its own Settings tab')
  assert.ok(settingsSource.includes('window.api.updates.checkNow'), 'Updates section should allow manual checks')
  assert.ok(settingsSource.includes('window.api.updates.download'), 'Updates section should allow downloads')
  assert.ok(settingsSource.includes('window.api.updates.install'), 'Updates section should allow install restart')
  assert.ok(css.includes('.update-card'), 'Updates section should be styled')
})

test('sidebar and volume prompt route users to the new homes', () => {
  assert.ok(sidebarSource.includes("const addDevice = () => setView({ kind: 'devices' })"), 'Sidebar add-device action should open Devices')
  assert.ok(!sidebarSource.includes("label=\"Ajustes de dispositivos\" onClick={() => setView({ kind: 'settings' })}"), 'Sidebar should not send device settings to Preferences')
  assert.ok(appSource.includes('Clasificalo desde Preferencias &gt; Bibliotecas.'), 'Global volume prompt should defer classification')
  assert.ok(appSource.includes('onReviewLibraries'), 'Global volume prompt should navigate to Bibliotecas')
  assert.ok(!appSource.includes('onOpenDevice'), 'Global volume prompt should not connect MP3s directly')
})

test('old settings tab styles were removed from the stylesheet', () => {
  assert.ok(!/\.settings-nav\b/.test(css), 'Old settings nav CSS should not linger')
  assert.ok(/\.library-volumes-panel\s*\{/.test(css), 'Bibliotecas volume panel should be styled')
  assert.ok(/\.library-volumes-panel \.device-settings-row\s*\{/.test(css), 'Bibliotecas volume rows should use fixed grid styling')
})
