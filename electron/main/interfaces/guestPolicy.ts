import type { InterfaceCapability, InterfaceGuestRequest } from '../../../shared/types/interfaces'

export const GUEST_METHOD_CAPABILITIES: Record<string, InterfaceCapability> = {
  'library.tracks': 'library.read', 'library.albums': 'library.read', 'library.artists': 'library.read',
  'library.playlists': 'library.read', 'library.search': 'library.read', 'library.albumTracks': 'library.read',
  'library.artistTracks': 'library.read', 'library.playlistTracks': 'library.read', 'library.trackCount': 'library.read',
  'playback.play': 'playback.control', 'playback.pause': 'playback.control', 'playback.toggle': 'playback.control',
  'playback.next': 'playback.control', 'playback.previous': 'playback.control', 'playback.seek': 'playback.control',
  'playback.volume': 'playback.control', 'playback.playTrack': 'playback.control',
  'queue.add': 'queue.control', 'queue.play': 'queue.control', 'queue.clear': 'queue.control', 'queue.remove': 'queue.control',
  'queue.list': 'library.read',
  'navigation.go': 'navigation', 'navigation.openSettings': 'navigation',
}

export function boundedJson(input: unknown, maximumBytes: number): unknown {
  let json: string | undefined
  try { json = JSON.stringify(input, (key, value) => {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error('Reserved object property')
    return value
  }) } catch { throw new Error('SDK messages must contain serializable JSON') }
  if (json === undefined) return null
  if (Buffer.byteLength(json) > maximumBytes) throw new Error('SDK message exceeds its size limit')
  return JSON.parse(json)
}

export function validateGuestRequest(input: unknown, capabilities: string[]): Omit<InterfaceGuestRequest, 'requestId'> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid SDK request')
  const value = input as Record<string, unknown>
  if (typeof value.method !== 'string' || !Object.hasOwn(GUEST_METHOD_CAPABILITIES, value.method)) throw new Error('SDK method is unavailable')
  if (!capabilities.includes(GUEST_METHOD_CAPABILITIES[value.method])) throw new Error(`Interface has not declared ${GUEST_METHOD_CAPABILITIES[value.method]}`)
  const params = boundedJson(value.params ?? {}, 64 * 1024) as Record<string, unknown>
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('SDK parameters must be an object')
  if (params.limit != null && (!Number.isInteger(params.limit) || Number(params.limit) < 1 || Number(params.limit) > 250)) throw new Error('SDK query limit must be between 1 and 250')
  if (params.offset != null && (!Number.isInteger(params.offset) || Number(params.offset) < 0 || Number(params.offset) > 10_000_000)) throw new Error('Invalid SDK query offset')
  return { method: value.method, params }
}
