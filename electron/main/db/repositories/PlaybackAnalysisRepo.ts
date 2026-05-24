import { gunzipSync, gzipSync } from 'node:zlib'
import type { Database as BetterSqliteDatabase, Statement } from 'better-sqlite3'
import type { DbTrack } from '@shared/types/db'
import type { PlaybackAnalysisResult, PlaybackCacheStats, PlaybackTableBarsResult } from '@shared/types/ipc-contract'

export const PLAYBACK_ANALYSIS_VERSION = 2
export const PLAYBACK_CACHE_DEFAULT_MAX_BYTES = 1024 * 1024 * 1024
const PLAYBACK_CACHE_MIN_MAX_BYTES = 64 * 1024 * 1024
const PLAYBACK_CACHE_MAX_MAX_BYTES = 100 * 1024 * 1024 * 1024
const MAX_BYTES_KEY = 'max_bytes'
const TABLE_BARS_FPS = 60
const TABLE_BARS_BANDS = 5

export interface TrackCacheFingerprint {
  fileSize: number | null
  fileMtimeMs: number | null
  trackDateModified: string | null
}

interface PlaybackAnalysisCacheRow {
  track_id: number
  analysis_version: number
  track_path: string
  file_size: number | null
  file_mtime_ms: number | null
  track_date_modified: string | null
  waveform_buckets: number
  spectrum_bins: number
  spectrum_frames: number
  waveform_peaks: Buffer
  spectrum_preview: Buffer
  dr_approx: number
  peak_db: number
  byte_size: number
  created_at: string
  last_accessed_at: string
}

interface PlaybackTableBarsCacheRow {
  track_id: number
  analysis_version: number
  track_path: string
  file_size: number | null
  file_mtime_ms: number | null
  track_date_modified: string | null
  fps: number
  bands: number
  frames: number
  duration_sec: number
  complete: number
  values_blob: Buffer
  byte_size: number
  created_at: string
  last_accessed_at: string
}

interface PruneCandidate {
  cache_type: 'analysis' | 'table_bars'
  track_id: number
  byte_size: number
}

function clampCacheBytes(value: number): number {
  if (!Number.isFinite(value)) return PLAYBACK_CACHE_DEFAULT_MAX_BYTES
  return Math.max(
    PLAYBACK_CACHE_MIN_MAX_BYTES,
    Math.min(PLAYBACK_CACHE_MAX_MAX_BYTES, Math.floor(value)),
  )
}

function encodeUnit16(values: number[]): Buffer {
  const buf = Buffer.allocUnsafe(values.length * 2)
  for (let i = 0; i < values.length; i++) {
    const value = Math.max(0, Math.min(1, values[i] ?? 0))
    buf.writeUInt16LE(Math.round(value * 65535), i * 2)
  }
  return buf
}

function decodeUnit16(buf: Buffer, count: number): number[] {
  const out = new Array(count).fill(0)
  const readable = Math.min(count, Math.floor(buf.length / 2))
  for (let i = 0; i < readable; i++) out[i] = buf.readUInt16LE(i * 2) / 65535
  return out
}

function encodeUnit8(values: number[]): Buffer {
  const buf = Buffer.allocUnsafe(values.length)
  for (let i = 0; i < values.length; i++) {
    const value = Math.max(0, Math.min(1, values[i] ?? 0))
    buf[i] = Math.round(value * 255)
  }
  return buf
}

function decodeUnit8(buf: Buffer, count: number): number[] {
  const out = new Array(count).fill(0)
  const readable = Math.min(count, buf.length)
  for (let i = 0; i < readable; i++) out[i] = buf[i] / 255
  return out
}

function sameNullableNumber(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return true
  return Math.round(a) === Math.round(b)
}

function sameNullableText(a: string | null, b: string | null): boolean {
  if (!a || !b) return true
  return a === b
}

export class PlaybackAnalysisRepo {
  private db: BetterSqliteDatabase
  private stmtGet: Statement
  private stmtTouch: Statement
  private stmtDeleteAnalysis: Statement
  private stmtGetTableBars: Statement
  private stmtTouchTableBars: Statement
  private stmtDeleteTableBars: Statement
  private stmtClear: Statement
  private stmtClearTableBars: Statement
  private stmtUpsert: Statement
  private stmtUpsertTableBars: Statement
  private stmtStats: Statement
  private stmtGetSetting: Statement
  private stmtSetSetting: Statement
  private stmtPruneCandidates: Statement

