import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import type {
  RockboxThemePreview,
  RockboxThemePreviewAlbumArtLayer,
  RockboxThemePreviewBarLayer,
  RockboxThemePreviewImageLayer,
  RockboxThemePreviewLayer,
  RockboxThemePreviewRectLayer,
  RockboxThemePreviewTextLayer,
} from '@shared/types/device-sync'
import { isRockboxIgnoredRelativePath } from './rockboxIgnoredFiles.ts'

const DEFAULT_WIDTH = 320
const DEFAULT_HEIGHT = 240
const DEFAULT_BACKGROUND = '000000'
const DEFAULT_FOREGROUND = 'ffffff'
const MAX_PREVIEW_LAYERS = 90

interface BmpInfo {
  width: number
  height: number
}

interface LoadedImage {
  id: string
  path: string
  x: number
  y: number
  nimages: number
  info: BmpInfo | null
}

interface Viewport {
  x: number
  y: number
  width: number
  height: number
  fontId: string
  foregroundColor: string
}

interface AlbumArtSlot {
  x: number
  y: number
  width: number
  height: number
}

interface ParseState {
  rockboxRoot: string
  themeName: string
  wpsPath: string | null
  width: number
  height: number
  backgroundColor: string
  foregroundColor: string
  currentViewport: Viewport
  loadedImages: Map<string, LoadedImage>
  layers: RockboxThemePreviewLayer[]
  referencedPaths: Set<string>
  warnings: string[]
  albumArtSlot: AlbumArtSlot | null
  imageInfoCache: Map<string, BmpInfo | null>
}

export interface RockboxThemePreviewResult {
  preview: RockboxThemePreview
  referencedPaths: string[]
}

function fallbackPreview(configValues: Record<string, string> = {}): RockboxThemePreview {
  return {
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    backgroundColor: sanitizeHexColor(configValues['background color']) ?? DEFAULT_BACKGROUND,
    foregroundColor: sanitizeHexColor(configValues['foreground color']) ?? DEFAULT_FOREGROUND,
    layers: [],
    warnings: [],
  }
}

function splitArgs(value: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: string | null = null

  for (const char of value) {
    if ((char === '"' || char === "'") && (quote === null || quote === char)) {
      quote = quote === char ? null : char
      continue
    }
    if (char === ',' && quote === null) {
      out.push(current.trim())
      current = ''
      continue
    }
    current += char
  }

  out.push(current.trim())
  return out
}

