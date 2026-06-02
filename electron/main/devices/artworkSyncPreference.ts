export function resolveOptimizeArtworkSelection(
  explicit: boolean | undefined,
  persistedDefault: boolean,
): boolean {
  return explicit ?? persistedDefault
}

export function canRunSyncWithArtworkOnly(actionCount: number, optimizeArtwork: boolean): boolean {
  return actionCount > 0 || optimizeArtwork
}

export function shouldOptimizeArtworkBeforeDeviceCopy(actionKind: string, optimizeArtwork: boolean): boolean {
  return optimizeArtwork && (actionKind === 'copy_pc_to_device' || actionKind === 'replace_device')
}
