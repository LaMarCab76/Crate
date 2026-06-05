import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import type { DbFolder } from '@shared/types/db'

export class FolderRepo {
  private db: BetterSqliteDatabase
  private stmtList
  private stmtById
  private stmtByPath
  private stmtInsert
  private stmtInsertCloud
  private stmtSetDeltaLink
  private stmtRemove
  private stmtUpdateTrackCount
  private stmtSetBookmark

  constructor(db: BetterSqliteDatabase) {
    this.db = db
    this.stmtList = db.prepare<unknown[], DbFolder>(`SELECT * FROM folders ORDER BY date_added ASC`)
    this.stmtById = db.prepare<[number], DbFolder>(`SELECT * FROM folders WHERE id = ?`)
    this.stmtByPath = db.prepare<[string], DbFolder>(`SELECT * FROM folders WHERE path = ?`)
    this.stmtInsert = db.prepare(`
      INSERT INTO folders (name, path, track_count, date_added, date_updated, bookmark_data)
      VALUES (?, ?, 0, ?, ?, ?)
    `)
    this.stmtInsertCloud = db.prepare(`
      INSERT INTO folders (name, path, track_count, date_added, date_updated, bookmark_data,
        source, cloud_drive_id, cloud_item_id, cloud_delta_link)
      VALUES (?, ?, 0, ?, ?, NULL, 'onedrive', ?, ?, NULL)
    `)
    this.stmtSetDeltaLink = db.prepare(`UPDATE folders SET cloud_delta_link = ?, date_updated = ? WHERE id = ?`)
    this.stmtRemove = db.prepare(`DELETE FROM folders WHERE id = ?`)
    this.stmtUpdateTrackCount = db.prepare(`
      UPDATE folders SET track_count = ?, date_updated = ? WHERE id = ?
    `)
    this.stmtSetBookmark = db.prepare(`UPDATE folders SET bookmark_data = ? WHERE id = ?`)
  }

  list(): DbFolder[] {
    return this.stmtList.all()
  }

  getById(id: number): DbFolder | undefined {
    return this.stmtById.get(id)
  }

  getByPath(path: string): DbFolder | undefined {
    return this.stmtByPath.get(path)
  }

  add(path: string, name: string): DbFolder {
    const existing = this.getByPath(path)
    if (existing) return existing
    const now = new Date().toISOString()
    const result = this.stmtInsert.run(name, path, now, now, null)
    return this.getById(Number(result.lastInsertRowid))!
  }

  // Register a OneDrive folder. Its synthetic `path` (onedrive://{driveId}/{itemId})
  // keeps the UNIQUE/NOT NULL contract without ever touching the filesystem.
  addCloud(driveId: string, itemId: string, name: string): DbFolder {
    const path = `onedrive://${driveId}/${itemId}`
    const existing = this.getByPath(path)
    if (existing) return existing
    const now = new Date().toISOString()
    const result = this.stmtInsertCloud.run(name, path, now, now, driveId, itemId)
    return this.getById(Number(result.lastInsertRowid))!
  }

  setDeltaLink(id: number, deltaLink: string | null): void {
    this.stmtSetDeltaLink.run(deltaLink, new Date().toISOString(), id)
  }

  remove(id: number): void {
    this.stmtRemove.run(id)
  }

  updateTrackCount(id: number, count: number): void {
    this.stmtUpdateTrackCount.run(count, new Date().toISOString(), id)
  }

  setBookmark(id: number, data: Buffer | null): void {
    this.stmtSetBookmark.run(data, id)
  }
}
