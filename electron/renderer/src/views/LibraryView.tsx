import { Icon } from '@renderer/components/Icon'
import { TrackTable } from '@renderer/components/TrackTable'
import { fmtTotal } from '@renderer/utils/format'
import { useLibraryStore, useTracks } from '@renderer/stores/libraryStore'

function EmptyState() {
  const pickFolder = useLibraryStore(s => s.pickFolder)
  const addFolder = useLibraryStore(s => s.addFolder)
  const pickAndAdd = async () => {
    const picked = await pickFolder()
    if (picked) await addFolder(picked)
  }

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 48,
        textAlign: 'center',
        gap: 16,
      }}
    >
      <div style={{ color: 'var(--text-tertiary)' }}>
        <Icon name="folder" size={56} stroke={1.1} />
      </div>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
        Your library is empty
      </h1>
      <p
        style={{
          margin: 0,
          maxWidth: 380,
          color: 'var(--text-secondary)',
          fontSize: 13,
          lineHeight: 1.5,
        }}
      >
        Add a folder of audio files and HiFidelity will scan it for tracks. FLAC, ALAC,
        AAC, MP3, WAV, AIFF, OGG, OPUS, APE, DSD all supported.
      </p>
      <button className="btn primary" onClick={pickAndAdd}>
        <Icon name="plus" size={12} /> Add Folder…
      </button>
    </div>
  )
}

export function LibraryView() {
  const tracks = useTracks()

  if (tracks.length === 0) {
    return <EmptyState />
  }

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
      <TrackTable tracks={tracks} showArt />
    </>
  )
}
