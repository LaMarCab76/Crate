const cache = new Map<string, Promise<string | null>>()
const MAX_ENTRIES = 50

export function extractDominantColor(src: string): Promise<string | null> {
  const cached = cache.get(src)
  if (cached) return cached

  const p = new Promise<string | null>(resolve => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = 32
      canvas.height = 32
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) { resolve(null); return }
      try {
        ctx.drawImage(img, 0, 0, 32, 32)
        const data = ctx.getImageData(0, 0, 32, 32).data
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
        if (w === 0) { resolve(null); return }
        const toHex = (v: number) => Math.round(v / w).toString(16).padStart(2, '0')
        resolve(`#${toHex(r)}${toHex(g)}${toHex(b)}`)
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = src
  })

  cache.set(src, p)
  if (cache.size > MAX_ENTRIES) {
    const first = cache.keys().next().value
    if (first !== undefined) cache.delete(first)
  }
  return p
}
