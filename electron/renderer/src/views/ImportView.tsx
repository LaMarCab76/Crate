import { Icon } from '@renderer/components/Icon'

const SAMPLE_FOLDERS = [
  { p: '~/Music/HiFidelity Library', n: 412, s: '38.4 GB', a: 'Active' },
  { p: '~/Downloads/Vinyl Rips',     n: 64,  s: '6.1 GB',  a: 'Active' },
  { p: '/Volumes/Studio/Masters',    n: 188, s: '142 GB',  a: 'Disconnected' },
]

export function ImportView() {
  return (
    <div>
      <div className="lib-head">
        <div>
          <h1>Library Sources</h1>
          <div className="sub">Folders HiFidelity watches for new files.</div>
        </div>
        <div className="actions">
          <button className="btn"><Icon name="plus" size={12} /> Add Folder…</button>
        </div>
      </div>

      <div className="import-drop">
        <div className="ic"><Icon name="drop" size={32} stroke={1.3} /></div>
        <h3>Drop audio files here</h3>
        <p>FLAC, ALAC, AAC, MP3, AIFF, WAV · or use Add Folder above</p>
      </div>

      <div style={{ padding: '0 24px 24px' }}>
        <div className="set-section">
          <h2>Watched Folders</h2>
          <div className="set-card">
            {SAMPLE_FOLDERS.map((f, i) => (
              <div key={i} className="folder-row">
                <Icon name="folder" />
                <div className="path">{f.p}</div>
                <div className="stat">{f.n} tracks · {f.s}</div>
                <div className="stat" style={{ color: f.a === 'Active' ? '#34c759' : 'var(--text-tertiary)' }}>
                  {f.a}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="set-section">
          <h2>Import Settings</h2>
          <div className="set-card">
            <div className="set-row">
              <div>
                <div className="lbl">Read tags & artwork on import</div>
                <div className="sub">ID3v2 / Vorbis / iXML metadata.</div>
              </div>
              <div className="toggle on" />
            </div>
            <div className="set-row">
              <div>
                <div className="lbl">Auto-fetch missing artwork</div>
                <div className="sub">From MusicBrainz when albums are unidentified.</div>
              </div>
              <div className="toggle on" />
            </div>
            <div className="set-row">
              <div>
                <div className="lbl">Keep files in original location</div>
                <div className="sub">Don't copy into the library folder.</div>
              </div>
              <div className="toggle" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
