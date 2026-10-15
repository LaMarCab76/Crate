/* Real-time-safe DSP helpers used by the mixer (no allocation, no locks). */
#ifndef CA_DSP_H
#define CA_DSP_H

#include <stdint.h>

typedef struct {
  double b0, b1, b2, a1, a2;  /* normalised by a0 */
} ca_biquad_coeffs;

typedef struct {
  double z1, z2;              /* transposed direct form II state */
} ca_biquad_state;

/* RBJ cookbook peaking EQ with the bandwidth in octaves — the filter BASS_FX
 * implements as BASS_BFX_BQF_PEAKINGEQ. The center is clamped below Nyquist. */
void ca_dsp_peaking_coeffs(ca_biquad_coeffs *c, double sample_rate, double center_hz,
                           double gain_db, double bandwidth_octaves);

/* Filters `frames` interleaved frames of `channels` channels in place.
 * `states` holds one state per channel. */
void ca_dsp_biquad_process(const ca_biquad_coeffs *c, ca_biquad_state *states, float *samples,
                           uint32_t frames, int channels);

/* Peak and RMS like BASS_ChannelGetLevelEx(..., BASS_LEVEL_STEREO): mono feeds
 * both sides; with more than two channels the 1st/3rd/5th... form the left
 * side and the 2nd/4th/6th... the right. out = {peakL, peakR, rmsL, rmsR}. */
void ca_dsp_levels(const float *samples, uint32_t frames, int channels, float out[4]);

/* Fast deterministic noise source for dither (xorshift32). */
static inline uint32_t ca_dsp_random(uint32_t *state) {
  uint32_t x = *state;
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  *state = x;
  return x;
}

/* Triangular (TPDF) dither of +/-1 LSB at `bits`, added in place. */
void ca_dsp_dither(float *samples, uint32_t count, int bits, uint32_t *rng);

/* Float -> integer PCM with rounding and clipping. These are exact for
 * samples that originally had at most the target depth, which keeps unity
 * gain playback bit-perfect. s24 is packed little-endian (3 bytes); s32 may
 * carry 24 valid bits left-justified, which is the same bit pattern. */
void ca_dsp_to_s16(const float *in, int16_t *out, uint32_t count);
void ca_dsp_to_s24(const float *in, uint8_t *out, uint32_t count);
void ca_dsp_to_s32(const float *in, int32_t *out, uint32_t count);

#endif /* CA_DSP_H */
