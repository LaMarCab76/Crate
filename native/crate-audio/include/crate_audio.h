/*
 * crate_audio — Crate's native audio engine.
 *
 * Decoding is done with FFmpeg (LGPL build, statically linked), output with
 * miniaudio plus small platform layers for CoreAudio and WASAPI. The library
 * is loaded from the Electron main process through koffi, so every exported
 * type here is a plain C struct with fixed-size members.
 *
 * Threading: every function may be called from any thread unless noted. A
 * single ca_decoder must not be used from two threads at the same time.
 *
 * Copyright (C) 2026 Lautaro Caballero. GPL-3.0-or-later.
 */
#ifndef CRATE_AUDIO_H
#define CRATE_AUDIO_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#if defined(_WIN32)
#  if defined(CA_BUILDING_LIBRARY)
#    define CA_API __declspec(dllexport)
#  else
#    define CA_API __declspec(dllimport)
#  endif
#else
#  define CA_API __attribute__((visibility("default")))
#endif

/* Bumped whenever an exported signature or struct layout changes. */
#define CA_API_VERSION 1

/* ---------------------------------------------------------------- results */

#define CA_OK                 0
#define CA_ERR_INVALID_ARG   -1
#define CA_ERR_NO_MEMORY     -2
#define CA_ERR_OPEN          -3
#define CA_ERR_NO_AUDIO      -4
#define CA_ERR_DECODE        -5
#define CA_ERR_SEEK          -6
#define CA_ERR_DEVICE        -7
#define CA_ERR_STATE         -8
#define CA_ERR_UNSUPPORTED   -9
#define CA_ERR_TIMEOUT      -10

/* --------------------------------------------------------------- library */

typedef struct ca_build_info {
  int32_t api_version;
  char    version[32];          /* crate_audio version */
  char    ffmpeg_version[64];   /* av_version_info() */
  char    ffmpeg_license[64];   /* avutil_license() — must say LGPL */
  char    miniaudio_version[32];
} ca_build_info;

CA_API int ca_get_build_info(ca_build_info *out);

/* Last error message for the calling thread (never NULL). */
CA_API const char *ca_last_error(void);

/* --------------------------------------------------------------- decoder */

typedef struct ca_decoder ca_decoder;

#define CA_SAMPLE_F32 1   /* interleaved 32-bit float */
#define CA_SAMPLE_S16 2   /* interleaved signed 16-bit */

/* Measure the real duration when the container only offers an estimate
 * (VBR MP3 without a Xing/VBRI header). Costs one pass over the packets. */
#define CA_DECODE_EXACT_DURATION 0x1

typedef struct ca_decode_opts {
  int32_t sample_format;  /* CA_SAMPLE_*; 0 = CA_SAMPLE_F32 */
  int32_t sample_rate;    /* 0 = source rate (DSD: 88200, like BASSDSD's default) */
  int32_t channels;       /* 0 = source channel count */
  int32_t flags;          /* CA_DECODE_* */
} ca_decode_opts;

typedef struct ca_stream_info {
  int32_t sample_rate;          /* rate of the frames returned by ca_decoder_read */
  int32_t channels;             /* channels of the frames returned */
  int32_t source_sample_rate;   /* codec rate; DSD reports the 1-bit rate (2822400 = DSD64) */
  int32_t source_channels;
  int32_t bits_per_sample;      /* source depth for PCM-like codecs, 1 for DSD, 0 for lossy */
  int32_t is_float;             /* source samples are floating point */
  int32_t is_lossless;
  int32_t is_dsd;
  int64_t frames;               /* total frames at sample_rate, -1 if unknown */
  double  duration;             /* seconds, -1 if unknown */
  int64_t bit_rate;             /* bits per second, 0 if unknown */
  char    codec[32];            /* FFmpeg codec name, e.g. "flac" */
  char    container[32];        /* FFmpeg demuxer name, e.g. "mov" */
} ca_stream_info;

/* Paths are UTF-8 on every platform (FFmpeg converts to UTF-16 on Windows). */
CA_API ca_decoder *ca_decoder_open_file(const char *utf8_path, const ca_decode_opts *opts);

/* The caller keeps `data` alive and unchanged until ca_decoder_close().
 * `name_hint` (may be NULL) is only used as a format probing hint. */
CA_API ca_decoder *ca_decoder_open_memory(const void *data, int64_t size, const char *name_hint,
                                          const ca_decode_opts *opts);

CA_API int ca_decoder_get_info(const ca_decoder *dec, ca_stream_info *out);

/* Reads up to max_frames interleaved frames into out (sized for
 * max_frames * channels samples). Returns frames read, 0 at the end of the
 * stream, or a negative CA_ERR_* code. */
CA_API int64_t ca_decoder_read(ca_decoder *dec, void *out, int64_t max_frames);

/* Sample-accurate seek. Positions past the end clamp to the end. */
CA_API int ca_decoder_seek(ca_decoder *dec, double seconds);

/* Position, in seconds, of the next frame ca_decoder_read returns. */
CA_API double ca_decoder_get_position(const ca_decoder *dec);

CA_API void ca_decoder_close(ca_decoder *dec);

/* ------------------------------------------------------------------- FFT */

/* 2048-point spectrum compatible with BASS_DATA_FFT2048: the input frames are
 * mixed to mono, Hann-windowed and transformed; out receives 1024 magnitudes. */
#define CA_FFT_SIZE 2048
#define CA_FFT_BINS 1024

typedef struct ca_fft ca_fft;

CA_API ca_fft *ca_fft_create(void);
/* `frames` must hold CA_FFT_SIZE interleaved frames of `channels` channels. */
CA_API int ca_fft_run(ca_fft *fft, const float *frames, int32_t channels, float *out);
CA_API void ca_fft_destroy(ca_fft *fft);

#ifdef __cplusplus
}
#endif

#endif /* CRATE_AUDIO_H */