  constructor(db: BetterSqliteDatabase) {
    this.db = db
    this.stmtGet = db.prepare<[number], PlaybackAnalysisCacheRow>(
      `SELECT * FROM playback_analysis_cache WHERE track_id = ?`,
    )
    this.stmtTouch = db.prepare(`UPDATE playback_analysis_cache SET last_accessed_at = ? WHERE track_id = ?`)
    this.stmtDeleteAnalysis = db.prepare(`DELETE FROM playback_analysis_cache WHERE track_id = ?`)
    this.stmtGetTableBars = db.prepare<[number], PlaybackTableBarsCacheRow>(
      `SELECT * FROM playback_table_bars_cache WHERE track_id = ?`,
    )
    this.stmtTouchTableBars = db.prepare(`UPDATE playback_table_bars_cache SET last_accessed_at = ? WHERE track_id = ?`)
    this.stmtDeleteTableBars = db.prepare(`DELETE FROM playback_table_bars_cache WHERE track_id = ?`)
    this.stmtClear = db.prepare(`DELETE FROM playback_analysis_cache`)
    this.stmtClearTableBars = db.prepare(`DELETE FROM playback_table_bars_cache`)
    this.stmtUpsert = db.prepare(`
      INSERT INTO playback_analysis_cache (
        track_id, analysis_version, track_path, file_size, file_mtime_ms, track_date_modified,
        waveform_buckets, spectrum_bins, spectrum_frames, waveform_peaks, spectrum_preview,
        dr_approx, peak_db, byte_size, created_at, last_accessed_at
      ) VALUES (
        @trackId, @analysisVersion, @trackPath, @fileSize, @fileMtimeMs, @trackDateModified,
        @waveformBuckets, @spectrumBins, @spectrumFrames, @waveformPeaks, @spectrumPreview,
        @drApprox, @peakDb, @byteSize, @createdAt, @lastAccessedAt
      )
      ON CONFLICT(track_id) DO UPDATE SET
        analysis_version = excluded.analysis_version,
        track_path = excluded.track_path,
        file_size = excluded.file_size,
        file_mtime_ms = excluded.file_mtime_ms,
        track_date_modified = excluded.track_date_modified,
        waveform_buckets = excluded.waveform_buckets,
        spectrum_bins = excluded.spectrum_bins,
        spectrum_frames = excluded.spectrum_frames,
        waveform_peaks = excluded.waveform_peaks,
        spectrum_preview = excluded.spectrum_preview,
        dr_approx = excluded.dr_approx,
        peak_db = excluded.peak_db,
        byte_size = excluded.byte_size,
        created_at = excluded.created_at,
        last_accessed_at = excluded.last_accessed_at
    `)
    this.stmtUpsertTableBars = db.prepare(`
      INSERT INTO playback_table_bars_cache (
        track_id, analysis_version, track_path, file_size, file_mtime_ms, track_date_modified,
        fps, bands, frames, duration_sec, complete, values_blob,
        byte_size, created_at, last_accessed_at
      ) VALUES (
        @trackId, @analysisVersion, @trackPath, @fileSize, @fileMtimeMs, @trackDateModified,
        @fps, @bands, @frames, @durationSec, @complete, @valuesBlob,
        @byteSize, @createdAt, @lastAccessedAt
      )
      ON CONFLICT(track_id) DO UPDATE SET
        analysis_version = excluded.analysis_version,
        track_path = excluded.track_path,
        file_size = excluded.file_size,
        file_mtime_ms = excluded.file_mtime_ms,
        track_date_modified = excluded.track_date_modified,
        fps = excluded.fps,
        bands = excluded.bands,
        frames = excluded.frames,
        duration_sec = excluded.duration_sec,
        complete = excluded.complete,
        values_blob = excluded.values_blob,
        byte_size = excluded.byte_size,
        created_at = excluded.created_at,
        last_accessed_at = excluded.last_accessed_at
    `)
    this.stmtStats = db.prepare(`
      SELECT
        COALESCE(SUM(byte_size), 0) as usedBytes,
        COUNT(*) as entries
      FROM (
        SELECT byte_size FROM playback_analysis_cache
        UNION ALL
        SELECT byte_size FROM playback_table_bars_cache
      )
    `)
    this.stmtGetSetting = db.prepare<[string], { value: string }>(`SELECT value FROM playback_cache_settings WHERE key = ?`)
    this.stmtSetSetting = db.prepare(`
      INSERT INTO playback_cache_settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `)
    this.stmtPruneCandidates = db.prepare<[], PruneCandidate>(`
      SELECT
        'analysis' as cache_type,
        c.track_id,
        c.byte_size,
        c.last_accessed_at,
        COALESCE(t.play_count, 0) as play_count,
        COALESCE(t.last_played_date, '') as last_played_date
      FROM playback_analysis_cache c
      JOIN tracks t ON t.id = c.track_id
      UNION ALL
      SELECT
        'table_bars' as cache_type,
        c.track_id,
        c.byte_size,
        c.last_accessed_at,
        COALESCE(t.play_count, 0) as play_count,
        COALESCE(t.last_played_date, '') as last_played_date
      FROM playback_table_bars_cache c
      JOIN tracks t ON t.id = c.track_id
      ORDER BY
        play_count ASC,
        last_played_date ASC,
        last_accessed_at ASC
    `)
  }

