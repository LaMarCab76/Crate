# Third-party notices

Crate is released under GPL-3.0-or-later with an additional permission for
BASS (see `LICENSE` and `LICENSE-BASS-EXCEPTION.md`). It depends on the
following third-party components, which keep their own licenses.

## BASS audio library (proprietary)

Playback, decoding and the equalizer use BASS, BASS_FX and the BASS decoder
add-ons (FLAC, Opus, WebM, WavPack, APE, DSD, MIDI, HLS, Musepack, Speex, TTA)
from un4seen developments: <https://www.un4seen.com/>.

BASS is **not** open source and is **not** included in this repository.
`npm run fetch:native` downloads the binaries from un4seen.com into
`native/libs/`, and release packages bundle them. Under the un4seen license
BASS is free for non-commercial use only; shipping Crate, or a derivative, as
part of a commercial product requires a BASS license from un4seen developments.

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
LRCLIB (lyrics), Microsoft Graph (optional OneDrive libraries), GitHub
Releases (updates and native assets) and, only with credentials you provide
yourself, the Qobuz and TIDAL APIs (optional downloads). Use of those services
is subject to their own terms.
