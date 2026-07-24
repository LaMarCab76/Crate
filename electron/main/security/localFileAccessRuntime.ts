import { BrowserWindow, dialog, shell } from 'electron'
import {
  LocalFileAccessService,
  defaultLocalFileAccessDependencies,
} from './LocalFileAccessService'

let instance: LocalFileAccessService | null = null

export function getLocalFileAccessService(): LocalFileAccessService {
  instance ??= new LocalFileAccessService(defaultLocalFileAccessDependencies(
    async (rootPath, owner) => {
      const options: Electron.OpenDialogOptions = {
        title: 'Dar acceso a la biblioteca',
        defaultPath: rootPath,
        buttonLabel: 'Dar acceso',
        message: 'Seleccioná nuevamente esta misma carpeta para que Crate pueda leerla, editarla y mover archivos a la Papelera.',
        properties: ['openDirectory'],
      }
      const window = owner instanceof BrowserWindow ? owner : null
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options)
      return {
        canceled: result.canceled || result.filePaths.length === 0,
        filePath: result.filePaths[0] ?? null,
      }
    },
    async () => {
      await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders')
    },
  ))
  return instance
}
