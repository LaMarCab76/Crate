// Pure audio-math helpers for the Studio view meters and metadata. No React,
// no side effects — safe to unit-test in isolation.

// ReplayGain 2.0 reference loudness (EBU R128 / ITU-R BS.1770).
const RG_REFERENCE_LUFS = -18

// Convert a linear amplitude (0..1) to dBFS, clamped to a floor so silence maps
// to a finite value instead of -Infinity.
export function dbFromLinear(x: number, floor = -60): number {
  if (x <= 0) return floor
  return Math.max(floor, 20 * Math.log10(x))
}

// Format a linear amplitude as a dB readout string (no unit). "-∞" at the floor.
export function fmtDb(x: number, floor = -60): string {
  const d = dbFromLinear(x, floor)
  return d <= floor ? '-∞' : d.toFixed(1)
}

// Derive a ReplayGain adjustment from integrated loudness (LUFS). Null when the
// track has no loudness metadata.
export function replayGainFromLufs(lufs: number | null | undefined): number | null {
  return lufs == null ? null : RG_REFERENCE_LUFS - lufs
}

// Format a gain in dB with an explicit sign, or "—" when unavailable.
export function fmtGain(gain: number | null | undefined): string {
  if (gain == null || !Number.isFinite(gain)) return '—'
  return `${gain >= 0 ? '+' : ''}${gain.toFixed(1)} dB`
}

// Format integrated loudness as a LUFS readout, or "—" when untagged.
export function fmtLufs(lufs: number | null | undefined): string {
  return lufs == null || !Number.isFinite(lufs) ? '—' : lufs.toFixed(1)
}

// Human-readable channel layout from a channel count.
export function channelLayoutLabel(chans: number | null | undefined): string {
  switch (chans) {
    case 1: return '1.0 Mono'
    case 2: return '2.0 Stereo'
    case 4: return '4.0 Quad'
    case 6: return '5.1 Surround'
    case 8: return '7.1 Surround'
    default: return chans ? `${chans}.0` : '—'
  }
}

// Crest-factor dB → a DR-style label ("DR12"). Approximate; not TT-DR.
export function drLabel(crestDb: number | null | undefined): string {
  if (crestDb == null || !Number.isFinite(crestDb)) return '—'
  return `DR${Math.max(0, Math.round(crestDb))}`
}
