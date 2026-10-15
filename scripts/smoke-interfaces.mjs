#!/usr/bin/env node
// Actual built Electron application, isolated catalog, real preload and IPC.
// Run after npm run build. Screenshots/results survive under the printed path.
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
if (!existsSync(join(root, 'out/main/index.js'))) throw new Error('Run npm run build before the interface UI smoke.')
const profile = mkdtempSync(join(tmpdir(), 'crate-interface-ui-profile-'))
const evidence = mkdtempSync('/private/tmp/crate-interface-ui-evidence-')
// Keeping only this tiny bootstrap in the project root makes app.getAppPath()
// resolve native/libs exactly as in normal development. Main itself is never
// bundled or copied, so relative native and preload paths remain authentic.
const bootstrap = join(root, `.crate-ui-smoke-${process.pid}.mjs`)
let child
function silentWav(path) {
  const rate = 44_100, seconds = 240, size = rate * seconds * 2
  const data = Buffer.alloc(44 + size)
  data.write('RIFF', 0); data.writeUInt32LE(size + 36, 4); data.write('WAVEfmt ', 8)
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22)
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34)
  data.write('data', 36); data.writeUInt32LE(size, 40)
  writeFileSync(path, data)
}
try {
  const music = join(profile, 'Music')
  mkdirSync(music)
  silentWav(join(music, '01 Interface smoke.wav'))
  silentWav(join(music, '02 Playback preservation.wav'))
  writeFileSync(bootstrap, `await import(${JSON.stringify(pathToFileURL(join(root, 'out/main/index.js')).href)});\nvoid import(${JSON.stringify(pathToFileURL(join(root, 'scripts/smoke-interfaces-runner.mjs')).href)});\n`)
  const env = { ...process.env, CRATE_USER_DATA_DIR: join(profile, 'userData'), CRATE_UI_SMOKE_PROFILE: profile, CRATE_UI_SMOKE_EVIDENCE: evidence, CRATE_UI_SMOKE_ROOT: root }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  for (const restart of [false, true]) {
    child = spawn(require('electron'), [bootstrap], { cwd: root, env: { ...env, CRATE_UI_SMOKE_RESTART: restart ? '1' : '0' }, stdio: 'inherit' })
    const timeout = setTimeout(() => { console.error('Interface UI smoke exceeded its 150 second process deadline.'); child.kill('SIGKILL') }, 150_000)
    const code = await new Promise((resolveCode, reject) => { child.once('error', reject); child.once('exit', value => resolveCode(value)) })
    clearTimeout(timeout)
    process.exitCode = typeof code === 'number' ? code : 1
    if (process.exitCode !== 0) break
  }
} finally {
  if (child && child.exitCode === null) child.kill('SIGKILL')
  rmSync(bootstrap, { force: true })
  rmSync(profile, { recursive: true, force: true })
  console.log(`Interface UI evidence: ${evidence}`)
}
