# BASS native libraries

This directory is populated from [un4seen.com](https://www.un4seen.com/) by:

```bash
npm run fetch:bass
npm run verify:bass -- --load
```

The binaries are intentionally ignored by Git because of their size and
license. The release workflow downloads the current platform set before
`electron-builder` copies it into `Resources/native/libs`.

Crate requires BASS core, BASS_FX, and its complete decoder plugin set. Names
are platform-specific:

- macOS: `libbass*.dylib`
- Linux: `libbass*.so`
- Windows: `bass*.dll`

Verified target versions:

- BASS 2.4.18.3
- BASS_FX 2.4.12.6

Avoid older BASS 2.4.14 Windows builds: NVD lists crafted-media denial-of-
service issues for that line.
