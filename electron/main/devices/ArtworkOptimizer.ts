import { nativeImage } from 'electron'
import { ByteVector, File, Picture, PictureType, type IPicture } from 'node-taglib-sharp'
import { clampDeviceArtworkEdge } from '@shared/constants/device-sync'

const JPEG_QUALITY = 85

type SupportedArtworkFormat = 'jpeg' | 'png'

export interface EmbeddedArtworkOptimizationResult {
  scannedPictures: number
  optimizedPictures: number
  skippedPictures: number
  bytesSaved: number
}

function emptyResult(): EmbeddedArtworkOptimizationResult {
  return {
    scannedPictures: 0,
    optimizedPictures: 0,
    skippedPictures: 0,
    bytesSaved: 0,
  }
}

function filenameWithExtension(filename: string | null | undefined, extension: string): string {
  const cleaned = (filename ?? '').trim()
  if (!cleaned) return `cover.${extension}`
  return cleaned.replace(/\.[^.]+$/, '') + `.${extension}`
}

function detectArtworkFormat(picture: IPicture, data: Buffer): SupportedArtworkFormat | null {
  const mimeType = (picture.mimeType ?? '').toLowerCase()
  if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') return 'jpeg'
  if (mimeType === 'image/png') return 'png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg'
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) {
    return 'png'
  }
  return null
}

function encodeResizedArtwork(
  image: Electron.NativeImage,
  format: SupportedArtworkFormat,
): { data: Buffer; mimeType: string; extension: string } {
  if (format === 'png') {
    return {
      data: image.toPNG(),
      mimeType: 'image/png',
      extension: 'png',
    }
  }

  return {
    data: image.toJPEG(JPEG_QUALITY),
    mimeType: 'image/jpeg',
    extension: 'jpg',
  }
}

function resizePicture(
  picture: IPicture,
  maxEdge: number,
): { picture: IPicture; optimized: boolean; bytesSaved: number } {
  const original = Buffer.from(picture.data.toByteArray())
  const format = detectArtworkFormat(picture, original)
  if (!format) return { picture, optimized: false, bytesSaved: 0 }

  const image = nativeImage.createFromBuffer(original)
  if (image.isEmpty()) return { picture, optimized: false, bytesSaved: 0 }

  const size = image.getSize()
  if (size.width <= maxEdge && size.height <= maxEdge) {
    return { picture, optimized: false, bytesSaved: 0 }
  }

  const scale = Math.min(maxEdge / size.width, maxEdge / size.height)
  const width = Math.max(1, Math.round(size.width * scale))
  const height = Math.max(1, Math.round(size.height * scale))
  const resized = image.resize({ width, height, quality: 'best' })
  const encoded = encodeResizedArtwork(resized, format)
  if (encoded.data.byteLength >= original.byteLength) {
    return { picture, optimized: false, bytesSaved: 0 }
  }

  const next = Picture.fromFullData(
    ByteVector.fromByteArray(encoded.data),
    picture.type ?? PictureType.FrontCover,
    encoded.mimeType,
    picture.description || 'cover',
  )
  next.filename = filenameWithExtension(picture.filename, encoded.extension)
  return {
    picture: next,
    optimized: true,
    bytesSaved: original.byteLength - encoded.data.byteLength,
  }
}

export function optimizeEmbeddedArtwork(filePath: string, maxEdge: number): EmbeddedArtworkOptimizationResult {
  const effectiveMaxEdge = clampDeviceArtworkEdge(maxEdge)
  const file = File.createFromPath(filePath)
  try {
    if (file.isPossiblyCorrupt) {
      return emptyResult()
    }
    if (!file.isWritable) return emptyResult()

    const pictures = file.tag.pictures ?? []
    if (pictures.length === 0) return emptyResult()

    const result = emptyResult()
    const nextPictures: IPicture[] = []
    let changed = false

    for (const picture of pictures) {
      result.scannedPictures += 1
      const next = resizePicture(picture, effectiveMaxEdge)
      nextPictures.push(next.picture)
      if (next.optimized) {
        changed = true
        result.optimizedPictures += 1
        result.bytesSaved += next.bytesSaved
      } else {
        result.skippedPictures += 1
      }
    }

    if (changed) {
      file.tag.pictures = nextPictures
      file.save()
    }

    return result
  } finally {
    file.dispose()
  }
}