  getMaxBytes(): number {
    const raw = this.stmtGetSetting.get(MAX_BYTES_KEY) as { value: string } | undefined
    const parsed = raw ? Number(raw.value) : PLAYBACK_CACHE_DEFAULT_MAX_BYTES
    return clampCacheBytes(parsed)
  }

  setMaxBytes(maxBytes: number, protectedTrackId: number | null = null): PlaybackCacheStats {
    const clamped = clampCacheBytes(maxBytes)
    this.stmtSetSetting.run(MAX_BYTES_KEY, String(clamped), new Date().toISOString())
    this.prune(protectedTrackId)
    return this.stats()
  }

  stats(): PlaybackCacheStats {
    const row = this.stmtStats.get() as { usedBytes: number; entries: number } | undefined
    return {
      maxBytes: this.getMaxBytes(),
      usedBytes: Number(row?.usedBytes ?? 0),
      entries: Number(row?.entries ?? 0),
    }
  }

  clear(): PlaybackCacheStats {
    const tx = this.db.transaction(() => {
      this.stmtClear.run()
      this.stmtClearTableBars.run()
    })
    tx()
    return this.stats()
  }

  getValid(track: DbTrack, buckets: number, fingerprint: TrackCacheFingerprint): PlaybackAnalysisResult | null {
    const row = this.stmtGet.get(track.id) as PlaybackAnalysisCacheRow | undefined
    if (!row) return null

    const stale =
      row.analysis_version !== PLAYBACK_ANALYSIS_VERSION ||
      row.waveform_buckets !== buckets ||
      row.track_path !== track.path ||
      !sameNullableNumber(row.file_size, fingerprint.fileSize) ||
      !sameNullableNumber(row.file_mtime_ms, fingerprint.fileMtimeMs) ||
      !sameNullableText(row.track_date_modified, fingerprint.trackDateModified)

    if (stale) {
      this.deleteAnalysis(track.id)
      return null
    }

    try {
      const peaks = decodeUnit16(gunzipSync(row.waveform_peaks), row.waveform_buckets)
      this.stmtTouch.run(new Date().toISOString(), track.id)
      return {
        peaks,
        drApprox: row.dr_approx,
        peakDb: row.peak_db,
        buckets: row.waveform_buckets,
        analysisVersion: row.analysis_version,
        source: 'cache',
      }
    } catch {
      this.deleteAnalysis(track.id)
      return null
    }
  }

