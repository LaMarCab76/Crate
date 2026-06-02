type ArtworkStepStatus = 'pending' | 'running' | 'completed' | 'failed'

interface ArtworkProgressStep {
  status: ArtworkStepStatus
}

export interface OptimizedArtworkProbePicture {
  format: 'jpeg' | 'png' | null
  width: number | null
  height: number | null
}

export interface OptimizedArtworkProbe {
  pictures: OptimizedArtworkProbePicture[]
}

export interface ResizedArtworkOutcome {
  optimized: true
  bytesSaved: number
}

export const ARTWORK_ANALYSIS_YIELD_EVERY = 8

export function artworkBytesSaved(originalBytes: number, optimizedBytes: number): number {
  return Math.max(0, originalBytes - optimizedBytes)
}

export function resizedArtworkOutcome(originalBytes: number, optimizedBytes: number): ResizedArtworkOutcome {
  return {
    optimized: true,
    bytesSaved: artworkBytesSaved(originalBytes, optimizedBytes),
  }
}

export function artworkOptimizationTempPath(filePath: string): string {
  const dotIndex = filePath.lastIndexOf('.')
  const slashIndex = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  if (dotIndex <= slashIndex + 1) return `${filePath}.crate-tmp`
  return `${filePath.slice(0, dotIndex)}.crate-tmp${filePath.slice(dotIndex)}`
}

export function countProcessedArtworkSteps(steps: ArtworkProgressStep[]): number {
  return steps.reduce(
    (count, step) => count + (step.status === 'completed' || step.status === 'failed' ? 1 : 0),
    0,
  )
}

export function shouldYieldArtworkAnalysis(
  processed: number,
  total: number,
  batchSize = ARTWORK_ANALYSIS_YIELD_EVERY,
): boolean {
  if (processed <= 0 || processed >= total) return false
  return processed % batchSize === 0
}

export function assertOptimizedArtworkWithinLimit(probe: OptimizedArtworkProbe, maxEdge: number): void {
  for (const picture of probe.pictures) {
    if (picture.format === null || picture.width === null || picture.height === null) continue
    if (picture.width <= maxEdge && picture.height <= maxEdge) continue
    throw new Error(
      `Artwork optimization verification failed: ${picture.format} artwork is ${picture.width}x${picture.height}, over ${maxEdge}px limit`,
    )
  }
}

export function hasArtworkOverLimit(probe: OptimizedArtworkProbe, maxEdge: number): boolean {
  return probe.pictures.some(picture =>
    picture.format !== null &&
    picture.width !== null &&
    picture.height !== null &&
    (picture.width > maxEdge || picture.height > maxEdge)
  )
}
