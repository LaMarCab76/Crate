/* A dependency-free programmable interface. No Node, Electron or window.api. */
const sdk = window.crateInterface
const byId = id => document.getElementById(id)
const seconds = value => `${Math.floor((value || 0) / 60)}:${String(Math.floor((value || 0) % 60)).padStart(2, '0')}`
let offset = 0
let total = 0
let query = ''
let requestVersion = 0
let lastQueueKey = ''
let lastArtwork = null
let lastSnapshot = null

async function request(method, params) {
  try { const value = await sdk.request(method, params); byId('status').textContent = ''; return value }
  catch (error) { byId('status').textContent = error.message || String(error); throw error }
}
function command(method, params) { void request(method, params).catch(() => {}) }
function artwork(container, url, fallback = '') {
  container.replaceChildren()
  if (url && url.startsWith('crate://artwork/')) {
    const image = document.createElement('img')
    image.src = url; image.alt = ''; image.addEventListener('error', () => { container.textContent = fallback }, { once: true })
    container.append(image)
  } else container.textContent = fallback
}

// A new component, wholly authored by the package: semantic cards with artwork,
// track details and independent play / queue actions.
function TrackCard(track) {
  const article = document.createElement('article'); article.className = 'track-card'
  const art = document.createElement('div'); art.className = 'track-card-art'; art.setAttribute('aria-hidden', 'true'); artwork(art, track.artworkUrl, track.title.slice(0, 1))
  const body = document.createElement('div'); body.className = 'track-card-body'
  const title = document.createElement('h3'); title.textContent = track.title
  const artist = document.createElement('p'); artist.textContent = track.artist
  const detail = document.createElement('small'); detail.textContent = `${track.format} · ${seconds(track.duration)}`
  const actions = document.createElement('div'); actions.className = 'track-card-actions'
  const play = document.createElement('button'); play.textContent = 'Reproducir'; play.addEventListener('click', () => command('playback.playTrack', { trackId: track.id }))
  const enqueue = document.createElement('button'); enqueue.textContent = '+ Cola'; enqueue.setAttribute('aria-label', `Agregar ${track.title} a la cola`); enqueue.addEventListener('click', () => command('queue.add', { ids: [track.id] }))
  actions.append(play, enqueue); body.append(title, artist, detail, actions); article.append(art, body)
  return article
}
async function loadTracks() {
  const version = ++requestVersion
  byId('status').textContent = 'Cargando colección…'
  try {
    const page = await request('library.tracks', { offset, limit: 48, query })
    if (version !== requestVersion) return
    total = page.total
    byId('cards').replaceChildren(...page.items.map(TrackCard))
    if (!page.items.length) byId('cards').textContent = query ? 'No hay coincidencias. Probá otra búsqueda.' : 'Tu colección está vacía. Agregá una carpeta desde Preferencias.'
    byId('page-description').textContent = total ? `${offset + 1}–${Math.min(offset + page.items.length, total)} de ${total}` : '0 canciones'
    byId('previous-page').disabled = offset === 0
    byId('next-page').disabled = offset + 48 >= total
  } catch { /* visible request error */ }
}
function renderQueue(state) {
  const key = JSON.stringify([state.queue.currentIndex, state.queue.tracks.map(track => [track.id, track.title, track.artist])])
  if (lastQueueKey === key) return
  lastQueueKey = key
  const rows = state.queue.tracks.map((track, index) => {
    const row = document.createElement('div'); row.className = 'queue-row'
    const play = document.createElement('button'); play.textContent = `${index === state.queue.currentIndex ? '▶ ' : ''}${track.title} · ${track.artist}`; play.addEventListener('click', () => command('queue.play', { index }))
    const remove = document.createElement('button'); remove.textContent = 'Quitar'; remove.setAttribute('aria-label', `Quitar ${track.title} de la cola`); remove.addEventListener('click', () => command('queue.remove', { index }))
    row.append(play, remove); return row
  })
  byId('queue-list').replaceChildren(...rows)
  if (!rows.length) byId('queue-list').textContent = 'La cola está vacía.'
}
function renderState(state) {
  if (!state?.playback || !state?.queue) return
  lastSnapshot = state
  const { playback } = state
  const track = playback.currentTrack
  byId('track-title').textContent = track?.title || 'Tu música está lista'
  byId('track-artist').textContent = track?.artist || ''
  byId('listening-title').textContent = track?.title || 'Elegí una canción'
  byId('listening-artist').textContent = track?.artist || ''
  byId('listening-quality').textContent = track ? `${track.album} · ${track.format} ${track.quality}` : ''
  const artworkKey = `${track?.id}:${track?.artworkUrl}`
  if (lastArtwork !== artworkKey) { lastArtwork = artworkKey; artwork(byId('cover'), track?.artworkUrl) }
  byId('toggle').textContent = playback.status === 'playing' ? 'Ⅱ' : '▶'
  byId('toggle').setAttribute('aria-label', playback.status === 'playing' ? 'Pausar' : 'Reproducir')
  byId('seek').max = playback.durationSec || 1; if (document.activeElement !== byId('seek')) byId('seek').value = playback.positionSec || 0; byId('seek').disabled = !track
  byId('elapsed').textContent = seconds(playback.positionSec); byId('duration').textContent = seconds(playback.durationSec)
  if (document.activeElement !== byId('volume')) byId('volume').value = playback.volume
  renderQueue(state)
}
document.querySelectorAll('[data-screen]').forEach(button => button.addEventListener('click', () => {
  const id = button.dataset.screen
  for (const section of document.querySelectorAll('main > section')) section.hidden = section.id !== id
  for (const item of document.querySelectorAll('[data-screen]')) item.removeAttribute('aria-current')
  button.setAttribute('aria-current', 'page')
  if (id === 'queue' && lastSnapshot) renderQueue(lastSnapshot)
}))
byId('settings').addEventListener('click', () => command('navigation.openSettings'))
byId('toggle').addEventListener('click', () => command('playback.toggle'))
byId('previous-track').addEventListener('click', () => command('playback.previous'))
byId('next-track').addEventListener('click', () => command('playback.next'))
byId('seek').addEventListener('change', event => command('playback.seek', { positionSec: Number(event.target.value) }))
byId('volume').addEventListener('change', event => command('playback.volume', { volume: Number(event.target.value) }))
byId('clear-queue').addEventListener('click', () => command('queue.clear'))
byId('refresh').addEventListener('click', () => void loadTracks())
byId('previous-page').addEventListener('click', () => { offset = Math.max(0, offset - 48); void loadTracks() })
byId('next-page').addEventListener('click', () => { if (offset + 48 < total) { offset += 48; void loadTracks() } })
let searchTimer
byId('search').addEventListener('input', event => { clearTimeout(searchTimer); query = event.target.value; offset = 0; searchTimer = setTimeout(() => void loadTracks(), 250) })
const unsubscribe = sdk.onState(renderState)
window.addEventListener('pagehide', () => { unsubscribe(); clearTimeout(searchTimer) }, { once: true })
void loadTracks()
