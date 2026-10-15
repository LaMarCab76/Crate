#ifndef CA_FFT_INTERNAL_H
#define CA_FFT_INTERNAL_H

#include "ca_internal.h"

/* Magnitude scales matching BASS_DATA_FFT2048 (calibrated against
 * tests/golden/fft-*.bass.f32): a full-scale sine reads 1.0, i.e. the Hann
 * window's 0.5 coherent gain is compensated; the DC bin is not doubled. */
#define CA_FFT_OUTPUT_SCALE (4.0f / CA_FFT_SIZE)
#define CA_FFT_DC_SCALE (2.0f / CA_FFT_SIZE)

/* Mono input buffer of CA_FFT_SIZE samples, filled by the caller before
 * ca__fft_run_mono(). Lets the playback tap skip an extra copy. */
float *ca__fft_input(ca_fft *fft);
int ca__fft_run_mono(ca_fft *fft, float *out);

#endif /* CA_FFT_INTERNAL_H */
