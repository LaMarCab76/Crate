import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const directory = mkdtempSync(join(tmpdir(), 'crate-interface-smoke-'))
try {
  const mainPath = join(directory, 'runtime.mjs')
  const preloadPath = join(directory, 'guest.cjs')
  await build({ entryPoints: [fileURLToPath(new URL('./runtime.smoke.ts', import.meta.url))], outfile: mainPath, bundle: true, platform: 'node', format: 'esm', external: ['electron'], logLevel: 'warning' })
  await build({ entryPoints: [fileURLToPath(new URL('../../preload/interface-guest.ts', import.meta.url))], outfile: preloadPath, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'warning' })
  const env = { ...process.env, CRATE_INTERFACE_SMOKE_DIR: directory, CRATE_INTERFACE_SMOKE_PRELOAD: preloadPath }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [mainPath], { env, stdio: 'inherit' })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 45_000)
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (status, signal) => { if (status !== 0) console.error(`Interface smoke Electron exited: status=${status} signal=${signal}`); resolve(status) }) })
  clearTimeout(timeout)
  process.exitCode = typeof code === 'number' ? code : 1
} finally { rmSync(directory, { recursive: true, force: true }) }
