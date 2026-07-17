import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const VERIFY_SCRIPT = join(SCRIPT_DIR, 'verify-bass.mjs')
const BASES = [
  'bass', 'bass_fx', 'bassflac', 'bassopus', 'basswebm', 'basswv', 'bassape',
  'bassdsd', 'bassmidi', 'basshls', 'bass_mpc', 'bass_spx', 'bass_tta',
]

const TARGETS = {
  darwin: { name: (base) => `lib${base}.dylib`, magic: Buffer.from('feedfacf', 'hex') },
  linux: { name: (base) => `lib${base}.so`, magic: Buffer.from([0x7f, 0x45, 0x4c, 0x46]) },
  win32: { name: (base) => `${base}.dll`, magic: Buffer.from('MZ') },
}

async function fixture(platform, omitBase) {
  const directory = await mkdtemp(join(tmpdir(), `crate-bass-${platform}-`))
  const target = TARGETS[platform]
  for (const base of BASES) {
    if (base === omitBase) continue
    const bytes = Buffer.alloc(4096)
    target.magic.copy(bytes)
    await writeFile(join(directory, target.name(base)), bytes)
  }
  return directory
}

function verify(platform, directory) {
  return spawnSync(process.execPath, [VERIFY_SCRIPT, `--platform=${platform}`, `--dir=${directory}`], {
    encoding: 'utf8',
  })
}

for (const platform of Object.keys(TARGETS)) {
  test(`verifies the complete ${platform} BASS package`, async () => {
    const directory = await fixture(platform)
    try {
      const result = verify(platform, directory)
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /13 binaries present and valid/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
}

test('fails when a required decoder plugin is missing', async () => {
  const directory = await fixture('linux', 'bassflac')
  try {
    const result = verify('linux', directory)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /libbassflac\.so/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
