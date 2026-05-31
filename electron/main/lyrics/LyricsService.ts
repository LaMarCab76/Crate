import { dialog } from 'electron'
import { writeFileSync } from 'node:fs'
import { getRepos, type Repos } from '../db/repositories'
import { broadcast } from '../ipc/events'
import type { DbTrack } from '@shared/types/db'
import type {
  LyricsCandidate,
  LyricsResult,
  LyricsSource,
  LyricsStatus,
  LyricsView,
  LyricsSelectionSummary,
} from '@shared/types/lyrics'
import { isSyncedLrc, setLrcOffset } from '@shared/lyrics/lrc'
import {
  ACCEPT_AUTO,
  ACCEPT_REVIEW,
  isExactDurationCompatible,
  scoreCandidate,
  toConfidence,
} from './LyricsMatcher'
import { LrclibProvider, type LrclibQuery, type LrclibRaw } from './providers/LrclibProvider'
import { readEmbeddedLyrics } from './providers/EmbeddedLyricsProvider'
import { readSidecarLrc } from './providers/SidecarLrcProvider'
import { writeSidecarLrc, removeSidecarLrc } from './writers/SidecarLrcWriter'

const NOT_FOUND_TTL_MS = 7 * 24 * 60 * 60 * 1000

function emptyView(trackId: number, status: LyricsStatus): LyricsView {
  return {
    trackId,
    status,
    source: null,
    plainLyrics: null,
    syncedLyricsLrc: null,
    instrumental: false,
    isUserEdited: false,
    embeddedInFile: false,
    sidecarWritten: false,
    confidence: 0,
  }
}

// Build the renderer-facing view from on-disk content (a sidecar `.lrc` or an
// embedded tag read). `isUserEdited` / `low_confidence` are no longer persisted
// (they lived in the DB) — a freshly written sidecar simply reads back as
// found_synced / found_plain.
function viewFromResult(
  trackId: number,
  res: LyricsResult,
  flags: { sidecarWritten: boolean; embeddedInFile: boolean },
): LyricsView {
  const synced = res.syncedLyricsLrc ?? null
  const plain = res.plainLyrics ?? null
  let status: LyricsStatus
  if (res.instrumental) status = 'instrumental'
  else if (synced) status = 'found_synced'
  else if (plain) status = 'found_plain'
  else status = 'none'

  return {
    trackId,
    status,
    source: res.source,
    plainLyrics: plain,
    syncedLyricsLrc: synced,
    instrumental: res.instrumental,
    isUserEdited: false,
    embeddedInFile: flags.embeddedInFile,
    sidecarWritten: flags.sidecarWritten,
    confidence: res.confidence,
  }
}

function userView(trackId: number, plain: string | null, synced: string | null, sidecarWritten: boolean): LyricsView {
  return {
    trackId,
    status: synced ? 'found_synced' : 'found_plain',
    source: 'user',
    plainLyrics: plain,
    syncedLyricsLrc: synced,
    instrumental: false,
    isUserEdited: true,
    embeddedInFile: false,
    sidecarWritten,
    confidence: 1,
  }
}

function trackToQuery(t: DbTrack): LrclibQuery {
  return {
    title: t.title,
    artist: t.artist,
    album: t.album && t.album !== 'Unknown Album' ? t.album : null,
    durationSeconds: t.duration > 0 ? Math.round(t.duration) : null,
  }
}

function rawScore(track: DbTrack, raw: LrclibRaw): number {
  return scoreCandidate({
    fileTitle: track.title,
    fileArtist: track.artist,
    fileAlbum: track.album && track.album !== 'Unknown Album' ? track.album : null,
    fileDuration: track.duration > 0 ? track.duration : null,
    candTitle: raw.trackName,
    candArtist: raw.artistName,
    candAlbum: raw.albumName,
    candDuration: raw.duration,
  })
}

export class LyricsService {
  private repos: Repos
  private lrclib = new LrclibProvider()

  // Session-only memory of tracks LRCLIB had no usable match for, so repeated
  // plays / sync passes don't re-hit the network. Replaces the persistent
  // `lyrics_failures` TTL now that lyrics state lives only on disk. Resets on
  // restart — a not-found track may be queried once more after relaunch.
  private notFound = new Map<number, number>() // trackId -> epoch ms of last miss

  constructor() {
    this.repos = getRepos()
  }

  // --- read-only resolution (no network) ---------------------------------

