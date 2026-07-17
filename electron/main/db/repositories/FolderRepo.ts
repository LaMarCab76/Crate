import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import type { DbFolder } from '@shared/types/db'
import type { LibraryLocation } from '@shared/types/library-locations'
import { posix, relative, resolve } from 'node:path'

export interface AddOneDriveFolderArgs {
  accountId: string
  driveId: string
  itemId: string
  name: string
  remotePath: string
}

function pathsOverlap(left: string, right: string): boolean {
  const comparable = (value: string) => {
    const path = resolve(value).normalize('NFC')
    return process.platform === 'win32' || process.platform === 'darwin'
      ? path.toLocaleLowerCase('en-US')
      : path
  }
  const a = comparable(left)
  const b = comparable(right)
  if (a === b) return true
  const aToB = relative(a, b)
  const bToA = relative(b, a)
  return (!aToB.startsWith('..') && aToB !== '') || (!bToA.startsWith('..') && bToA !== '')
}

function normalizedRemotePath(value: string): string {
  return posix
    .normalize(value.startsWith('/') ? value : `/${value}`)
    .normalize('NFC')
    .toLocaleLowerCase('en-US')
}

function remotePathsOverlap(left: string, right: string): boolean {
  const a = normalizedRemotePath(left)
  const b = normalizedRemotePath(right)
  const within = (child: string, parent: string) => (
    parent === '/' ? child.startsWith('/') : child.startsWith(`${parent}/`)
  )
  return a === b || within(a, b) || within(b, a)
}

function locationsOverlap(left: DbFolder, right: DbFolder): boolean {
  if (left.provider !== right.provider) return false
  if (left.provider === 'local') return pathsOverlap(left.path, right.path)
  return (
    left.drive_id != null
    && left.drive_id === right.drive_id
    && left.remote_path != null
    && right.remote_path != null
    && remotePathsOverlap(left.remote_path, right.remote_path)
  )
}

export function toLibraryLocation(folder: DbFolder): LibraryLocation {
  return {
    id: folder.id,
    name: folder.name,
    path: folder.path,
    provider: folder.provider,
    role: folder.role,
    backupSourceFolderId: folder.backup_source_folder_id,
    trackCount: folder.track_count,
    accountId: folder.account_id,
    driveId: folder.drive_id,
    itemId: folder.item_id,
    remotePath: folder.remote_path,
    deltaCursor: folder.delta_cursor,
    displayIcon: folder.display_icon,
    dateAdded: folder.date_added,
    dateUpdated: folder.date_updated,
  }
}

export class FolderRepo {
  private db: BetterSqliteDatabase
  private stmtList
  private stmtListAll
  private stmtListBackups
  private stmtById
  private stmtByPath
  private stmtInsert
  private stmtInsertOneDrive
  private stmtRemove
  private stmtUpdateTrackCount
  private stmtSetBookmark
  private stmtSetDeltaCursor
  private stmtBackupForSource

  constructor(db: BetterSqliteDatabase) {
    this.db = db
    // Existing catalog callers use list(). Keeping backups out here makes it
    // impossible for watchers, downloads and device sync to treat a mirror as
    // a second library accidentally. Settings/onboarding use listAll().
    this.stmtList = db.prepare<unknown[], DbFolder>(`
      SELECT * FROM folders WHERE role = 'library' ORDER BY date_added ASC
    `)
    this.stmtListAll = db.prepare<unknown[], DbFolder>(`SELECT * FROM folders ORDER BY date_added ASC`)
    this.stmtListBackups = db.prepare<unknown[], DbFolder>(`
      SELECT * FROM folders WHERE role = 'backup' ORDER BY date_added ASC
    `)
    this.stmtById = db.prepare<[number], DbFolder>(`SELECT * FROM folders WHERE id = ?`)
    this.stmtByPath = db.prepare<[string], DbFolder>(`SELECT * FROM folders WHERE path = ?`)
    this.stmtInsert = db.prepare(`
      INSERT INTO folders (name, path, track_count, date_added, date_updated, bookmark_data)
      VALUES (?, ?, 0, ?, ?, ?)
    `)
    this.stmtInsertOneDrive = db.prepare(`
      INSERT INTO folders (
        name, path, track_count, date_added, date_updated, bookmark_data,
        provider, role, account_id, drive_id, item_id, remote_path
      ) VALUES (?, ?, 0, ?, ?, NULL, 'onedrive', 'library', ?, ?, ?, ?)
    `)
    this.stmtRemove = db.prepare(`DELETE FROM folders WHERE id = ?`)
    this.stmtUpdateTrackCount = db.prepare(`
      UPDATE folders SET track_count = ?, date_updated = ? WHERE id = ?
    `)
    this.stmtSetBookmark = db.prepare(`UPDATE folders SET bookmark_data = ? WHERE id = ?`)
    this.stmtSetDeltaCursor = db.prepare(`
      UPDATE folders SET delta_cursor = ?, date_updated = ? WHERE id = ? AND provider = 'onedrive'
    `)
    this.stmtBackupForSource = db.prepare<[number], DbFolder>(`
      SELECT * FROM folders WHERE role = 'backup' AND backup_source_folder_id = ?
    `)
  }

