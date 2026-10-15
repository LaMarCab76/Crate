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
 * mixed to mono (average), Hann-windowed and transformed; out receives 1024
 * magnitudes, scaled so a full-scale sine reads 1.0. */
#define CA_FFT_SIZE 2048
#define CA_FFT_BINS 1024

typedef struct ca_fft ca_fft;

CA_API ca_fft *ca_fft_create(void);
/* `frames` holds `frame_count` (1..CA_FFT_SIZE) interleaved frames. Fewer
 * than CA_FFT_SIZE frames (the end of a stream) are windowed over their own
 * length and zero-padded, exactly like BASS does. */
CA_API int ca_fft_run(ca_fft *fft, const float *frames, int32_t frame_count, int32_t channels, float *out);
CA_API void ca_fft_destroy(ca_fft *fft);


/* ---------------------------------------------------------------- engine */

/* Tests only: CA_INIT_NULL_BACKEND opens miniaudio's null device instead of
 * real hardware; CA_INIT_NO_DEVICE runs without any device (see tests). */
#define CA_INIT_NULL_BACKEND 0x1
#define CA_INIT_NO_DEVICE    0x2

CA_API int ca_init(int32_t flags);
CA_API void ca_shutdown(void);

/* --------------------------------------------------------------- devices */

#define CA_MAX_RATES 32

typedef struct ca_device_info {
  char    id[256];             /* CoreAudio UID / WASAPI endpoint id / ALSA or Pulse name */
  char    name[256];
  int32_t is_default;
  int32_t max_channels;
  int32_t max_sample_rate;
  int32_t max_bits;
  int32_t supports_exclusive;
  int32_t reserved;
} ca_device_info;

/* Refreshes the playback device list; returns the number of devices. */
CA_API int ca_device_count(void);
CA_API int ca_device_get(int32_t index, ca_device_info *out);

typedef struct ca_device_caps {
  int32_t count;               /* entries in rates/bits */
  int32_t rates[CA_MAX_RATES]; /* supported rates, ascending */
  int32_t bits[CA_MAX_RATES];  /* deepest integer format at rates[i]; 32 may be float */
  int32_t max_channels;
  int32_t current_rate;
  int32_t current_bits;
  int32_t can_set_rate;        /* the rate can follow the track in this mode */
  int32_t exclusive;           /* these caps describe exclusive mode */
} ca_device_caps;

/* device_id NULL = system default. */
CA_API int ca_device_get_caps(const char *device_id, int32_t exclusive, ca_device_caps *out);

/* ---------------------------------------------------------------- output */

typedef struct ca_output_policy {
  int32_t exclusive;           /* hog mode (macOS) / WASAPI exclusive (Windows) */
  int32_t bit_perfect;         /* follow each track's rate and depth */
} ca_output_policy;

/* Why the output differs from the track. */
#define CA_LIMIT_DAC_RATE      0x01
#define CA_LIMIT_DAC_BITS      0x02
#define CA_LIMIT_DAC_CHANNELS  0x04
#define CA_LIMIT_FIXED_RATE    0x08   /* the rate can't change in this mode (e.g. Windows shared) */
#define CA_LIMIT_SETTING_OFF   0x10   /* bit-perfect is switched off */

typedef struct ca_output_format {
  int32_t sample_rate;
  int32_t bits;                /* integer depth delivered to the device; 32 also covers float */
  int32_t channels;
  int32_t resampled;
  int32_t dithered;
  int32_t downmixed;
  int32_t limited_by;          /* CA_LIMIT_* */
  int32_t reserved;
} ca_output_format;

/* Pure function: the output format for a track on a device (see plan §2.4). */
CA_API int ca_choose_output_format(const ca_stream_info *source, const ca_device_caps *caps,
                                   const ca_output_policy *policy, ca_output_format *out);

typedef struct ca_output_info {
  int32_t open;
  int32_t sample_rate;
  int32_t bits;
  int32_t channels;
  int32_t exclusive;
  int32_t bit_perfect;         /* policy */
  int32_t original_rate;       /* device rate before Crate changed it, 0 if untouched */
  int32_t reserved;
  ca_output_format current;    /* decision for the main player's current track */
  char    device_id[256];
  char    device_name[256];
} ca_output_info;

