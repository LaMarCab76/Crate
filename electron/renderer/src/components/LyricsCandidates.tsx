import { fmtTime } from '@renderer/utils/format'
import { useLyricsStore } from '@renderer/stores/lyricsStore'
import { ModalShell } from './ModalShell'

// Online-search result chooser. Mounted once at app root; renders only when the
// lyrics store has candidates (i.e. a manual search returned more than one hit).
export function LyricsCandidates() {
  const candidates = useLyricsStore(s => s.candidates)
  const busy = useLyricsStore(s => s.busy)
  if (!candidates) return null

  return (
    <ModalShell title="Elegir letra" onClose={() => useLyricsStore.getState().dismissCandidates()}>
      <div className="lyr-cand-list">
        {candidates.length === 0 && <div className="modal-muted">No hay resultados.</div>}
        {candidates.map(c => (
          <button
            key={c.id}
            type="button"
            className="lyr-cand-row"
            disabled={busy}
            onClick={() => { void useLyricsStore.getState().chooseCandidate(c.id) }}
          >
            <div className="lyr-cand-main">
              <div className="lyr-cand-title">{c.trackName}</div>
              <div className="lyr-cand-sub">
                {c.artistName}{c.albumName ? ` · ${c.albumName}` : ''}
              </div>
            </div>
            <div className="lyr-cand-meta">
              {c.durationSeconds != null && <span className="lyr-cand-dur">{fmtTime(c.durationSeconds)}</span>}
              {c.instrumental ? (
                <span className="lyr-badge inst">Instrumental</span>
              ) : c.hasSynced ? (
                <span className="lyr-badge synced">Synced</span>
              ) : c.hasPlain ? (
                <span className="lyr-badge plain">Plain</span>
              ) : null}
            </div>
          </button>
        ))}
      </div>
    </ModalShell>
  )
}
