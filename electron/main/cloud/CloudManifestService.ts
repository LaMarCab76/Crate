import type { Repos } from '../db/repositories'
import { getRepos } from '../db/repositories'
import { getOneDriveClient } from './OneDriveClient'
import { broadcast } from '../ipc/events'
import type { CloudManifest } from '@shared/types/cloud'

// Writes/reads a per-folder library manifest stored INSIDE the OneDrive folder
// itself. The track list is reconstructable from the delta API (OneDrive is the
// source of truth), so the manifest's job is to carry per-track *state*
// (favorites / play counts / ratings) across machines and reinstalls.
const MANIFEST_NAME = 'crate-manifest.json'

export class CloudManifestService {
  private repos: Repos

  constructor() {
    this.repos = getRepos()
  }

  // Serialize the folder's cloud tracks + their state and upload it into the
  // folder. Best-effort: a failure here never breaks indexing/playback.
  async writeManifest(folderId: number): Promise<void> {
    const folder = this.repos.folders.getById(folderId)
    if (!folder || folder.source !== 'onedrive' || !folder.cloud_drive_id || !folder.cloud_item_id) return

    const tracks = this.repos.tracks
      .getByFolder(folderId)
      .filter(t => t.source === 'onedrive' && t.cloud_item_id)

    const manifest: CloudManifest = {
      version: 1,
      generatedAtIso: new Date().toISOString(),
      driveId: folder.cloud_drive_id,
      folderItemId: folder.cloud_item_id,
      tracks: tracks.map(t => ({
        cloudItemId: t.cloud_item_id as string,
        isFavorite: t.is_favorite === 1,
        playCount: t.play_count,
        rating: t.rating,
        lastPlayedDate: t.last_played_date,
      })),
    }

    const buffer = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')
    await getOneDriveClient().uploadFile({
      driveId: folder.cloud_drive_id,
      parentItemId: folder.cloud_item_id,
      filename: MANIFEST_NAME,
      buffer,
    })
  }

  // Pull the in-folder manifest (if present) and restore per-track state onto the
  // already-indexed rows, matched by cloud item id. Used when adding a folder
  // that another machine already populated.
  async importManifest(folderId: number): Promise<void> {
    const folder = this.repos.folders.getById(folderId)
    if (!folder || folder.source !== 'onedrive' || !folder.cloud_drive_id || !folder.cloud_item_id) return

    const text = await getOneDriveClient().downloadChildText(folder.cloud_drive_id, folder.cloud_item_id, MANIFEST_NAME)
    if (!text) return

    let manifest: CloudManifest
    try {
      manifest = JSON.parse(text) as CloudManifest
    } catch {
      console.warn('[cloud] ignoring unparseable manifest')
      return
    }
    if (manifest.version !== 1 || !Array.isArray(manifest.tracks)) return

    let restored = 0
    for (const state of manifest.tracks) {
      if (!state?.cloudItemId) continue
      const track = this.repos.tracks.getByCloudItem(folder.cloud_drive_id, state.cloudItemId)
      if (!track) continue
      this.repos.tracks.restoreState({
        id: track.id,
        isFavorite: Boolean(state.isFavorite),
        playCount: Number.isFinite(state.playCount) ? state.playCount : 0,
        rating: typeof state.rating === 'number' ? state.rating : null,
        lastPlayedDate: typeof state.lastPlayedDate === 'string' ? state.lastPlayedDate : null,
      })
      restored++
    }
    if (restored) broadcast('library:changed', { reason: 'cloud-manifest-import' })
  }
}

let instance: CloudManifestService | null = null
export function getCloudManifestService(): CloudManifestService {
  if (!instance) instance = new CloudManifestService()
  return instance
}
