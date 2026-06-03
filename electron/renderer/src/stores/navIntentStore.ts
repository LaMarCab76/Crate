// Cross-cutting navigation intents. View state lives only in App.tsx, but some
// deeply nested triggers (the metadata banners, the track/album context menus)
// need to route the app without threading `navigate` through a dozen components.
// They write an intent here; App.tsx consumes it once and calls navigate().

import { create } from 'zustand'

export interface MetadataFixIntent {
  trackIds: number[]
  title?: string
  // How many of the requested tracks are known to be missing data. Set from the
  // banners (which count targets) so the view can show an honest "N con datos
  // faltantes · M con propuesta automática" instead of only the proposable count.
  missingCount?: number
}

interface NavIntentState {
  metadataFix: MetadataFixIntent | null
  requestMetadataFix(trackIds: number[], title?: string, missingCount?: number): void
  clearMetadataFix(): void
}

export const useNavIntentStore = create<NavIntentState>(set => ({
  metadataFix: null,
  requestMetadataFix(trackIds, title, missingCount) {
    set({ metadataFix: { trackIds, title, missingCount } })
  },
  clearMetadataFix() {
    set({ metadataFix: null })
  },
}))

export function useMetadataFixIntent(): MetadataFixIntent | null {
  return useNavIntentStore(s => s.metadataFix)
}
