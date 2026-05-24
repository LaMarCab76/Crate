import { randomUUID } from 'node:crypto'
import { statSync, readFileSync } from 'node:fs'
import { extname } from 'node:path'
import type {
  DownloadProvider,
  HarExtractedCredential,
  HarImportPreview,
  ProviderCredentialsPayload,
} from '@shared/types/downloads'

const MAX_HAR_BYTES = 64 * 1024 * 1024
const MAX_TEXT_BYTES = 2 * 1024 * 1024

interface HarEntry {
  request?: {
    method?: string
    url?: string
    headers?: Array<{ name?: string; value?: string }>
    queryString?: Array<{ name?: string; value?: string }>
    postData?: {
      mimeType?: string
      text?: string
      params?: Array<{ name?: string; value?: string }>
    }
  }
  response?: {
    headers?: Array<{ name?: string; value?: string }>
    content?: {
      mimeType?: string
      text?: string
      encoding?: string
    }
  }
}

interface Candidate {
  key: string
  value: string
  sourceHint: string
}

interface ExtractedHarCredentials {
  preview: HarImportPreview
  payload: ProviderCredentialsPayload
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function hostHint(rawUrl: string | undefined, method: string | undefined): string {
  try {
    const url = new URL(rawUrl ?? '')
    return `${method ?? 'GET'} ${url.hostname}${url.pathname}`
  } catch {
    return method ?? 'HAR entry'
  }
}

function redact(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed.length <= 10) return `${trimmed.slice(0, 2)}...`
  return `${trimmed.slice(0, 5)}...${trimmed.slice(-4)}`
}

function addCandidate(out: Candidate[], key: string | undefined, value: string | undefined, sourceHint: string): void {
  const name = asString(key)
  const clean = asString(value)
  if (!name || !clean) return
  out.push({ key: name, value: clean, sourceHint })
}

function addPairs(out: Candidate[], pairs: Array<{ name?: string; value?: string }> | undefined, sourceHint: string): void {
  for (const pair of pairs ?? []) {
    addCandidate(out, pair.name, pair.value, sourceHint)
  }
}

function addUrlParams(out: Candidate[], rawUrl: string | undefined, sourceHint: string): void {
  try {
    const url = new URL(rawUrl ?? '')
    for (const [key, value] of url.searchParams.entries()) {
      addCandidate(out, key, value, sourceHint)
    }
  } catch {
    /* ignore malformed HAR URLs */
  }
}

function addAuthorization(out: Candidate[], headers: Array<{ name?: string; value?: string }> | undefined, sourceHint: string): void {
  for (const header of headers ?? []) {
    if (asString(header.name).toLowerCase() !== 'authorization') continue
    const value = asString(header.value)
    const bearer = /^bearer\s+(.+)$/i.exec(value)
    if (bearer?.[1]) addCandidate(out, 'authorization_bearer', bearer[1], sourceHint)
  }
}

function parseTextBody(text: string | undefined, encoding: string | undefined): string {
  const raw = asString(text)
  if (!raw) return ''
  if (raw.length > MAX_TEXT_BYTES) return ''
  if (encoding === 'base64') {
    try {
      return Buffer.from(raw, 'base64').toString('utf8')
    } catch {
      return ''
    }
  }
  return raw
}

function looksLikeFormBody(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > 128 * 1024) return false
  if (!trimmed.includes('=')) return false
  if (/^\s*[{[]/.test(trimmed)) return false
  if (/[<>]/.test(trimmed.slice(0, 512))) return false
  return /^[A-Za-z0-9_.%[\]-]+=/.test(trimmed)
}

function addBodyCandidates(out: Candidate[], text: string, sourceHint: string): void {
  const trimmed = text.trim()
  if (!trimmed) return

  if (looksLikeFormBody(trimmed)) {
    const params = new URLSearchParams(trimmed)
    for (const [key, value] of params.entries()) {
      addCandidate(out, key, value, sourceHint)
    }
  }

  if (!/^\s*[{[]/.test(trimmed)) return
  try {
    const json = JSON.parse(trimmed) as unknown
    addJsonCandidates(out, json, sourceHint)
  } catch {
    /* not JSON */
  }
}

function addJsonCandidates(out: Candidate[], value: unknown, sourceHint: string): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) addJsonCandidates(out, item, sourceHint)
    return
  }
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' || typeof item === 'number') {
      addCandidate(out, key, String(item), sourceHint)
    } else {
      addJsonCandidates(out, item, sourceHint)
    }
  }
}