/* device_id NULL = follow the system default device. */
CA_API int ca_output_open(const char *device_id, const ca_output_policy *policy);
CA_API int ca_output_set_policy(const ca_output_policy *policy);
CA_API void ca_output_close(void);
CA_API int ca_output_get_info(ca_output_info *out);

/* --------------------------------------------------------------- players */

typedef struct ca_player ca_player;

#define CA_PLAYER_STOPPED 0
#define CA_PLAYER_PLAYING 1
#define CA_PLAYER_PAUSED  2

typedef struct ca_player_status {
  int32_t state;               /* CA_PLAYER_* */
  int32_t ended;               /* the last queued track finished */
  int64_t serial;              /* caller-supplied id of the track being heard */
  double  position;            /* seconds into that track */
  double  buffered_seconds;    /* decoded audio waiting in the ring */
} ca_player_status;

/* The main player drives the output format (bit-perfect); others (duplicate
 * audition) adapt to whatever the device runs at. */
CA_API ca_player *ca_player_create(int32_t is_main);
CA_API void ca_player_destroy(ca_player *player);
CA_API int ca_player_get_id(const ca_player *player);

/* Decoders stay owned by the caller, who must not touch them until the
 * player gives them back: synchronously for set_source / queue_next /
 * clear_next / skip_to_next / replace_source / detach (the replaced decoders
 * are free to close when the call returns), or through a
 * CA_EVENT_DECODER_RETIRED event after a gapless transition. */
CA_API int ca_player_set_source(ca_player *player, ca_decoder *decoder, float gain, int64_t serial);
CA_API int ca_player_queue_next(ca_player *player, ca_decoder *decoder, float gain, int64_t serial);
CA_API int ca_player_clear_next(ca_player *player);
CA_API int ca_player_skip_to_next(ca_player *player);
/* Swaps the current track's decoder for another one of the same file (e.g. a
 * RAM copy) at the exact decode position: no audible change. */
CA_API int ca_player_replace_source(ca_player *player, ca_decoder *decoder);
CA_API int ca_player_detach(ca_player *player);

CA_API int ca_player_play(ca_player *player);
CA_API int ca_player_pause(ca_player *player);
CA_API int ca_player_seek(ca_player *player, double seconds);
CA_API int ca_player_get_status(ca_player *player, ca_player_status *out);

CA_API int ca_player_set_volume(ca_player *player, float volume);
/* Loudness-leveler gain of the track being heard (queued tracks carry their own). */
CA_API int ca_player_set_gain(ca_player *player, float gain);
CA_API int ca_player_set_eq(ca_player *player, int32_t enabled, int32_t count, const float *freqs_hz,
                            const float *gains_db, float bandwidth_octaves);

/* Live analysis of what is being played (post-EQ, pre-volume, like BASS). */
CA_API int ca_player_get_fft(ca_player *player, float *out /* CA_FFT_BINS */);
CA_API int ca_player_get_levels(ca_player *player, float window_seconds, float *out /* peakL peakR rmsL rmsR */);

/* ---------------------------------------------------------------- events */

#define CA_EVENT_TRACK_STARTED    1   /* serial is now audible (gapless transitions too) */
#define CA_EVENT_TRACK_ENDED      2   /* serial finished and nothing was queued */
#define CA_EVENT_DECODER_RETIRED  3   /* decoder may be closed now */
#define CA_EVENT_OUTPUT_CHANGED   4   /* device format changed; read ca_output_get_info */
#define CA_EVENT_DEVICE_LOST      5
#define CA_EVENT_DEVICE_REROUTED  6
#define CA_EVENT_DECODE_ERROR     7   /* serial stopped early; code = CA_ERR_* */

typedef struct ca_event {
  int32_t  type;
  int32_t  player_id;
  int64_t  serial;
  uint64_t decoder;            /* ca_decoder address for DECODER_RETIRED */
  int32_t  code;
  int32_t  reserved;
} ca_event;

/* Drains up to max pending events; returns how many were written. */
CA_API int ca_poll_events(ca_event *out, int32_t max);

#ifdef __cplusplus
}
#endif

#endif /* CRATE_AUDIO_H */
