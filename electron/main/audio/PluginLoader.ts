import { app } from 'electron'
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadBass } from './bass-ffi'
import { bassErrorName } from './bass-constants'

// All BASS decoder plugins we want to enable. Bass core itself handles MP3,
// MP4/AAC, WAV, AIFF, OGG Vorbis natively. The plugins below add the rest.
const KNOWN_PLUGINS = [
  'libbassflac.dylib',
  'libbassopus.dylib',
  'libbasswebm.dylib',
  'libbasswv.dylib',
  'libbassape.dylib',
  'libbassdsd.dylib',
  'libbassmidi.dylib',
  'libbass_mpc.dylib',
  'libbass_spx.dylib',
  'libbass_tta.dylib',
  'libbasshls.dylib',
]

function libsDir(): string {
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
  return join(base, 'native', 'libs')
}

export interface PluginLoadResult {
  loaded: string[]
  skipped: Array<{ name: string; reason: string }>
}

export function loadAllPlugins(): PluginLoadResult {
  const bass = loadBass()
  const result: PluginLoadResult = { loaded: [], skipped: [] }
  const dir = libsDir()

  for (const name of KNOWN_PLUGINS) {
    const path = join(dir, name)
    if (!existsSync(path)) {
      result.skipped.push({ name, reason: 'missing' })
      continue
    }
    const handle = bass.PluginLoad(path, 0)
    if (handle === 0) {
      const code = bass.ErrorGetCode()
      result.skipped.push({ name, reason: bassErrorName(code) })
      continue
    }
    result.loaded.push(name)
  }

  // Also auto-load any other libbass*.dylib we ship that wasn't in the list
  // above (e.g. format plugins added later — we ignore non-decoder plugins
  // like libbass_fx since that one is loaded explicitly by EQManager).
  try {
    for (const entry of readdirSync(dir)) {
      if (!entry.startsWith('libbass')) continue
      if (entry === 'libbass.dylib' || entry === 'libbass_fx.dylib') continue
      if (entry === 'libbass_vst.dylib') continue
      if (KNOWN_PLUGINS.includes(entry)) continue
      const path = join(dir, entry)
      const handle = bass.PluginLoad(path, 0)
      if (handle !== 0) result.loaded.push(entry)
      else result.skipped.push({ name: entry, reason: bassErrorName(bass.ErrorGetCode()) })
    }
  } catch {
    // dir may not exist in some build configs; nothing to do
  }

  return result
}
