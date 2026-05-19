// BASS constants used in the FFI layer. Mirrors the #defines in
// old_swift/HiFidelity/Core/Audio/bass-include/bass.h and bass_fx.h.

// ---------------- Streams / channels ----------------

export const BASS_STREAM_PRESCAN  = 0x20000
export const BASS_STREAM_DECODE   = 0x200000
export const BASS_STREAM_AUTOFREE = 0x40000
export const BASS_SAMPLE_FLOAT    = 256
export const BASS_UNICODE         = 0x80000000

// ChannelGet/SetPosition modes
export const BASS_POS_BYTE        = 0
export const BASS_POS_MUSIC_ORDER = 1
export const BASS_POS_OGG         = 3

// ChannelIsActive return values
export const BASS_ACTIVE_STOPPED = 0
export const BASS_ACTIVE_PLAYING = 1
export const BASS_ACTIVE_STALLED = 2
export const BASS_ACTIVE_PAUSED  = 3
export const BASS_ACTIVE_PAUSED_DEVICE = 4

// Sync types
export const BASS_SYNC_POS         = 0
export const BASS_SYNC_END         = 2
export const BASS_SYNC_META        = 4
export const BASS_SYNC_SLIDE       = 5
export const BASS_SYNC_STALL       = 6
export const BASS_SYNC_DOWNLOAD    = 7
export const BASS_SYNC_FREE        = 8
export const BASS_SYNC_SETPOS      = 11
export const BASS_SYNC_MUSICPOS    = 10
export const BASS_SYNC_ONETIME     = 0x80000000

// Channel attributes
export const BASS_ATTRIB_FREQ      = 1
export const BASS_ATTRIB_VOL       = 2
export const BASS_ATTRIB_PAN       = 3
export const BASS_ATTRIB_EAXMIX    = 4
export const BASS_ATTRIB_NOBUFFER  = 5
export const BASS_ATTRIB_VBR       = 6
export const BASS_ATTRIB_CPU       = 7
export const BASS_ATTRIB_SRC       = 8
export const BASS_ATTRIB_BUFFER    = 14

// Global config options (BASS_SetConfig)
export const BASS_CONFIG_BUFFER             = 0
export const BASS_CONFIG_UPDATEPERIOD       = 1
export const BASS_CONFIG_GVOL_SAMPLE        = 4
export const BASS_CONFIG_GVOL_STREAM        = 5
export const BASS_CONFIG_NET_BUFFER         = 12
export const BASS_CONFIG_PAUSE_NOPLAY       = 13
export const BASS_CONFIG_NET_PREBUF         = 15
export const BASS_CONFIG_DEV_BUFFER         = 27
export const BASS_CONFIG_DEV_DEFAULT        = 36
export const BASS_CONFIG_FLOAT              = 17

// BASS error codes (most common ones — see bass.h for the full list)
export const BASS_OK                = 0
export const BASS_ERROR_FILEOPEN    = 2
export const BASS_ERROR_DRIVER      = 3
export const BASS_ERROR_BUFLOST     = 4
export const BASS_ERROR_HANDLE      = 5
export const BASS_ERROR_FORMAT      = 6
export const BASS_ERROR_POSITION    = 7
export const BASS_ERROR_INIT        = 8
export const BASS_ERROR_START       = 9
export const BASS_ERROR_SSL         = 10
export const BASS_ERROR_REINIT      = 11
export const BASS_ERROR_ALREADY     = 14
export const BASS_ERROR_NOTAUDIO    = 17
export const BASS_ERROR_NOCHAN      = 18
export const BASS_ERROR_ILLTYPE     = 19
export const BASS_ERROR_ILLPARAM    = 20
export const BASS_ERROR_NO3D        = 21
export const BASS_ERROR_NOEAX       = 22
export const BASS_ERROR_DEVICE      = 23
export const BASS_ERROR_NOPLAY      = 24
export const BASS_ERROR_FREQ        = 25
export const BASS_ERROR_NOTFILE     = 27
export const BASS_ERROR_NOHW        = 29
export const BASS_ERROR_EMPTY       = 31
export const BASS_ERROR_NONET       = 32
export const BASS_ERROR_CREATE      = 33
export const BASS_ERROR_NOFX        = 34
export const BASS_ERROR_NOTAVAIL    = 37
export const BASS_ERROR_DECODE      = 38
export const BASS_ERROR_DX          = 39
export const BASS_ERROR_TIMEOUT     = 40
export const BASS_ERROR_FILEFORM    = 41
export const BASS_ERROR_SPEAKER     = 42
export const BASS_ERROR_VERSION     = 43
export const BASS_ERROR_CODEC       = 44
export const BASS_ERROR_ENDED       = 45
export const BASS_ERROR_BUSY        = 46
export const BASS_ERROR_UNSTREAMABLE = 47
export const BASS_ERROR_PROTOCOL    = 48
export const BASS_ERROR_DENIED      = 49
export const BASS_ERROR_UNKNOWN     = -1

export const BASS_ERROR_NAMES: Record<number, string> = {
  0: 'OK',
  2: 'FILEOPEN', 3: 'DRIVER', 4: 'BUFLOST', 5: 'HANDLE', 6: 'FORMAT',
  7: 'POSITION', 8: 'INIT', 9: 'START', 10: 'SSL', 11: 'REINIT',
  14: 'ALREADY', 17: 'NOTAUDIO', 18: 'NOCHAN', 19: 'ILLTYPE',
  20: 'ILLPARAM', 21: 'NO3D', 22: 'NOEAX', 23: 'DEVICE', 24: 'NOPLAY',
  25: 'FREQ', 27: 'NOTFILE', 29: 'NOHW', 31: 'EMPTY', 32: 'NONET',
  33: 'CREATE', 34: 'NOFX', 37: 'NOTAVAIL', 38: 'DECODE', 39: 'DX',
  40: 'TIMEOUT', 41: 'FILEFORM', 42: 'SPEAKER', 43: 'VERSION',
  44: 'CODEC', 45: 'ENDED', 46: 'BUSY', 47: 'UNSTREAMABLE',
  48: 'PROTOCOL', 49: 'DENIED', [-1 >>> 0]: 'UNKNOWN',
}

// ---------------- BASS_FX ----------------

// EQ filter types — we only use PEAKEQ (10-band parametric peak).
export const BASS_FX_BFX_PEAKEQ = 0x10000

// ---------------- Helper ----------------

export function bassErrorName(code: number): string {
  return BASS_ERROR_NAMES[code] ?? `UNKNOWN(${code})`
}
