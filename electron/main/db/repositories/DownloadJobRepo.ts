import type { Database as BetterSqliteDatabase, Statement } from 'better-sqlite3'
import type { DownloadJob, DownloadProvider, DownloadQuality, DownloadStatus, OnlineTrackResult } from '@shared/types/downloads'

interface DownloadJobRow {
  id: string
  provider: DownloadProvider
  provider_track_id: string
  status: DownloadStatus
  quality: DownloadQuality
  folder_id: number | null
  title: string
  artist: string
  album: string
  artwork_url: string | null
  source_url: string | null
  path: string | null
  error: string | null
  bytes_received: number
  bytes_total: number | null
  created_at: number
  updated_at: number
  completed_at: number | null
}

const SELECT_COLUMNS = `
  id, provider, provider_track_id, status, quality, folder_id, title, artist, album,
  artwork_url, source_url, path, error, bytes_received, bytes_total,
  created_at, updated_at, completed_at
`

function toJob(row: DownloadJobRow): DownloadJob {
  return {
    id: row.id,
    provider: row.provider,
    providerTrackId: row.provider_track_id,
    status: row.status,
    quality: row.quality,
    folderId: row.folder_id,
    title: row.title,
    artist: row.artist,
    album: row.album,
    artworkUrl: row.artwork_url,
    sourceUrl: row.source_url,
    path: row.path,
    error: row.error,
    bytesReceived: row.bytes_received,
    bytesTotal: row.bytes_total,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }
}

export class DownloadJobRepo {
  private stmtList: Statement
  private stmtQueued: Statement
  private stmtById: Statement
  private stmtInsert: Statement
  private stmtUpdateStatus: Statement
  private stmtUpdateProgress: Statement
  private stmtUpdatePath: Statement
  private stmtResetForRetry: Statement

  constructor(db: BetterSqliteDatabase) {
    this.stmtList = db.prepare<unknown[], DownloadJobRow>(`
      SELECT ${SELECT_COLUMNS}
      FROM download_jobs
      ORDER BY created_at DESC
      LIMIT 300
    `)
    this.stmtQueued = db.prepare<unknown[], DownloadJobRow>(`
      SELECT ${SELECT_COLUMNS}
      FROM download_jobs
      WHERE status = 'queued'
      ORDER BY created_at ASC
      LIMIT 20
    `)
    this.stmtById = db.prepare<[string], DownloadJobRow>(`
      SELECT ${SELECT_COLUMNS}
      FROM download_jobs
      WHERE id = ?
    `)
    this.stmtInsert = db.prepare(`
      INSERT INTO download_jobs (
        id, provider, provider_track_id, status, quality, folder_id,
        title, artist, album, artwork_url, source_url, metadata_json,
        path, error, bytes_received, bytes_total, created_at, updated_at, completed_at
      ) VALUES (
        @id, @provider, @providerTrackId, @status, @quality, @folderId,
        @title, @artist, @album, @artworkUrl, @sourceUrl, @metadataJson,
        @path, @error, @bytesReceived, @bytesTotal, @createdAt, @updatedAt, @completedAt
      )
    `)
    this.stmtUpdateStatus = db.prepare(`
      UPDATE download_jobs
      SET status = @status,
          error = @error,
          updated_at = @updatedAt,
          completed_at = @completedAt
      WHERE id = @id
    `)
    this.stmtUpdateProgress = db.prepare(`
      UPDATE download_jobs
      SET bytes_received = @bytesReceived,
          bytes_total = @bytesTotal,
          updated_at = @updatedAt
      WHERE id = @id
    `)
    this.stmtUpdatePath = db.prepare(`
      UPDATE download_jobs
      SET path = @path,
          updated_at = @updatedAt
      WHERE id = @id
    `)
    this.stmtResetForRetry = db.prepare(`
      UPDATE download_jobs
      SET status = 'queued',
          error = NULL,
          bytes_received = 0,
          bytes_total = NULL,
          updated_at = @updatedAt,
          completed_at = NULL
      WHERE id = @id
    `)
  }

  list(): DownloadJob[] {
    return (this.stmtList.all() as DownloadJobRow[]).map(toJob)
  }

  queued(): DownloadJob[] {
    return (this.stmtQueued.all() as DownloadJobRow[]).map(toJob)
  }

  getById(id: string): DownloadJob | null {
    const row = this.stmtById.get(id) as DownloadJobRow | undefined
    return row ? toJob(row) : null
  }

  insert(track: OnlineTrackResult, args: { id: string; folderId: number | null; quality: DownloadQuality }): DownloadJob {
    const now = Date.now()
    this.stmtInsert.run({
      id: args.id,
      provider: track.provider,
      providerTrackId: track.providerTrackId,
      status: 'queued',
      quality: args.quality,
      folderId: args.folderId,
      title: track.title || 'Unknown Title',
      artist: track.artist || 'Unknown Artist',
      album: track.album || 'Unknown Album',
      artworkUrl: track.artworkUrl,
      sourceUrl: track.sourceUrl,
      metadataJson: JSON.stringify(track),
      path: null,
      error: null,
      bytesReceived: 0,
      bytesTotal: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    })
    return this.getById(args.id)!
  }

  setStatus(id: string, status: DownloadStatus, error: string | null = null): DownloadJob | null {
    const completedAt = ['completed', 'failed', 'cancelled', 'unavailable', 'already_exists'].includes(status)
      ? Date.now()
      : null
    this.stmtUpdateStatus.run({ id, status, error, updatedAt: Date.now(), completedAt })
    return this.getById(id)
  }

  setProgress(id: string, bytesReceived: number, bytesTotal: number | null): DownloadJob | null {
    this.stmtUpdateProgress.run({ id, bytesReceived, bytesTotal, updatedAt: Date.now() })
    return this.getById(id)
  }

  setPath(id: string, path: string | null): DownloadJob | null {
    this.stmtUpdatePath.run({ id, path, updatedAt: Date.now() })
    return this.getById(id)
  }

  resetForRetry(id: string): DownloadJob | null {
    this.stmtResetForRetry.run({ id, updatedAt: Date.now() })
    return this.getById(id)
  }
}