  getForTrack(trackId: number): LyricsView {
    const track = this.repos.tracks.getById(trackId)
    if (!track) return emptyView(trackId, 'none')

    // Sidecar is the source of truth; embedded tags are a secondary read source.
    const sidecar = readSidecarLrc(track.path)
    if (sidecar) return viewFromResult(trackId, sidecar, { sidecarWritten: true, embeddedInFile: false })

    const embedded = readEmbeddedLyrics(track.path)
    if (embedded) return viewFromResult(trackId, embedded, { sidecarWritten: false, embeddedInFile: true })

    if (this.notFound.has(trackId)) return emptyView(trackId, 'not_found')
    return emptyView(trackId, 'none')
  }

  // --- online fetch (auto-accept) ----------------------------------------

  async fetchOnline(trackId: number, opts?: { force?: boolean }): Promise<LyricsView> {
    const track = this.repos.tracks.getById(trackId)
    if (!track) return emptyView(trackId, 'none')

    // A sidecar already on disk means the lyrics are resolved — never hit the
    // network for it unless the user explicitly forces a re-fetch.
    if (!opts?.force) {
      const existing = readSidecarLrc(track.path)
      if (existing) return viewFromResult(trackId, existing, { sidecarWritten: true, embeddedInFile: false })
    }

    if (!track.title.trim() || !track.artist.trim()) {
      this.notFound.set(trackId, Date.now())
      return emptyView(trackId, 'not_found')
    }

    if (!opts?.force) {
      const lastMiss = this.notFound.get(trackId)
      if (lastMiss != null && Date.now() - lastMiss < NOT_FOUND_TTL_MS) {
        return emptyView(trackId, 'not_found')
      }
    }

    const query = trackToQuery(track)
    try {
      let chosen: LrclibRaw | null = null
      let confidence = 0

      const exact = await this.lrclib.getExact(query)
      if (exact) {
        const score = rawScore(track, exact)
        if (score >= ACCEPT_AUTO || isExactDurationCompatible(query.durationSeconds ?? null, exact.duration)) {
          chosen = exact
          confidence = Math.max(toConfidence(score), 0.9)
        }
      }

      if (!chosen) {
        const results = await this.lrclib.search(query)
        if (results.length > 0) {
          const ranked = results
            .map(raw => ({ raw, score: rawScore(track, raw) }))
            .sort((a, b) => b.score - a.score)
          const best = ranked[0]
          if (best.score >= ACCEPT_AUTO) {
            chosen = best.raw
            confidence = toConfidence(best.score)
          } else if (best.score >= ACCEPT_REVIEW) {
            // Ambiguous: don't auto-import; surface for manual review.
            return emptyView(trackId, 'low_confidence')
          }
        }
      }

      if (!chosen) {
        this.notFound.set(trackId, Date.now())
        return emptyView(trackId, 'not_found')
      }

      return this.persistChosen(track, chosen, confidence)
    } catch {
      // Provider timeout / rate-limit. Not remembered as not-found, so a later
      // attempt can still succeed.
      return emptyView(trackId, 'failed_provider')
    }
  }

  // --- explicit online search (chooser) ----------------------------------

  async searchOnline(trackId: number): Promise<LyricsCandidate[]> {
    const track = this.repos.tracks.getById(trackId)
    if (!track || !track.title.trim() || !track.artist.trim()) return []
    let results: LrclibRaw[]
    try {
      results = await this.lrclib.search(trackToQuery(track))
    } catch {
      return []
    }
    return results
      .map(raw => ({
        id: String(raw.id),
        trackName: raw.trackName,
        artistName: raw.artistName,
        albumName: raw.albumName,
        durationSeconds: raw.duration,
        instrumental: raw.instrumental,
        hasSynced: Boolean(raw.syncedLyrics),
        hasPlain: Boolean(raw.plainLyrics),
        score: rawScore(track, raw),
      }))
      .sort((a, b) => b.score - a.score)
  }

  async importCandidate(trackId: number, lrclibId: string): Promise<LyricsView> {
    const track = this.repos.tracks.getById(trackId)
    if (!track) return emptyView(trackId, 'none')
    let raw: LrclibRaw | null
    try {
      raw = await this.lrclib.getById(lrclibId)
    } catch {
      return emptyView(trackId, 'failed_provider')
    }
    if (!raw) return emptyView(trackId, 'not_found')
    return this.persistChosen(track, raw, toConfidence(rawScore(track, raw)))
  }

  // --- user import / edit -------------------------------------------------