function collectCandidates(entries: HarEntry[]): Candidate[] {
  const out: Candidate[] = []
  for (const entry of entries) {
    const request = entry.request
    const response = entry.response
    const sourceHint = hostHint(request?.url, request?.method)
    addUrlParams(out, request?.url, sourceHint)
    addPairs(out, request?.queryString, sourceHint)
    addPairs(out, request?.headers, sourceHint)
    addAuthorization(out, request?.headers, sourceHint)
    addPairs(out, request?.postData?.params, sourceHint)
    addBodyCandidates(out, parseTextBody(request?.postData?.text, undefined), sourceHint)
    addPairs(out, response?.headers, sourceHint)
    addAuthorization(out, response?.headers, sourceHint)
    addBodyCandidates(
      out,
      parseTextBody(response?.content?.text, response?.content?.encoding),
      sourceHint,
    )
  }
  return out
}

function findCandidate(candidates: Candidate[], names: string[]): Candidate | null {
  const lowered = new Set(names.map(name => name.toLowerCase()))
  return candidates.find(candidate => lowered.has(candidate.key.toLowerCase())) ?? null
}

function expiresAtFromCandidates(candidates: Candidate[]): number | null {
  const expiresAt = findCandidate(candidates, ['expires_at', 'expiresAt'])
  if (expiresAt) {
    const parsed = Number.parseInt(expiresAt.value, 10)
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed > 10_000_000_000 ? parsed : parsed * 1000
    }
  }
  const expiresIn = findCandidate(candidates, ['expires_in', 'expiresIn'])
  if (expiresIn) {
    const seconds = Number.parseInt(expiresIn.value, 10)
    if (Number.isFinite(seconds) && seconds > 0) return Date.now() + seconds * 1000
  }
  return null
}

function field(key: string, label: string, candidate: Candidate | null): HarExtractedCredential {
  return {
    key,
    label,
    status: candidate ? 'found' : 'missing',
    valuePreview: candidate ? redact(candidate.value) : null,
    sourceHint: candidate?.sourceHint ?? null,
  }
}

function inspectQobuz(candidates: Candidate[]): ExtractedHarCredentials {
  const appId = findCandidate(candidates, ['app_id', 'appId', 'qobuz_app_id', 'qobuzAppId'])
  const appSecret = findCandidate(candidates, ['app_secret', 'appSecret', 'qobuz_app_secret', 'qobuzAppSecret'])
  const userAuthToken = findCandidate(candidates, ['user_auth_token', 'userAuthToken', 'qobuz_user_auth_token', 'authorization_bearer'])
  const fields = [
    field('appId', 'App ID', appId),
    field('appSecret', 'App Secret', appSecret),
    field('userAuthToken', 'User Auth Token', userAuthToken),
  ]
  const missingFields = fields.filter(item => item.status === 'missing').map(item => item.key)
  const foundCount = fields.length - missingFields.length
  return {
    preview: {
      previewId: randomUUID(),
      provider: 'qobuz',
      createdAt: Date.now(),
      fields,
      missingFields,
      canApply: foundCount > 0,
      summary: foundCount > 0
        ? `Found ${foundCount} Qobuz credential field${foundCount === 1 ? '' : 's'}.`
        : 'No Qobuz credential fields were found in this HAR.',
    },
    payload: {
      provider: 'qobuz',
      appId: appId?.value,
      appSecret: appSecret?.value,
      userAuthToken: userAuthToken?.value,
      source: 'har',
      importedAt: Date.now(),
      expiresAt: expiresAtFromCandidates(candidates),
    },
  }
}

