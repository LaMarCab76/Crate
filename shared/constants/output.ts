// Why the audio output differs from the track (OutputInfoPayload.limitedBy).
// Mirrors CA_LIMIT_* in native/crate-audio/include/crate_audio.h.
export const OUTPUT_LIMIT_DAC_RATE = 0x01
export const OUTPUT_LIMIT_DAC_BITS = 0x02
export const OUTPUT_LIMIT_DAC_CHANNELS = 0x04
export const OUTPUT_LIMIT_FIXED_RATE = 0x08
export const OUTPUT_LIMIT_SETTING_OFF = 0x10
