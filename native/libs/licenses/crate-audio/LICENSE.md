# License

`libcrate_audio` (`crate_audio.dll` on Windows) is Crate's native audio
engine. It is one shared library built from three parts:

| Part | License | Source |
|---|---|---|
| Crate's engine code (`native/crate-audio/`) | GPL-3.0-or-later | This repository |
| FFmpeg 9.0.2: libavformat, libavcodec, libswresample, libavutil (audio decoders only) | LGPL-2.1-or-later | `ffmpeg-9.0.2.tar.xz`, see `SOURCE.md` |
| miniaudio 0.11.25 | Public domain (Unlicense) or MIT No Attribution | `MINIAUDIO-LICENSE.txt` |

FFmpeg is configured without `--enable-gpl` and without `--enable-nonfree`,
so it stays under the LGPL. `libavutil` reports its own license at runtime
(`avutil_license()`), and `scripts/verify-crate-audio.mjs` rejects any build
that does not report LGPL.

FFmpeg is linked statically into the library. Because Crate is distributed
under the GPL-3.0-or-later with its complete source code, and the exact
FFmpeg source plus the build script are published alongside it, users can
modify FFmpeg and relink the library as the LGPL requires
(`npm run build:crate-audio`).

The full text of the GNU Lesser General Public License version 2.1 is in
`LGPL-2.1.txt` (FFmpeg's `COPYING.LGPLv2.1`).