  list(): DbFolder[] {
    return this.stmtList.all()
  }

  listLibraries(): DbFolder[] {
    return this.list()
  }

  listAll(): DbFolder[] {
    return this.stmtListAll.all()
  }

  listBackups(): DbFolder[] {
    return this.stmtListBackups.all()
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

  addOneDrive(args: AddOneDriveFolderArgs): DbFolder {
    const path = `onedrive://${args.driveId}/${args.itemId}`
    const existing = this.getByPath(path)
    if (existing) return existing
    const now = new Date().toISOString()
    const result = this.stmtInsertOneDrive.run(
      args.name,
      path,
      now,
      now,
      args.accountId,
      args.driveId,
      args.itemId,
      args.remotePath,
    )
    return this.getById(Number(result.lastInsertRowid))!
  }

  addCloud(
    driveId: string,
    itemId: string,
    name: string,
    options: { accountId?: string; remotePath?: string } = {},
  ): DbFolder {
    if (!options.accountId?.trim()) {
      throw new Error('OneDrive accountId is required when registering a cloud library.')
    }
    return this.addOneDrive({
      accountId: options.accountId,
      driveId,
      itemId,
      name,
      remotePath: options.remotePath ?? `/${name}`,
    })
  }

  getBackupForSource(sourceFolderId: number): DbFolder | undefined {
    return this.stmtBackupForSource.get(sourceFolderId)
  }

  hasTracks(folderId: number): boolean {
    return this.db.prepare<[number], { present: number }>(`
      SELECT 1 AS present FROM tracks WHERE folder_id = ? LIMIT 1
    `).get(folderId) != null
  }

  /**
   * Validate an existing source/destination pair without mutating either row.
   * `assignBackup` repeats these checks inside its immediate transaction so an
   * IPC confirmation can never become the only line of defence.
   */
  validateBackupAssignment(sourceFolderId: number, backupFolderId: number): void {
    this.assertBackupAssignment(sourceFolderId, backupFolderId)
  }

  /** Register a brand-new local destination and assign it atomically. */
  addLocalBackup(sourceFolderId: number, path: string, name: string): DbFolder {
    const add = this.db.transaction(() => {
      if (this.getByPath(path)) throw new Error('The backup location is already registered.')
      const now = new Date().toISOString()
      const result = this.stmtInsert.run(name, path, now, now, null)
      return this.assignBackupNow(sourceFolderId, Number(result.lastInsertRowid))
    })
    return add.immediate()
  }

  /** Register a brand-new OneDrive destination and assign it atomically. */
  addOneDriveBackup(sourceFolderId: number, args: AddOneDriveFolderArgs): DbFolder {
    const add = this.db.transaction(() => {
      const path = `onedrive://${args.driveId}/${args.itemId}`
      if (this.getByPath(path)) throw new Error('The backup location is already registered.')
      const now = new Date().toISOString()
      const result = this.stmtInsertOneDrive.run(
        args.name,
        path,
        now,
        now,
        args.accountId,
        args.driveId,
        args.itemId,
        args.remotePath,
      )
      return this.assignBackupNow(sourceFolderId, Number(result.lastInsertRowid))
    })
    return add.immediate()
  }

  assignBackup(sourceFolderId: number, backupFolderId: number): DbFolder {
    const assign = this.db.transaction(() => this.assignBackupNow(sourceFolderId, backupFolderId))
    return assign.immediate()
  }

  private assertBackupAssignment(sourceFolderId: number, backupFolderId: number): {
    source: DbFolder
    backup: DbFolder
  } {
    const source = this.getById(sourceFolderId)
    const backup = this.getById(backupFolderId)
    if (!source) throw new Error(`Source library ${sourceFolderId} does not exist.`)
    if (!backup) throw new Error(`Backup location ${backupFolderId} does not exist.`)
    if (source.id === backup.id) throw new Error('A library cannot back up to itself.')
    if (source.role !== 'library') throw new Error('A backup cannot be used as a source library.')
    if (backup.role === 'backup') {
      if (backup.backup_source_folder_id === source.id) return { source, backup }
      throw new Error('The destination is already assigned as another library backup.')
    }

    const existing = this.getBackupForSource(source.id)
    if (existing && existing.id !== backup.id) {
      throw new Error('The source library already has a backup location.')
    }
    const destinationBackup = this.getBackupForSource(backup.id)
    if (destinationBackup) {
      throw new Error('A library with its own linked backup cannot become another library backup.')
    }
    if (locationsOverlap(source, backup)) {
      throw new Error('Source and backup folders cannot be the same or overlap.')
    }

    // A destination is an exclusive root, not merely a different row. Reject
    // legacy or externally-created overlapping registrations as well.
    const overlap = this.listAll().find(candidate => (
      candidate.id !== backup.id
      && candidate.id !== source.id
      && locationsOverlap(candidate, backup)
    ))
    if (overlap) {
      throw new Error(`The backup location overlaps registered location "${overlap.name}".`)
    }
    return { source, backup }
  }

  private assignBackupNow(sourceFolderId: number, backupFolderId: number): DbFolder {
    const { source, backup } = this.assertBackupAssignment(sourceFolderId, backupFolderId)
    if (backup.role === 'backup') return backup

    // Reclassification removes the destination from the catalog but never
    // touches its files. Foreign-key cascades keep playlists/queue coherent.
    this.db.prepare(`DELETE FROM tracks WHERE folder_id = ?`).run(backup.id)
    const result = this.db.prepare(`
      UPDATE folders
      SET role = 'backup', backup_source_folder_id = ?, track_count = 0, date_updated = ?
      WHERE id = ? AND role = 'library'
    `).run(source.id, new Date().toISOString(), backup.id)
    if (result.changes !== 1) throw new Error('The backup location changed while it was being assigned.')
    return this.getById(backup.id)!
  }

  unlinkBackup(backupFolderId: number): DbFolder {
    const unlink = this.db.transaction(() => {
      const backup = this.getById(backupFolderId)
      if (!backup) throw new Error(`Backup location ${backupFolderId} does not exist.`)
      if (backup.role !== 'backup') return backup
      this.clearMirrorJournal(backupFolderId)
      this.db.prepare(`
        UPDATE folders
        SET role = 'library', backup_source_folder_id = NULL, date_updated = ?
        WHERE id = ?
      `).run(new Date().toISOString(), backupFolderId)
      return this.getById(backupFolderId)!
    })
    return unlink.immediate()
  }

  promoteBackup(backupFolderId: number): DbFolder {
    return this.unlinkBackup(backupFolderId)
  }

  private clearMirrorJournal(backupFolderId: number): void {
    this.db.prepare(`DELETE FROM library_mirror_snapshots WHERE backup_folder_id = ?`).run(backupFolderId)
    this.db.prepare(`DELETE FROM library_mirror_state WHERE backup_folder_id = ?`).run(backupFolderId)
    this.db.prepare(`DELETE FROM library_mirror_runs WHERE backup_folder_id = ?`).run(backupFolderId)
  }

  remove(id: number): void {
    const linked = this.getBackupForSource(id)
    if (linked) {
      throw new Error(`Library ${id} still has backup location ${linked.id}; unlink or promote it first.`)
    }
    this.stmtRemove.run(id)
  }

  updateTrackCount(id: number, count: number): void {
    this.stmtUpdateTrackCount.run(count, new Date().toISOString(), id)
  }

  setBookmark(id: number, data: Buffer | null): void {
    this.stmtSetBookmark.run(data, id)
  }

  setDeltaCursor(id: number, deltaCursor: string | null): void {
    const result = this.stmtSetDeltaCursor.run(deltaCursor, new Date().toISOString(), id)
    if (result.changes === 0) throw new Error(`OneDrive library ${id} does not exist.`)
  }

  setDeltaLink(id: number, deltaLink: string | null): void {
    this.setDeltaCursor(id, deltaLink)
  }

  updatePresentation(id: number, input: { name: string; displayIcon: string | null }): DbFolder {
    const name = input.name.trim()
    if (!name) throw new Error('Library location name is required.')
    if (input.displayIcon != null && !/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(input.displayIcon)) {
      throw new Error('Invalid library location icon.')
    }
    const result = this.db.prepare(`
      UPDATE folders SET name = ?, display_icon = ?, date_updated = ? WHERE id = ?
    `).run(name, input.displayIcon, new Date().toISOString(), id)
    if (result.changes !== 1) throw new Error(`Library location ${id} does not exist.`)
    return this.getById(id)!
  }
}
