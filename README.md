# Crate

Audiophile music library and player for **macOS, Windows and Linux**, built as an
Electron + Vite + React + TypeScript desktop app on top of the
[BASS](https://www.un4seen.com/bass.html) audio library.

> Current release: **v0.6.6** — installers and release notes live in
> [`docs/releases/`](docs/releases/).

## Quick start

```bash
npm install
npm run fetch:native  # downloads the native libraries for this OS
npm run verify:native # checks BASS + Chromaprint before launch/package
npm run dev          # Electron dev window with Vite HMR
npm test             # Node test suite
npm run typecheck    # tsc for the main + renderer projects
npm run build        # bundles main, preload, renderer into out/
npm run dist         # packages an installer with electron-builder
npm run dist:mac     # DMG (x64 + arm64)
npm run dist:win     # NSIS installer (x64)
npm run dist:linux   # AppImage + .deb
```

The `postinstall` hook rebuilds `better-sqlite3` against the bundled Electron
runtime. If a native module ever drifts after an Electron upgrade,
`npm run rebuild` does it on demand.

Packaged builds check GitHub Releases for updates through `electron-updater`.
The release workflow uploads installer artifacts plus `latest*.yml` metadata.
Stable releases can be checked, downloaded, and installed from Preferences →
Actualizaciones. Prereleases are installed manually and are not offered by the in-app
updater. Tag-triggered macOS prereleases use
ad hoc signing; those builds require a Gatekeeper override and do not support
automatic installation of updates. A manual workflow dispatch can still use
Developer ID signing, notarization, stapling, and Gatekeeper validation when
the required Apple credentials are available.

## Optional OneDrive setup

Crate supports personal OneDrive accounts through OAuth without embedding a
client secret. To enable it, create a Microsoft public-client app that accepts
personal Microsoft accounts, add the **Mobile and desktop applications**
platform with the `http://localhost` redirect, and grant delegated
`Files.ReadWrite` and `User.Read` permissions. Enter its **Application (client)
ID** in Settings → Libraries when adding OneDrive; tokens are encrypted using
the operating system's secure storage.

## Project layout

```
electron/
  main/         Electron main process (Node) — DB, audio, devices, IPC
    audio/        BASS FFI bindings, AudioEngine, GaplessController, EQ, CoreAudio hog mode
    db/           better-sqlite3 connection, migrator + 30 SQL migrations, repositories
    cloud/        OneDrive auth, Graph client, delta index, portable manifests
    library-mirror/ persistent local/cloud backup plans and journals
    library-migration/ relocate/merge planning, execution and recovery
    devices/      DAP detection, sync planner/journal, Rockbox theme scanner, artwork optimizer
    library/      Folder watchers, reconciler, metadata extractor/writer, artwork cache
    lyrics/       LRClib + sidecar + embedded providers, .lrc sidecar writer
    ipc/          typed channels for library, audio, lyrics, devices and updates
    services/     LibraryBackup (portable JSON mirror of the SQLite library)
  preload/      contextBridge that exposes the typed `window.api` to the renderer
  renderer/     React UI
    src/
      components/   Sidebar, PlayerPane, PlayerBottomBar, NowPlayingFull,
                    FullScreenQueue, LyricsPanel, SpectrumVisualizer, EQBars,
                    TrackTable, ContextMenu, ModalShell, DeviceConnectModal…
      views/        Library, Albums, Album, Artists, Artist, Genres, Playlist,
                    Search, Devices, DeviceLibrary, Import, Settings
      stores/       Zustand stores: library, playback, queue, settings, EQ,
                    devices, lyrics
      utils/        FFT, levels, color extract, virtual rows, audio math
      styles/       globals.css
shared/         Cross-process TypeScript: IPC contract, library/db/device types,
                LRC parser, equalizer + device-sync constants
native/libs/    BASS codecs plus the pinned Chromaprint duplicate-fingerprint library
electron-build/ App icon, entitlements, Electron rebuild scripts
docs/           Release notes + feature specs (e.g. lyrics-feature.md)
```

## Features

### Audio engine
- **BASS** loaded through the [koffi](https://koffi.dev) FFI in the main process,
  with the full plugin set in `native/libs/` (FLAC, Opus, DSD, WavPack, TTA,
  Musepack, APE, HLS, WebM, MIDI, FX) so the same engine handles MP3, AAC,
  FLAC, ALAC, DSD, WavPack and more.
- Streams are preferred **fully in memory** when the RAM budget allows; large
  files fall back to disk streaming.
- **Gapless playback** via a dedicated `GaplessController` that preloads the
  next track on a configurable threshold and hot-swaps the BASS stream on
  end-of-stream, with adoption from the queue store so autoplay keeps working
  even if preload didn't fire.
- **Crossfade** (0–12 s) and **soundcheck** toggle in Settings.
- **Exclusive / hog mode** on macOS through a CoreAudio FFI shim
  (`ExclusiveModeManager`) — bypasses the system mixer, releases the device on
  quit so other apps recover the output.
- **Output device picker** with hot-reapply, plus FFT and stereo RMS level
  metering exposed to the UI at configurable cadences (mini / full / screen).
- **Persistent playback analysis cache** (waveform peaks + track-row bars)
  stored in SQLite with a configurable disk quota, so re-opening an album does
  not re-decode every file.
- 10-band **graphic EQ** powered by the bass_fx plugin, with per-band gain
  shared between the renderer store and the engine.

### Library
- Unified local and OneDrive libraries with per-source names, icons and badges.
- Multi-folder local libraries with a **chokidar** `FolderWatcher` plus a
  `LibraryReconciler` that scans on startup, sweeps in the background, and
  records every run in a `library_scan_log` with configurable retention.
- `ImportService` + `MetadataExtractor` use **music-metadata** and
  **node-taglib-sharp** to ingest tags, embedded artwork and stream info.
- `MetadataCompletionService` applies rule-based fill-ins (artist / album
  cleanup, sort fields, primary-artist parsing) with an in-app review modal
  before writing tags back via `MetadataWriter`.
- Single-track **Move to album** actions validate the destination against
  MusicBrainz, reuse sibling artwork from an existing local album track, move
  the audio plus `.lrc` sidecar, rename it as the destination slot, and update
  the same SQLite row without replacing an already-local album track.
- `ArtworkCache` extracts and resizes embedded art on first sight and exposes
  it under a privileged `crate://` protocol scheme so the renderer can render
  thousands of covers without round-tripping through IPC for the bytes.
- **SQLite** schema (30 migrations) with **FTS5** search and triggers that keep
  the index fresh as tracks change, plus repositories per entity
  (tracks, albums, artists, genres, playlists, queues, folders, scan log,
  playback analysis, lyrics).
- Optional **portable JSON backup** (`LibraryBackup`) that mirrors the SQLite
  library to disk and flushes before quit, so the library survives a wipe of
  the user-data directory.

### Views & UI shell
- Three-pane layout with a translucent vibrant sidebar, main content, and a
  right-side player pane behind a draggable splitter.
- Dark + light themes, three densities (compact / regular / comfy), three list
  layouts (classic / editorial / dense).
- Top-level views: **Library, Albums, Album, Artists, Artist, Genres, Playlist,
  Search (FTS5), Devices, Device library, Import, Settings**, with
  per-view list sort + filter prefs persisted via `ListPrefsMenu`.
- Procedural SVG album artwork as a fallback (palette + seed + pattern), and a
  per-frame color extractor that tints the player from the current cover.
- Animated EQ indicator for the playing track in any list, `UpNextToast`
  notices, `TrackLoadingOverlay`, `ContextMenu` actions, `ModalShell` for
  dialogs.

### Player surfaces
- `PlayerPane` (sidebar player) with codec strip, transport, queue preview and
  optional inline lyrics + FFT visualizer.
- `PlayerBottomBar` as a slim transport for dense layouts.
- `NowPlayingFull` full-screen mode with background spectrum, synced lyrics,
  and a sibling `FullScreenQueue` view for managing what's next.
- `SpectrumVisualizer` and `EQBars` with unified bands and a custom log-spaced
  FFT mapping; the engine downshifts its FFT mode when no visualizer is mounted.
- Player tint source is configurable per session: **default / preset / custom /
  artwork-extracted**.

### Lyrics
- Read pipeline composes **LRCLIB** (online), embedded tags, and `.lrc`
  **sidecars** — coordinated by `LyricsMatcher` with candidate selection in
  `LyricsCandidates` when multiple matches show up.
- Write pipeline writes mandatory **`.lrc` sidecars** next to the audio file
  (`SidecarLrcWriter`) for local library/playback use. A
  `FlacVorbisLyricsWriter` plus `stripFlacLyrics` handle legacy embedded cases.
- Online lookups are globally queued at **one song per minute**. Local sidecars
  and embedded lyrics resolve immediately and do not consume a lookup slot.
- Synced display with **global** and **per-track** timing offsets
  (`lyricsGlobalOffsetMs` in settings, plus the parsed `[offset:…]` tag
  honored at lookup time).
- Settings: auto-fetch, background fetch, prefer-synced, orphan `.lrc` cleanup,
  global offset, and a manual library panel for finding songs with/without
  lyrics and fetching selected missing lyrics without playback.
- A `LyricsPanel` (inline) and `LyricsSidePane` (overlay) both subscribe to the
  same playback tick and run the same current-line lookup.
- Full spec for future iteration in [`docs/lyrics-feature.md`](docs/lyrics-feature.md).

### Devices & sync (DAPs)
- `DeviceSyncService` with an OS-level **volume monitor** that detects mounted
  USB / Rockbox / FiiO-style players on macOS, Windows and Linux and classifies
  them as connected / candidate / unknown.
- `DeviceConnectModal` to confirm music root, artwork limits and per-device
  options before linking; sidebar nav and a per-device dashboard
  (`DeviceLibraryView`) once linked.
- **Sync planner** that produces a plan + journal; sync is journaled so it
  can be **resumed or discarded** after a crash or unplug, with pending
  journals surfaced in the Devices view.
- `ArtworkOptimizer` re-encodes embedded covers to the device's configured
  maximum edge size (default tunable in Settings). PC-to-device copies are
  staged with the limited artwork before the final device write, while existing
  on-device tracks can still be optimized during sync.
- `RockboxThemeScanner` lists installed themes and accepts **drag-and-drop
  `.zip` theme installs** straight into the device's `/.rockbox/themes/`.
- Device sync no longer propagates lyrics: it does not copy/import `.lrc`
  sidecars and does not read embedded lyrics to decide sync actions. Lyrics stay
  local to the PC library/player workflow.
- Local track album moves are journaled per track and, on PC-to-device or safe
  bidirectional sync, become a delete of the old device path plus a copy or
  replace at the new album path. Device-to-PC plans warn about pending local
  moves instead of forcing them from the device side.

### Settings
- Library: folders, manual + scheduled scans, scan-log retention, portable
  backup toggle.
- Audio: gapless, crossfade duration, soundcheck, exclusive mode, 10-band EQ.
- Player: tint source (default / preset / custom / artwork), spectrum +
  inline-lyrics visibility, full-screen background spectrum.
- Lyrics: auto-fetch, background fetch, prefer-synced, orphan `.lrc` cleanup,
  global offset, and manual missing-lyrics management.
- Updates: manual check/download/install controls backed by GitHub Releases,
  plus an automatic check when a packaged app starts.
- Devices: default artwork max-edge, volume detection, ignore lists.
- Playback cache: stats + clear + per-byte quota.

### Packaging & infra
- `electron-builder` targets: **DMG (x64 + arm64), NSIS (x64), AppImage, .deb**,
  with `native/libs/` shipped via `extraResources` + `asarUnpack` so BASS and
  Chromaprint load at runtime.
- `fetch:native` downloads the platform-specific BASS set and the verified
  Chromaprint package; `verify:native -- --load` validates formats,
  architectures, provenance, dependencies and frozen native fingerprints.
- GitHub Releases publish configuration emits updater metadata
  (`latest-mac.yml`, `latest.yml`, `latest-linux.yml`) and macOS zip artifacts
  required by the updater.
- macOS release packaging is fail-closed: it requires a Developer ID certificate,
  notarizes both architectures, and verifies codesign, stapling and Gatekeeper
  acceptance before upload.
- Strict renderer sandbox: `contextIsolation: true`, `nodeIntegration: false`,
  navigation locked to the app's own origin, `window.open` filtered to
  http(s) only.
- IPC layer with input **validation helpers**, **throttled** event broadcasts
  and a single `events.ts` `broadcast()` entry point.
- Unhandled-rejection / uncaught-exception loggers so a single bad IPC call
  can't silently kill the main process.

## Status

| Phase | Description | Status |
|------:|:------------|:------:|
| 0 | Archive Swift, scaffold Electron app | ✅ |
| 1 | UI shell — all views, theme, density, mini player, full-screen NowPlaying | ✅ |
| 2 | Data layer — `better-sqlite3`, FTS5, schema, repositories | ✅ |
| 3 | Audio engine — BASS via koffi FFI, gapless, EQ, exclusive mode | ✅ |
| 4 | Metadata + library import — `music-metadata`, chokidar watchers, reconciler | ✅ |
| 5 | Lyrics (LRClib + sidecar), playback analysis cache, device sync | ✅ |
| 6 | Packaging — DMG, NSIS, AppImage, .deb | ✅ |
| 7 | R128 / loudness scanner, OS media keys, mini-player popout, auto-update | pending |

## License

Crate's source code is licensed under **GPL-3.0-or-later** (see `LICENSE`)
with an additional permission, under GPL section 7, to combine and distribute
it with the proprietary BASS audio library (see `LICENSE-BASS-EXCEPTION.md`).

BASS itself is not open source and is not part of this repository: it is
downloaded from un4seen.com by `npm run fetch:native` and is free for
non-commercial use only. Distributing Crate, or a fork, as part of a
commercial product requires a BASS license from un4seen developments. Other
third-party components are listed in `THIRD_PARTY_NOTICES.md`.

## Acknowledgements

Crate started as a cross-platform rewrite of
[HiFidelity](https://github.com/rvarunrathod/HiFidelity), the macOS-only
SwiftUI audiophile player by Varun Rathod (published under Apache-2.0 at the
time this project forked from it). HiFidelity was feature-rich (gapless,
hi-res, hog mode, R128, FTS5 search) but locked to Apple platforms. Crate's
Electron code base was written from scratch and this repository contains no
Swift sources; what it keeps is the idea of an audiophile-grade BASS engine
(previously bridged through CBass in Swift, now through koffi FFI in Node),
unlocking cross-platform builds, Vite HMR-driven UI iteration, and modern
TypeScript tooling. Feature notes like
[`docs/lyrics-feature.md`](docs/lyrics-feature.md) guide the parity work as
Crate moves through its remaining phases.
