#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
for (const script of ['verify-bass.mjs', 'verify-chromaprint.mjs']) {
  const result = spawnSync(process.execPath, [join(scriptDirectory, script), ...process.argv.slice(2)], { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
