export function resolveOptimizeArtworkSelection(
  explicit: boolean | undefined,
  persistedDefault: boolean,
): boolean {
  return explicit ?? persistedDefault
}

export function canRunSyncWithArtworkOnly(actionCount: number, optimizeArtwork: boolean): boolean {
  return actionCount > 0 || optimizeArtwork
}
