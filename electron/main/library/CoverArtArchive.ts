// Cover Art Archive (coverartarchive.org) lookups shared by metadata completion
// and the move-to-original-album flow. CAA is not rate limited like MusicBrainz,
// so these requests don't go through the MusicBrainz queue.

const CAA_BASE = 'https://coverartarchive.org'
// CAA redirects every request to archive.org, which routinely takes 5–8 s for
// the index and the image alike; MusicBrainz's 6 s budget is too tight here.
const INDEX_TIMEOUT_MS = 15_000
const IMAGE_TIMEOUT_MS = 20_000
export const MAX_COVER_ART_BYTES = 8 * 1024 * 1024
const ALLOWED_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp'])

export interface CoverArtImage {
  data: Buffer
  mimeType: string
}

function asString(value: unknown): string | null {
  if (value == null) return null
  const text = String(value).trim()
  return text || null
}

// Best image URL from a CAA index: the front cover, else an approved image,
// else the first one. Prefers the 1200px thumbnail over the (huge) original.
export function coverUrlFromArchive(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null
  const images = Array.isArray((json as Record<string, unknown>)['images'])
    ? (json as Record<string, unknown>)['images'] as Record<string, unknown>[]
    : []
  const image = images.find(item => item['front'] === true)
    ?? images.find(item => item['approved'] === true)
    ?? images[0]
  if (!image) return null
  const thumbnails = image['thumbnails'] && typeof image['thumbnails'] === 'object'
    ? image['thumbnails'] as Record<string, unknown>
    : {}
  return asString(thumbnails['1200'])
    ?? asString(thumbnails['500'])
    ?? asString(image['image'])
}

async function fetchArchiveIndex(url: string, userAgent: string): Promise<unknown> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), INDEX_TIMEOUT_MS)
  try {
    const response = await fetch(url, { headers: { 'User-Agent': userAgent, Accept: 'application/json' }, signal: ctrl.signal })
    return response.ok ? await response.json() : null
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchCoverArtBytes(url: string, userAgent: string): Promise<CoverArtImage | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), IMAGE_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': userAgent, Accept: 'image/jpeg,image/png,image/webp' },
      signal: ctrl.signal,
    })
    if (!response.ok) return null
    const mimeType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (!ALLOWED_MIME.has(mimeType)) return null
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_COVER_ART_BYTES) return null
    return { data: bytes, mimeType: mimeType === 'image/jpg' ? 'image/jpeg' : mimeType }
  } finally {
    clearTimeout(timer)
  }
}

// Front cover for a release, falling back to its release group. Returns null
// when neither has usable art; individual source failures are swallowed so the
// next source still gets a chance.
export async function fetchCoverArtForRelease(args: {
  releaseId: string | null
  releaseGroupId: string | null
  userAgent: string
}): Promise<CoverArtImage | null> {
  const urls = [
    args.releaseId ? `${CAA_BASE}/release/${encodeURIComponent(args.releaseId)}` : null,
    args.releaseGroupId ? `${CAA_BASE}/release-group/${encodeURIComponent(args.releaseGroupId)}` : null,
  ].filter((url): url is string => url != null)

  for (const url of urls) {
    try {
      const artUrl = coverUrlFromArchive(await fetchArchiveIndex(url, args.userAgent))
      if (!artUrl) continue
      const art = await fetchCoverArtBytes(artUrl, args.userAgent)
      if (art) return art
    } catch {
      /* Try the next cover source. */
    }
  }
  return null
}
