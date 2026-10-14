# Native audio libraries

This directory is populated with BASS from
[un4seen.com](https://www.un4seen.com/) and a pinned Chromaprint shared library:

```bash
npm run fetch:native
npm run verify:native -- --load
```

The binaries are intentionally ignored by Git because of their size and
license. The release workflow downloads the current platform set before
`electron-builder` copies it into `Resources/native/libs`. `fetch:bass` also
saves the license and readme texts of every BASS package under
`licenses/bass/<name>/`; they ship with the binaries, and `verify:bass` fails
without them.

Crate requires BASS core, BASS_FX, and its complete decoder plugin set. Names
are platform-specific:

- macOS: `libbass*.dylib`
- Linux: `libbass*.so`
- Windows: `bass*.dll`

Verified target versions:

- BASS 2.4.18.3
- BASS_FX 2.4.12.6
- Chromaprint 1.6.0 (`CHROMAPRINT_ALGORITHM_DEFAULT`, KissFFT)

Avoid older BASS 2.4.14 Windows builds: NVD lists crafted-media denial-of-
service issues for that line.

Chromaprint's upstream source tarball is pinned by SHA-256 and accompanies
release binaries under `licenses/chromaprint/`. Development builds do not need
the library until duplicate analysis runs. Build it locally with CMake using
`npm run build:chromaprint`, or fetch a verified Crate native asset with
`npm run fetch:chromaprint`.
