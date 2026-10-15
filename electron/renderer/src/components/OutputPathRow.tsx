// Bit-perfect indicator shown at the top of the Audio Output menus: what the
// track is, what the device receives and, when they differ, why.

import { describeOutputPath } from '@shared/utils/outputPath'
import { useEqStore } from '@renderer/stores/eqStore'
import { useOutputInfoStore } from '@renderer/stores/outputInfoStore'

export function OutputPathRow() {
  const info = useOutputInfoStore(s => s.info)
  const eqEnabled = useEqStore(s => s.enabled)
  const path = describeOutputPath(info, { eqEnabled }, window.api.meta.platform)
  if (path.state === 'idle') return null
  return (
    <div className={`output-path-row ${path.state}`} role="status">
      <div className="output-path-formats">
        <span className="output-path-format">{path.source}</span>
        <span className="output-path-arrow" aria-hidden="true">→</span>
        <span className="output-path-format">{path.output}</span>
        <span className="output-path-headline">{path.headline}</span>
      </div>
      {path.reasons.length > 0 && (
        <div className="output-path-reasons">{path.reasons.join(' · ')}</div>
      )}
    </div>
  )
}
