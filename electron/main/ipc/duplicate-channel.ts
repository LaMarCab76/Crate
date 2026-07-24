import { BrowserWindow } from 'electron'
import type {
  DuplicateAuditionCompareSegmentRequest,
  DuplicateAuditionOpenRequest,
  DuplicateAuditionSeekRequest,
  DuplicateAuditionSide,
  DuplicateCandidateStatus,
  DuplicateListRequest,
  DuplicateResolutionRequest,
} from '@shared/types/duplicates'
import { getDuplicateAuditionService } from '../duplicates/DuplicateAuditionService'
import { getDuplicateResolutionService } from '../duplicates/DuplicateResolutionService'
import { getDuplicateRuntime } from '../duplicates/runtime'
import { secureIpcMain as ipcMain } from './secureIpc'

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} inválido.`)
  return value as Record<string, unknown>
}

function candidateId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new Error('Identificador de caso inválido.')
  }
  return value
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) throw new Error(`${label} inválido.`)
  return Number(value)
}

function side(value: unknown): DuplicateAuditionSide {
  if (value !== 'left' && value !== 'right') throw new Error('Lado de audición inválido.')
  return value
}

function listRequest(value: unknown): DuplicateListRequest {
  if (value == null) return {}
  const raw = record(value, 'Filtro')
  const allowed = new Set<DuplicateCandidateStatus>(['pending', 'dismissed', 'stale'])
  const status = raw.status == null ? undefined : String(raw.status) as DuplicateCandidateStatus
  if (status && !allowed.has(status)) throw new Error('Estado de duplicado inválido.')
  const limit = raw.limit == null ? undefined : positiveInteger(raw.limit, 'Límite')
  const offset = raw.offset == null ? undefined : Number(raw.offset)
  if (offset != null && (!Number.isInteger(offset) || offset < 0)) throw new Error('Offset inválido.')
  return { status, limit, offset }
}

function resolutionRequest(value: unknown): DuplicateResolutionRequest {
  const raw = record(value, 'Resolución')
  const base = {
    candidateId: candidateId(raw.candidateId),
    expectedRevision: positiveInteger(raw.expectedRevision, 'Revisión'),
  }
  if (raw.action === 'keep_both') {
    if (raw.reason !== 'different_versions' && raw.reason !== 'not_duplicates') {
      throw new Error('Elegí por qué querés conservar ambas pistas.')
    }
    return { ...base, action: 'keep_both', reason: raw.reason }
  }
  if (raw.action === 'trash_left' || raw.action === 'trash_right') {
    if (raw.reason != null) throw new Error('La acción de Papelera no acepta una razón enviada por el renderer.')
    return { ...base, action: raw.action }
  }
  throw new Error('Acción de resolución inválida.')
}

function openRequest(value: unknown): DuplicateAuditionOpenRequest {
  const raw = record(value, 'Audición')
  return {
    candidateId: candidateId(raw.candidateId),
    expectedRevision: positiveInteger(raw.expectedRevision, 'Revisión'),
  }
}

function seekRequest(value: unknown): DuplicateAuditionSeekRequest {
  const raw = record(value, 'Búsqueda')
  const positionSec = Number(raw.positionSec)
  if (!Number.isFinite(positionSec) || positionSec < 0 || positionSec > 24 * 60 * 60) {
    throw new Error('Posición de audición inválida.')
  }
  return { side: side(raw.side), positionSec }
}

function segmentRequest(value: unknown): DuplicateAuditionCompareSegmentRequest {
  const raw = record(value, 'Segmento')
  const segmentIndex = Number(raw.segmentIndex)
  if (!Number.isInteger(segmentIndex) || segmentIndex < 0 || segmentIndex > 100_000) {
    throw new Error('Segmento inválido.')
  }
  return { segmentIndex }
}

export function registerDuplicateChannel(): void {
  const runtime = getDuplicateRuntime()
  const audition = getDuplicateAuditionService()
  const resolution = getDuplicateResolutionService()

  ipcMain.handle('duplicates:summary', () => runtime.summary())
  ipcMain.handle('duplicates:list', (_event, value: unknown) =>
    runtime.service.listCandidates(listRequest(value)))
  ipcMain.handle('duplicates:detail', (_event, value: unknown) => {
    const detail = runtime.service.getCandidate(candidateId(value))
    if (!detail) throw new Error('El caso ya no está disponible.')
    return detail
  })
  ipcMain.handle('duplicates:reanalyze', () => {
    runtime.scheduleAll({ force: true, delayMs: 0 })
  })
  ipcMain.handle('duplicates:resolve', async (event, value: unknown) => {
    const request = resolutionRequest(value)
    audition.pause()
    const result = await resolution.resolve(
      request,
      BrowserWindow.fromWebContents(event.sender) ?? undefined,
    )
    await audition.invalidateCandidate(request.candidateId)
    return result
  })

  ipcMain.handle('duplicates:audition:open', (event, value: unknown) =>
    audition.open(openRequest(value), BrowserWindow.fromWebContents(event.sender) ?? undefined))
  ipcMain.handle('duplicates:audition:beginSession', () => audition.beginSession())
  ipcMain.handle('duplicates:audition:play', (_event, value: unknown) =>
    audition.play(side(value)))
  ipcMain.handle('duplicates:audition:pause', () => audition.pause())
  ipcMain.handle('duplicates:audition:seek', (_event, value: unknown) =>
    audition.seek(seekRequest(value)))
  ipcMain.handle('duplicates:audition:compareSegment', (_event, value: unknown) =>
    audition.compareSegment(segmentRequest(value)))
  ipcMain.handle('duplicates:audition:close', () => audition.close())
}

export async function disposeDuplicateChannel(): Promise<void> {
  try { await getDuplicateAuditionService().close() } catch { /* no active audition */ }
}
