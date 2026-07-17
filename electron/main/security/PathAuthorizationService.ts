import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

export type PathAuthorizationPurpose =
  | 'library:add'
  | 'library:location'
  | 'device:connect'
  | 'device:pick-music-root'
  | 'device:ignore'

interface PathAuthorization {
  path: string
  purposes: Set<PathAuthorizationPurpose>
  expiresAt: number
}

const DEFAULT_TTL_MS = 5 * 60 * 1000
const MAX_AUTHORIZATIONS = 2_000

/**
 * Keeps filesystem paths on the main side of the IPC boundary. Renderers only
 * receive opaque, short-lived capabilities scoped to the actions they need.
 */
export class PathAuthorizationService {
  private readonly authorizations = new Map<string, PathAuthorization>()

  issue(
    path: string,
    purposes: readonly PathAuthorizationPurpose[],
    ttlMs = DEFAULT_TTL_MS,
  ): string {
    if (purposes.length === 0) throw new Error('Path authorization requires a purpose')
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > DEFAULT_TTL_MS) {
      throw new Error('Invalid path authorization TTL')
    }

    this.pruneExpired()
    if (this.authorizations.size >= MAX_AUTHORIZATIONS) {
      const oldest = this.authorizations.keys().next().value as string | undefined
      if (oldest) this.authorizations.delete(oldest)
    }

    const token = randomUUID()
    this.authorizations.set(token, {
      path: resolve(path),
      purposes: new Set(purposes),
      expiresAt: Date.now() + ttlMs,
    })
    return token
  }

  resolve(
    token: string,
    purpose: PathAuthorizationPurpose,
    options: { consume?: boolean } = {},
  ): string {
    if (typeof token !== 'string' || token.length < 16 || token.length > 128) {
      throw new Error('Invalid or expired path authorization')
    }

    const authorization = this.authorizations.get(token)
    if (!authorization || authorization.expiresAt <= Date.now()) {
      this.authorizations.delete(token)
      throw new Error('Path authorization expired. Choose the folder again.')
    }
    if (!authorization.purposes.has(purpose)) {
      throw new Error('Path authorization is not valid for this action')
    }

    if (options.consume) {
      authorization.purposes.delete(purpose)
      if (authorization.purposes.size === 0) this.authorizations.delete(token)
    }
    return authorization.path
  }

  private pruneExpired(): void {
    const now = Date.now()
    for (const [token, authorization] of this.authorizations) {
      if (authorization.expiresAt <= now) this.authorizations.delete(token)
    }
  }
}

let instance: PathAuthorizationService | null = null

export function getPathAuthorizationService(): PathAuthorizationService {
  instance ??= new PathAuthorizationService()
  return instance
}
