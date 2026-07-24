import { resolve } from 'node:path'
import { getRepos } from '../../db/repositories/index.ts'
import { getLocalFileAccessService } from '../../security/localFileAccessRuntime.ts'
import type { FingerprintProvider, FingerprintSource } from '../fingerprint.ts'
import { UnavailableFingerprintProvider } from '../fingerprint.ts'
import { BassChromaprintPcmDecoder } from './BassChromaprintPcmDecoder.ts'
import {
  CHROMAPRINT_PROVIDER_VERSION,
  ChromaprintFingerprintProvider,
} from './ChromaprintFingerprintProvider.ts'
import { DefaultChromaprintSourceResolver } from './ChromaprintSourceResolver.ts'
import {
  getChromaprintAvailability,
  type ChromaprintUnavailableReason,
} from './chromaprint-ffi.ts'

export * from './BassChromaprintPcmDecoder.ts'
export * from './ChromaprintFingerprintProvider.ts'
export * from './ChromaprintSourceResolver.ts'
export * from './chromaprint-ffi.ts'
export * from './chromaprint-paths.ts'

function unavailableCopy(reason: ChromaprintUnavailableReason): {
    code: 'native_component_missing' | 'native_component_incompatible' | 'native_component_load_failed'
    message: string
  } {
  switch (reason) {
    case 'missing_binary':
      return {
        code: 'native_component_missing',
        message: `Falta el componente acústico Chromaprint ${CHROMAPRINT_PROVIDER_VERSION}. El análisis no se inició y las pistas no presentan errores.`,
      }
    case 'version_mismatch':
      return {
        code: 'native_component_incompatible',
        message: `La versión instalada de Chromaprint no es compatible con Crate. El análisis no se inició y las pistas no presentan errores.`,
      }
    default:
      return {
        code: 'native_component_load_failed',
        message: `Chromaprint ${CHROMAPRINT_PROVIDER_VERSION} está instalado, pero Crate no pudo cargarlo. El análisis no se inició y las pistas no presentan errores.`,
      }
  }
}

function comparableLocalPath(value: string): string {
  const normalized = resolve(value).normalize('NFC')
  return process.platform === 'darwin' || process.platform === 'win32'
    ? normalized.toLocaleLowerCase('en-US')
    : normalized
}

async function authorizeIndexedLocalTrackRead(
  source: FingerprintSource,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  const repos = getRepos()
  const track = repos.tracks.getById(source.trackId)
  if (
    !track
    || track.provider !== 'local'
    || comparableLocalPath(track.path) !== comparableLocalPath(source.locator)
  ) {
    throw new Error('La pista local cambió o ya no pertenece a la biblioteca indexada.')
  }
  const folder = repos.folders.getById(track.folder_id)
  if (!folder || folder.provider !== 'local' || folder.role !== 'library') {
    throw new Error('La biblioteca local principal ya no está disponible.')
  }
  await getLocalFileAccessService().runWithAccess(
    folder.path,
    'read',
    async () => { signal?.throwIfAborted() },
    { interactive: false, retryOnce: false },
  )
}

/** Stable main-process factory used by duplicate startup/IPC wiring. */
export function createChromaprintFingerprintProvider(): FingerprintProvider {
  const availability = getChromaprintAvailability()
  if (!availability.available) {
    const copy = unavailableCopy(availability.reason)
    return new UnavailableFingerprintProvider(
      'chromaprint',
      CHROMAPRINT_PROVIDER_VERSION,
      availability.detail,
      {
        code: copy.code,
        message: copy.message,
        component: 'Chromaprint',
      },
    )
  }
  return new ChromaprintFingerprintProvider(
    new DefaultChromaprintSourceResolver({ authorizeLocalRead: authorizeIndexedLocalTrackRead }),
    new BassChromaprintPcmDecoder(),
    { availability: () => availability },
  )
}
