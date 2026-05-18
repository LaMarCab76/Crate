import type { Track } from '@shared/types/library'
import { Icon } from '@renderer/components/Icon'
import { TrackTable } from '@renderer/components/TrackTable'
import { fmtTotal } from '@renderer/utils/format'
import { mockLibrary } from '@renderer/data/mockLibrary'

interface Props {
  playingId?: string
  onPlay?: (t: Track) => void
}

export function LibraryView({ playingId, onPlay }: Props) {
  const tracks = mockLibrary.tracks
  const totalDur = tracks.reduce((s, t) => s + t.d, 0)
  return (
    <>
      <div className="lib-head">
        <div>
          <h1>Songs</h1>
          <div className="sub">{tracks.length} tracks · {fmtTotal(totalDur)} · sorted by Date Added</div>
        </div>
        <div className="actions">
          <button className="btn ghost icon" title="Sort"><Icon name="sortAZ" /></button>
          <button className="btn ghost icon" title="Filter"><Icon name="filter" /></button>
          <button className="btn"><Icon name="play" size={12} /> Shuffle All</button>
        </div>
      </div>
      <TrackTable tracks={tracks} showArt playingId={playingId} onPlay={onPlay} />
    </>
  )
}
