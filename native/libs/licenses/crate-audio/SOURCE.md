# crate-audio source and rebuild information

Crate ships its audio engine as one shared library, `libcrate_audio`, built
from:

- Crate's engine code: `native/crate-audio/` in this repository.
- FFmpeg 9.0.2
  - Upstream source: `https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz`
  - SHA-256: `8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e`
  - Configured as a static, audio-only, LGPL build. The exact `configure`
    flags are in `scripts/crate-audio-config.mjs` and in
    `../../crate-audio-manifest.json`.
- miniaudio 0.11.25
  - Upstream source: `https://raw.githubusercontent.com/mackron/miniaudio/0.11.25/miniaudio.h`
  - SHA-256: `ac7af4de748b7e26b777f37e01cee313a308a7296a3eb080e2906b320cc55c89`

The native asset archives include the exact verified FFmpeg source archive
beside this file as `ffmpeg-9.0.2.tar.xz`. The build is reproducible with:

```bash
npm run build:crate-audio -- --force
npm run verify:crate-audio -- --load
```

macOS builds compile x86_64 and arm64 separately (deployment target 12.0) and
join them into one universal library. Windows builds use MinGW-w64 (MSYS2
UCRT64) with the GCC runtime linked statically. Linux targets x86_64.
