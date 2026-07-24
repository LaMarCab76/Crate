export const CHROMAPRINT_VERSION = '1.6.0'
export const CHROMAPRINT_ALGORITHM = 1
export const CHROMAPRINT_SOURCE_NAME = `chromaprint-${CHROMAPRINT_VERSION}.tar.gz`
export const CHROMAPRINT_SOURCE_URL = `https://github.com/acoustid/chromaprint/releases/download/v${CHROMAPRINT_VERSION}/${CHROMAPRINT_SOURCE_NAME}`
export const CHROMAPRINT_SOURCE_SHA256 = '9d33482e56a1389a37a0d6742c376139fa43e3b8a63d29003222b93db2cb40da'
export const LGPL_2_1_SHA256 = 'f2f118b9029ec1871b953639ecc46651b2fc7b62e295e6cf3ef2ac4c9a058b33'

// Native assets are published independently from application releases. Keeping
// the toolchain revision in the tag lets us rebuild the same upstream version
// without silently replacing an artifact that has already shipped.
export const CHROMAPRINT_NATIVE_RELEASE = `chromaprint-native-v${CHROMAPRINT_VERSION}-1`
export const CHROMAPRINT_NATIVE_REPOSITORY = 'LaMarCab76/LocalLibrary'

export const CHROMAPRINT_MANIFEST = 'chromaprint-manifest.json'
// This is also part of the portable ZIP layout, so keep it POSIX-normalized.
// Joining it to a local root still produces the native path on every platform.
export const CHROMAPRINT_LICENSE_DIR = 'licenses/chromaprint'

export const CHROMAPRINT_CMAKE_FLAGS = Object.freeze([
  '-DCMAKE_BUILD_TYPE=Release',
  '-DBUILD_SHARED_LIBS=ON',
  '-DBUILD_TOOLS=OFF',
  '-DBUILD_TESTS=OFF',
  '-DBUILD_FRAMEWORK=OFF',
  '-DFFT_LIB=kissfft',
  '-DAUDIO_PROCESSOR_LIB=',
  '-DUSE_INTERNAL_AVRESAMPLE=ON',
  '-DCMAKE_DISABLE_FIND_PACKAGE_FFmpeg=ON',
  '-DCMAKE_DISABLE_FIND_PACKAGE_FFTW3=ON',
])

export function normalizeChromaprintTarget(platform, arch) {
  if (platform === 'darwin') {
    if (!['arm64', 'x64', 'universal'].includes(arch)) {
      throw new Error(`Unsupported Chromaprint architecture for macOS: ${arch}`)
    }
    return { platform, arch: 'universal' }
  }
  if (platform === 'win32' || platform === 'linux') {
    if (arch !== 'x64') {
      throw new Error(`Chromaprint ${platform} packages currently support x64 only (received ${arch})`)
    }
    return { platform, arch }
  }
  throw new Error(`Unsupported Chromaprint platform: ${platform}`)
}

export function chromaprintLibraryName(platform) {
  switch (platform) {
    case 'darwin': return 'libchromaprint.dylib'
    case 'linux': return 'libchromaprint.so'
    case 'win32': return 'chromaprint.dll'
    default: throw new Error(`Unsupported Chromaprint platform: ${platform}`)
  }
}

export function chromaprintArtifactName(platform, arch) {
  const target = normalizeChromaprintTarget(platform, arch)
  return `chromaprint-${CHROMAPRINT_VERSION}-${target.platform}-${target.arch}.zip`
}