function inspectTidal(candidates: Candidate[]): ExtractedHarCredentials {
  const clientId = findCandidate(candidates, ['client_id', 'clientId', 'tidal_client_id', 'tidalClientId'])
  const clientSecret = findCandidate(candidates, ['client_secret', 'clientSecret', 'tidal_client_secret', 'tidalClientSecret'])
  const accessToken = findCandidate(candidates, ['access_token', 'accessToken', 'authorization_bearer'])
  const refreshToken = findCandidate(candidates, ['refresh_token', 'refreshToken'])
  const webToken = findCandidate(candidates, ['x-tidal-token', 'x_tidal_token', 'tidal_token', 'tidalToken'])
  const countryCode = findCandidate(candidates, ['countryCode', 'country_code'])
  const fields = [
    field('clientId', 'Client ID', clientId),
    field('clientSecret', 'Client Secret', clientSecret),
    field('accessToken', 'Access Token', accessToken),
    field('refreshToken', 'Refresh Token', refreshToken),
    field('webToken', 'Web Token', webToken),
    field('countryCode', 'Country Code', countryCode),
  ]
  const foundCount = fields.filter(item => item.status === 'found').length
  const foundCredentialCount = [clientId, clientSecret, accessToken, refreshToken, webToken].filter(Boolean).length
  const canSearch = Boolean(accessToken || webToken || (clientId && clientSecret))
  const missingFields = canSearch
    ? []
    : [
        ...(clientId ? [] : ['clientId']),
        ...(clientSecret ? [] : ['clientSecret']),
        ...(accessToken || webToken ? [] : ['accessToken', 'webToken']),
      ]
  return {
    preview: {
      previewId: randomUUID(),
      provider: 'tidal',
      createdAt: Date.now(),
      fields,
      missingFields,
      canApply: foundCredentialCount > 0,
      summary: foundCount > 0
        ? `Found ${foundCount} TIDAL credential field${foundCount === 1 ? '' : 's'}.`
        : 'No TIDAL credential fields were found in this HAR.',
    },
    payload: {
      provider: 'tidal',
      clientId: clientId?.value,
      clientSecret: clientSecret?.value,
      accessToken: accessToken?.value,
      refreshToken: refreshToken?.value,
      webToken: webToken?.value,
      countryCode: countryCode?.value,
      source: 'har',
      importedAt: Date.now(),
      expiresAt: expiresAtFromCandidates(candidates),
    },
  }
}

export class HarCredentialExtractor {
  inspect(provider: DownloadProvider, paths: string[]): ExtractedHarCredentials {
    if (paths.length === 0) throw new Error('Choose a HAR file first.')
    const entries = paths.flatMap(path => this.readEntries(path))
    const candidates = collectCandidates(entries)
    return provider === 'qobuz' ? inspectQobuz(candidates) : inspectTidal(candidates)
  }

  private readEntries(path: string): HarEntry[] {
    if (extname(path).toLowerCase() !== '.har') {
      throw new Error('Only .har files can be imported.')
    }
    const stats = statSync(path)
    if (!stats.isFile()) throw new Error('HAR import expects a file.')
    if (stats.size > MAX_HAR_BYTES) throw new Error('HAR file is too large.')
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    } catch {
      throw new Error('Invalid HAR file: JSON could not be parsed.')
    }
    if (!parsed || typeof parsed !== 'object') throw new Error('Invalid HAR file.')
    const log = (parsed as { log?: { entries?: unknown[] } }).log
    if (!log || !Array.isArray(log.entries)) throw new Error('Invalid HAR file: missing log.entries.')
    return log.entries as HarEntry[]
  }
}
