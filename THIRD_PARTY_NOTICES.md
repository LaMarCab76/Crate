# Third-party notices

Crate is released under GPL-3.0-or-later with an additional permission for
BASS (see `LICENSE` and `LICENSE-BASS-EXCEPTION.md`). It depends on the
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
  `AudioEffectsManager.swift`;
- the set and order of BASS decoder plugins
  (`electron/main/audio/PluginLoader.ts`), from `BASSAudioEngine.swift`.

The Apache-2.0 text is in `licenses/HiFidelity-Apache-2.0.txt`. HiFidelity
moved away from that license on 2025-12-25; nothing in Crate is based on its
later versions. The README lists these inherited elements as work to redo.

## BASS audio library and add-ons (proprietary)

Playback, decoding and the equalizer use BASS and the add-ons below. None of
them is open source, none is included in this repository, and each keeps the
terms stated in its own package:

| Component | Author | Terms |
|---|---|---|
| BASS | un4seen developments | Free for non-commercial use; commercial products need a BASS license |
| BASSFLAC, BASSOPUS, BASSWEBM, BASSWV, BASSAPE, BASSDSD, BASSMIDI, BASSHLS | un4seen developments | Free to use with BASS |
| BASS_FX | JOBnik! (Arthur Aminov) | Free; redistributable at no charge with its files unmodified; usable in commercial software with credit |
| BASS_MPC | Sebastian Andersson | Free to use and distribute |
| BASS_SPX | Sebastian Andersson | Free to use and distribute following the Speex (BSD) license |
| BASS_TTA | Sebastian Andersson | Free to use and distribute following the LGPL |

These binaries also contain code from other projects, credited in their texts:
minimp3 and libogg/libvorbis (Xiph.Org Foundation) in BASS; libFLAC, libopus,
nestegg (Mozilla Foundation), WavPack and the Monkey's Audio SDK in the
official add-ons; SoundTouch (LGPL, Olli Parviainen), Freeverb and
smbPitchShift in BASS_FX; Musepack, Speex and The True Audio library (LGPL)
in the Sebastian Andersson add-ons. The LGPL sources are published upstream:
SoundTouch at <https://www.surina.net/soundtouch> and TTA at
<http://www.true-audio.com>.

`npm run fetch:native` downloads the binaries from <https://www.un4seen.com/>
into `native/libs/`, together with each package's license and readme text
under `native/libs/licenses/bass/`. Release packages bundle both, and
`npm run verify:native` fails if a text is missing. Shipping Crate, or a
derivative, as part of a commercial product requires a BASS license from
un4seen developments.

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