  getValidTableBars(track: DbTrack, fingerprint: TrackCacheFingerprint): PlaybackTableBarsResult | null {
    const row = this.stmtGetTableBars.get(track.id) as PlaybackTableBarsCacheRow | undefined
    if (!row) return null

    const stale =
      row.analysis_version !== PLAYBACK_ANALYSIS_VERSION ||
      row.fps !== TABLE_BARS_FPS ||
      row.bands !== TABLE_BARS_BANDS ||
      row.complete !== 1 ||
      row.frames <= 0 ||
      row.track_path !== track.path ||
      !sameNullableNumber(row.file_size, fingerprint.fileSize) ||
      !sameNullableNumber(row.file_mtime_ms, fingerprint.fileMtimeMs) ||
      !sameNullableText(row.track_date_modified, fingerprint.trackDateModified)

    if (stale) {
      this.deleteTableBars(track.id)
      return null
    }

    try {
      const valueCount = row.frames * row.bands
      const values = decodeUnit8(gunzipSync(row.values_blob), valueCount)
      if (values.length !== valueCount) throw new Error('invalid table-bars payload')
      this.stmtTouchTableBars.run(new Date().toISOString(), track.id)
      return {
        analysisVersion: row.analysis_version,
        source: 'cache',
        fps: TABLE_BARS_FPS,
        bands: TABLE_BARS_BANDS,
        frames: row.frames,
        durationSec: row.duration_sec,
        complete: true,
        values,
      }
    } catch {
      this.deleteTableBars(track.id)
      return null
    }
  }

  save(
    track: DbTrack,
    fingerprint: TrackCacheFingerprint,
    result: PlaybackAnalysisResult,
    protectedTrackIds: Array<number | null> = [track.id],
  ): PlaybackCacheStats {
    const waveformPeaks = gzipSync(encodeUnit16(result.peaks))
    const spectrumPreview = gzipSync(Buffer.alloc(0))
    const now = new Date().toISOString()
    const byteSize = waveformPeaks.length + spectrumPreview.length

    this.stmtUpsert.run({
      trackId: track.id,
      analysisVersion: PLAYBACK_ANALYSIS_VERSION,
      trackPath: track.path,
      fileSize: fingerprint.fileSize,
      fileMtimeMs: fingerprint.fileMtimeMs,
      trackDateModified: fingerprint.trackDateModified,
      waveformBuckets: result.buckets,
      spectrumBins: 0,
      spectrumFrames: 0,
      waveformPeaks,
      spectrumPreview,
      drApprox: result.drApprox,
      peakDb: result.peakDb,
      byteSize,
      createdAt: now,
      lastAccessedAt: now,
    })

    this.prune(protectedTrackIds)
    return this.stats()
  }

  saveTableBars(
    track: DbTrack,
    fingerprint: TrackCacheFingerprint,
    result: PlaybackTableBarsResult,
    protectedTrackIds: Array<number | null> = [track.id],
  ): PlaybackCacheStats {
    const valuesBlob = gzipSync(encodeUnit8(result.values))
    const now = new Date().toISOString()
    const byteSize = valuesBlob.length

    this.stmtUpsertTableBars.run({
      trackId: track.id,
      analysisVersion: PLAYBACK_ANALYSIS_VERSION,
      trackPath: track.path,
      fileSize: fingerprint.fileSize,
      fileMtimeMs: fingerprint.fileMtimeMs,
      trackDateModified: fingerprint.trackDateModified,
      fps: result.fps,
      bands: result.bands,
      frames: result.frames,
      durationSec: result.durationSec,
      complete: result.complete ? 1 : 0,
      valuesBlob,
      byteSize,
      createdAt: now,
      lastAccessedAt: now,
    })

    this.prune(protectedTrackIds)
    return this.stats()
  }

  deleteAnalysis(trackId: number): void {
    this.stmtDeleteAnalysis.run(trackId)
  }

  deleteTableBars(trackId: number): void {
    this.stmtDeleteTableBars.run(trackId)
  }

  prune(protectedTrackIds: number | Array<number | null> | null = null): PlaybackCacheStats {
    const maxBytes = this.getMaxBytes()
    let stats = this.stats()
    if (stats.usedBytes <= maxBytes) return stats

    const protectedSet = new Set(
      (Array.isArray(protectedTrackIds) ? protectedTrackIds : [protectedTrackIds])
        .filter((id): id is number => id != null && Number.isInteger(id) && id > 0),
    )
    const candidates = (this.stmtPruneCandidates.all() as PruneCandidate[])
      .filter(row => !protectedSet.has(row.track_id))
    const tx = this.db.transaction((rows: PruneCandidate[]) => {
      let usedBytes = stats.usedBytes
      for (const row of rows) {
        if (usedBytes <= maxBytes) break
        if (row.cache_type === 'table_bars') {
          this.stmtDeleteTableBars.run(row.track_id)
        } else {
          this.stmtDeleteAnalysis.run(row.track_id)
        }
        usedBytes -= row.byte_size
      }
    })
    tx(candidates)
    stats = this.stats()
    return stats
  }
}
