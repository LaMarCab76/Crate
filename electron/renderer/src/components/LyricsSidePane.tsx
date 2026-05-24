import { Icon } from './Icon'
import { LyricsPanel } from './LyricsPanel'

interface LyricsSidePaneProps {
  closing?: boolean
  onClose: () => void
}

export function LyricsSidePane({ closing = false, onClose }: LyricsSidePaneProps) {
  return (
    <aside className={`lyrics-side-pane ${closing ? 'closing' : ''}`} aria-label="Lyrics sidebar">
      <div className="lyrics-side-head">
        <span>Lyrics</span>
        <button type="button" className="tb-icon-btn" title="Close lyrics sidebar" aria-label="Close lyrics sidebar" onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
      </div>
      <LyricsPanel variant="side" />
    </aside>
  )
}
