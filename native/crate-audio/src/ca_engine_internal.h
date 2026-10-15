/* Playback engine internals shared by ca_engine.c and ca_player.c.
 *
 * Threads and ownership:
 *   - JS / koffi threads call the public API. Calls that change a player take
 *     engine.lock (when they may reconfigure the device), then
 *     player.command_lock, then player.lock, and "hold" the player's decode
 *     thread so it is parked while sources, the ring or decoders change.
 *   - One decode thread per player reads FFmpeg into that player's ring.
 *   - The audio callback consumes the rings. It never blocks: it only
 *     try-locks ring_lock and eq_lock and reads atomics.
 *   - The control thread performs device reconfigurations that the decode
 *     threads request (a gapless transition into a different format).
 */
#ifndef CA_ENGINE_INTERNAL_H
#define CA_ENGINE_INTERNAL_H

#include <stdatomic.h>

#include "ca_internal.h"
#include "ca_dsp.h"
#include "ca_thread.h"
#include "miniaudio.h"

#define CA_MAX_PLAYERS 4
#define CA_MAX_EQ_BANDS 32
#define CA_MAX_OUT_CHANNELS 8
#define CA_TAP_FRAMES 8192
#define CA_MARKERS 8
#define CA_EVENT_CAPACITY 512
#define CA_DECODE_CHUNK 4096
#define CA_RING_SECONDS 1.0
#define CA_MIX_FRAMES 4096

enum { CA_MARKER_TRACK = 1, CA_MARKER_SEEK = 2 };

typedef struct {
  uint64_t start;    /* absolute ring frame where it takes effect */
  int64_t serial;
  double base;       /* track position (seconds) at `start` */
  float gain;
  int kind;
} ca_marker;

typedef struct {
  ca_decoder *decoder;
  float gain;
  int64_t serial;
  ca_stream_info info;
  ca_output_format format;  /* device format this track wants (main player) */
} ca_item;

typedef struct {
  int enabled;
  int count;
  float freqs[CA_MAX_EQ_BANDS];
  float gains[CA_MAX_EQ_BANDS];
  float bandwidth;
} ca_eq_params;

struct ca_player {
  int id;
  int is_main;

  ca_mutex command_lock;   /* serialises public calls on this player */
  ca_mutex lock;           /* decode-thread state below */
  ca_cond cond;            /* wakes the decode thread */
  ca_cond held_cond;       /* decode thread acknowledges a hold */
  ca_thread thread;
  int thread_started;
  int quit;
  int hold;
  int held;

  /* Sources. items[0] is being heard; items[1] is queued (and possibly
   * already being decoded, when decode_index == 1). */
  ca_item items[2];
  int count;
  int decode_index;
  int ended;               /* nothing left to decode */
  int switch_pending;      /* items[1] needs a different device format */
  double restart_at;       /* position for the next rebuild; NAN = keep playing position */
  float *scratch;
  uint32_t scratch_frames;

  /* SPSC ring of device-format float frames: decode thread -> callback. */
  float *ring;
  uint32_t ring_frames;
  int channels;
  int rate;
  _Atomic uint64_t write_pos;
  _Atomic uint64_t read_pos;
  ca_mutex ring_lock;      /* producer-side flushes; callback only try-locks */
  ca_marker markers[CA_MARKERS];
  _Atomic uint32_t marker_write;
  _Atomic uint32_t marker_read;

  /* Callback-owned playback state, published through a seqlock. */
  int64_t cb_serial;
  double cb_base;
  uint64_t cb_start;
  float cb_gain;
  int cb_valid;
  int cb_end_reported;
  float cb_level;          /* ramped volume x gain actually applied */
  uint32_t cb_gain_seq;
  _Atomic uint32_t seq;
  _Atomic int64_t pub_serial;
  _Atomic double pub_base;
  _Atomic uint64_t pub_start;
  _Atomic uint64_t pub_read;
  _Atomic int pub_rate;
  _Atomic int pub_valid;

  _Atomic int64_t played_serial;
  _Atomic int state;
  _Atomic int ended_flag;
  _Atomic int switch_flag;
  _Atomic int drained_flag;
  _Atomic int pending_seek;
  _Atomic uint64_t pending_seek_bits;
  _Atomic uint32_t volume_bits;
  _Atomic uint32_t gain_override_bits;
  _Atomic uint32_t gain_override_seq;

