import type { DuplicateAnalysisProgress } from '@shared/types/duplicates'

export type DuplicateActivityOrigin = NonNullable<DuplicateAnalysisProgress['activityOrigin']>

export function mergeDuplicateActivityOrigin(
  current: DuplicateActivityOrigin,
  incoming: DuplicateActivityOrigin = 'background',
): DuplicateActivityOrigin {
  return current === 'startup' || incoming === 'startup' ? 'startup' : 'background'
}
