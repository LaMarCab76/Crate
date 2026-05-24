import { dialog } from 'electron'
import { writeFileSync } from 'node:fs'
import { getRepos, type Repos } from '../db/repositories'
import { broadcast } from '../ipc/events'
import type { DbTrack, DbTrackLyrics } from '@shared/types/db'
import type {
  LyricsCandidate,
  LyricsEmbedPreview,
  LyricsEmbedResult,
  LyricsResult,
  LyricsSource,
  LyricsStatus,
  LyricsView,
  LyricsWriteOptions,
  LyricsSelectionSummary,
} from '@shared/types/lyrics'
import { isSyncedLrc, setLrcOffset } from '@shared/lyrics/lrc'
import { getLyricsSettings } from './LyricsSettings'
import {
  ACCEPT_AUTO,
  ACCEPT_REVIEW,
  isExactDurationCompatible,
  scoreCandidate,
  toConfidence,
} from './LyricsMatcher'
import { LrclibProvider, LrclibRateLimitError, type LrclibQuery, type LrclibRaw } from './providers/LrclibProvider'
import { readEmbeddedLyrics, hasEmbeddedLyrics } from './providers/EmbeddedLyricsProvider'
import { readSidecarLrc, sidecarPathFor } from './providers/SidecarLrcProvider'
import { writeFlacLyrics } from './writers/FlacVorbisLyricsWriter'
import { writeSidecarLrc, removeSidecarLrc } from './writers/SidecarLrcWriter'
import { stripFlacLyrics } from './writers/stripFlacLyrics'
import { extname } from 'node:path'

const NOT_FOUND_TTL_MS = 7 * 24 * 60 * 60 * 1000
const LOW_CONFIDENCE = 0.8 // < this (for an lrclib row not user-edited) => 'low_confidence'

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

