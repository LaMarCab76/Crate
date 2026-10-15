import { type CSSProperties, type ReactNode, useEffect, useMemo, useState } from 'react'
import type { InterfaceManifest, InterfaceNode } from '@shared/types/interfaces'
import type { Album, Artist, Track } from '@shared/types/library'
import { useLibraryStore } from '@renderer/stores/libraryStore'
import { usePlaybackStore } from '@renderer/stores/playbackStore'
import { useQueueStore } from '@renderer/stores/queueStore'
import { Artwork } from '@renderer/components/Artwork'
import { Icon } from '@renderer/components/Icon'
import { LyricsPanel } from '@renderer/components/LyricsPanel'
import './interfaces.css'

const samples: Track[] = ['First light', 'Ocean avenue', 'Slow motion', 'Blue hour', 'Stay a little'].map((t, i) => ({
  id: `sample-${i}`, t, d: 186 + i * 14, fmt: 'FLAC', q: '24/96', plays: i, albumId: `sample-album-${i % 3}`,
  albumTitle: ['Open skies', 'Tides', 'After hours'][i % 3], artist: ['Maya Reed', 'The Satellites', 'Daniel North'][i % 3],
  artistId: `sample-artist-${i % 3}`, year: 2026, genre: 'Indie', no: i + 1, added: '2026-01-01', loved: i === 0,
}))
const sampleAlbums: Album[] = samples.slice(0, 3).map((track, i) => ({
  id: track.albumId, title: track.albumTitle, artist: track.artist, year: 2026, added: '2026-01-01',
  seed: i + 10, palette: [['#213d46', '#5e8676', '#ded5b3'], ['#54364a', '#9d6777', '#f1c3aa'], ['#29354c', '#5668a0', '#b1c5df']][i] as [string, string, string],
  pattern: 'circles', genre: 'Indie', tracks: samples.filter(item => item.albumId === track.albumId),
}))
const sampleArtists: Artist[] = sampleAlbums.map((album, i) => ({ id: `sample-artist-${i}`, name: album.artist, albums: [album], seed: album.seed, palette: album.palette, pattern: album.pattern, trackCount: album.tracks.length }))
const time = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
const num = (value: unknown, fallback: number, min = 0, max = 2000) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback
const str = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback

// Only scalar CSS values from a small allowlist reach a node. Package styles
// cannot inject CSS rules affecting the host or URL-based resources.
function safeColor(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 80 || /url|[;{}<>]/i.test(value)) return undefined
  return /^(#[\da-f]{3,8}|(?:rgb|hsl)a?\([\d\s.,%/+-]+\)|[a-z]+)$/i.test(value) ? value : undefined
}

export function nodeStyle(node: InterfaceNode): CSSProperties {
  const p = node.props ?? {}
  const style: CSSProperties = {
    gap: num(p.gap, 16, 0, 200), padding: num(p.padding, 0, 0, 200),
    borderRadius: num(p.radius, 12, 0, 100), minWidth: num(p.minWidth, 0),
    color: safeColor(p.color), background: safeColor(p.background),
  }
  if (typeof p.width === 'number') style.width = num(p.width, 300)
  if (typeof p.height === 'number') style.height = num(p.height, 200)
  if (typeof p.fontSize === 'number') style.fontSize = num(p.fontSize, 16, 8, 120)
  if (typeof p.fontWeight === 'number') style.fontWeight = num(p.fontWeight, 400, 100, 900)
  if (['start', 'center', 'end', 'stretch'].includes(str(p.align))) style.alignItems = str(p.align)
  if (['start', 'center', 'end', 'space-between', 'space-around'].includes(str(p.justify))) style.justifyContent = str(p.justify)
  if (node.type === 'grid') style.gridTemplateColumns = `repeat(${Math.floor(num(p.columns, 3, 1, 12))}, minmax(0, 1fr))`
  return style
}

interface Props {
  manifest: InterfaceManifest
  onNavigateHost?: (route: string) => void
  renderHostView?: (route: string) => ReactNode
  preview?: boolean
  selectedNodeId?: string
  onSelectNode?: (id: string) => void
  screenId?: string
  onScreenChange?: (id: string) => void
  previewState?: 'ready' | 'empty' | 'loading' | 'error'
}

