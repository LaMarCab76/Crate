import { type CSSProperties, useEffect, useRef, useState } from 'react'
import { Artwork, type ArtworkSource } from './Artwork'
import type { Album } from '@shared/types/library'

// Cross-dissolving wrapper around <Artwork>. When the displayed cover changes
// (track change, gapless advance, or a user-initiated crossfade), the previous
// artwork is held underneath while the incoming artwork fades in on top, giving
// a smooth dissolve instead of a hard cut. Respects prefers-reduced-motion.

const DEFAULT_XFADE_MS = 600

type Src = ArtworkSource | Album

// A stable identity for a cover so we only animate on a *real* change, not on
// every parent re-render (e.g. progress ticks recreating a fallback literal).
function artworkKey(src: Src): string {
  if (src.artworkPath) return `p:${src.artworkPath}`
  const palette = Array.isArray((src as ArtworkSource).palette)
    ? (src as ArtworkSource).palette.join(',')
    : ''
  return `g:${src.seed}|${(src as ArtworkSource).pattern}|${palette}`
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
}

interface CrossfadeArtworkProps {
  album: Src | null | undefined
  radius?: number
  objectFit?: 'cover' | 'contain'
  durationMs?: number
  className?: string
  style?: CSSProperties
}

export function CrossfadeArtwork({
  album,
  radius = 6,
  objectFit = 'cover',
  durationMs = DEFAULT_XFADE_MS,
  className,
  style,
}: CrossfadeArtworkProps) {
  const key = album ? artworkKey(album) : null
  const reduce = prefersReducedMotion()

  // The artwork being dissolved *out* — a frozen snapshot of the previous cover.
  const [outgoing, setOutgoing] = useState<{ id: number; album: Src } | null>(null)
  const idRef = useRef(0)
  // "Previous render" values, used to snapshot the outgoing cover on a change.
  const prevKeyRef = useRef<string | null>(key)
  const prevAlbumRef = useRef<Src | null>(album ?? null)

  // Defined BEFORE the ref-sync effect so it sees the *previous* render's values.
  useEffect(() => {
    if (key == null) {
      setOutgoing(null)
      return
    }
    const prevKey = prevKeyRef.current
    const prevAlbum = prevAlbumRef.current
    if (prevKey == null || prevKey === key || reduce || !prevAlbum) return

    const id = ++idRef.current
    setOutgoing({ id, album: prevAlbum })
    const timer = window.setTimeout(() => {
      setOutgoing(current => (current && current.id === id ? null : current))
    }, durationMs)
    return () => window.clearTimeout(timer)
  }, [key, durationMs, reduce])

  // Runs every render, after the change effect above, so the refs always hold
  // the latest cover for the *next* change to snapshot.
  useEffect(() => {
    prevKeyRef.current = key
    prevAlbumRef.current = album ?? null
  })

  if (!album || key == null) return null

  return (
    <div className={`xfade-art${className ? ` ${className}` : ''}`} style={style}>
      {outgoing && (
        <div key={`out-${outgoing.id}`} className="xfade-art-layer" aria-hidden="true">
          <Artwork album={outgoing.album} radius={radius} objectFit={objectFit} />
        </div>
      )}
      <div
        key={key}
        className={`xfade-art-layer${outgoing ? ' entering' : ''}`}
        style={outgoing ? { animationDuration: `${durationMs}ms` } : undefined}
      >
        <Artwork album={album} radius={radius} objectFit={objectFit} />
      </div>
    </div>
  )
}
