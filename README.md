# Crate

Audiophile music library and player, built as an **Electron + Vite + React + TypeScript** desktop app (replacing a prior SwiftUI / macOS-only implementation).

## Status

This is an alpha. The current shell renders the full UI from the design with mock data. The next phases wire up SQLite, BASS audio playback, library import, lyrics, and EQ.

| Phase | Description | Status |
|------:|:------------|:------:|
| 0 | Archive Swift, scaffold Electron app | ✅ |
| 1 | UI shell — all views, theme, density, mini player, full-screen NowPlaying | ✅ |
| 2 | Data layer — `better-sqlite3`, FTS5, schema port | pending |
| 3 | Audio engine — BASS via koffi FFI, gapless, DACManager, EQ | pending |
| 4 | Metadata + library import — `music-metadata`, chokidar watchers | pending |
| 5 | Lyrics (LRClib — see `docs/lyrics-feature.md`), R128 scanner, media keys, mini player popout | pending |
| 6 | Packaging — DMG, NSIS, AppImage, auto-update | pending |

## Quick start

```bash
npm install
npm run dev     # opens an Electron dev window with HMR
npm run build   # bundles main, preload, renderer into out/
npm run dist    # builds an installer with electron-builder
```

## Project layout

```
electron/
  main/         # Electron main process (Node) — IPC, audio, DB live here
  preload/      # contextBridge to expose typed APIs to the renderer
  renderer/     # React UI (this is what users see)
    src/
      components/    # Reusable: Sidebar, PlayerPane, CodecStrip, Artwork, Icon…
      views/         # Top-level: LibraryView, AlbumsView, AlbumView, ArtistView…
      stores/        # Settings, queue, playback state (Zustand)
      data/          # mockLibrary.ts (replaced by SQLite queries in Phase 2)
      styles/        # globals.css
shared/         # Types shared between main and renderer (audio, library, IPC)
native/         # BASS dylibs/dlls/sos (populated in Phase 3)
```

## Design

The UI is a port of the original Claude Design handoff:

- Three-pane layout: translucent sidebar + main + right player pane with a draggable splitter
- Dark + light themes, three densities (compact / regular / comfy), three layouts (classic / editorial / dense)
- Codec strip with audiophile tiers (low / mid / high / cd / studio / master / ref)
- Procedural SVG album artwork (palette + seed + pattern)
- Animated equalizer indicator for the currently playing track
- Full-screen Now Playing with synced lyrics + visualizer
- Synced lyrics with global and per-track timing offset controls
- Persistent playback visualization cache with configurable DB quota
- Filesystem-backed library reconciliation with per-library scan history and
  configurable retention.
- Mini player popout
- Device sync with automatic volume detection, sidebar navigation for mounted
  DAPs, Rockbox theme listing, drag-and-drop Rockbox theme installs, per-device
  dashboard/configuration, and global sync progress.

## Why Electron (this time)

The prior Swift app was feature-rich (gapless, hi-res, hog mode, R128, FTS5 search) but iteration was slow and it was locked to macOS. Electron unlocks:

- Faster UI iteration (Vite HMR, no Xcode)
- Cross-platform potential (macOS + Windows + Linux)
- Modern dev tooling (TypeScript, React DevTools)

The audiophile features will be preserved by reusing the same **BASS C library** (currently called via CBass on Swift) through Node FFI (koffi) in Phase 3.

## License

GPL-3.0-or-later. See `LICENSE`.
