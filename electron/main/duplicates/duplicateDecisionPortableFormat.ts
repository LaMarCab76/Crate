import { parse as parseYaml } from 'yaml'
import { isSafePortablePath } from '../cloud/cloudPortableManifest.ts'

export const DUPLICATE_DECISIONS_VERSION = 1
export const DUPLICATE_DECISIONS_MAX_BYTES = 10 * 1024 * 1024

export interface PortableBinding {
  relativePath: string
  algorithm: string
  algorithmVersion: string
  acousticDigest: string
}

export interface PortableDecision {
  id: string
  lowIdentityId: string
  highIdentityId: string
  lowAcousticDigest: string
  highAcousticDigest: string
  algorithm: string
  algorithmVersion: string
  reason: 'versiones_distintas' | 'no_son_duplicados'
  createdAt: string
  updatedAt: string
}

export interface PortableDuplicateDecisionFile {
  version: 1
  appName: 'Crate'
  updatedAt: string
  bindings: Record<string, PortableBinding>
  decisions: Record<string, PortableDecision>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value)
}

export function parseDuplicateDecisionPortable(text: string): PortableDuplicateDecisionFile | null {
  if (Buffer.byteLength(text, 'utf8') > DUPLICATE_DECISIONS_MAX_BYTES) return null
  let parsed: unknown
  try {
    parsed = parseYaml(text)
  } catch {
    return null
  }
  if (
    !isRecord(parsed)
    || parsed.version !== DUPLICATE_DECISIONS_VERSION
    || !isRecord(parsed.bindings)
    || !isRecord(parsed.decisions)
  ) return null

  const bindings: Record<string, PortableBinding> = {}
  for (const [id, raw] of Object.entries(parsed.bindings)) {
    if (!id || !isRecord(raw)) continue
    const relativePath = typeof raw.relativePath === 'string' ? raw.relativePath : ''
    const algorithm = typeof raw.algorithm === 'string' ? raw.algorithm : ''
    const algorithmVersion = typeof raw.algorithmVersion === 'string' ? raw.algorithmVersion : ''
    const acousticDigest = typeof raw.acousticDigest === 'string' ? raw.acousticDigest : ''
    if (!isSafePortablePath(relativePath) || !algorithm || !algorithmVersion || !acousticDigest) continue
    bindings[id] = { relativePath, algorithm, algorithmVersion, acousticDigest }
  }

  const decisions: Record<string, PortableDecision> = {}
  for (const [key, raw] of Object.entries(parsed.decisions)) {
    if (!key || !isRecord(raw)) continue
    const reason = raw.reason
    if (reason !== 'versiones_distintas' && reason !== 'no_son_duplicados') continue
    const decision: PortableDecision = {
      id: typeof raw.id === 'string' ? raw.id : '',
      lowIdentityId: typeof raw.lowIdentityId === 'string' ? raw.lowIdentityId : '',
      highIdentityId: typeof raw.highIdentityId === 'string' ? raw.highIdentityId : '',
      lowAcousticDigest: typeof raw.lowAcousticDigest === 'string' ? raw.lowAcousticDigest : '',
      highAcousticDigest: typeof raw.highAcousticDigest === 'string' ? raw.highAcousticDigest : '',
      algorithm: typeof raw.algorithm === 'string' ? raw.algorithm : '',
      algorithmVersion: typeof raw.algorithmVersion === 'string' ? raw.algorithmVersion : '',
      reason,
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    }
    if (
      !decision.id || !decision.lowIdentityId || !decision.highIdentityId
      || decision.lowIdentityId >= decision.highIdentityId
      || !decision.lowAcousticDigest || !decision.highAcousticDigest
      || !decision.algorithm || !decision.algorithmVersion || !decision.createdAt || !decision.updatedAt
    ) continue
    decisions[key] = decision
  }
  return {
    version: DUPLICATE_DECISIONS_VERSION,
    appName: 'Crate',
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
    bindings,
    decisions,
  }
}
