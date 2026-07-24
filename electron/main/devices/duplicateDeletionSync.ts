export interface DuplicateDeletionIntentLike {
  id: string
  syncKey: string
  relativePath: string
  expectedFingerprint: string
}

export interface DuplicateDeviceTrackLike {
  key: string
  relativePath: string
  /** Existing sync identity; useful for narrowing renamed candidates. */
  fingerprint: string
  /** Fresh Chromaprint digest, populated only for destructive verification. */
  acousticDigest?: string | null
}

interface DuplicateDeletionFingerprintV2 {
  version: 2
  metadataFingerprint: string
  acousticDigest: string
}

function parseExpectedFingerprint(value: string): DuplicateDeletionFingerprintV2 | null {
  try {
    const parsed = JSON.parse(value) as Partial<DuplicateDeletionFingerprintV2>
    if (
      parsed.version !== 2
      || typeof parsed.metadataFingerprint !== 'string'
      || !parsed.metadataFingerprint
      || typeof parsed.acousticDigest !== 'string'
      || !/^[a-f0-9]{64}$/i.test(parsed.acousticDigest)
    ) return null
    return {
      version: 2,
      metadataFingerprint: parsed.metadataFingerprint,
      acousticDigest: parsed.acousticDigest.toLowerCase(),
    }
  } catch {
    return null
  }
}

export function encodeDuplicateDeletionFingerprint(
  metadataFingerprint: string,
  acousticDigest: string,
): string {
  if (!metadataFingerprint || !/^[a-f0-9]{64}$/i.test(acousticDigest)) {
    throw new Error('Duplicate device deletion requires metadata and acoustic fingerprints.')
  }
  return JSON.stringify({
    version: 2,
    metadataFingerprint,
    acousticDigest: acousticDigest.toLowerCase(),
  } satisfies DuplicateDeletionFingerprintV2)
}

function pathKey(value: string): string {
  return value.replaceAll('\\', '/').normalize('NFC').toLocaleLowerCase('en-US')
}

export type DuplicateDeletionDisposition =
  | { kind: 'already_absent'; intent: DuplicateDeletionIntentLike }
  | { kind: 'pending_absence'; intent: DuplicateDeletionIntentLike }
  | {
      kind: 'delete'
      intent: DuplicateDeletionIntentLike
      device: DuplicateDeviceTrackLike
      relatedDevices: DuplicateDeviceTrackLike[]
    }
  | {
      kind: 'conflict'
      intent: DuplicateDeletionIntentLike
      device: DuplicateDeviceTrackLike
      relatedDevices: DuplicateDeviceTrackLike[]
    }

function exactTrack(
  intent: DuplicateDeletionIntentLike,
  byKey: ReadonlyMap<string, DuplicateDeviceTrackLike>,
  byPath: ReadonlyMap<string, DuplicateDeviceTrackLike>,
): DuplicateDeviceTrackLike | undefined {
  return byKey.get(intent.syncKey) ?? byPath.get(pathKey(intent.relativePath))
}

/**
 * Returns the smallest set that needs a fresh acoustic fingerprint. An exact
 * key/path is preferred; when the file was renamed, stable sync metadata is
 * used only to narrow the search and Chromaprint remains the delete authority.
 */
export function duplicateDeletionVerificationTracks(
  intents: readonly DuplicateDeletionIntentLike[],
  deviceTracks: readonly DuplicateDeviceTrackLike[],
  additionalKeys: ReadonlySet<string> = new Set(),
): DuplicateDeviceTrackLike[] {
  const byKey = new Map(deviceTracks.map(track => [track.key, track]))
  const byPath = new Map(deviceTracks.map(track => [pathKey(track.relativePath), track]))
  const selected = new Map<string, DuplicateDeviceTrackLike>()
  for (const track of deviceTracks) {
    if (additionalKeys.has(track.key)) selected.set(track.key, track)
  }
  for (const intent of intents) {
    const expected = parseExpectedFingerprint(intent.expectedFingerprint)
    if (!expected) continue
    const exact = exactTrack(intent, byKey, byPath)
    const candidates = exact
      ? [exact]
      : deviceTracks.filter(track => track.fingerprint === expected.metadataFingerprint)
    for (const track of candidates) selected.set(track.key, track)
  }
  return [...selected.values()]
}

/**
 * Reconciles persistent duplicate-cleanup intentions with a fresh device scan.
 * The caller turns `delete` into a reviewed delete_device action, surfaces
 * `conflict`, and marks `already_absent` only after this scan proved absence.
 */
export function reconcileDuplicateDeletionIntents(
  intents: readonly DuplicateDeletionIntentLike[],
  deviceTracks: readonly DuplicateDeviceTrackLike[],
  options: { acousticInventoryComplete?: boolean } = {},
): DuplicateDeletionDisposition[] {
  const byKey = new Map(deviceTracks.map(track => [track.key, track]))
  const byPath = new Map(deviceTracks.map(track => [pathKey(track.relativePath), track]))
  return intents.map(intent => {
    const expected = parseExpectedFingerprint(intent.expectedFingerprint)
    if (!expected) {
      // Legacy rows remain conservative at their original path. They are not
      // considered portable across a rename because they lack audio identity.
      const device = exactTrack(intent, byKey, byPath)
      if (!device) return { kind: 'already_absent', intent }
      if (device.fingerprint !== intent.expectedFingerprint) {
        return { kind: 'conflict', intent, device, relatedDevices: [device] }
      }
      return { kind: 'delete', intent, device, relatedDevices: [device] }
    }

    const exact = exactTrack(intent, byKey, byPath)
    if (exact) {
      if (exact.acousticDigest?.toLowerCase() === expected.acousticDigest) {
        return { kind: 'delete', intent, device: exact, relatedDevices: [exact] }
      }
      return { kind: 'conflict', intent, device: exact, relatedDevices: [exact] }
    }

    const acousticMatches = deviceTracks.filter(
      track => track.acousticDigest?.toLowerCase() === expected.acousticDigest,
    )
    const metadataMatches = deviceTracks.filter(
      track => track.fingerprint === expected.metadataFingerprint,
    )
    const related = [...new Map(
      [...acousticMatches, ...metadataMatches].map(track => [track.key, track]),
    ).values()]
    if (acousticMatches.length === 1) {
      return { kind: 'delete', intent, device: acousticMatches[0], relatedDevices: related }
    }
    if (related.length > 0) {
      // Missing native verification, changed audio, or multiple indistinguishable
      // copies are all review conflicts. None may be silently copied back.
      return { kind: 'conflict', intent, device: related[0], relatedDevices: related }
    }
    return options.acousticInventoryComplete === false
      ? { kind: 'pending_absence', intent }
      : { kind: 'already_absent', intent }
  })
}
