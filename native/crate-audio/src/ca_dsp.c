#include "ca_dsp.h"

#include <math.h>

void ca_dsp_peaking_coeffs(ca_biquad_coeffs *c, double sample_rate, double center_hz,
                           double gain_db, double bandwidth_octaves) {
  const double pi = 3.14159265358979323846;
  double nyquist = sample_rate / 2.0;
  if (center_hz >= nyquist) center_hz = nyquist - 1.0;
  if (center_hz < 1.0) center_hz = 1.0;
  if (bandwidth_octaves <= 0.0) bandwidth_octaves = 1.0;

  double A = pow(10.0, gain_db / 40.0);
  double w0 = 2.0 * pi * center_hz / sample_rate;
  double sw = sin(w0);
  double cw = cos(w0);
  double alpha = sw * sinh(log(2.0) / 2.0 * bandwidth_octaves * w0 / sw);

  double a0 = 1.0 + alpha / A;
  c->b0 = (1.0 + alpha * A) / a0;
  c->b1 = (-2.0 * cw) / a0;
  c->b2 = (1.0 - alpha * A) / a0;
  c->a1 = (-2.0 * cw) / a0;
  c->a2 = (1.0 - alpha / A) / a0;
}

void ca_dsp_biquad_process(const ca_biquad_coeffs *c, ca_biquad_state *states, float *samples,
                           uint32_t frames, int channels) {
  for (int ch = 0; ch < channels; ch++) {
    double z1 = states[ch].z1;
    double z2 = states[ch].z2;
    float *p = samples + ch;
    for (uint32_t i = 0; i < frames; i++, p += channels) {
      double x = *p;
      double y = c->b0 * x + z1;
      z1 = c->b1 * x - c->a1 * y + z2;
      z2 = c->b2 * x - c->a2 * y;
      *p = (float)y;
    }
    /* Flush denormals so a silent tail can't slow the callback down. */
    if (fabs(z1) < 1e-30) z1 = 0.0;
    if (fabs(z2) < 1e-30) z2 = 0.0;
    states[ch].z1 = z1;
    states[ch].z2 = z2;
  }
}

void ca_dsp_levels(const float *samples, uint32_t frames, int channels, float out[4]) {
  double peak[2] = {0, 0};
  double sum[2] = {0, 0};
  uint64_t count[2] = {0, 0};
  for (uint32_t i = 0; i < frames; i++) {
    const float *frame = samples + (uint64_t)i * (uint64_t)channels;
    for (int c = 0; c < channels; c++) {
      double v = frame[c];
      double a = fabs(v);
      int side = channels == 1 ? 0 : (c & 1);
      if (a > peak[side]) peak[side] = a;
      sum[side] += v * v;
      count[side]++;
    }
  }
  if (channels == 1) {
    peak[1] = peak[0];
    sum[1] = sum[0];
    count[1] = count[0];
  }
  for (int side = 0; side < 2; side++) {
    out[side] = (float)peak[side];
    out[2 + side] = count[side] ? (float)sqrt(sum[side] / (double)count[side]) : 0.0f;
  }
}

void ca_dsp_dither(float *samples, uint32_t count, int bits, uint32_t *rng) {
  if (bits <= 0 || bits >= 24) return;
  const float lsb = 1.0f / (float)(1u << (bits - 1));
  const float scale = lsb / 4294967296.0f;
  for (uint32_t i = 0; i < count; i++) {
    float r1 = (float)ca_dsp_random(rng);
    float r2 = (float)ca_dsp_random(rng);
    samples[i] += (r1 - r2) * scale;
  }
}

void ca_dsp_to_s16(const float *in, int16_t *out, uint32_t count) {
  for (uint32_t i = 0; i < count; i++) {
    double v = nearbyint((double)in[i] * 32768.0);
    if (v > 32767.0) v = 32767.0;
    else if (v < -32768.0) v = -32768.0;
    out[i] = (int16_t)v;
  }
}

void ca_dsp_to_s24(const float *in, uint8_t *out, uint32_t count) {
  for (uint32_t i = 0; i < count; i++) {
    double v = nearbyint((double)in[i] * 8388608.0);
    if (v > 8388607.0) v = 8388607.0;
    else if (v < -8388608.0) v = -8388608.0;
    int32_t s = (int32_t)v;
    out[i * 3] = (uint8_t)(s & 0xff);
    out[i * 3 + 1] = (uint8_t)((s >> 8) & 0xff);
    out[i * 3 + 2] = (uint8_t)((s >> 16) & 0xff);
  }
}

void ca_dsp_to_s32(const float *in, int32_t *out, uint32_t count) {
  for (uint32_t i = 0; i < count; i++) {
    double v = nearbyint((double)in[i] * 2147483648.0);
    if (v > 2147483647.0) v = 2147483647.0;
    else if (v < -2147483648.0) v = -2147483648.0;
    out[i] = (int32_t)v;
  }
}
