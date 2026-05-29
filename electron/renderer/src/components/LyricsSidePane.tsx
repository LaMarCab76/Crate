import type { CSSProperties } from 'react'
import { Icon } from './Icon'
import { LyricsPanel } from './LyricsPanel'

interface LyricsSidePaneProps {
  closing?: boolean
  width: number
  onClose: () => void
}

export function LyricsSidePane({ closing = false, width, onClose }: LyricsSidePaneProps) {
  return (
    <aside
      className={`lyrics-side-pane ${closing ? 'closing' : ''}`}
      aria-label="Lyrics sidebar"
      style={{ '--lyrics-side-w': `${width}px` } as CSSProperties}
    >
      <div className="lyrics-side-head">
        <span>Lyrics</span>
        <button type="button" className="tb-icon-btn" title="Close lyrics sidebar" aria-label="Close lyrics sidebar" onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
      </div>
      <LyricsPanel variant="side" active={!closing} />
    </aside>
  )
}
