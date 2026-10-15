// What the audio output is doing right now (device format vs track format),
// for the bit-perfect indicator. Seeded from main and kept in sync through
// audio:output-changed, which main sends on every track and format change.

import { create } from 'zustand'
import type { OutputInfoPayload } from '@shared/types/ipc-contract'

interface OutputInfoStore {
  info: OutputInfoPayload | null
  refresh(): Promise<void>
}

export const useOutputInfoStore = create<OutputInfoStore>(set => ({
  info: null,
  async refresh() {
    try {
      set({ info: await window.api.audio.getOutputInfo() })
    } catch {
      /* main not ready yet */
    }
  },
}))

if (typeof window !== 'undefined' && window.api?.audio) {
  void useOutputInfoStore.getState().refresh()
  const off = window.api.audio.onOutputChanged(info => useOutputInfoStore.setState({ info }))
  import.meta.hot?.dispose(() => off())
}
