import { Icon } from '@renderer/components/Icon'
import type { Tweak } from '@renderer/stores/settingsStore'
import { useEqStore } from '@renderer/stores/eqStore'

interface Props {
  tweak: Tweak
  setTweak: <K extends keyof Tweak>(key: K, value: Tweak[K]) => void
}

const EQ_LABELS = ['32', '64', '125', '250', '500', '1k', '2k', '4k', '8k', '16k']

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
        <h2>Library</h2>
        <div className="set-card">
          <div className="set-row">
            <div>
              <div className="lbl">Keep portable backup in folder</div>
              <div className="sub">
                Saves your plays, favorites, ratings, lyrics and EQ overrides into a hidden{' '}
                <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>.hifidelity-library.json</code>
                {' '}at the root of each library folder. When you reconnect the folder elsewhere those
                are merged back automatically.
              </div>
            </div>
            <div
              className={`toggle ${tweak.libraryBackup ? 'on' : ''}`}
              onClick={() => setTweak('libraryBackup', !tweak.libraryBackup)}
              role="switch"
              aria-checked={tweak.libraryBackup}
              tabIndex={0}
            />
          </div>
        </div>
      </div>

      <div className="set-section">
        <h2>Equalizer</h2>
        <EqPanel />
      </div>

      <div className="set-section">
        <h2>Output</h2>
        <div style={{ padding: '0 4px 12px', color: 'var(--text-tertiary)', fontSize: 12 }}>
          DAC selection + hog mode arrive in a later session. For now BASS uses the system default output.
        </div>
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

function EqPanel() {
  const enabled = useEqStore(s => s.enabled)
  const preset = useEqStore(s => s.preset)
  const bands = useEqStore(s => s.bands)
  const presetNames = useEqStore(s => s.presetNames)
  const setEnabled = useEqStore(s => s.setEnabled)
  const setBand = useEqStore(s => s.setBand)
  const setPreset = useEqStore(s => s.setPreset)

  return (
    <>
      <div className="set-card" style={{ marginBottom: 12 }}>
        <div className="set-row">
          <div>
            <div className="lbl">Enable equalizer</div>
            <div className="sub">10-band peaking EQ applied to the BASS playback chain.</div>
          </div>
          <div
            className={`toggle ${enabled ? 'on' : ''}`}
            onClick={() => { void setEnabled(!enabled) }}
            role="switch"
            aria-checked={enabled}
            tabIndex={0}
          />
        </div>
      </div>

      <div className="eq-graph" style={{ opacity: enabled ? 1 : 0.45 }}>
        {bands.map((gain, i) => {
          // Map -15..+15 dB → 0..1 for the column fill height; center at 0 dB.
          const normalized = (gain + 15) / 30
          return (
            <div key={EQ_LABELS[i]} className="eq-band">
              <input
                type="range"
                min={-15}
                max={15}
                step={0.5}
                value={gain}
                disabled={!enabled}
                onChange={e => { void setBand(i, parseFloat(e.target.value)) }}
                title={`${EQ_LABELS[i]} Hz: ${gain.toFixed(1)} dB`}
                style={{
                  flex: 1,
                  width: 20,
                  writingMode: 'vertical-lr',
                  direction: 'rtl',
                  // Vertical orientation via CSS appearance hint (browser-specific).
                  ['appearance' as never]: 'slider-vertical',
                  ['WebkitAppearance' as never]: 'slider-vertical',
                }}
              />
              <div className="hz">{EQ_LABELS[i]}</div>
              <div style={{ fontSize: 9, fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)' }}>
                {gain > 0 ? `+${gain.toFixed(0)}` : gain.toFixed(0)}
              </div>
              {/* Visual track behind the slider for parity with the design */}
              <div style={{ position: 'absolute', pointerEvents: 'none', opacity: 0 }}>
                <div className="col"><div className="fill" style={{ bottom: 0, height: `${normalized * 100}%` }} /></div>
              </div>
            </div>
          )
        })}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="muted tiny">Preset:</span>
        {presetNames.map(p => (
          <div
            key={p}
            className="select"
            style={{ background: p === preset ? 'var(--bg-selected)' : 'var(--bg-elev)', cursor: 'pointer' }}
            onClick={() => { void setPreset(p) }}
            role="button"
            tabIndex={0}
          >
            {p}
          </div>
        ))}
        {preset === 'Custom' && (
          <span className="muted tiny" style={{ marginLeft: 'auto' }}>Custom curve</span>
        )}
      </div>
    </>
  )
}
