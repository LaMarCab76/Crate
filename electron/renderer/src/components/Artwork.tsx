import { type CSSProperties } from 'react'
import type { Album, Pattern } from '@shared/types/library'

function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

export interface ArtworkSource {
  seed: number
  palette: [string, string, string]
  pattern: Pattern
  artworkPath?: string
}

export interface ArtworkProps {
  album: ArtworkSource | Album | undefined | null
  size?: number
  radius?: number
  objectFit?: 'cover' | 'contain'
  style?: CSSProperties
}

export function Artwork({ album, radius = 6, objectFit = 'cover', style }: ArtworkProps) {
  if (!album) return null

  // If we have a real cover cached on disk, render the bitmap. The hifi://
  // protocol is registered in the main process and serves files from
  // userData/artwork/. Procedural SVG remains the fallback so the UI always
  // renders something even before any artwork is extracted.
  const artworkPath = album.artworkPath
  if (artworkPath) {
    const src = `hifi://artwork/${encodeURIComponent(artworkPath)}`
    if (objectFit === 'contain') {
      return (
        <div style={{ position: 'relative', width: '100%', height: '100%', borderRadius: radius, overflow: 'hidden' }}>
          <img src={src} alt="" draggable={false} style={{
            position: 'absolute', inset: 0, display: 'block', width: '100%', height: '100%',
            objectFit: 'cover',
            filter: 'blur(20px) brightness(0.5) saturate(1.3)',
            transform: 'scale(1.2)',
          }} />
          <img src={src} alt="" draggable={false} style={{
            position: 'absolute', inset: 0, display: 'block', width: '100%', height: '100%',
            objectFit: 'contain',
          }} />
        </div>
      )
    }
    return (
      <img
        src={src}
        alt=""
        draggable={false}
        style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover', borderRadius: radius, ...style }}
      />
    )
  }

  const [c0, c1, c2] = album.palette
  const seed = album.seed || 1
  const pat: Pattern = album.pattern || 'grid'
  const rand = seeded(seed)
  const id = `g${seed}-${pat}`

  const grad = (
    <defs>
      <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor={c0} />
        <stop offset="100%" stopColor={c1} />
      </linearGradient>
      <linearGradient id={`${id}-acc`} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor={c2} stopOpacity="0.95" />
        <stop offset="100%" stopColor={c2} stopOpacity="0.55" />
      </linearGradient>
    </defs>
  )

  const svgStyle: CSSProperties = { display: 'block', width: '100%', height: '100%', borderRadius: radius, ...style }

  if (pat === 'rays') {
    const rays = Array.from({ length: 12 }).map((_, i) => {
      const a = (i / 12) * Math.PI * 2
      const x = 100 + Math.cos(a) * 200
      const y = 100 + Math.sin(a) * 200
      return <line key={i} x1="100" y1="100" x2={x} y2={y} stroke={c2} strokeWidth="14" opacity="0.55" />
    })
    return (
      <svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" style={svgStyle}>
        {grad}
        <rect width="200" height="200" fill={`url(#${id}-bg)`} />
        <g style={{ mixBlendMode: 'screen' }}>{rays}</g>
        <circle cx="100" cy="100" r="30" fill={c2} opacity="0.9" />
      </svg>
    )
  }

  let pattern: React.ReactNode = null

  if (pat === 'circles') {
    pattern = (
      <g>
        {Array.from({ length: 4 }).map((_, i) => {
          const cx = 30 + rand() * 140
          const cy = 30 + rand() * 140
          const r = 40 + rand() * 80
          return <circle key={i} cx={cx} cy={cy} r={r} fill={`url(#${id}-acc)`} opacity={0.45 + i * 0.1} />
        })}
      </g>
    )
  } else if (pat === 'sun') {
    pattern = (
      <g>
        <circle cx="100" cy="125" r="70" fill={c2} opacity="0.9" />
        <rect x="0" y="125" width="200" height="75" fill={c0} opacity="0.6" />
        <rect x="0" y="135" width="200" height="2" fill={c2} opacity="0.7" />
        <rect x="0" y="148" width="200" height="2" fill={c2} opacity="0.5" />
        <rect x="0" y="160" width="200" height="2" fill={c2} opacity="0.35" />
      </g>
    )
  } else if (pat === 'grid') {
    const cells: React.ReactElement[] = []
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        if (rand() > 0.55) {
          cells.push(
            <rect key={`${x}-${y}`} x={x * 25} y={y * 25} width="25" height="25" fill={c2} opacity={0.15 + rand() * 0.5} />,
          )
        }
      }
    }
    pattern = <g>{cells}</g>
  } else if (pat === 'wave') {
    let path = `M 0 ${130}`
    for (let x = 0; x <= 200; x += 10) {
      const y = 130 + Math.sin((x / 200) * Math.PI * 3 + seed) * 30
      path += ` L ${x} ${y}`
    }
    path += ' L 200 200 L 0 200 Z'
    pattern = (
      <g>
        <path d={path} fill={c2} opacity="0.6" />
        <path d={path} fill={c2} opacity="0.4" transform="translate(0,-22)" />
        <path d={path} fill={c2} opacity="0.25" transform="translate(0,-44)" />
      </g>
    )
  } else if (pat === 'stripes') {
    pattern = (
      <g>
        {Array.from({ length: 6 }).map((_, i) => (
          <rect key={i} x="-30" y={i * 35 - 10} width="280" height="14" fill={c2} opacity={0.85 - i * 0.1} transform="rotate(-22 100 100)" />
        ))}
      </g>
    )
  } else if (pat === 'rings') {
    pattern = (
      <g fill="none" stroke={c2} strokeWidth="6">
        <circle cx="100" cy="100" r="20" opacity="0.95" />
        <circle cx="100" cy="100" r="40" opacity="0.7" />
        <circle cx="100" cy="100" r="60" opacity="0.5" />
        <circle cx="100" cy="100" r="80" opacity="0.3" />
      </g>
    )
  } else if (pat === 'half') {
    pattern = (
      <g>
        <path d="M 0 200 Q 100 100 200 200 Z" fill={c2} opacity="0.85" />
        <circle cx="155" cy="55" r="22" fill={c2} opacity="0.9" />
      </g>
    )
  } else if (pat === 'diag') {
    pattern = (
      <g>
        {Array.from({ length: 14 }).map((_, i) => (
          <line key={i} x1={-50 + i * 25} y1="-20" x2={i * 25} y2="220" stroke={c2} strokeWidth="3" opacity={0.2 + (i % 3) * 0.3} />
        ))}
      </g>
    )
  } else if (pat === 'lines') {
    pattern = (
      <g>
        {Array.from({ length: 18 }).map((_, i) => (
          <line key={i} x1="0" y1={10 + i * 11} x2="200" y2={10 + i * 11} stroke={c2} strokeWidth={1 + ((i * seed) % 3)} opacity={0.5 + rand() * 0.4} />
        ))}
      </g>
    )
  }

  return (
    <svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice" style={svgStyle}>
      {grad}
      <rect width="200" height="200" fill={`url(#${id}-bg)`} />
      {pattern}
    </svg>
  )
}
