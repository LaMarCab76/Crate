#!/usr/bin/env node
import { createRequire } from 'node:module'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const electronExecutable = require('electron')
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

async function collect(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await collect(path))
    else if (entry.isFile() && entry.name.endsWith('.integration.ts')) files.push(path)
  }
  return files
}

const files = await collect(join(root, 'electron'))
if (files.length === 0) throw new Error('No Electron integration tests were found')

const result = spawnSync(electronExecutable, ['--experimental-strip-types', '--test', ...files], {
  cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