  /* EQ: parameters handed over under eq_lock, coefficients owned by the
   * callback (recomputed when the device rate changes). */
  ca_mutex eq_lock;
  ca_eq_params eq_next;
  _Atomic int eq_dirty;
  ca_eq_params eq_active;
  int eq_rate;
  ca_biquad_coeffs eq_coeffs[CA_MAX_EQ_BANDS];
  ca_biquad_state eq_state[CA_MAX_EQ_BANDS][CA_MAX_OUT_CHANNELS];

  /* Last CA_TAP_FRAMES frames heard (post-EQ, pre-volume) for FFT/levels.
   * tap_lock keeps the buffer alive for JS readers across reconfiguration;
   * the callback never takes it (it is not running while buffers change). */
  ca_mutex tap_lock;
  float *tap;
  _Atomic uint64_t tap_write;
  int tap_channels;
  ca_fft *fft;             /* only used from ca_player_get_fft callers */
  float *analysis;         /* CA_TAP_FRAMES * CA_MAX_OUT_CHANNELS scratch */
};

typedef struct ca_engine {
  ca_mutex lock;
  int initialized;
  int flags;

  ma_context context;
  int context_ready;
  ma_device device;
  int device_open;
  _Atomic int device_running;

  int out_rate;
  int out_channels;
  int out_bits;            /* depth the device receives (32 = float) */
  ma_format out_format;
  int dither_bits;         /* 0 = none */
  int native_rate;         /* device rate before bit-perfect touched it */
  ca_output_policy policy;
  int follow_default;      /* opened with device_id NULL */
  char device_id[256];
  char device_name[256];
  ca_output_format current_format;

  _Atomic(ca_player *) players[CA_MAX_PLAYERS];
  int next_player_id;
  _Atomic uint32_t mix_epoch;  /* odd while the callback is mixing */

  /* Events from non-real-time threads. */
  ca_mutex event_lock;
  ca_event events[CA_EVENT_CAPACITY];
  int event_head;
  int event_count;
  /* Events from the audio callback (SPSC, lock-free). */
  ca_event rt_events[CA_EVENT_CAPACITY];
  _Atomic uint32_t rt_write;
  _Atomic uint32_t rt_read;

  ca_thread control;
  int control_started;
  int control_quit;
  ca_cond control_cond;
  _Atomic int notify_rerouted;
  _Atomic int notify_stopped;

  ca_mutex render_lock;    /* CA_INIT_NO_DEVICE: render vs reconfiguration */
  float *mix;
  float *work;
  void *convert;           /* integer output staging */
  uint32_t rng;
} ca_engine;

extern ca_engine g_engine;

/* ca_engine.c */
void ca__push_event(int type, int player_id, int64_t serial, ca_decoder *decoder, int code);
void ca__push_rt_event(int type, int player_id, int64_t serial);
/* Output format the player's track needs; for non-main players this is
 * always the current device format. Engine lock held. */
void ca__desired_format(const ca_player *player, const ca_stream_info *info, ca_output_format *out);
int ca__format_matches_output(const ca_output_format *format);
/* Reopens the device in `format` and rebuilds every player around it. With
 * advance_main, the main player's queued track becomes current. Engine lock
 * held; no player locks held. */
int ca__engine_apply_format(const ca_output_format *format, int advance_main);
/* Mixes `frames` frames of every player into out (float, device channels). */
void ca__engine_mix(float *out, uint32_t frames);
/* Tests: mixes without a device (CA_INIT_NO_DEVICE) and reports the format
 * used, consistently with any concurrent reconfiguration. */
void ca__engine_render(float *out, uint32_t frames, int *rate, int *channels);
/* Returns once any mix pass running at call time has finished. */
void ca__engine_wait_for_mix(void);

/* ca_player.c */
void ca__player_hold(ca_player *player);
void ca__player_release(ca_player *player);
/* Rebuilds ring and decoders after the device format changed. Player held,
 * command_lock and lock taken. */
int ca__player_reconfigure(ca_player *player, int rate, int channels, int advance);
void ca__player_consume(ca_player *player, float *mix, uint32_t frames, int channels);
uint64_t ca__player_buffered_frames(ca_player *player);
double ca__player_position(ca_player *player);

#endif /* CA_ENGINE_INTERNAL_H */
