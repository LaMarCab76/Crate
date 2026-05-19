import type { PlayerTintSource, Tweak } from '@renderer/stores/settingsStore'
import { useEqStore } from '@renderer/stores/eqStore'
import { EQ_BAND_LABELS, EQ_GAIN_MAX, EQ_GAIN_MIN, EQ_GAIN_STEP } from '@shared/constants/equalizer'
import { COLOR_PRESETS } from '@renderer/utils/colorPresets'

interface Props {
  tweak: Tweak
  setTweak: <K extends keyof Tweak>(key: K, value: Tweak[K]) => void
}

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
        <h2>Now Playing</h2>
        <div className="set-card">
          <div className="set-row">
            <div>
              <div className="lbl">Player tint</div>
              <div className="sub">Color del panel de reproducción. "Artwork" usa el color dominante del track actual.</div>
            </div>
            <div className="rule-row" style={{ margin: 0 }}>
              {(['default', 'preset', 'custom', 'artwork'] as const).map(s => (
                <div
                  key={s}
                  className="select"
                  style={{ background: tweak.playerTintSource === s ? 'var(--bg-selected)' : 'var(--bg-elev)' }}
                  onClick={() => setTweak('playerTintSource', s as PlayerTintSource)}
                  role="button" tabIndex={0}
                >
                  {s === 'default' ? 'Default' : s === 'preset' ? 'Preset' : s === 'custom' ? 'Custom' : 'Artwork'}
                </div>
              ))}
            </div>
          </div>
          {tweak.playerTintSource === 'preset' && (
            <div className="set-color-extra">
              <div className="swatch-row">
                {COLOR_PRESETS.map(p => (
                  <div
                    key={p.id}
                    className={`swatch ${tweak.playerTintColor.toLowerCase() === p.hex.toLowerCase() ? 'selected' : ''}`}
                    style={{ background: p.hex }}
                    title={p.label}
                    onClick={() => setTweak('playerTintColor', p.hex)}
                    role="button" tabIndex={0}
                  />
                ))}
              </div>
            </div>
          )}
          {tweak.playerTintSource === 'custom' && (
            <div className="set-color-extra">
              <input
                type="color"
                className="color-input"
                value={tweak.playerTintColor}
                onChange={e => setTweak('playerTintColor', e.target.value)}
                aria-label="Custom player tint color"
              />
              <span className="set-color-note">{tweak.playerTintColor}</span>
            </div>
          )}
          {tweak.playerTintSource === 'artwork' && (
            <div className="set-color-extra">
              <span className="set-color-note">
                El panel de reproducción adopta el color dominante del track que se está reproduciendo.
              </span>
            </div>
          )}
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
                Saves your plays, favorites, ratings and EQ settings into a hidden{' '}
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
  const selectedPreset = presetNames.includes(preset) ? preset : 'Custom'

  return (
    <>
      <div className="set-card" style={{ marginBottom: 12 }}>
        <div className="set-row">
          <div>
            <div className="lbl">Enable equalizer</div>
            <div className="sub">15-band peaking EQ applied to the BASS playback chain.</div>
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
        <div className="eq-bands">
          {EQ_BAND_LABELS.map((label, i) => {
            // Map the gain range to 0..1 for the hidden design parity fill.
            const gain = bands[i] ?? 0
            const normalized = (gain - EQ_GAIN_MIN) / (EQ_GAIN_MAX - EQ_GAIN_MIN)
            return (
              <div key={label} className="eq-band">
                <input
                  type="range"
                  min={EQ_GAIN_MIN}
                  max={EQ_GAIN_MAX}
                  step={EQ_GAIN_STEP}
                  value={gain}
                  disabled={!enabled}
                  onChange={e => { void setBand(i, parseFloat(e.target.value)) }}
                  title={`${label} Hz: ${gain.toFixed(1)} dB`}
                  style={{
                    flex: 1,
                    width: 16,
                    writingMode: 'vertical-lr',
                    direction: 'rtl',
                    // Vertical orientation via CSS appearance hint (browser-specific).
                    ['appearance' as never]: 'slider-vertical',
                    ['WebkitAppearance' as never]: 'slider-vertical',
                  }}
                />
                <div className="hz">{label}</div>
                <div className="gain">
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
        <div className="eq-preset-row">
          <label className="eq-preset-control">
            <span>Preset</span>
            <span className="eq-preset-select-wrap">
              <select
                value={selectedPreset}
                onChange={e => { void setPreset(e.target.value) }}
                aria-label="Equalizer preset"
              >
                <option value="Custom" disabled>Custom</option>
                {presetNames.map(p => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </span>
          </label>
          {preset === 'Custom' && (
            <span className="eq-custom-note">Custom curve</span>
          )}
        </div>
      </div>
    </>
  )
}
