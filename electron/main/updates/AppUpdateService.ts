import { app, BrowserWindow, dialog, type MessageBoxOptions } from 'electron'
import electronUpdater, {
  type AppUpdater,
  type ProgressInfo,
  type UpdateDownloadedEvent,
  type UpdateInfo,
} from 'electron-updater'
import type { AppUpdateState } from '@shared/types/ipc-contract'
import { broadcast } from '../ipc/events'
import { createInitialUpdateState, reduceUpdateState } from './updateState'

type CheckSource = 'auto' | 'manual'

const AUTO_CHECK_DELAY_MS = 7000

class AppUpdateService {
  private readonly updater: AppUpdater
  private state: AppUpdateState
  private configured = false
  private activeCheckSource: CheckSource = 'manual'
  private showingAvailablePrompt = false
  private showingDownloadedPrompt = false

  constructor(updater: AppUpdater, currentVersion: string, supported: boolean) {
    this.updater = updater
    this.state = createInitialUpdateState(
      currentVersion,
      supported,
      supported ? undefined : 'Las actualizaciones desde GitHub Releases se activan en la app empaquetada.',
    )
  }

  getState(): AppUpdateState {
    return this.state
  }

  startAutoCheck(): void {
    if (!this.state.canCheck) return
    this.configure()
    setTimeout(() => {
      void this.checkForUpdates('auto')
    }, AUTO_CHECK_DELAY_MS)
  }

  async checkForUpdates(source: CheckSource = 'manual'): Promise<AppUpdateState> {
    if (!this.state.canCheck) return this.state
    this.configure()
    this.activeCheckSource = source
    this.setState(reduceUpdateState(this.state, { type: 'checking', now: Date.now() }))
    try {
      await this.updater.checkForUpdates()
    } catch (err) {
      this.setState(reduceUpdateState(this.state, { type: 'error', error: err, now: Date.now() }))
    }
    return this.state
  }

  async downloadUpdate(): Promise<AppUpdateState> {
    if (!this.state.canDownload) return this.state
    this.configure()
    this.setState(reduceUpdateState(this.state, {
      type: 'downloading',
      progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 },
    }))
    try {
      await this.updater.downloadUpdate()
    } catch (err) {
      this.setState(reduceUpdateState(this.state, { type: 'error', error: err, now: Date.now() }))
    }
    return this.state
  }

  installDownloadedUpdate(): void {
    if (!this.state.canInstall) return
    this.updater.quitAndInstall(false, true)
  }

  private configure(): void {
    if (this.configured || this.state.status === 'unsupported') return
    this.configured = true

    this.updater.logger = {
      info: message => console.log('[updates]', message),
      warn: message => console.warn('[updates]', message),
      error: message => console.error('[updates]', message),
    }
    this.updater.autoDownload = false
    this.updater.autoInstallOnAppQuit = true
    this.updater.allowPrerelease = false

    this.updater.on('checking-for-update', () => {
      this.setState(reduceUpdateState(this.state, { type: 'checking', now: Date.now() }))
    })
    this.updater.on('update-available', info => {
      this.setState(reduceUpdateState(this.state, { type: 'available', info: toUpdateInfoLike(info), now: Date.now() }))
      if (this.activeCheckSource === 'auto') void this.promptToDownload(info)
    })
    this.updater.on('update-not-available', info => {
      this.setState(reduceUpdateState(this.state, { type: 'not-available', info: toUpdateInfoLike(info), now: Date.now() }))
    })
    this.updater.on('download-progress', progress => {
      this.setState(reduceUpdateState(this.state, { type: 'downloading', progress: toProgress(progress) }))
    })
    this.updater.on('update-downloaded', info => {
      this.setState(reduceUpdateState(this.state, { type: 'downloaded', info: toUpdateInfoLike(info), now: Date.now() }))
      void this.promptToInstall(info)
    })
    this.updater.on('error', error => {
      this.setState(reduceUpdateState(this.state, { type: 'error', error, now: Date.now() }))
    })
  }

  private setState(next: AppUpdateState): void {
    this.state = next
    broadcast('app:update-state', next)
  }

  private async promptToDownload(info: UpdateInfo): Promise<void> {
    if (this.showingAvailablePrompt || !this.state.canDownload) return
    this.showingAvailablePrompt = true
    try {
      const { response } = await showUpdateDialog({
        type: 'info',
        buttons: ['Descargar', 'Más tarde'],
        defaultId: 0,
        cancelId: 1,
        title: 'Actualización disponible',
        message: `Crate ${info.version} está disponible.`,
        detail: 'La actualización se descargará en segundo plano y podrás instalarla reiniciando la app.',
      })
      if (response === 0) await this.downloadUpdate()
    } finally {
      this.showingAvailablePrompt = false
    }
  }

  private async promptToInstall(info: UpdateDownloadedEvent): Promise<void> {
    if (this.showingDownloadedPrompt || !this.state.canInstall) return
    this.showingDownloadedPrompt = true
    try {
      const { response } = await showUpdateDialog({
        type: 'info',
        buttons: ['Reiniciar e instalar', 'Después'],
        defaultId: 0,
        cancelId: 1,
        title: 'Actualización lista',
        message: `Crate ${info.version} ya se descargó.`,
        detail: 'Para completar la actualización, Crate se cerrará y volverá a abrirse.',
      })
      if (response === 0) this.installDownloadedUpdate()
    } finally {
      this.showingDownloadedPrompt = false
    }
  }
}

function toUpdateInfoLike(info: UpdateInfo | UpdateDownloadedEvent) {
  return {
    version: info.version,
    releaseName: info.releaseName,
    releaseDate: info.releaseDate,
    releaseNotes: info.releaseNotes,
  }
}

function toProgress(progress: ProgressInfo) {
  return {
    percent: progress.percent,
    transferred: progress.transferred,
    total: progress.total,
    bytesPerSecond: progress.bytesPerSecond,
  }
}

function showUpdateDialog(options: MessageBoxOptions) {
  const focusedWindow = BrowserWindow.getFocusedWindow()
  return focusedWindow
    ? dialog.showMessageBox(focusedWindow, options)
    : dialog.showMessageBox(options)
}

let instance: AppUpdateService | null = null

export function getAppUpdateService(): AppUpdateService {
  if (!instance) {
    const { autoUpdater } = electronUpdater
    instance = new AppUpdateService(autoUpdater, app.getVersion(), app.isPackaged)
  }
  return instance
}
