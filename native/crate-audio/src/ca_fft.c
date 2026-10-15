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

int ca__fft_run_mono(ca_fft *fft, int count, float *out) {
  if (count >= CA_FFT_SIZE) {
    count = CA_FFT_SIZE;
    for (int i = 0; i < CA_FFT_SIZE; i++) fft->input[i] *= fft->window[i];
  } else {
    /* BASS stretches its 2048-point window over the remaining samples; a
     * floor lookup reproduces it closely (exactly for powers of two). */
    for (int i = 0; i < count; i++) fft->input[i] *= fft->window[(int)(((int64_t)i * CA_FFT_SIZE) / count)];
    memset(fft->input + count, 0, sizeof(float) * (size_t)(CA_FFT_SIZE - count));
  }
  fft->fn(fft->tx, fft->output, fft->input, sizeof(float));
  float scale = CA_FFT_OUTPUT_SCALE / (float)count;
  float dc_scale = CA_FFT_DC_SCALE / (float)count;
  for (int k = 0; k < CA_FFT_BINS; k++) {
    float re = fft->output[k].re;
    float im = fft->output[k].im;
    out[k] = sqrtf(re * re + im * im) * (k == 0 ? dc_scale : scale);
  }
  return CA_OK;
}

float *ca__fft_input(ca_fft *fft) {
  return fft->input;
}

CA_API int ca_fft_run(ca_fft *fft, const float *frames, int32_t frame_count, int32_t channels, float *out) {
  if (!fft || !frames || !out || channels <= 0 || frame_count <= 0) {
    return ca__fail(CA_ERR_INVALID_ARG, "ca_fft_run: invalid arguments");
  }
  int count = frame_count > CA_FFT_SIZE ? CA_FFT_SIZE : frame_count;
  if (channels == 1) {
    memcpy(fft->input, frames, sizeof(float) * (size_t)count);
  } else {
    float inv = 1.0f / (float)channels;
    for (int i = 0; i < count; i++) {
      float sum = 0.0f;
      const float *frame = frames + (size_t)i * (size_t)channels;
      for (int c = 0; c < channels; c++) sum += frame[c];
      fft->input[i] = sum * inv;
    }
  }
  return ca__fft_run_mono(fft, count, out);
}

CA_API void ca_fft_destroy(ca_fft *fft) {
  if (!fft) return;
  av_tx_uninit(&fft->tx);
  av_freep(&fft->window);
  av_freep(&fft->input);
  av_freep(&fft->output);
  free(fft);
}