  importLrcText(trackId: number, lrcText: string): LyricsView {
    const track = this.repos.tracks.getById(trackId)
    if (!track) return emptyView(trackId, 'none')
    const synced = isSyncedLrc(lrcText)
    const written = this.writeSidecar(track, lrcText)
    this.notFound.delete(trackId)
    return userView(trackId, synced ? null : lrcText, synced ? lrcText : null, written)
  }

  saveUserEdit(trackId: number, plain: string | null, synced: string | null): LyricsView {
    const track = this.repos.tracks.getById(trackId)
    if (!track) return emptyView(trackId, 'none')
    const content = synced ?? plain
    if (!content) {
      // Empty save clears the lyrics: remove the assigned sidecar file.
      removeSidecarLrc(track.path)
      return emptyView(trackId, 'none')
    }
    const written = this.writeSidecar(track, content)
    this.notFound.delete(trackId)
    return userView(trackId, plain, synced, written)
  }

  setOffset(trackId: number, offsetMs: number): LyricsView {
    const track = this.repos.tracks.getById(trackId)
    if (!track) return emptyView(trackId, 'none')
    const current = readSidecarLrc(track.path) ?? readEmbeddedLyrics(track.path)
    const synced = current?.syncedLyricsLrc ?? null
    if (!synced || !isSyncedLrc(synced)) {
      throw new Error('Synced lyrics are required to set an offset.')
    }
    const shifted = setLrcOffset(synced, offsetMs)
    const written = this.writeSidecar(track, shifted)
    return userView(trackId, current?.plainLyrics ?? null, shifted, written)
  }

  async exportLrc(trackId: number): Promise<{ canceled: boolean; path: string | null }> {
    const track = this.repos.tracks.getById(trackId)
    if (!track) return { canceled: true, path: null }
    const res = readSidecarLrc(track.path) ?? readEmbeddedLyrics(track.path)
    const content = res?.syncedLyricsLrc ?? res?.plainLyrics ?? null
    if (!content) return { canceled: true, path: null }

    const safe = `${track.title} - ${track.artist}`.replace(/[\\/:*?"<>|]/g, '-')
    const result = await dialog.showSaveDialog({
      title: 'Export lyrics',
      defaultPath: `${safe}.lrc`,
      filters: [{ name: 'LRC', extensions: ['lrc'] }],
    })
    if (result.canceled || !result.filePath) return { canceled: true, path: null }
    writeFileSync(result.filePath, content, 'utf8')
    return { canceled: false, path: result.filePath }
  }

  remove(trackId: number): void {
    const track = this.repos.tracks.getById(trackId)
    if (track) removeSidecarLrc(track.path)
    this.notFound.delete(trackId)
  }

  // --- bounded selection fetch -------------------------------------------

  async fetchForSelection(trackIds: number[]): Promise<LyricsSelectionSummary> {
    const total = trackIds.length
    let done = 0
    let found = 0
    let failed = 0
    for (const id of trackIds) {
      try {
        const view = await this.fetchOnline(id)
        if (view.status === 'found_synced' || view.status === 'found_plain' || view.status === 'instrumental') {
          found++
        } else if (view.status === 'failed_provider') {
          failed++
        }
        broadcast('lyrics:changed', { trackId: id })
      } catch {
        failed++
      }
      done++
      broadcast('lyrics:selection:progress', { done, total, found, failed })
    }
    return { done, found, failed }
  }

  // --- internals ----------------------------------------------------------

  private persistChosen(track: DbTrack, raw: LrclibRaw, confidence: number): LyricsView {
    const instrumental = raw.instrumental
    const plain = instrumental ? null : raw.plainLyrics ?? null
    const synced = instrumental ? null : raw.syncedLyrics ?? null
    const content = synced ?? plain
    const written = content ? this.writeSidecar(track, content) : false
    this.notFound.delete(track.id)

    return {
      trackId: track.id,
      status: instrumental ? 'instrumental' : synced ? 'found_synced' : plain ? 'found_plain' : 'not_found',
      source: 'lrclib' as LyricsSource,
      plainLyrics: plain,
      syncedLyricsLrc: synced,
      instrumental,
      isUserEdited: false,
      embeddedInFile: false,
      sidecarWritten: written,
      confidence,
    }
  }

  // Write the `.lrc` sidecar next to the audio file. The sidecar is the canonical
  // store, so this always overwrites. Returns whether the write succeeded.
  private writeSidecar(track: DbTrack, content: string): boolean {
    try {
      writeSidecarLrc(track.path, content)
      return true
    } catch {
      return false
    }
  }
}

let instance: LyricsService | null = null

export function getLyricsService(): LyricsService {
  if (!instance) instance = new LyricsService()
  return instance
}
