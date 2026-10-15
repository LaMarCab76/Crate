/* BASS_DATA_FFT2048-compatible spectrum built on FFmpeg's av_tx RDFT. The
 * window shape, mono mix and output scale were calibrated against BASS so the
 * renderer's visualizer constants keep working unchanged. */
#include "ca_fft_internal.h"

#include <math.h>
#include <stdlib.h>

#include <libavutil/mem.h>
#include <libavutil/tx.h>

struct ca_fft {
  AVTXContext *tx;
  av_tx_fn fn;
  float *window;
  float *input;
  AVComplexFloat *output;
};

CA_API ca_fft *ca_fft_create(void) {
  ca_fft *fft = calloc(1, sizeof *fft);
  if (!fft) {
    ca__fail(CA_ERR_NO_MEMORY, "out of memory");
    return NULL;
  }
  float scale = 1.0f;
  fft->window = av_malloc(sizeof(float) * CA_FFT_SIZE);
  fft->input = av_malloc(sizeof(float) * CA_FFT_SIZE);
  fft->output = av_malloc(sizeof(AVComplexFloat) * (CA_FFT_SIZE / 2 + 1));
  if (!fft->window || !fft->input || !fft->output ||
      av_tx_init(&fft->tx, &fft->fn, AV_TX_FLOAT_RDFT, 0, CA_FFT_SIZE, &scale, 0) < 0) {
    ca_fft_destroy(fft);
    ca__fail(CA_ERR_NO_MEMORY, "cannot initialise the FFT");
    return NULL;
  }
  const double pi = 3.14159265358979323846;
  for (int i = 0; i < CA_FFT_SIZE; i++) {
    fft->window[i] = (float)(0.5 * (1.0 - cos(2.0 * pi * i / CA_FFT_SIZE)));  /* periodic Hann, like BASS */
  }
  return fft;
}

int ca__fft_run_mono(ca_fft *fft, float *out) {
  for (int i = 0; i < CA_FFT_SIZE; i++) fft->input[i] *= fft->window[i];
  fft->fn(fft->tx, fft->output, fft->input, sizeof(float));
  for (int k = 0; k < CA_FFT_BINS; k++) {
    float re = fft->output[k].re;
    float im = fft->output[k].im;
    out[k] = sqrtf(re * re + im * im) * (k == 0 ? CA_FFT_DC_SCALE : CA_FFT_OUTPUT_SCALE);
  }
  return CA_OK;
}

float *ca__fft_input(ca_fft *fft) {
  return fft->input;
}

CA_API int ca_fft_run(ca_fft *fft, const float *frames, int32_t channels, float *out) {
  if (!fft || !frames || !out || channels <= 0) {
    return ca__fail(CA_ERR_INVALID_ARG, "ca_fft_run: invalid arguments");
  }
  if (channels == 1) {
    memcpy(fft->input, frames, sizeof(float) * CA_FFT_SIZE);
  } else {
    float inv = 1.0f / (float)channels;
    for (int i = 0; i < CA_FFT_SIZE; i++) {
      float sum = 0.0f;
      const float *frame = frames + (size_t)i * (size_t)channels;
      for (int c = 0; c < channels; c++) sum += frame[c];
      fft->input[i] = sum * inv;
    }
  }
  return ca__fft_run_mono(fft, out);
}

CA_API void ca_fft_destroy(ca_fft *fft) {
  if (!fft) return;
  av_tx_uninit(&fft->tx);
  av_freep(&fft->window);
  av_freep(&fft->input);
  av_freep(&fft->output);
  free(fft);
}
