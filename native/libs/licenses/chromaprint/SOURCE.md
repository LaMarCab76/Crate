# Chromaprint source and rebuild information

Crate ships Chromaprint 1.6.0 as a dynamically linked shared library.

- Upstream source: `https://github.com/acoustid/chromaprint/releases/download/v1.6.0/chromaprint-1.6.0.tar.gz`
- SHA-256: `9d33482e56a1389a37a0d6742c376139fa43e3b8a63d29003222b93db2cb40da`
- Fingerprint algorithm: `CHROMAPRINT_ALGORITHM_DEFAULT` (numeric value `1`)
- FFT implementation: the KissFFT sources vendored by Chromaprint
- Audio conversion: Chromaprint's internal avresample-derived implementation
- External FFmpeg, FFTW, and KissFFT runtime libraries: disabled

Release packages include the exact verified source archive beside this file as
`chromaprint-1.6.0.tar.gz`, the upstream notice in `LICENSE.md`, and the full
LGPL-2.1 license text in `LGPL-2.1.txt`. The build is reproducible with:

```bash
npm run build:chromaprint -- --force
npm run verify:chromaprint -- --load
```

The complete CMake configuration is recorded in
`../../chromaprint-manifest.json` and enforced by
`scripts/verify-chromaprint.mjs`. macOS builds target x86_64 and arm64 in one
universal library with deployment target 11.0. Windows uses the static MSVC
runtime; Linux targets x86_64.