function viewFromRow(row: DbTrackLyrics): LyricsView {
  const instrumental = row.instrumental === 1
  const synced = row.synced_lyrics_lrc
  const plain = row.plain_lyrics
  let status: LyricsStatus
  if (instrumental) status = 'instrumental'
  else if (synced) status = 'found_synced'
  else if (plain) status = 'found_plain'
  else status = 'none'

  if (
    (status === 'found_synced' || status === 'found_plain') &&
    row.is_user_edited !== 1 &&
    row.source === 'lrclib' &&
    row.confidence > 0 &&
    row.confidence < LOW_CONFIDENCE
  ) {
    status = 'low_confidence'
  }

  return {
    trackId: row.track_id,
    status,
    source: row.source as LyricsSource,
    plainLyrics: plain,
    syncedLyricsLrc: synced,
    instrumental,
    isUserEdited: row.is_user_edited === 1,
    embeddedInFile: row.embedded_in_file === 1,
    sidecarWritten: row.sidecar_written === 1,
    confidence: row.confidence,
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

  constructor() {
    this.repos = getRepos()
  }

  // --- read-only resolution (no network) ---------------------------------

  getForTrack(trackId: number): LyricsView {
    const track = this.repos.tracks.getById(trackId)
    if (!track) return emptyView(trackId, 'none')

    const row = this.repos.lyrics.getByTrackId(trackId)
    if (row) return viewFromRow(row)

    // No DB row yet: read local file sources in priority order and seed.
    const embedded = readEmbeddedLyrics(track.path)
    if (embedded) {
      const seeded = this.seedFromResult(trackId, embedded)
      this.repos.lyrics.markEmbedded(trackId, true)
      return viewFromRow(this.repos.lyrics.getByTrackId(trackId) ?? seeded)
    }

    const sidecar = readSidecarLrc(track.path)
    if (sidecar) {
      const seeded = this.seedFromResult(trackId, sidecar)
      this.repos.lyrics.markSidecarWritten(trackId, true, sidecarPathFor(track.path))
      return viewFromRow(this.repos.lyrics.getByTrackId(trackId) ?? seeded)
    }

    const last = this.repos.lyrics.lastFailure(trackId)
    if (last?.reason === 'provider_not_found') return emptyView(trackId, 'not_found')
    return emptyView(trackId, 'none')
  }

  // --- online fetch (auto-accept) ----------------------------------------

  async fetchOnline(trackId: number, opts?: { force?: boolean }): Promise<LyricsView> {
    const track = this.repos.tracks.getById(trackId)
    if (!track) return emptyView(trackId, 'none')
    if (!track.title.trim() || !track.artist.trim()) {
      this.repos.lyrics.recordFailure(trackId, 'matcher', 'missing_metadata')
      return emptyView(trackId, 'not_found')
    }

    if (!opts?.force) {
      const last = this.repos.lyrics.lastFailure(trackId)
      if (last?.reason === 'provider_not_found' && Date.now() - last.failed_at < NOT_FOUND_TTL_MS) {
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
            this.repos.lyrics.recordFailure(trackId, 'matcher', 'low_confidence_match')
            return emptyView(trackId, 'low_confidence')
          }
        }
      }

      if (!chosen) {
        this.repos.lyrics.recordFailure(trackId, 'lrclib', 'provider_not_found')
        return emptyView(trackId, 'not_found')
      }

      return this.persistChosen(track, chosen, confidence)
    } catch (err) {
      const reason = err instanceof LrclibRateLimitError ? 'provider_rate_limited' : 'provider_timeout'
      this.repos.lyrics.recordFailure(trackId, 'lrclib', reason)
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
    } catch (err) {
      const reason = err instanceof LrclibRateLimitError ? 'provider_rate_limited' : 'provider_timeout'
      this.repos.lyrics.recordFailure(trackId, 'lrclib', reason)
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
    const plain = synced ? null : lrcText
    const syncedLrc = synced ? lrcText : null
    this.repos.lyrics.setUserEdited(trackId, plain, syncedLrc)
    this.maybeWriteSidecar(track, syncedLrc)
    return viewFromRow(this.repos.lyrics.getByTrackId(trackId)!)
  }

  saveUserEdit(trackId: number, plain: string | null, synced: string | null): LyricsView {
    const track = this.repos.tracks.getById(trackId)
    if (!track) return emptyView(trackId, 'none')
    this.repos.lyrics.setUserEdited(trackId, plain, synced)
    this.maybeWriteSidecar(track, synced)
    return viewFromRow(this.repos.lyrics.getByTrackId(trackId)!)
  }

  setOffset(trackId: number, offsetMs: number): LyricsView {
    const track = this.repos.tracks.getById(trackId)
    if (!track) return emptyView(trackId, 'none')
    const row = this.repos.lyrics.getByTrackId(trackId)
    if (!row?.synced_lyrics_lrc || !isSyncedLrc(row.synced_lyrics_lrc)) {
      throw new Error('Synced lyrics are required to set an offset.')
    }
    const synced = setLrcOffset(row.synced_lyrics_lrc, offsetMs)
    this.repos.lyrics.setUserEdited(trackId, row.plain_lyrics, synced)
    this.maybeWriteSidecar(track, synced)
    return viewFromRow(this.repos.lyrics.getByTrackId(trackId)!)
  }

  async exportLrc(trackId: number): Promise<{ canceled: boolean; path: string | null }> {
    const track = this.repos.tracks.getById(trackId)
    const row = this.repos.lyrics.getByTrackId(trackId)
    const content = row?.synced_lyrics_lrc ?? row?.plain_lyrics ?? null
    if (!track || !content) return { canceled: true, path: null }

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

  // --- FLAC embed (opt-in) -----------------------------------------------

  previewEmbed(trackId: number): LyricsEmbedPreview {
    const track = this.repos.tracks.getById(trackId)
    const row = this.repos.lyrics.getByTrackId(trackId)
    const settings = getLyricsSettings().get()
    const path = track?.path ?? ''
    const isFlac = path !== '' && extname(path).toLowerCase() === '.flac'
    const existing = isFlac ? hasEmbeddedLyrics(path) : { synced: false, plain: false }
    const hasExistingLyrics = existing.synced || existing.plain
    const willWriteUnsynced = Boolean(row?.plain_lyrics)
    const willWriteSynced = Boolean(row?.synced_lyrics_lrc)

    let blocked: LyricsEmbedPreview['blocked'] = null
    if (!track) blocked = 'file_not_found'
    else if (!isFlac) blocked = 'not_flac'
    else if (!willWriteUnsynced && !willWriteSynced) blocked = 'missing_metadata'
    else if (hasExistingLyrics && !settings.overwriteExisting) blocked = 'existing_lyrics'

    return {
      trackId,
      path,
      isFlac,
      hasExistingLyrics,
      willWriteUnsynced,
      willWriteSynced,
      willBackup: settings.backupBeforeModifying,
      blocked,
    }
  }

  embedInFile(trackId: number, opts?: Partial<LyricsWriteOptions>): LyricsEmbedResult {
    const track = this.repos.tracks.getById(trackId)
    const row = this.repos.lyrics.getByTrackId(trackId)
    if (!track) return { ok: false, reason: 'file_not_found', verified: false }
    if (!row || (!row.plain_lyrics && !row.synced_lyrics_lrc)) {
      return { ok: false, reason: 'missing_metadata', verified: false }
    }

    const settings = getLyricsSettings().get()
    const result = writeFlacLyrics({
      path: track.path,
      plainLyrics: row.plain_lyrics,
      syncedLyricsLrc: row.synced_lyrics_lrc,
      sourceId: row.source_id,
      overwriteExisting: opts?.overwriteExisting ?? settings.overwriteExisting,
      createBackup: opts?.createBackup ?? settings.backupBeforeModifying,
    })

    if (result.ok) this.repos.lyrics.markEmbedded(trackId, true)
    else this.repos.lyrics.recordFailure(trackId, 'flac-writer', result.reason ?? 'unknown')
    return result
  }

  remove(trackId: number, opts?: { stripEmbedded?: boolean }): void {
    const track = this.repos.tracks.getById(trackId)
    const row = this.repos.lyrics.getByTrackId(trackId)
    if (track && row?.sidecar_written === 1) removeSidecarLrc(track.path)
    if (track && opts?.stripEmbedded && row?.embedded_in_file === 1) stripFlacLyrics(track.path)
    this.repos.lyrics.delete(trackId)
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
    const settings = getLyricsSettings().get()
    const instrumental = raw.instrumental
    const plain = instrumental ? null : raw.plainLyrics
    const synced = instrumental ? null : raw.syncedLyrics

    if (settings.cacheLocal) {
      this.repos.lyrics.upsert({
        track_id: track.id,
        plain_lyrics: plain,
        synced_lyrics_lrc: synced,
        source: 'lrclib',
        source_id: String(raw.id),
        source_url: `https://lrclib.net/api/get/${raw.id}`,
        confidence,
        instrumental: instrumental ? 1 : 0,
      })
    }
    this.maybeWriteSidecar(track, synced)

    const row = this.repos.lyrics.getByTrackId(track.id)
    if (row) return viewFromRow(row)
    // cacheLocal disabled: build a transient view from the raw result.
    return {
      trackId: track.id,
      status: instrumental ? 'instrumental' : synced ? 'found_synced' : plain ? 'found_plain' : 'not_found',
      source: 'lrclib',
      plainLyrics: plain,
      syncedLyricsLrc: synced,
      instrumental,
      isUserEdited: false,
      embeddedInFile: false,
      sidecarWritten: false,
      confidence,
    }
  }

  private maybeWriteSidecar(track: DbTrack, synced: string | null): void {
    if (!synced) return
    if (!getLyricsSettings().get().createSidecar) return
    try {
      const path = writeSidecarLrc(track.path, synced)
      this.repos.lyrics.markSidecarWritten(track.id, true, path)
    } catch {
      this.repos.lyrics.recordFailure(track.id, 'sidecar-writer', 'write_failed')
    }
  }

  private seedFromResult(trackId: number, res: LyricsResult): DbTrackLyrics {
    return this.repos.lyrics.upsert({
      track_id: trackId,
      plain_lyrics: res.plainLyrics ?? null,
      synced_lyrics_lrc: res.syncedLyricsLrc ?? null,
      source: res.source,
      source_id: res.sourceId ?? null,
      source_url: res.sourceUrl ?? null,
      confidence: res.confidence,
      instrumental: res.instrumental ? 1 : 0,
    })
  }
}

let instance: LyricsService | null = null

export function getLyricsService(): LyricsService {
  if (!instance) instance = new LyricsService()
  return instance
}
