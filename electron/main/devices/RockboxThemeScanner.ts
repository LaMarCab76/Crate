import { existsSync } from 'node:fs'
import { lstat, readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const ROCKBOX_DIR = '.rockbox'
const THEME_CONFIG_EXTENSION = '.cfg'
const SHALLOW_SCAN_DEPTH = 4

export type RockboxThemeScanStatus = 'ok' | 'no-rockbox' | 'no-themes-dir' | 'unreadable'

export interface RockboxThemeSummary {
  id: string
  name: string
  configPath: string
  wpsPath: string | null
  sbsPath: string | null
  fmsPath: string | null
  font: string | null
  updatedAt: string | null
}

export interface RockboxThemeScanDiagnostic {
  status: RockboxThemeScanStatus
  message: string | null
  themesPath: string
  misplacedConfigPaths: string[]
}

export interface RockboxThemeScanResult {
  themes: RockboxThemeSummary[]
  scan: RockboxThemeScanDiagnostic
}

function toPosixRelative(root: string, absPath: string): string {
  return relative(root, absPath).split(sep).join('/')
}

function fromPosix(root: string, relPath: string): string {
  return join(root, ...relPath.split('/').filter(Boolean))
}

function keyForRelativePath(relPath: string): string {
  return relPath
    .split('/')
    .filter(Boolean)
    .join('/')
    .normalize('NFC')
    .toLowerCase()
}

function idForValue(value: string): string {
  return keyForRelativePath(value).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item'
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function normalizeRockboxConfigPath(value: string): string {
  const normalized = value.split('\\').join('/').replace(/^\/+/, '')
  return normalized.replace(/^\.rockbox\//i, '')
}

function themeConfigValue(config: string, key: string): string | null {
  const pattern = new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, 'im')
  const match = config.match(pattern)
  return match?.[1]?.replace(/^"|"$/g, '').trim() || null
}

function themeConfigPath(rockboxRoot: string, config: string, key: string, fallback: string | null): string | null {
  const raw = themeConfigValue(config, key)
  const candidates = [
    raw ? normalizeRockboxConfigPath(raw) : null,
    fallback,
  ].filter((value): value is string => Boolean(value))

  for (const relPath of candidates) {
    const absolute = fromPosix(rockboxRoot, relPath)
    if (isInside(rockboxRoot, resolve(absolute)) && existsSync(absolute)) return relPath
  }

  return raw && key === 'font' ? normalizeRockboxConfigPath(raw) : null
}

async function isDirectory(path: string): Promise<boolean | null> {
  try {
    return (await lstat(path)).isDirectory()
  } catch (err) {
    const code = (err as { code?: unknown }).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    return null
  }
}

function isDirectThemeConfig(rockboxRelativePath: string): boolean {
  const parts = rockboxRelativePath.split('/').filter(Boolean)
  return parts.length === 2 &&
    parts[0].toLowerCase() === 'themes' &&
    extname(parts[1]).toLowerCase() === THEME_CONFIG_EXTENSION
}

function looksLikeMisplacedThemeConfig(rockboxRelativePath: string): boolean {
  const parts = rockboxRelativePath.split('/').filter(Boolean)
  if (parts.length < 2 || extname(parts.at(-1) ?? '').toLowerCase() !== THEME_CONFIG_EXTENSION) return false
  if (isDirectThemeConfig(rockboxRelativePath)) return false
  return parts.slice(0, -1).some(part => part.toLowerCase() === 'themes')
}

async function findMisplacedConfigPaths(rockboxRoot: string): Promise<string[]> {
  const root = resolve(rockboxRoot)
  const out = new Set<string>()

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > SHALLOW_SCAN_DEPTH) return

    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (entry.name === '__MACOSX' || entry.name === '.DS_Store') continue
      const full = resolve(dir, entry.name)
      if (!isInside(root, full)) continue

      if (entry.isDirectory()) {
        await walk(full, depth + 1)
      } else if (entry.isFile()) {
        const rel = toPosixRelative(root, full)
        if (looksLikeMisplacedThemeConfig(rel)) out.add(`${ROCKBOX_DIR}/${rel}`)
      }
    }
  }

  await walk(root, 0)
  return [...out].sort((a, b) => a.localeCompare(b))
}

function diagnostic(
  status: RockboxThemeScanStatus,
  themesPath: string,
  misplacedConfigPaths: string[],
  message: string | null,
): RockboxThemeScanDiagnostic {
  return { status, message, themesPath, misplacedConfigPaths }
}

export async function scanRockboxThemes(deviceRoot: string): Promise<RockboxThemeScanResult> {
  const rootPath = resolve(deviceRoot)
  const rockboxRoot = join(rootPath, ROCKBOX_DIR)
  const themesRoot = join(rockboxRoot, 'themes')

  const rockboxState = await isDirectory(rockboxRoot)
  if (rockboxState !== true) {
    return {
      themes: [],
      scan: diagnostic(
        rockboxState === false ? 'no-rockbox' : 'unreadable',
        themesRoot,
        [],
        rockboxState === false
          ? `No existe ${ROCKBOX_DIR} en este dispositivo.`
          : `No se pudo leer ${ROCKBOX_DIR}: permisos insuficientes o volumen inaccesible.`,
      ),
    }
  }

  const misplacedConfigPaths = await findMisplacedConfigPaths(rockboxRoot)
  const themesState = await isDirectory(themesRoot)
  if (themesState !== true) {
    return {
      themes: [],
      scan: diagnostic(
        themesState === false ? 'no-themes-dir' : 'unreadable',
        themesRoot,
        misplacedConfigPaths,
        themesState === false
          ? `No existe ${ROCKBOX_DIR}/themes. Rockbox solo lista themes desde archivos .cfg en esa carpeta.`
          : `No se pudo leer ${ROCKBOX_DIR}/themes: permisos insuficientes o volumen inaccesible.`,
      ),
    }
  }

  let entries
  try {
    entries = await readdir(themesRoot, { withFileTypes: true })
  } catch (err) {
    return {
      themes: [],
      scan: diagnostic(
        'unreadable',
        themesRoot,
        misplacedConfigPaths,
        `No se pudo listar ${ROCKBOX_DIR}/themes: ${errorMessage(err)}`,
      ),
    }
  }

  const themes: RockboxThemeSummary[] = []
  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== THEME_CONFIG_EXTENSION) continue
    const configPath = join(themesRoot, entry.name)
    const name = basename(entry.name, THEME_CONFIG_EXTENSION)
    let config = ''
    try {
      config = await readFile(configPath, 'utf8')
    } catch {
      /* still show unreadable cfg files */
    }
    const configStat = await stat(configPath).catch(() => null)
    themes.push({
      id: idForValue(name),
      name,
      configPath: `themes/${entry.name}`,
      wpsPath: themeConfigPath(rockboxRoot, config, 'wps', `wps/${name}.wps`),
      sbsPath: themeConfigPath(rockboxRoot, config, 'sbs', `wps/${name}.sbs`),
      fmsPath: themeConfigPath(rockboxRoot, config, 'fms', `wps/${name}.fms`),
      font: themeConfigPath(rockboxRoot, config, 'font', null),
      updatedAt: configStat?.mtime.toISOString() ?? null,
    })
  }

  const sortedThemes = themes.sort((a, b) => a.name.localeCompare(b.name))
  return {
    themes: sortedThemes,
    scan: diagnostic(
      'ok',
      themesRoot,
      misplacedConfigPaths,
      sortedThemes.length === 0
        ? `La carpeta ${ROCKBOX_DIR}/themes se pudo leer, pero no contiene archivos .cfg directos.`
        : null,
    ),
  }
}
