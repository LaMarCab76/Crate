# Third-party notices

Crate is released under GPL-3.0-or-later (see `LICENSE`). It depends on the
following third-party components, which keep their own licenses.

## HiFidelity (Apache-2.0)

Crate began as a rewrite of [HiFidelity](https://github.com/rvarunrathod/HiFidelity),
the macOS player by Varun Rathod. A few parts of Crate are derived from
HiFidelity's code as it was published under the Apache License 2.0 (up to
commit `8c6a8e1`, 2025-12-22), and were modified for Crate:

- the database schema and FTS5 search triggers
  (`electron/main/db/migrations/0001_initial.sql`, `0002_fts5.sql`), from
  `DatabaseMigrator.swift` and `DatabaseInit.swift`;
- the legacy 10-band equalizer layout (`shared/constants/equalizer.ts`), from
  `AudioEffectsManager.swift`.

The Apache-2.0 text is in `licenses/HiFidelity-Apache-2.0.txt`. HiFidelity
moved away from that license on 2025-12-25; nothing in Crate is based on its
later versions. The README lists these inherited elements as work to redo.

## Audio engine (libcrate_audio)

Crate's audio engine is one shared library built from Crate's own code
(GPL-3.0-or-later), **FFmpeg 9.0.2** and **miniaudio 0.11.25**:

- FFmpeg (libavformat, libavcodec, libswresample, libavutil) is built as an
  audio-only, LGPL-2.1-or-later configuration — without `--enable-gpl` or
  `--enable-nonfree` — and linked statically. The engine refuses to load a build
  whose FFmpeg does not report the LGPL.
- miniaudio is dual-licensed under the public domain (Unlicense) or MIT No
  Attribution.

Release packages include the exact FFmpeg source archive, the build manifest
(with the full `configure` line), the LGPL-2.1 text and the miniaudio license
under `native/libs/licenses/crate-audio/`. `npm run build:crate-audio` rebuilds
the library from the pinned sources.

## Chromaprint (LGPL-2.1)

The native Chromaprint component is distributed as a shared library and is
treated as LGPL-2.1 as a whole because it contains Chromaprint's internal
avresample-derived code. Its bundled KissFFT implementation is BSD-3-Clause.

Release packages include the exact Chromaprint 1.6.0 source archive, build
manifest, upstream notice, full LGPL-2.1 license, and KissFFT notice under
`native/libs/licenses/chromaprint/`.

## node-taglib-sharp (LGPL-2.1-or-later)

Tag reading and writing use node-taglib-sharp, a TypeScript port of TagLib#,
used unmodified as an npm dependency.

## npm dependencies

The remaining runtime dependencies (Electron, React, better-sqlite3, koffi,
music-metadata, chokidar, zustand, yaml, extract-zip, electron-updater,
@azure/msal-node and their transitive dependencies) are distributed under
permissive licenses (MIT, ISC, BSD, Apache-2.0, BlueOak-1.0.0 and similar).
The exact set and versions are recorded in `package-lock.json`, and each
package ships its own license text under `node_modules/`.

## Online services

Crate talks to MusicBrainz and the Cover Art Archive (metadata and artwork),
LRCLIB (lyrics), Microsoft Graph (optional OneDrive libraries) and GitHub
Releases (updates and native assets). Use of those services is subject to
their own terms.
