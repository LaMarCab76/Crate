const dominantCache = new Map<string, Promise<string | null>>()
const paletteCache = new Map<string, Promise<string[] | null>>()
const sampleCache = new Map<string, Promise<Uint8ClampedArray | null>>()
const MAX_ENTRIES = 50

const SAMPLE_SIZE = 32
const PALETTE_BUCKET_BITS = 5
const PALETTE_BUCKET_SHIFT = 8 - PALETTE_BUCKET_BITS
const PALETTE_MIN_DISTANCE = 60

function trimCache<K, V>(cache: Map<K, V>): void {
  if (cache.size <= MAX_ENTRIES) return
  const first = cache.keys().next().value
  if (first !== undefined) cache.delete(first)
}

function loadSamples(src: string): Promise<Uint8ClampedArray | null> {
  const cached = sampleCache.get(src)
  if (cached) return cached

  const p = new Promise<Uint8ClampedArray | null>(resolve => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = SAMPLE_SIZE
      canvas.height = SAMPLE_SIZE
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) { resolve(null); return }
      try {
        ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE)
        resolve(ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data)
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = src
  })

  sampleCache.set(src, p)
  trimCache(sampleCache)
  return p
}

export function extractDominantColor(src: string): Promise<string | null> {
  const cached = dominantCache.get(src)
  if (cached) return cached

  const p = loadSamples(src).then(data => {
    if (!data) return null
    let r = 0, g = 0, b = 0, w = 0
    for (let i = 0; i < data.length; i += 4) {
      const R = data[i]
      const G = data[i + 1]
      const B = data[i + 2]
      const max = Math.max(R, G, B)
      const min = Math.min(R, G, B)
      if (max < 30) continue       // skip near-black
      if (min > 235) continue      // skip near-white
      const sat = (max - min) / (max || 1)
      const weight = 0.2 + sat * 0.8
      r += R * weight
      g += G * weight
      b += B * weight
      w += weight
    }
    if (w === 0) return null
    const toHex = (v: number) => Math.round(v / w).toString(16).padStart(2, '0')
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`
  })

  dominantCache.set(src, p)
  trimCache(dominantCache)
  return p
}

interface PaletteBucket {
  r: number
  g: number
  b: number
  weight: number
}

function bucketDistance(a: PaletteBucket, b: PaletteBucket): number {
  const dr = a.r - b.r
  const dg = a.g - b.g
  const db = a.b - b.b
  return Math.sqrt(dr * dr + dg * dg + db * db)
}

export function extractPalette(src: string, count = 3): Promise<string[] | null> {
  const key = `${src}|${count}`
  const cached = paletteCache.get(key)
  if (cached) return cached

  const p = loadSamples(src).then(data => {
    if (!data) return null

    const buckets = new Map<number, PaletteBucket>()
    for (let i = 0; i < data.length; i += 4) {
      const R = data[i]
      const G = data[i + 1]
      const B = data[i + 2]
      const max = Math.max(R, G, B)
      const min = Math.min(R, G, B)
      if (max < 30) continue
      if (min > 235) continue
      const sat = (max - min) / (max || 1)
      const weight = 0.2 + sat * 0.8
      const qr = R >> PALETTE_BUCKET_SHIFT
      const qg = G >> PALETTE_BUCKET_SHIFT
      const qb = B >> PALETTE_BUCKET_SHIFT
      const bucketKey = (qr << (PALETTE_BUCKET_BITS * 2)) | (qg << PALETTE_BUCKET_BITS) | qb
      const existing = buckets.get(bucketKey)
      if (existing) {
        existing.r += R * weight
        existing.g += G * weight
        existing.b += B * weight
        existing.weight += weight
      } else {
        buckets.set(bucketKey, { r: R * weight, g: G * weight, b: B * weight, weight })
      }
    }

    if (buckets.size === 0) return null

    const candidates: PaletteBucket[] = []
    for (const bucket of buckets.values()) {
      candidates.push({
        r: bucket.r / bucket.weight,
        g: bucket.g / bucket.weight,
        b: bucket.b / bucket.weight,
        weight: bucket.weight,
      })
    }
    candidates.sort((a, b) => b.weight - a.weight)

    const picked: PaletteBucket[] = []
    for (const candidate of candidates) {
      if (picked.length >= count) break
      const tooClose = picked.some(other => bucketDistance(candidate, other) < PALETTE_MIN_DISTANCE)
      if (tooClose) continue
      picked.push(candidate)
    }

    // If we couldn't find `count` distinct enough colors, relax the distance
    // filter and reuse the highest-weighted remaining candidates so callers
    // always get a stable palette length when there's any color data at all.
    if (picked.length < count) {
      for (const candidate of candidates) {
        if (picked.length >= count) break
        if (picked.includes(candidate)) continue
        picked.push(candidate)
      }
    }

    if (picked.length === 0) return null

    const toHex = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
    return picked.map(p => `#${toHex(p.r)}${toHex(p.g)}${toHex(p.b)}`)
  })

  paletteCache.set(key, p)
  trimCache(paletteCache)
  return p
}
