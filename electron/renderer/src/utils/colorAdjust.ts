const MIN_SATURATION = 0.60
const MIN_LIGHTNESS = 0.40
const MAX_LIGHTNESS = 0.60

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function parseHex(input: string): [number, number, number] | null {
  let hex = input.trim()
  if (hex.startsWith('#')) hex = hex.slice(1)
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('')
  if (hex.length !== 6) return null
  const num = Number.parseInt(hex, 16)
  if (Number.isNaN(num)) return null
  return [(num >> 16) & 0xff, (num >> 8) & 0xff, num & 0xff]
}

function parseHsl(input: string): [number, number, number] | null {
  const m = input.match(/hsla?\(\s*([\d.]+)(?:deg)?\s*[, ]\s*([\d.]+)%\s*[, ]\s*([\d.]+)%/i)
  if (!m) return null
  const h = Number.parseFloat(m[1])
  const s = Number.parseFloat(m[2]) / 100
  const l = Number.parseFloat(m[3]) / 100
  if (!Number.isFinite(h) || !Number.isFinite(s) || !Number.isFinite(l)) return null
  return [((h % 360) + 360) % 360, clamp01(s), clamp01(l)]
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  let h = 0
  let s = 0
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case rn: h = ((gn - bn) / d + (gn < bn ? 6 : 0)); break
      case gn: h = (bn - rn) / d + 2; break
      case bn: h = (rn - gn) / d + 4; break
    }
    h *= 60
  }
  return [h, s, l]
}

function hslToHex(h: number, s: number, l: number): string {
  const hh = (((h % 360) + 360) % 360) / 360
  const ss = clamp01(s)
  const ll = clamp01(l)
  const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss
  const p = 2 * ll - q
  const hue2rgb = (t: number): number => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  const r = Math.round(hue2rgb(hh + 1 / 3) * 255)
  const g = Math.round(hue2rgb(hh) * 255)
  const b = Math.round(hue2rgb(hh - 1 / 3) * 255)
  const toHex = (v: number) => v.toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

// Boost a color so it always shows up as a vivid, mid-range tint regardless of
// whether it came from artwork extraction or a synthetic HSL palette. Returns
// null if the input can't be parsed.
export function vivify(input: string | null | undefined): string | null {
  if (!input) return null
  let h: number, s: number, l: number
  const hsl = parseHsl(input)
  if (hsl) {
    [h, s, l] = hsl
  } else {
    const rgb = parseHex(input)
    if (!rgb) return null
    ;[h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2])
  }
  const nextS = Math.max(s, MIN_SATURATION)
  const nextL = Math.min(MAX_LIGHTNESS, Math.max(MIN_LIGHTNESS, l))
  return hslToHex(h, nextS, nextL)
}
