/** Keep a useful content column without changing a user's saved panel choices. */
export function panelLayout(input: { width: number; sidebarWidth: number; sidebarOpen: boolean; playerOpen: boolean; lyricsOpen: boolean; lyricsWidth: number }) {
  const contentMin = 280
  const playerWidth = 340
  let sidebarOpen = input.sidebarOpen
  let playerOpen = input.playerOpen
  let lyricsWidth = Math.max(300, Math.min(input.lyricsWidth, 620))
  // A wide lyrics card contracts before the sidebar has to yield.
  if (input.lyricsOpen) lyricsWidth = Math.min(lyricsWidth, Math.max(300, input.width - (sidebarOpen ? input.sidebarWidth : 0) - contentMin))
  const dockWidth = () => (playerOpen ? playerWidth : 0) + (input.lyricsOpen ? lyricsWidth : 0)
  // With both panels open the player becomes the bottom transport first.
  if (playerOpen && input.width - (sidebarOpen ? input.sidebarWidth : 0) - dockWidth() < contentMin) playerOpen = false
  if (sidebarOpen && input.width - input.sidebarWidth - dockWidth() < contentMin) sidebarOpen = false
  if (input.lyricsOpen) lyricsWidth = Math.min(lyricsWidth, Math.max(300, input.width - (sidebarOpen ? input.sidebarWidth : 0) - (playerOpen ? playerWidth : 0) - contentMin))
  return { sidebarOpen, playerOpen, lyricsWidth }
}