function sanitizeHexColor(value: string | null | undefined): string | null {
  const raw = value?.trim().replace(/^#/, '').toLowerCase()
  return raw && /^[0-9a-f]{6}$/.test(raw) ? raw : null
}

function normalizeRockboxPath(value: string): string | null {
  const cleaned = value
    .trim()
    .replace(/^["']|["']$/g, '')
    .split('\\')
    .join('/')
    .replace(/^\/+/, '')
    .replace(/^\.rockbox\//i, '')

  if (!cleaned || cleaned.includes('\u0000')) return null
  const parts = cleaned.split('/').filter(Boolean)
  if (parts.some(part => part === '.' || part === '..')) return null
  const normalized = parts.join('/')
  if (isRockboxIgnoredRelativePath(normalized)) return null
  return normalized
}

function fromPosix(root: string, relPath: string): string {
  return join(root, ...relPath.split('/').filter(Boolean))
}

function resolveImagePath(state: ParseState, rawPath: string): string | null {
  const normalized = normalizeRockboxPath(rawPath)
  if (!normalized) return null

  const candidates = normalized.includes('/')
    ? [normalized]
    : [`wps/${state.themeName}/${normalized}`, `wps/${normalized}`]

  for (const candidate of candidates) {
    const full = resolve(fromPosix(state.rockboxRoot, candidate))
    const root = resolve(state.rockboxRoot)
    if (full !== root && !full.startsWith(`${root}/`)) continue
    if (existsSync(full)) return candidate
  }

  return candidates[0] ?? null
}

function readBmpInfo(buffer: Buffer): BmpInfo | null {
  if (buffer.length < 26 || buffer.toString('ascii', 0, 2) !== 'BM') return null
  const width = Math.abs(buffer.readInt32LE(18))
  const height = Math.abs(buffer.readInt32LE(22))
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return { width, height }
}

async function imageInfo(state: ParseState, relPath: string): Promise<BmpInfo | null> {
  if (state.imageInfoCache.has(relPath)) return state.imageInfoCache.get(relPath) ?? null
  try {
    const buffer = await readFile(fromPosix(state.rockboxRoot, relPath))
    const info = readBmpInfo(buffer)
    state.imageInfoCache.set(relPath, info)
    return info
  } catch {
    state.imageInfoCache.set(relPath, null)
    return null
  }
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value == null || value === '' || value === '-') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function resolveCoordinate(value: string | undefined, size: number, fallback: number): number {
  const parsed = parseNumber(value, fallback)
  return parsed < 0 ? Math.max(0, size + parsed) : parsed
}

function resolveLength(value: string | undefined, origin: number, size: number, fallback: number): number {
  if (value == null || value === '' || value === '-') return Math.max(1, size - origin)
  return Math.max(1, parseNumber(value, fallback))
}

function layerId(state: ParseState, prefix: string): string {
  return `${prefix}-${state.layers.length + 1}`
}

function pushLayer(state: ParseState, layer: RockboxThemePreviewLayer): void {
  if (state.layers.length >= MAX_PREVIEW_LAYERS) return
  state.layers.push(layer)
}

function overlapRatio(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): number {
  const x = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const y = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  const intersection = x * y
  const smaller = Math.min(a.width * a.height, b.width * b.height)
  return smaller > 0 ? intersection / smaller : 0
}

function layerBounds(state: ParseState, x: number, y: number, width: number, height: number): void {
  state.width = Math.max(state.width, Math.ceil(x + width))
  state.height = Math.max(state.height, Math.ceil(y + height))
}

function fontSizeFor(viewport: Viewport): number {
  return Math.max(7, Math.min(18, Math.round(viewport.height * 0.72)))
}

function parseAlign(line: string): 'left' | 'center' | 'right' {
  if (line.includes('%ar')) return 'right'
  if (line.includes('%ac')) return 'center'
  return 'left'
}

function viewportForArgs(state: ParseState, args: string[], offset = 0): Viewport {
  const x = resolveCoordinate(args[offset], state.width, 0)
  const y = resolveCoordinate(args[offset + 1], state.height, 0)
  const width = resolveLength(args[offset + 2], x, state.width, state.width)
  const height = resolveLength(args[offset + 3], y, state.height, 14)
  return {
    x,
    y,
    width,
    height,
    fontId: args[offset + 4] || '-',
    foregroundColor: state.currentViewport.foregroundColor,
  }
}

function extractCalls(line: string, tag: string): string[] {
  const calls: string[] = []
  const parenPattern = new RegExp(`%${tag}\\(([^)]*)\\)`, 'g')
  let match: RegExpExecArray | null
  while ((match = parenPattern.exec(line))) calls.push(match[1] ?? '')

  const pipePattern = new RegExp(`%${tag}\\|([^\\n]+?)\\|`, 'g')
  while ((match = pipePattern.exec(line))) calls.push((match[1] ?? '').split('|').join(','))
  return calls
}

function branchFromConditional(line: string, tag: string, index: number): string | null {
  const start = line.indexOf(`%?${tag}<`)
  if (start < 0) return null
  const bodyStart = start + tag.length + 3
  const bodyEnd = line.lastIndexOf('>')
  if (bodyEnd <= bodyStart) return null
  const branches = line.slice(bodyStart, bodyEnd).split('|')
  return branches[Math.min(branches.length - 1, Math.max(0, index))] ?? null
}

function imageSourceForLine(line: string): string {
  const progressBranch = branchFromConditional(line, 'px', 17)
  if (progressBranch) return progressBranch
  const playbackBranch = branchFromConditional(line, 'mp', 1)
  if (playbackBranch) return playbackBranch
  const repeatBranch = branchFromConditional(line, 'mm', 1)
  if (repeatBranch) return repeatBranch
  const shuffleBranch = branchFromConditional(line, 'ps', 0)
  if (shuffleBranch) return shuffleBranch
  const albumArtBranch = branchFromConditional(line, 'C', 0)
  if (albumArtBranch) return albumArtBranch
  return line
}

function subImageIndex(value: string): number {
  const char = value[0]
  if (!char) return 0
  if (char >= 'a' && char <= 'z') return char.charCodeAt(0) - 97
  if (char >= 'A' && char <= 'Z') return char.charCodeAt(0) - 65 + 26
  return 0
}

function imageForDisplay(state: ParseState, token: string): { image: LoadedImage; index: number } | null {
  const exact = state.loadedImages.get(token)
  if (exact) return { image: exact, index: 0 }
  const base = token[0] ? state.loadedImages.get(token[0]) : null
  if (!base) return null
  return { image: base, index: subImageIndex(token.slice(1)) }
}

async function addImageLayer(state: ParseState, image: LoadedImage, index: number, x: number, y: number): Promise<void> {
  const info = image.info ?? await imageInfo(state, image.path)
  if (!info) {
    state.warnings.push(`No se pudo leer ${image.path}`)
    return
  }
  const sourceHeight = Math.max(1, Math.floor(info.height / Math.max(1, image.nimages)))
  const clampedIndex = Math.min(Math.max(0, index), Math.max(0, image.nimages - 1))
  const layer: RockboxThemePreviewImageLayer = {
    id: layerId(state, 'image'),
    type: 'image',
    path: image.path,
    x,
    y,
    width: info.width,
    height: sourceHeight,
    intrinsicWidth: info.width,
    intrinsicHeight: info.height,
    sourceX: 0,
    sourceY: sourceHeight * clampedIndex,
    sourceWidth: info.width,
    sourceHeight,
  }
  state.referencedPaths.add(image.path)
  layerBounds(state, layer.x, layer.y, layer.width, layer.height)
  pushLayer(state, layer)
}

function templateFromLine(rawLine: string): string | null {
  let line = rawLine
    .replace(/^\s+|\s+$/g, '')
    .replace(/%Sx\(([^)]*)\)/g, '$1')
    .replace(/%t\([^)]*\)/g, '')
    .replace(/%t[0-9.]+/g, '')
    .replace(/%s/g, '')

  for (let i = 0; i < 4; i += 1) {
    line = line.replace(/%\?[A-Za-z][A-Za-z0-9]*(?:\([^)]*\))?<([^<>]*)>/g, (_match, body: string) => {
      const branch = body.split('|').find(part => part.trim().length > 0)
      return branch ?? ''
    })
  }

  line = line
    .replace(/%it/g, '{{title}}')
    .replace(/%ia/g, '{{artist}}')
    .replace(/%id/g, '{{album}}')
    .replace(/%iy/g, '{{year}}')
    .replace(/%fn/g, '{{filename}}')
    .replace(/%fm/g, '{{filename}}')
    .replace(/%pc/g, '{{elapsed}}')
    .replace(/%pt/g, '{{duration}}')
    .replace(/%pr/g, '{{remaining}}')
    .replace(/%pp/g, '{{playlistPosition}}')
    .replace(/%pe/g, '{{playlistTotal}}')
    .replace(/%fb/g, '{{bitrate}}')
    .replace(/%fc/g, '{{codec}}')
    .replace(/%fk/g, '{{sampleRateKhz}}')
    .replace(/%pv/g, '{{volumeDb}}')
    .replace(/%Ia/g, '{{nextArtist}}')
    .replace(/%It/g, '{{nextTitle}}')
    .replace(/%Id/g, '{{nextAlbum}}')
    .replace(/%Fn/g, '{{nextFilename}}')
    .replace(/%c[HIlkMPS]/g, '{{clock}}')
    .replace(/%[A-Za-z0-9]{1,3}\([^)]*\)/g, '')
    .replace(/%[A-Za-z0-9]{1,3}/g, '')
    .replace(/[<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const subline = line.split(';').map(part => part.trim()).find(Boolean) ?? ''
  if (!subline || !/[A-Za-z0-9{]/.test(subline)) return null
  return subline
}

function addTextLayer(state: ParseState, line: string): void {
  if (line.includes('%xl') || line.includes('%xd') || line.includes('%X(') || line.includes('%pb(') || line.includes('%pv(')) return
  const template = templateFromLine(line)
  if (!template) return
  const viewport = state.currentViewport
  const layer: RockboxThemePreviewTextLayer = {
    id: layerId(state, 'text'),
    type: 'text',
    template,
    x: viewport.x,
    y: viewport.y,
    width: viewport.width,
    height: viewport.height,
    color: viewport.foregroundColor,
    align: parseAlign(line),
    fontSize: fontSizeFor(viewport),
  }
  const overlapsExistingText = state.layers.some(existing =>
    existing.type === 'text' && overlapRatio(existing, layer) > 0.55,
  )
  if (overlapsExistingText) return
  layerBounds(state, layer.x, layer.y, layer.width, layer.height)
  pushLayer(state, layer)
}

async function handleImagePreloads(state: ParseState, line: string): Promise<void> {
  for (const call of extractCalls(line, 'xl')) {
    const args = splitArgs(call)
    const id = args[0]
    const rawPath = args[1]
    if (!id || !rawPath) continue
    const resolvedPath = resolveImagePath(state, rawPath)
    if (!resolvedPath) continue
    const info = await imageInfo(state, resolvedPath)
    state.loadedImages.set(id, {
      id,
      path: resolvedPath,
      x: parseNumber(args[2], 0),
      y: parseNumber(args[3], 0),
      nimages: Math.max(1, parseNumber(args[4], 1)),
      info,
    })
    state.referencedPaths.add(resolvedPath)
  }
}

async function handleImmediateImages(state: ParseState, line: string): Promise<void> {
  for (const call of extractCalls(line, 'X')) {
    const [rawPath] = splitArgs(call)
    const resolvedPath = rawPath ? resolveImagePath(state, rawPath) : null
    if (!resolvedPath) continue
    const info = await imageInfo(state, resolvedPath)
    if (!info) continue
    state.width = Math.max(state.width, info.width)
    state.height = Math.max(state.height, info.height)
    await addImageLayer(state, {
      id: 'backdrop',
      path: resolvedPath,
      x: 0,
      y: 0,
      nimages: 1,
      info,
    }, 0, 0, 0)
  }

  for (const call of extractCalls(line, 'x')) {
    const args = splitArgs(call)
    const id = args[0]
    const rawPath = args[1]
    if (!id || !rawPath) continue
    const resolvedPath = resolveImagePath(state, rawPath)
    if (!resolvedPath) continue
    const info = await imageInfo(state, resolvedPath)
    const image: LoadedImage = {
      id,
      path: resolvedPath,
      x: parseNumber(args[2], 0),
      y: parseNumber(args[3], 0),
      nimages: Math.max(1, parseNumber(args[4], 1)),
      info,
    }
    state.loadedImages.set(id, image)
    await addImageLayer(state, image, 0, image.x, image.y)
  }
}

async function handleImageDisplays(state: ParseState, line: string): Promise<void> {
  const displayLine = imageSourceForLine(line)
  const calls = extractCalls(displayLine, 'xd')
  const selectedCalls = calls.length > 4 ? calls.slice(0, 1) : calls
  for (const call of selectedCalls) {
    const [token] = splitArgs(call)
    if (!token) continue
    const display = imageForDisplay(state, token)
    if (!display) continue
    await addImageLayer(
      state,
      display.image,
      display.index,
      state.currentViewport.x + display.image.x,
      state.currentViewport.y + display.image.y,
    )
  }
}

function handleViewport(state: ParseState, line: string): void {
  const labelCalls = extractCalls(line, 'Vl')
  if (labelCalls.length > 0) {
    const args = splitArgs(labelCalls.at(-1) ?? '')
    state.currentViewport = viewportForArgs(state, args, 1)
  }

  const viewportCalls = extractCalls(line, 'V')
  if (viewportCalls.length > 0) {
    const lastCall = viewportCalls.at(-1) ?? ''
    if (!lastCall.includes("'") && splitArgs(lastCall).length >= 2) {
      state.currentViewport = viewportForArgs(state, splitArgs(lastCall), 0)
    }
  }

  const colorCalls = extractCalls(line, 'Vf')
  const color = sanitizeHexColor(colorCalls.at(-1))
  if (color) state.currentViewport = { ...state.currentViewport, foregroundColor: color }
}

function handleAlbumArt(state: ParseState, line: string): void {
  const calls = extractCalls(line, 'Cl')
  if (calls.length > 0) {
    const args = splitArgs(calls.at(-1) ?? '')
    state.albumArtSlot = {
      x: state.currentViewport.x + parseNumber(args[0], 0),
      y: state.currentViewport.y + parseNumber(args[1], 0),
      width: Math.max(24, parseNumber(args[2], 96)),
      height: Math.max(24, parseNumber(args[3], 96)),
    }
  }
  if (!line.includes('%Cd') || !state.albumArtSlot) return
  const slot = state.albumArtSlot
  const layer: RockboxThemePreviewAlbumArtLayer = {
    id: layerId(state, 'album-art'),
    type: 'albumArt',
    x: slot.x,
    y: slot.y,
    width: slot.width,
    height: slot.height,
  }
  layerBounds(state, layer.x, layer.y, layer.width, layer.height)
  pushLayer(state, layer)
}

function handleBars(state: ParseState, line: string): void {
  const addBar = (kind: 'progress' | 'volume', call: string) => {
    const args = splitArgs(call)
    const viewport = state.currentViewport
    const x = viewport.x + parseNumber(args[0], 0)
    const y = viewport.y + parseNumber(args[1], 0)
    const width = Math.max(4, parseNumber(args[2], viewport.width))
    const height = Math.max(2, parseNumber(args[3], Math.min(8, viewport.height)))
    const layer: RockboxThemePreviewBarLayer = {
      id: layerId(state, kind),
      type: 'bar',
      kind,
      x,
      y,
      width,
      height,
      value: kind === 'progress' ? 0.48 : 0.72,
      color: viewport.foregroundColor,
      trackColor: '303034',
    }
    layerBounds(state, layer.x, layer.y, layer.width, layer.height)
    pushLayer(state, layer)
  }

  for (const call of extractCalls(line, 'pb')) addBar('progress', call)
  for (const call of extractCalls(line, 'pv')) addBar('volume', call)
}

function handleRects(state: ParseState, line: string): void {
  for (const call of extractCalls(line, 'dr')) {
    const args = splitArgs(call)
    const viewport = state.currentViewport
    const x = viewport.x + parseNumber(args[0], 0)
    const y = viewport.y + parseNumber(args[1], 0)
    const width = resolveLength(args[2], x, state.width, viewport.width)
    const height = resolveLength(args[3], y, state.height, viewport.height)
    const color = sanitizeHexColor(args[4]) ?? viewport.foregroundColor
    const layer: RockboxThemePreviewRectLayer = {
      id: layerId(state, 'rect'),
      type: 'rect',
      x,
      y,
      width,
      height,
      color,
      opacity: 1,
    }
    layerBounds(state, layer.x, layer.y, layer.width, layer.height)
    pushLayer(state, layer)
  }
}

export async function parseRockboxThemePreview(
  rockboxRoot: string,
  themeName: string,
  wpsPath: string | null,
  configValues: Record<string, string> = {},
): Promise<RockboxThemePreviewResult> {
  if (!wpsPath || extname(wpsPath).toLowerCase() !== '.wps') {
    return { preview: fallbackPreview(configValues), referencedPaths: [] }
  }

  let source = ''
  try {
    source = await readFile(fromPosix(rockboxRoot, wpsPath), 'utf8')
  } catch {
    return {
      preview: {
        ...fallbackPreview(configValues),
        warnings: [`No se pudo leer ${wpsPath}`],
      },
      referencedPaths: [],
    }
  }

  const foregroundColor = sanitizeHexColor(configValues['foreground color']) ?? DEFAULT_FOREGROUND
  const state: ParseState = {
    rockboxRoot,
    themeName,
    wpsPath,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    backgroundColor: sanitizeHexColor(configValues['background color']) ?? DEFAULT_BACKGROUND,
    foregroundColor,
    currentViewport: {
      x: 0,
      y: 0,
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
      fontId: '-',
      foregroundColor,
    },
    loadedImages: new Map(),
    layers: [],
    referencedPaths: new Set([wpsPath]),
    warnings: [],
    albumArtSlot: null,
    imageInfoCache: new Map(),
  }

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    handleViewport(state, line)
    await handleImagePreloads(state, line)
    await handleImmediateImages(state, line)
    await handleImageDisplays(state, line)
    handleAlbumArt(state, line)
    handleBars(state, line)
    handleRects(state, line)
    addTextLayer(state, line)
  }

  return {
    preview: {
      width: Math.max(1, Math.min(1200, state.width)),
      height: Math.max(1, Math.min(1200, state.height)),
      backgroundColor: state.backgroundColor,
      foregroundColor: state.foregroundColor,
      layers: state.layers,
      warnings: [...new Set(state.warnings)].slice(0, 8),
    },
    referencedPaths: [...state.referencedPaths],
  }
}
