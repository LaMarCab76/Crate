# Native libraries

This directory holds the native libraries Crate loads at runtime. They are not
committed; build or fetch them for the current platform:

```bash
npm run fetch:native          # verified prebuilt packages (crate-audio + Chromaprint)
npm run verify:native -- --load
```

## libcrate_audio — the audio engine

Crate's own engine (`native/crate-audio/`): FFmpeg 9.0.2 (LGPL, audio decoders
only, linked statically) for decoding and miniaudio 0.11.25 for output.

- macOS: `libcrate_audio.dylib` (universal: x86_64 + arm64)
- Windows: `crate_audio.dll` (x64, MinGW-w64)
- Linux: `libcrate_audio.so` (x64)

Build it from the pinned sources with `npm run build:crate-audio` (needs a C
compiler, make and CMake 3.16+; on Windows an MSYS2 UCRT64 shell). The build
writes `crate-audio-manifest.json` and copies the exact FFmpeg source archive
into `licenses/crate-audio/`. `npm run verify:crate-audio -- --load` checks the
manifest, architectures, that only `ca_*` symbols are exported, the runtime
dependencies, the license material, and that the library loads, reports an
LGPL FFmpeg and decodes a fixture.

## Chromaprint

Pinned Chromaprint 1.6.0 (`CHROMAPRINT_ALGORITHM_DEFAULT`, KissFFT) for
duplicate fingerprints. Its upstream source tarball is pinned by SHA-256 and
accompanies release binaries under `licenses/chromaprint/`. Development builds
do not need the library until duplicate analysis runs. Build it locally with
CMake using `npm run build:chromaprint`, or fetch a verified Crate native asset
with `npm run fetch:chromaprint`.
