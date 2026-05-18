import { Icon } from '@renderer/components/Icon'
import type { Tweak } from '@renderer/stores/settingsStore'

interface Props {
  tweak: Tweak
  setTweak: <K extends keyof Tweak>(key: K, value: Tweak[K]) => void
}

const EQ_BANDS = [
  { hz: '32',  v: 0.45 },
  { hz: '64',  v: 0.55 },
  { hz: '125', v: 0.60 },
  { hz: '250', v: 0.62 },
  { hz: '500', v: 0.55 },
  { hz: '1k',  v: 0.50 },
  { hz: '2k',  v: 0.45 },
  { hz: '4k',  v: 0.55 },
  { hz: '8k',  v: 0.68 },
  { hz: '16k', v: 0.72 },
]

export function SettingsView({ tweak, setTweak }: Props) {
  return (
    <div className="settings">
      <h1>Preferences</h1>

      <div className="set-section">
        <h2>Appearance</h2>
        <div className="set-card">
          <div className="set-row">
            <div>
              <div className="lbl">Theme</div>
              <div className="sub">Switch between light & dark interface.</div>
            </div>
            <div className="rule-row" style={{ margin: 0 }}>
              <div
                className="select"
                style={{ background: !tweak.dark ? 'var(--bg-selected)' : 'var(--bg-elev)' }}
                onClick={() => setTweak('dark', false)}
                role="button" tabIndex={0}
              >
                Light
              </div>
              <div
                className="select"
                style={{ background: tweak.dark ? 'var(--bg-selected)' : 'var(--bg-elev)' }}
                onClick={() => setTweak('dark', true)}
                role="button" tabIndex={0}
              >
                Dark
              </div>
            </div>
          </div>
          <div className="set-row">
            <div>
              <div className="lbl">Density</div>
              <div className="sub">Row height in lists & tables.</div>
            </div>
            <div className="rule-row" style={{ margin: 0 }}>
              {(['compact', 'regular', 'comfy'] as const).map(d => (
                <div
                  key={d}
                  className="select"
                  style={{ background: tweak.density === d ? 'var(--bg-selected)' : 'var(--bg-elev)' }}
                  onClick={() => setTweak('density', d)}
                  role="button" tabIndex={0}
                >
                  {d}
                </div>
              ))}
            </div>
          </div>
          <div className="set-row">
            <div>
              <div className="lbl">Translucent sidebar</div>
              <div className="sub">Vibrancy blur behind the navigation pane.</div>
            </div>
            <div
              className={`toggle ${tweak.translucent ? 'on' : ''}`}
              onClick={() => setTweak('translucent', !tweak.translucent)}
              role="switch"
              aria-checked={tweak.translucent}
              tabIndex={0}
            />
          </div>
        </div>
      </div>

      <div className="set-section">
        <h2>Playback</h2>
        <div className="set-card">
          <div className="set-row">
            <div>
              <div className="lbl">Crossfade</div>
              <div className="sub">Smoothly mix between songs. Currently {tweak.crossfade}s.</div>
            </div>
            <input
              type="range" min={0} max={12} step={1}
              value={tweak.crossfade}
              onChange={e => setTweak('crossfade', Number(e.target.value))}
              style={{ width: 160 }}
            />
          </div>
          <div className="set-row">
            <div>
              <div className="lbl">Gapless playback</div>
              <div className="sub">Honor album track-to-track sequencing.</div>
            </div>
            <div
              className={`toggle ${tweak.gapless ? 'on' : ''}`}
              onClick={() => setTweak('gapless', !tweak.gapless)}
              role="switch"
              aria-checked={tweak.gapless}
              tabIndex={0}
            />
          </div>
          <div className="set-row">
            <div>
              <div className="lbl">Sound check</div>
              <div className="sub">Normalize song loudness to a consistent target.</div>
            </div>
            <div
              className={`toggle ${tweak.soundcheck ? 'on' : ''}`}
              onClick={() => setTweak('soundcheck', !tweak.soundcheck)}
              role="switch"
              aria-checked={tweak.soundcheck}
              tabIndex={0}
            />
          </div>
        </div>
      </div>

      <div className="set-section">
        <h2>Equalizer</h2>
        <div className="eq-graph">
          {EQ_BANDS.map(b => (
            <div key={b.hz} className="eq-band">
              <div className="col">
                <div className="fill" style={{ bottom: 0, height: `${b.v * 100}%` }} />
              </div>
              <div className="hz">{b.hz}</div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
          <span className="muted tiny">Preset:</span>
          {['Flat', 'Vocal', 'Jazz', 'Electronic', 'Acoustic'].map(p => (
            <div
              key={p}
              className="select"
              style={{ background: p === 'Acoustic' ? 'var(--bg-selected)' : 'var(--bg-elev)' }}
            >
              {p}
            </div>
          ))}
        </div>
      </div>

      <div className="set-section">
        <h2>Output</h2>
        <div className="set-card">
          <div className="dev-list">
            <div className="dev-row active">
              <Icon name="computer" />
              <div>
                <div className="name">MacBook Pro Speakers</div>
                <div className="sub">Built-in · 48 kHz / 24-bit</div>
              </div>
              <Icon name="check" />
            </div>
            <div className="dev-row">
              <Icon name="headphones" />
              <div>
                <div className="name">Hanón Studio M1</div>
                <div className="sub">Wired · USB-C</div>
              </div>
            </div>
            <div className="dev-row">
              <Icon name="airplay" />
              <div>
                <div className="name">Living Room</div>
                <div className="sub">AirPlay 2 · HomePod mini</div>
              </div>
            </div>
            <div className="dev-row">
              <Icon name="bluetooth" />
              <div>
                <div className="name">Carlos's Earbuds</div>
                <div className="sub">Bluetooth · AAC</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
