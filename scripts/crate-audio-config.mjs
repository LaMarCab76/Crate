// Pinned inputs for libcrate_audio, Crate's native audio engine: an LGPL-only,
// audio-only static FFmpeg plus miniaudio, compiled into one shared library.

export const CRATE_AUDIO_VERSION = '1.0.0'
// Must match CA_API_VERSION in native/crate-audio/include/crate_audio.h.
export const CRATE_AUDIO_API_VERSION = 1

export const FFMPEG_VERSION = '9.0.2'
export const FFMPEG_SOURCE_NAME = `ffmpeg-${FFMPEG_VERSION}.tar.xz`
export const FFMPEG_SOURCE_URL = `https://ffmpeg.org/releases/${FFMPEG_SOURCE_NAME}`
export const FFMPEG_SOURCE_SHA256 = '8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e'

export const MINIAUDIO_VERSION = '0.11.25'
export const MINIAUDIO_HEADER_URL = `https://raw.githubusercontent.com/mackron/miniaudio/${MINIAUDIO_VERSION}/miniaudio.h`
export const MINIAUDIO_HEADER_SHA256 = 'ac7af4de748b7e26b777f37e01cee313a308a7296a3eb080e2906b320cc55c89'
export const MINIAUDIO_LICENSE_SHA256 = '457f1b500e0adf6bc059edddfa78a2f62012e7c3bb43476c20e0bd23b25ba0eb'

// Native assets are published independently from application releases, like
// Chromaprint's. The revision suffix allows rebuilding the same versions.
export const CRATE_AUDIO_NATIVE_RELEASE = `crate-audio-native-v${CRATE_AUDIO_VERSION}-1`
export const CRATE_AUDIO_NATIVE_REPOSITORY = 'LaMarCab76/Crate'

export const CRATE_AUDIO_MANIFEST = 'crate-audio-manifest.json'
// Also part of the portable ZIP layout, so keep it POSIX-normalized.
export const CRATE_AUDIO_LICENSE_DIR = 'licenses/crate-audio'
export const CRATE_AUDIO_LICENSE_FILES = Object.freeze(['LICENSE.md', 'LGPL-2.1.txt', 'MINIAUDIO-LICENSE.txt', 'SOURCE.md'])
// FFmpeg's COPYING.LGPLv2.1 from the pinned tarball.
export const FFMPEG_LGPL_SHA256 = '246041b6ecf9bc32d718a62c57877c78b5eb397b6467e74ed7ae2626ab189c30'

// Only what Crate plays: the 16 extensions in ImportService/deviceScanCore.
// No --enable-gpl / --enable-nonfree: the result must stay LGPL-2.1+.
export const FFMPEG_DEMUXERS = Object.freeze([
  'aiff', 'ape', 'dsf', 'flac', 'iff', 'matroska', 'mov', 'mp3', 'mpc', 'mpc8', 'ogg', 'tta', 'wav', 'wv',
])
export const FFMPEG_DECODERS = Object.freeze([
  'aac', 'alac', 'ape', 'dsd_lsbf', 'dsd_lsbf_planar', 'dsd_msbf', 'dsd_msbf_planar', 'dst', 'flac',
  'mp3float', 'mpc7', 'mpc8', 'opus', 'speex', 'tta', 'vorbis', 'wavpack',
  'pcm_alaw', 'pcm_f32be', 'pcm_f32le', 'pcm_f64be', 'pcm_f64le', 'pcm_mulaw', 'pcm_s16be', 'pcm_s16le',
  'pcm_s24be', 'pcm_s24le', 'pcm_s32be', 'pcm_s32le', 'pcm_s8', 'pcm_u8', 'adpcm_ima_wav', 'adpcm_ms',
])
export const FFMPEG_PARSERS = Object.freeze(['aac', 'flac', 'mpegaudio', 'opus', 'vorbis'])

export const FFMPEG_CONFIGURE_FLAGS = Object.freeze([
  '--disable-everything',
  '--disable-programs',
  '--disable-doc',
  '--disable-network',
  '--disable-autodetect',
  '--disable-avdevice',
  '--disable-avfilter',
  '--disable-swscale',
  '--disable-x86asm',
  '--disable-debug',
  '--enable-static',
  '--disable-shared',
  '--enable-pic',
  '--enable-avcodec',
  '--enable-avformat',
  '--enable-swresample',
  '--enable-protocol=file',
  `--enable-demuxer=${FFMPEG_DEMUXERS.join(',')}`,
  `--enable-decoder=${FFMPEG_DECODERS.join(',')}`,
  `--enable-parser=${FFMPEG_PARSERS.join(',')}`,
])

export const MACOS_DEPLOYMENT_TARGET = '12.0'

export function normalizeCrateAudioTarget(platform, arch) {
  if (platform === 'darwin') {
    if (!['arm64', 'x64', 'universal'].includes(arch)) {
      throw new Error(`Unsupported crate-audio architecture for macOS: ${arch}`)
    }
    return { platform, arch: 'universal' }
  }
  if (platform === 'win32' || platform === 'linux') {
    if (arch !== 'x64') throw new Error(`crate-audio ${platform} packages support x64 only (received ${arch})`)
    return { platform, arch }
  }
  throw new Error(`Unsupported crate-audio platform: ${platform}`)
}

export function crateAudioLibraryName(platform) {
  switch (platform) {
    case 'darwin': return 'libcrate_audio.dylib'
    case 'linux': return 'libcrate_audio.so'
    case 'win32': return 'crate_audio.dll'
    default: throw new Error(`Unsupported crate-audio platform: ${platform}`)
  }
}

export function crateAudioArtifactName(platform, arch) {
  const target = normalizeCrateAudioTarget(platform, arch)
  return `crate-audio-${CRATE_AUDIO_VERSION}-${target.platform}-${target.arch}.zip`
}

// Per-architecture FFmpeg configure flags (the build compiles each slice of a
// macOS universal binary separately and joins them with lipo).
export function ffmpegTargetFlags(platform, arch) {
  if (platform === 'darwin') {
    const clangArch = arch === 'arm64' ? 'arm64' : 'x86_64'
    const minVersion = `-mmacosx-version-min=${MACOS_DEPLOYMENT_TARGET}`
    return [
      `--arch=${arch === 'arm64' ? 'aarch64' : 'x86_64'}`,
      '--target-os=darwin',
      '--enable-cross-compile',
      `--cc=clang -arch ${clangArch}`,
      `--extra-cflags=${minVersion}`,
      `--extra-ldflags=${minVersion}`,
    ]
  }
  if (platform === 'win32') return ['--arch=x86_64', '--target-os=mingw32']
  return ['--arch=x86_64', '--target-os=linux']
}
