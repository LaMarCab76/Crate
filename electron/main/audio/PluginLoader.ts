import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadBass } from './bass-ffi'
import { bassErrorName } from './bass-constants'
import { bassLibExtension, bassLibFileName, nativeLibsDir } from './bass-paths'

// All BASS decoder plugins we want to enable. Bass core itself handles MP3,
// MP4/AAC, WAV, AIFF, OGG Vorbis natively. The plugins below add the rest.
// The set and its order are derived from HiFidelity by Varun Rathod
// (BASSAudioEngine.swift, Apache-2.0, see licenses/HiFidelity-Apache-2.0.txt).
const KNOWN_PLUGIN_BASES = [
  'bassflac',
  'bassopus',
  'basswebm',
  'basswv',
  'bassape',
  'bassdsd',
  'bassmidi',
  'bass_mpc',
  'bass_spx',
  'bass_tta',
  'basshls',
]

function isBassPluginFile(entry: string): boolean {
  const stem = process.platform === 'win32' ? entry : entry.replace(/^lib/, '')
  return stem.startsWith('bass')
}

export interface PluginLoadResult {
  loaded: string[]
  skipped: Array<{ name: string; reason: string }>
}

export function loadAllPlugins(): PluginLoadResult {
  const bass = loadBass()
  const result: PluginLoadResult = { loaded: [], skipped: [] }
  const dir = nativeLibsDir()
  const knownNames = KNOWN_PLUGIN_BASES.map(bassLibFileName)

  for (const name of knownNames) {
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

  // Also auto-load any other platform BASS decoder plugin we ship. Core,
  // bass_fx (loaded by EQManager), and bass_vst are intentionally excluded.
  const ext = bassLibExtension()
  const skipNames = new Set([
    bassLibFileName('bass'),
    bassLibFileName('bass_fx'),
    bassLibFileName('bass_vst'),
    ...knownNames,
  ])
  try {
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(ext)) continue
      if (skipNames.has(entry)) continue
      if (!isBassPluginFile(entry)) continue
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