export function DeclarativeInterface({ manifest, onNavigateHost, renderHostView, preview = false, selectedNodeId, onSelectNode, screenId, onScreenChange, previewState = 'ready' }: Props) {
  const [activeScreen, setActiveScreen] = useState(screenId ?? manifest.navigation?.[0]?.screenId ?? manifest.screens?.[0]?.id)
  const [previewPlaying, setPreviewPlaying] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [tabs, setTabs] = useState<Record<string, number>>({})
  const [pages, setPages] = useState<Record<string, number>>({})
  const tracks = useLibraryStore(s => s.tracks)
  const albums = useLibraryStore(s => s.albums)
  const artists = useLibraryStore(s => s.artists)
  const loading = useLibraryStore(s => s.loading)
  const error = useLibraryStore(s => s.error)
  const currentTrack = usePlaybackStore(s => s.currentTrack)
  const status = usePlaybackStore(s => s.status)
  const position = usePlaybackStore(s => s.positionSec)
  const duration = usePlaybackStore(s => s.durationSec)
  const volume = usePlaybackStore(s => s.volume)
  const queued = useQueueStore(s => s.tracks)
  const playing = preview ? previewPlaying : status === 'playing'
  const canReadLibrary = manifest.capabilities.includes('library.read')
  const song = preview ? previewState === 'ready' ? samples[0] : null : canReadLibrary ? currentTrack : null
  const sourceTracks = preview ? previewState === 'ready' ? samples : [] : manifest.capabilities.includes('library.read') ? tracks : []
  const sourceAlbums = preview ? previewState === 'ready' ? sampleAlbums : [] : manifest.capabilities.includes('library.read') ? albums : []
  const sourceArtists = preview ? previewState === 'ready' ? sampleArtists : [] : manifest.capabilities.includes('library.read') ? artists : []
  const filtered = useMemo(() => sourceTracks.filter(track => `${track.t} ${track.artist} ${track.albumTitle}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [query, sourceTracks])
  const filteredAlbums = useMemo(() => sourceAlbums.filter(album => `${album.title} ${album.artist}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [query, sourceAlbums])
  const filteredArtists = useMemo(() => sourceArtists.filter(artist => artist.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [query, sourceArtists])
  useEffect(() => { if (screenId) setActiveScreen(screenId) }, [screenId])
  useEffect(() => {
    if (!manifest.screens?.some(screen => screen.id === activeScreen)) setActiveScreen(manifest.screens?.[0]?.id)
  }, [activeScreen, manifest.screens])
  const screen = manifest.screens?.find(item => item.id === activeScreen) ?? manifest.screens?.[0]
  const theme: CSSProperties & Record<string, string | undefined> = {
    '--if-background': safeColor(manifest.theme?.background), '--if-surface': safeColor(manifest.theme?.surface),
    '--if-text': safeColor(manifest.theme?.text), '--if-muted': safeColor(manifest.theme?.muted), '--if-accent': safeColor(manifest.theme?.accent),
  }
  if (manifest.theme?.['font-family'] && /^[\w\s,\-"']{1,100}$/.test(manifest.theme['font-family'])) theme.fontFamily = manifest.theme['font-family']
  const navigateScreen = (id: string) => { setActiveScreen(id); onScreenChange?.(id) }

  async function action(name: string, target?: string, track?: Track) {
    try {
      setNotice(null)
      if (name === 'navigate') {
        if (target?.startsWith('screen:')) { navigateScreen(target.slice(7)); return }
        if (preview) { setNotice(`Vista previa: abrir ${target ?? 'biblioteca'}`); return }
        if (!manifest.capabilities.includes('navigation')) throw new Error('Esta interfaz no declaró navegación.')
        onNavigateHost?.(target || 'library')
        return
      }
      if (preview) { setPreviewPlaying(value => !value); setNotice('Vista previa: la biblioteca y el audio real no se modifican.'); return }
      if (!manifest.capabilities.includes('playback.control')) throw new Error('Esta interfaz no declaró control de reproducción.')
      const queue = useQueueStore.getState()
      if (name === 'togglePlay') await queue.togglePlay()
      else if (name === 'next') await queue.next()
      else if (name === 'previous') await queue.previous()
      else if (name === 'play' && track) await queue.playNow(track, filtered)
      else throw new Error(`Acción no disponible: ${name}`)
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
  }

  const render = (node: InterfaceNode): ReactNode => {
    const p = node.props ?? {}
    const limit = Math.floor(num(p.limit, 24, 1, 200))
    const offsetFor = (total: number) => Math.min(pages[node.id] ?? 0, Math.max(0, Math.floor((total - 1) / limit))) * limit
    const pagination = (total: number): ReactNode => total > limit ? <div className="if-pagination"><button type="button" className="if-small-button" disabled={offsetFor(total) === 0} onClick={() => setPages(current => ({ ...current, [node.id]: Math.max(0, Math.floor(offsetFor(total) / limit) - 1) }))}>← Anterior</button><span>{offsetFor(total) + 1}–{Math.min(offsetFor(total) + limit, total)} de {total}</span><button type="button" className="if-small-button" disabled={offsetFor(total) + limit >= total} onClick={() => setPages(current => ({ ...current, [node.id]: Math.floor(offsetFor(total) / limit) + 1 }))}>Siguiente →</button></div> : null
    let content: ReactNode
    const controlsDisabled = !preview && !manifest.capabilities.includes('playback.control')
    switch (node.type) {
      case 'row': case 'column': case 'grid': case 'panel': case 'stack': content = node.children?.map(render); break
      case 'tabs': {
        const children = node.children ?? []
        const containsSelected = (item: InterfaceNode): boolean => item.id === selectedNodeId || Boolean(item.children?.some(containsSelected))
        const selectedTab = onSelectNode ? children.findIndex(containsSelected) : -1
        const active = selectedTab >= 0 ? selectedTab : Math.min(tabs[node.id] ?? 0, Math.max(0, children.length - 1))
        content = <><div className="if-tabs" role="tablist" aria-label={str(p.title, 'Pestañas')}>{children.map((child, index) => <button key={child.id} type="button" role="tab" aria-selected={index === active} tabIndex={index === active ? 0 : -1} onClick={() => setTabs(current => ({ ...current, [node.id]: index }))} onKeyDown={event => { if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return; event.preventDefault(); const next = (index + (event.key === 'ArrowRight' ? 1 : -1) + children.length) % children.length; setTabs(current => ({ ...current, [node.id]: next })); (event.currentTarget.parentElement?.children[next] as HTMLButtonElement | undefined)?.focus() }}>{str(child.props?.title, `Pestaña ${index + 1}`)}</button>)}</div><div role="tabpanel">{children[active] && render(children[active])}</div></>
        break
      }
      case 'spacer': content = <span aria-hidden="true" />; break
      case 'text': content = <span>{str(p.text, 'Texto')}</span>; break
      case 'button': content = <button type="button" className="if-button" onClick={() => void action(str(p.action, 'navigate'), str(p.target, 'library'))}>{str(p.text, 'Abrir')}</button>; break
      case 'search': content = <label className="if-search"><Icon name="search" size={16} /><input aria-label="Buscar en la interfaz" placeholder="Buscar música…" value={query} onChange={event => { setQuery(event.target.value); setPages({}) }} /></label>; break
      case 'tracks': case 'queue': {
        const list = node.type === 'queue' ? (preview ? previewState === 'ready' ? samples : [] : canReadLibrary ? queued : []) : p.data === 'favorites' ? filtered.filter(track => track.loved) : filtered
        const disabled = node.type === 'queue' ? !preview && !manifest.capabilities.includes('queue.control') : controlsDisabled
        const offset = offsetFor(list.length)
        content = <div className="if-track-list">{p.title && <h2>{str(p.title)}</h2>}{list.length === 0 ? <p className="if-muted">{str(p.emptyText, node.type === 'queue' ? 'La cola está vacía.' : 'No hay canciones para mostrar.')}</p> : list.slice(offset, offset + limit).map((track, i) => <button disabled={disabled} type="button" className={`if-track${song?.id === track.id ? ' is-playing' : ''}`} key={`${track.id}-${i}`} onClick={() => node.type === 'queue' && !preview ? void useQueueStore.getState().jumpTo(offset + i).catch(error => setNotice(String(error))) : void action('play', undefined, track)}><span className="if-muted">{offset + i + 1}</span><span><strong>{track.t}</strong><small>{track.artist} · {track.albumTitle}</small></span><span className="if-muted">{time(track.d)}</span></button>)}{pagination(list.length)}</div>
        break
      }
      case 'albums': { const offset = offsetFor(filteredAlbums.length); content = <div>{p.title && <h2>{str(p.title)}</h2>}<div className="if-albums" style={{ '--if-card-min': `${num(p.minWidth, 130, 70, 400)}px` } as CSSProperties}>{filteredAlbums.slice(offset, offset + limit).map(album => <button className="if-album" type="button" key={album.id} onClick={() => void action('navigate', `album:${album.id}`)}><div className="if-artwork"><Artwork album={album} /></div><strong>{album.title}</strong><small>{album.artist}</small></button>)}</div>{filteredAlbums.length === 0 && <p className="if-muted">{str(p.emptyText, 'No hay álbumes para mostrar.')}</p>}{pagination(filteredAlbums.length)}</div>; break }
      case 'artists': { const offset = offsetFor(filteredArtists.length); content = <div>{p.title && <h2>{str(p.title)}</h2>}<div className="if-albums">{filteredArtists.slice(offset, offset + limit).map(artist => <button type="button" className="if-album" key={artist.id} onClick={() => void action('navigate', `artist:${artist.id}`)}><div className="if-artwork if-artist-art"><Artwork album={artist} /></div><strong>{artist.name}</strong><small>{artist.trackCount} canciones</small></button>)}</div>{!filteredArtists.length && <p className="if-muted">{str(p.emptyText, 'No hay artistas para mostrar.')}</p>}{pagination(filteredArtists.length)}</div>; break }
      case 'player': content = <div className={`if-player${p.compact ? ' is-compact' : ''}`}><div className="if-artwork"><Artwork album={(preview ? sampleAlbums : albums).find(album => album.id === song?.albumId) ?? (song?.artworkPath ? { seed: 1, palette: ['#253548', '#565b75', '#cad0df'], pattern: 'circles', artworkPath: song.artworkPath } : sampleAlbums[0])} /></div><div className="if-player-info"><strong>{song?.t ?? 'Elegí una canción'}</strong><small>{song?.artist ?? 'Tu música está lista'}</small><div className="if-player-controls">{(['previous', 'togglePlay', 'next'] as const).map((name, i) => <button className="if-icon-button" key={name} type="button" disabled={controlsDisabled || (!preview && !song && name !== 'togglePlay')} aria-label={['Anterior', playing ? 'Pausar' : 'Reproducir', 'Siguiente'][i]} onClick={() => void action(name)}><Icon name={['prev', playing ? 'pause' : 'play', 'next'][i]} size={22} /></button>)}</div><label className="if-slider"><span className="if-muted">{time(preview ? 68 : position)}</span><input type="range" aria-label="Posición de reproducción" min={0} max={preview ? 186 : duration || 1} value={preview ? 68 : Math.min(position, duration || 1)} disabled={controlsDisabled || (!preview && !song)} onChange={event => { if (!preview) void useQueueStore.getState().seek(Number(event.target.value)).catch(error => setNotice(String(error))) }} /><span className="if-muted">{time(preview ? 186 : duration)}</span></label><label className="if-slider"><Icon name="volume" size={15} /><input type="range" aria-label="Volumen" min={0} max={1} step={0.01} value={preview ? 0.7 : volume} disabled={controlsDisabled} onChange={event => { if (!preview) void useQueueStore.getState().setVolume(Number(event.target.value)).catch(error => setNotice(String(error))) }} /></label></div></div>; break
      case 'lyrics': content = preview ? <div className="if-sample-lyrics"><p>Let the morning find us here</p><p>With the music in the air</p><small>Letra de muestra</small></div> : canReadLibrary ? <LyricsPanel variant="inline" showActions={false} /> : <p className="if-muted">Esta interfaz no tiene acceso a los datos de la biblioteca.</p>; break
      case 'host-view': content = preview ? <div className="if-host-placeholder"><Icon name="library" size={28} /><strong>Vista de Crate: {str(p.target, 'library')}</strong><p>Los datos y acciones reales estarán disponibles al activar la interfaz.</p></div> : manifest.capabilities.includes('navigation') && renderHostView ? renderHostView(str(p.target, 'library')) : <button className="if-button" onClick={() => void action('navigate', str(p.target, 'library'))}>Abrir {str(p.target, 'biblioteca')}</button>; break
      default: content = <p className="if-muted">Componente «{node.type}» no disponible. Usá un paquete de código para componentes nuevos.</p>
    }
    return <div key={node.id} data-interface-node={node.id} className={`if-node if-node-${node.type}${selectedNodeId === node.id ? ' if-node-selected' : ''}${num(p.hideBelow, 0) > 0 ? ' if-hide-small' : ''}`} style={nodeStyle(node)} onClickCapture={onSelectNode ? event => { event.stopPropagation(); event.preventDefault(); onSelectNode((event.target as Element).closest('[data-interface-node]')?.getAttribute('data-interface-node') ?? node.id) } : undefined}>{content}</div>
  }

  return <section className={`if-runtime if-base-${manifest.base}${preview ? ' if-preview' : ''}`} style={theme} aria-label={preview ? 'Vista previa de interfaz' : manifest.name}>
    <nav className="if-runtime-nav" aria-label="Navegación de interfaz">{(manifest.navigation ?? []).map(item => <button type="button" key={item.id} aria-current={activeScreen === item.screenId ? 'page' : undefined} onClick={() => navigateScreen(item.screenId)}>{item.label}</button>)}</nav>
    {notice && <div role="status" className="if-notice">{notice}<button type="button" aria-label="Cerrar aviso" onClick={() => setNotice(null)}>×</button></div>}
    {(!preview && loading || preview && previewState === 'loading') && <div className="if-notice" role="status">Cargando biblioteca…</div>}
    {(!preview && error || preview && previewState === 'error') && <div className="if-error" role="alert">{preview ? 'No se pudo cargar la biblioteca (error de muestra).' : error}</div>}
    <div className="if-runtime-screen">{screen ? render(screen.root) : <p className="if-empty">Esta interfaz no tiene pantallas. Podés editarla desde Preferencias → Apariencia → Interfaz.</p>}</div>
  </section>
}
