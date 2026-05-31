import { strict as assert } from 'node:assert'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { scanRockboxThemes } from './RockboxThemeScanner.ts'

function tempDevice() {
  return mkdtempSync(join(tmpdir(), 'crate-rockbox-scan-'))
}

function cleanup(path) {
  rmSync(path, { recursive: true, force: true })
}

test('lists valid direct Rockbox theme cfg files', async () => {
  const root = tempDevice()
  try {
    mkdirSync(join(root, '.rockbox', 'themes'), { recursive: true })
    mkdirSync(join(root, '.rockbox', 'wps'), { recursive: true })
    mkdirSync(join(root, '.rockbox', 'fonts'), { recursive: true })
    mkdirSync(join(root, '.rockbox', 'backdrops'), { recursive: true })
    writeFileSync(join(root, '.rockbox', 'wps', 'Foo.wps'), '')
    writeFileSync(join(root, '.rockbox', 'wps', 'Foo.sbs'), '')
    writeFileSync(join(root, '.rockbox', 'fonts', '08-Foo.fnt'), '')
    writeFileSync(join(root, '.rockbox', 'backdrops', 'Foo.bmp'), '')
    writeFileSync(join(root, '.rockbox', 'themes', 'Foo.cfg'), [
      'wps: "/.rockbox/wps/Foo.wps"',
      'sbs: .rockbox/wps/Foo.sbs',
      'font: "/.rockbox/fonts/08-Foo.fnt"',
      'backdrop: /.rockbox/backdrops/Foo.bmp',
      'iconset: /.rockbox/icons/Missing.icons',
    ].join('\n'))

    const result = await scanRockboxThemes(root)

    assert.equal(result.scan.status, 'ok')
    assert.equal(result.scan.message, null)
    assert.equal(result.themes.length, 1)
    assert.equal(result.themes[0].name, 'Foo')
    assert.equal(result.themes[0].configPath, 'themes/Foo.cfg')
    assert.equal(result.themes[0].wpsPath, 'wps/Foo.wps')
    assert.equal(result.themes[0].sbsPath, 'wps/Foo.sbs')
    assert.equal(result.themes[0].font, 'fonts/08-Foo.fnt')
    assert.equal(result.themes[0].backdropPath, 'backdrops/Foo.bmp')
    assert.equal(result.themes[0].fileCount, 5)
    assert.deepEqual(result.themes[0].missingFiles, ['icons/Missing.icons'])
  } finally {
    cleanup(root)
  }
})

test('reports a missing Rockbox themes directory', async () => {
  const root = tempDevice()
  try {
    mkdirSync(join(root, '.rockbox'), { recursive: true })

    const result = await scanRockboxThemes(root)

    assert.equal(result.scan.status, 'no-themes-dir')
    assert.equal(result.themes.length, 0)
    assert.match(result.scan.message ?? '', /\.rockbox\/themes/)
  } finally {
    cleanup(root)
  }
})

test('reports misplaced cfg files without counting them as themes', async () => {
  const root = tempDevice()
  try {
    mkdirSync(join(root, '.rockbox', 'themes'), { recursive: true })
    mkdirSync(join(root, '.rockbox', '.rockbox', 'themes'), { recursive: true })
    mkdirSync(join(root, '.rockbox', 'wrapped-theme', 'themes'), { recursive: true })
    writeFileSync(join(root, '.rockbox', '.rockbox', 'themes', 'Nested.cfg'), '')
    writeFileSync(join(root, '.rockbox', 'wrapped-theme', 'themes', 'Wrapped.cfg'), '')

    const result = await scanRockboxThemes(root)

    assert.equal(result.scan.status, 'ok')
    assert.equal(result.themes.length, 0)
    assert.deepEqual(result.scan.misplacedConfigPaths, [
      '.rockbox/.rockbox/themes/Nested.cfg',
      '.rockbox/wrapped-theme/themes/Wrapped.cfg',
    ])
  } finally {
    cleanup(root)
  }
})

test('ignores macOS AppleDouble metadata files when listing themes', async () => {
  const root = tempDevice()
  try {
    mkdirSync(join(root, '.rockbox', 'themes'), { recursive: true })
    mkdirSync(join(root, '.rockbox', 'wps'), { recursive: true })
    mkdirSync(join(root, '.rockbox', '__MACOSX', 'themes'), { recursive: true })
    writeFileSync(join(root, '.rockbox', 'wps', 'Foo.wps'), '')
    writeFileSync(join(root, '.rockbox', 'wps', '._Foo.wps'), 'metadata')
    writeFileSync(join(root, '.rockbox', 'themes', 'Foo.cfg'), 'wps: /.rockbox/wps/Foo.wps\n')
    writeFileSync(join(root, '.rockbox', 'themes', '._Foo.cfg'), 'metadata')
    writeFileSync(join(root, '.rockbox', 'themes', '.DS_Store'), 'metadata')
    writeFileSync(join(root, '.rockbox', '__MACOSX', 'themes', 'Wrapped.cfg'), '')

    const result = await scanRockboxThemes(root)

    assert.equal(result.scan.status, 'ok')
    assert.equal(result.themes.length, 1)
    assert.equal(result.themes[0].name, 'Foo')
    assert.equal(result.themes[0].fileCount, 2)
    assert.deepEqual(result.scan.misplacedConfigPaths, [])
  } finally {
    cleanup(root)
  }
})

test('treats Rockbox dash path values as disabled rather than missing files', async () => {
  const root = tempDevice()
  try {
    mkdirSync(join(root, '.rockbox', 'themes'), { recursive: true })
    mkdirSync(join(root, '.rockbox', 'wps'), { recursive: true })
    writeFileSync(join(root, '.rockbox', 'wps', 'Foo.wps'), '')
    writeFileSync(join(root, '.rockbox', 'themes', 'Foo.cfg'), [
      'wps: /.rockbox/wps/Foo.wps',
      'iconset: -',
      'viewers iconset: -',
      'backdrop: -',
    ].join('\n'))

    const result = await scanRockboxThemes(root)

    assert.equal(result.themes.length, 1)
    assert.equal(result.themes[0].iconsetPath, null)
    assert.equal(result.themes[0].viewerIconsetPath, null)
    assert.equal(result.themes[0].backdropPath, null)
    assert.deepEqual(result.themes[0].missingFiles, [])
  } finally {
    cleanup(root)
  }
})

test('reports unreadable themes directories where permissions allow it', async t => {
  if (process.platform === 'win32') {
    t.skip('chmod-based unreadable directory checks are not stable on Windows')
    return
  }

  const root = tempDevice()
  const themesRoot = join(root, '.rockbox', 'themes')
  try {
    mkdirSync(themesRoot, { recursive: true })
    chmodSync(themesRoot, 0)

    const result = await scanRockboxThemes(root)

    assert.equal(result.scan.status, 'unreadable')
    assert.equal(result.themes.length, 0)
  } finally {
    chmodSync(themesRoot, 0o700)
    cleanup(root)
  }
})
