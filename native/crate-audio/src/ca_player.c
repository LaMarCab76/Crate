/* Players: source queue, decode thread, ring buffer and the per-player part
 * of the audio callback. See ca_engine_internal.h for the threading rules. */
#include "ca_engine_internal.h"

#include <math.h>
#include <stdlib.h>

#include "ca_decoder_internal.h"
#include "ca_fft_internal.h"

static uint32_t float_bits(float value) {
  uint32_t bits;
  memcpy(&bits, &value, sizeof bits);
  return bits;
}

static float bits_float(uint32_t bits) {
  float value;
  memcpy(&value, &bits, sizeof value);
  return value;
}

static uint64_t double_bits(double value) {
  uint64_t bits;
  memcpy(&bits, &value, sizeof bits);
  return bits;
}

static double bits_double(uint64_t bits) {
  double value;
  memcpy(&value, &bits, sizeof value);
  return value;
}

/* ------------------------------------------------------------------ ring */

static uint32_t ring_used(ca_player *p) {
  uint64_t w = atomic_load_explicit(&p->write_pos, memory_order_relaxed);
  uint64_t r = atomic_load_explicit(&p->read_pos, memory_order_acquire);
  return (uint32_t)(w - r);
}

static void ring_write(ca_player *p, const float *source, uint32_t frames) {
  uint64_t w = atomic_load_explicit(&p->write_pos, memory_order_relaxed);
  uint32_t ch = (uint32_t)p->channels;
  uint32_t index = (uint32_t)(w % p->ring_frames);
  uint32_t first = CA_MIN(frames, p->ring_frames - index);
  memcpy(p->ring + (size_t)index * ch, source, sizeof(float) * first * ch);
  if (frames > first) memcpy(p->ring, source + (size_t)first * ch, sizeof(float) * (frames - first) * ch);
  atomic_store_explicit(&p->write_pos, w + frames, memory_order_release);
}

static void push_marker(ca_player *p, int kind, double base, int64_t serial, float gain) {
  uint32_t w = atomic_load_explicit(&p->marker_write, memory_order_relaxed);
  ca_marker *m = &p->markers[w % CA_MARKERS];
  m->start = atomic_load_explicit(&p->write_pos, memory_order_relaxed);
  m->serial = serial;
  m->base = base;
  m->gain = gain;
  m->kind = kind;
  atomic_store_explicit(&p->marker_write, w + 1, memory_order_release);
}

/* Drops everything buffered. Caller holds ring_lock (the callback is out). */
static void ring_flush_locked(ca_player *p) {
  atomic_store_explicit(&p->read_pos, atomic_load_explicit(&p->write_pos, memory_order_relaxed), memory_order_release);
  atomic_store_explicit(&p->marker_read, atomic_load_explicit(&p->marker_write, memory_order_relaxed), memory_order_release);
  atomic_store(&p->drained_flag, 0);
}

static void reset_production(ca_player *p) {
  p->decode_index = 0;
  p->ended = 0;
  p->switch_pending = 0;
  atomic_store(&p->ended_flag, 0);
  atomic_store(&p->switch_flag, 0);
  atomic_store(&p->drained_flag, 0);
}

/* Restarts audible output at `position` of items[0]. Player held. */
static void restart_locked(ca_player *p, double position, int kind) {
  ca_mutex_lock(&p->ring_lock);
  ring_flush_locked(p);
  reset_production(p);
  if (p->count > 0) {
    push_marker(p, kind, position, p->items[0].serial, p->items[0].gain);
    atomic_store(&p->pending_seek_bits, double_bits(position));
    atomic_store(&p->pending_seek, 1);
  }
  ca_mutex_unlock(&p->ring_lock);
}

/* ------------------------------------------------------- hold protocol */

void ca__player_hold(ca_player *p) {
  p->hold = 1;
  ca_cond_broadcast(&p->cond);
  while (p->thread_started && !p->held) ca_cond_wait(&p->held_cond, &p->lock);
}

void ca__player_release(ca_player *p) {
  p->hold = 0;
  ca_cond_broadcast(&p->cond);
}

static void begin_command(ca_player *p) {
  ca_mutex_lock(&p->command_lock);
  ca_mutex_lock(&p->lock);
  ca__player_hold(p);
}

static void end_command(ca_player *p) {
  ca__player_release(p);
  ca_mutex_unlock(&p->lock);
  ca_mutex_unlock(&p->command_lock);
}

/* ------------------------------------------------------- decode thread */

static int item_compatible(const ca_player *p, const ca_item *item) {
  if (!p->is_main) return 1;
  return item->format.sample_rate == p->rate && item->format.channels == p->channels;
}

static void retire_finished(ca_player *p) {
  int64_t played = atomic_load(&p->played_serial);
  if (p->count == 2 && p->decode_index == 1 && played == p->items[1].serial) {
    ca__push_event(CA_EVENT_DECODER_RETIRED, p->id, p->items[0].serial, p->items[0].decoder, 0);
    p->items[0] = p->items[1];
    memset(&p->items[1], 0, sizeof p->items[1]);
    p->count = 1;
    p->decode_index = 0;
  }
}

static void player_thread(void *arg) {
  ca_player *p = arg;
  ca_mutex_lock(&p->lock);
  for (;;) {
    if (p->hold) {
      p->held = 1;
      ca_cond_broadcast(&p->held_cond);
      while (p->hold && !p->quit) ca_cond_wait(&p->cond, &p->lock);
      p->held = 0;
      continue;
    }
    if (p->quit) break;
    retire_finished(p);

    if (!p->ring || p->count == 0 || p->decode_index >= p->count || p->ended || p->switch_pending) {
      ca_cond_timedwait(&p->cond, &p->lock, 20);
      continue;
    }
    uint32_t space = p->ring_frames - ring_used(p);
    uint32_t want = CA_MIN(space, p->scratch_frames);
    if (want < 1024 && space < p->ring_frames) {
      ca_cond_timedwait(&p->cond, &p->lock, 5);
      continue;
    }

    ca_item *item = &p->items[p->decode_index];
    ca_decoder *decoder = item->decoder;
    /* Read without the lock so commands can queue up; they hold the thread,
     * which only acknowledges at the top of the loop, after this read. */
    ca_mutex_unlock(&p->lock);
    int64_t n = ca_decoder_read(decoder, p->scratch, want);
    ca_mutex_lock(&p->lock);

    if (n > 0) {
      ring_write(p, p->scratch, (uint32_t)n);
      continue;
    }
    if (n < 0) ca__push_event(CA_EVENT_DECODE_ERROR, p->id, item->serial, NULL, (int)n);

    if (p->decode_index + 1 < p->count) {
      ca_item *next = &p->items[p->decode_index + 1];
      if (item_compatible(p, next)) {
        push_marker(p, CA_MARKER_TRACK, 0.0, next->serial, next->gain);
        p->decode_index++;
      } else {
        /* The control thread reopens the device once this track drains. */
        p->switch_pending = 1;
        atomic_store(&p->switch_flag, 1);
        ca_cond_signal(&g_engine.control_cond);
      }
    } else {
      p->ended = 1;
      atomic_store(&p->ended_flag, 1);
    }
  }
  ca_mutex_unlock(&p->lock);
}

/* ----------------------------------------------------- reconfiguration */

static int ensure_buffers(ca_player *p, int rate, int channels) {
  uint32_t ring_frames = (uint32_t)CA_MAX(16384.0, rate * CA_RING_SECONDS);
  if (!p->ring || p->ring_frames != ring_frames || p->channels != channels) {
    float *ring = calloc((size_t)ring_frames * (size_t)channels, sizeof(float));
    float *scratch = calloc((size_t)CA_DECODE_CHUNK * (size_t)channels, sizeof(float));
    float *tap = calloc((size_t)CA_TAP_FRAMES * (size_t)channels, sizeof(float));
    if (!ring || !scratch || !tap) {
      free(ring);
      free(scratch);
      free(tap);
      return ca__fail(CA_ERR_NO_MEMORY, "out of memory allocating the playback buffer");
    }
    ca_mutex_lock(&p->tap_lock);
    free(p->ring);
    free(p->scratch);
    free(p->tap);
    p->ring = ring;
    p->scratch = scratch;
    p->tap = tap;
    p->ring_frames = ring_frames;
    p->scratch_frames = CA_DECODE_CHUNK;
    ca_mutex_unlock(&p->tap_lock);
  }
  ca_mutex_lock(&p->tap_lock);
  p->channels = channels;
  p->tap_channels = channels;
  p->rate = rate;
  atomic_store(&p->tap_write, 0);
  memset(p->tap, 0, sizeof(float) * CA_TAP_FRAMES * (size_t)channels);
  ca_mutex_unlock(&p->tap_lock);
  return CA_OK;
}

int ca__player_reconfigure(ca_player *p, int rate, int channels, int advance) {
  double position;
  int kind = CA_MARKER_SEEK;
  if (advance && p->count == 2) {
    ca__push_event(CA_EVENT_DECODER_RETIRED, p->id, p->items[0].serial, p->items[0].decoder, 0);
    p->items[0] = p->items[1];
    memset(&p->items[1], 0, sizeof p->items[1]);
    p->count = 1;
    position = 0.0;
    kind = CA_MARKER_TRACK;
  } else if (!isnan(p->restart_at)) {
    position = p->restart_at;
    kind = CA_MARKER_TRACK;
  } else {
    position = ca__player_position(p);
  }
  p->restart_at = NAN;

  ca_mutex_lock(&p->ring_lock);
  int status = ensure_buffers(p, rate, channels);
  if (status == CA_OK) {
    for (int i = 0; i < p->count; i++) ca__decoder_set_output(p->items[i].decoder, rate, channels);
    if (p->count > 0) ca_decoder_seek(p->items[0].decoder, position);
    if (p->count > 1) ca_decoder_seek(p->items[1].decoder, 0.0);
    ring_flush_locked(p);
    reset_production(p);
    p->eq_rate = 0;  /* coefficients depend on the rate */
    if (p->count > 0) {
      push_marker(p, kind, position, p->items[0].serial, p->items[0].gain);
      atomic_store(&p->pending_seek_bits, double_bits(position));
      atomic_store(&p->pending_seek, 1);
    }
  }
  ca_mutex_unlock(&p->ring_lock);
  return status;
}

/* --------------------------------------------------- audio callback side */

/* Seqlock writer (the callback is the only writer). */
static void publish(ca_player *p, uint64_t read) {
  atomic_fetch_add_explicit(&p->seq, 1, memory_order_relaxed);
  atomic_thread_fence(memory_order_release);
  atomic_store_explicit(&p->pub_serial, p->cb_serial, memory_order_relaxed);
  atomic_store_explicit(&p->pub_base, p->cb_base, memory_order_relaxed);
  atomic_store_explicit(&p->pub_start, p->cb_start, memory_order_relaxed);
  atomic_store_explicit(&p->pub_read, read, memory_order_relaxed);
  atomic_store_explicit(&p->pub_rate, p->rate, memory_order_relaxed);
  atomic_store_explicit(&p->pub_valid, p->cb_valid, memory_order_relaxed);
  atomic_fetch_add_explicit(&p->seq, 1, memory_order_release);
}

static void apply_markers(ca_player *p, uint64_t read) {
  uint32_t r = atomic_load_explicit(&p->marker_read, memory_order_relaxed);
  uint32_t w = atomic_load_explicit(&p->marker_write, memory_order_acquire);
  while (r != w) {
    const ca_marker *m = &p->markers[r % CA_MARKERS];
    if (m->start > read) break;
    p->cb_serial = m->serial;
    p->cb_base = m->base;
    p->cb_start = m->start;
    p->cb_gain = m->gain;
    p->cb_valid = 1;
    p->cb_end_reported = 0;
    if (m->kind == CA_MARKER_TRACK) {
      atomic_store(&p->played_serial, m->serial);
      ca__push_rt_event(CA_EVENT_TRACK_STARTED, p->id, m->serial);
    }
    r++;
    atomic_store(&p->pending_seek, 0);
  }
  atomic_store_explicit(&p->marker_read, r, memory_order_release);
}

static void refresh_eq(ca_player *p) {
  int rate_changed = p->eq_rate != p->rate;
  if (!atomic_load(&p->eq_dirty) && !rate_changed) return;
  if (!ca_mutex_trylock(&p->eq_lock)) return;
  int reset = atomic_load(&p->eq_dirty) &&
              (p->eq_next.count != p->eq_active.count || p->eq_next.enabled != p->eq_active.enabled);
  p->eq_active = p->eq_next;
  atomic_store(&p->eq_dirty, 0);
  ca_mutex_unlock(&p->eq_lock);
  for (int b = 0; b < p->eq_active.count; b++) {
    ca_dsp_peaking_coeffs(&p->eq_coeffs[b], p->rate, p->eq_active.freqs[b], p->eq_active.gains[b], p->eq_active.bandwidth);
  }
  if (reset || rate_changed) memset(p->eq_state, 0, sizeof p->eq_state);
  p->eq_rate = p->rate;
}

static void write_tap(ca_player *p, const float *frames, uint32_t n) {
  uint64_t w = atomic_load_explicit(&p->tap_write, memory_order_relaxed);
  uint32_t ch = (uint32_t)p->tap_channels;
  for (uint32_t done = 0; done < n;) {
    uint32_t index = (uint32_t)((w + done) % CA_TAP_FRAMES);
    uint32_t chunk = CA_MIN(n - done, CA_TAP_FRAMES - index);
    memcpy(p->tap + (size_t)index * ch, frames + (size_t)done * ch, sizeof(float) * chunk * ch);
    done += chunk;
  }
  atomic_store_explicit(&p->tap_write, w + n, memory_order_release);
}

void ca__player_consume(ca_player *p, float *mix, uint32_t frames, int channels) {
  if (!ca_mutex_trylock(&p->ring_lock)) return;
  if (!p->ring || p->channels != channels) {
    ca_mutex_unlock(&p->ring_lock);
    return;
  }
  refresh_eq(p);

  uint32_t override_seq = atomic_load(&p->gain_override_seq);
  if (override_seq != p->cb_gain_seq) {
    p->cb_gain_seq = override_seq;
    p->cb_gain = bits_float(atomic_load(&p->gain_override_bits));
  }

  uint64_t r = atomic_load_explicit(&p->read_pos, memory_order_relaxed);
  uint64_t w = atomic_load_explicit(&p->write_pos, memory_order_acquire);
  float *work = g_engine.work;
  uint32_t done = 0;
  for (;;) {
    apply_markers(p, r);
    if (atomic_load(&p->state) != CA_PLAYER_PLAYING || done >= frames) break;
    uint64_t available = w - r;
    if (available == 0) break;
    uint64_t limit = available;
    uint32_t mr = atomic_load_explicit(&p->marker_read, memory_order_relaxed);
    if (mr != atomic_load_explicit(&p->marker_write, memory_order_acquire)) {
      uint64_t start = p->markers[mr % CA_MARKERS].start;
      if (start > r && start - r < limit) limit = start - r;
    }
    uint32_t n = (uint32_t)CA_MIN(limit, (uint64_t)(frames - done));

    uint32_t index = (uint32_t)(r % p->ring_frames);
    uint32_t first = CA_MIN(n, p->ring_frames - index);
    memcpy(work, p->ring + (size_t)index * (size_t)channels, sizeof(float) * first * (size_t)channels);
    if (n > first) memcpy(work + (size_t)first * (size_t)channels, p->ring, sizeof(float) * (n - first) * (size_t)channels);

    if (p->eq_active.enabled) {
      for (int b = 0; b < p->eq_active.count; b++) {
        if (p->eq_active.gains[b] == 0.0f) continue;
        ca_dsp_biquad_process(&p->eq_coeffs[b], p->eq_state[b], work, n, channels);
      }
    }
    write_tap(p, work, n);

    /* Volume x leveler gain, ramped across the block to avoid zipper noise. */
    float target = bits_float(atomic_load(&p->volume_bits)) * p->cb_gain;
    float level = p->cb_level;
    float step = (target - level) / (float)n;
    float *dst = mix + (size_t)done * (size_t)channels;
    for (uint32_t i = 0; i < n; i++) {
      level += step;
      const float *src = work + (size_t)i * (size_t)channels;
      for (int c = 0; c < channels; c++) dst[(size_t)i * channels + c] += src[c] * level;
    }
    p->cb_level = target;

    r += n;
    done += n;
  }
  atomic_store_explicit(&p->read_pos, r, memory_order_release);
  publish(p, r);

  if (atomic_load(&p->state) == CA_PLAYER_PLAYING && r == w &&
      atomic_load_explicit(&p->marker_read, memory_order_relaxed) ==
          atomic_load_explicit(&p->marker_write, memory_order_acquire)) {
    if (atomic_load(&p->ended_flag)) {
      if (!p->cb_end_reported) {
        p->cb_end_reported = 1;
        ca__push_rt_event(CA_EVENT_TRACK_ENDED, p->id, p->cb_serial);
      }
      atomic_store(&p->state, CA_PLAYER_STOPPED);
    } else if (atomic_load(&p->switch_flag)) {
      atomic_store(&p->drained_flag, 1);
    }
  }
  ca_mutex_unlock(&p->ring_lock);
}

/* -------------------------------------------------------------- queries */

double ca__player_position(ca_player *p) {
  if (atomic_load(&p->pending_seek)) return bits_double(atomic_load(&p->pending_seek_bits));
  for (int attempt = 0; attempt < 64; attempt++) {
    uint32_t s1 = atomic_load_explicit(&p->seq, memory_order_acquire);
    if (s1 & 1u) continue;
    double base = atomic_load_explicit(&p->pub_base, memory_order_relaxed);
    uint64_t start = atomic_load_explicit(&p->pub_start, memory_order_relaxed);
    uint64_t read = atomic_load_explicit(&p->pub_read, memory_order_relaxed);
    int rate = atomic_load_explicit(&p->pub_rate, memory_order_relaxed);
    int valid = atomic_load_explicit(&p->pub_valid, memory_order_relaxed);
    atomic_thread_fence(memory_order_acquire);
    uint32_t s2 = atomic_load_explicit(&p->seq, memory_order_relaxed);
    if (s1 != s2) continue;
    if (!valid || rate <= 0) return 0.0;
    return base + (double)(read - start) / (double)rate;
  }
  return 0.0;
}

uint64_t ca__player_buffered_frames(ca_player *p) {
  return ring_used(p);
}

/* ------------------------------------------------------------ public API */

static void set_item(ca_item *item, ca_decoder *decoder, float gain, int64_t serial) {
  memset(item, 0, sizeof *item);
  item->decoder = decoder;
  item->gain = gain;
  item->serial = serial;
  ca_decoder_get_info(decoder, &item->info);
}

CA_API ca_player *ca_player_create(int32_t is_main) {
  if (!g_engine.initialized) {
    ca__fail(CA_ERR_STATE, "ca_init has not been called");
    return NULL;
  }
  ca_player *p = calloc(1, sizeof *p);
  float *analysis = calloc((size_t)CA_TAP_FRAMES * CA_MAX_OUT_CHANNELS, sizeof(float));
  ca_fft *fft = ca_fft_create();
  if (!p || !analysis || !fft) {
    free(p);
    free(analysis);
    ca_fft_destroy(fft);
    ca__fail(CA_ERR_NO_MEMORY, "out of memory");
    return NULL;
  }
  p->is_main = is_main ? 1 : 0;
  p->analysis = analysis;
  p->fft = fft;
  p->restart_at = NAN;
  p->cb_gain = 1.0f;
  p->cb_level = 1.0f;
  atomic_store(&p->volume_bits, float_bits(1.0f));
  atomic_store(&p->state, CA_PLAYER_STOPPED);
  atomic_store(&p->played_serial, -1);
  ca_mutex_init(&p->command_lock);
  ca_mutex_init(&p->lock);
  ca_mutex_init(&p->ring_lock);
  ca_mutex_init(&p->eq_lock);
  ca_mutex_init(&p->tap_lock);
  ca_cond_init(&p->cond);
  ca_cond_init(&p->held_cond);

  ca_mutex_lock(&g_engine.lock);
  int slot = -1;
  for (int i = 0; i < CA_MAX_PLAYERS; i++) {
    if (!g_engine.players[i]) {
      slot = i;
      break;
    }
  }
  if (slot < 0) {
    ca_mutex_unlock(&g_engine.lock);
    ca_player_destroy(p);
    ca__fail(CA_ERR_STATE, "too many players");
    return NULL;
  }
  p->id = ++g_engine.next_player_id;
  if (g_engine.device_open) ensure_buffers(p, g_engine.out_rate, g_engine.out_channels);
  if (ca_thread_start(&p->thread, player_thread, p) == 0) p->thread_started = 1;
  atomic_store(&g_engine.players[slot], p);
  ca_mutex_unlock(&g_engine.lock);
  if (!p->thread_started) {
    ca_player_destroy(p);
    ca__fail(CA_ERR_NO_MEMORY, "cannot start the decode thread");
    return NULL;
  }
  return p;
}

CA_API void ca_player_destroy(ca_player *p) {
  if (!p) return;
  ca_mutex_lock(&g_engine.lock);
  for (int i = 0; i < CA_MAX_PLAYERS; i++) {
    if (atomic_load(&g_engine.players[i]) == p) atomic_store(&g_engine.players[i], NULL);
  }
  ca_mutex_unlock(&g_engine.lock);
  /* A mix pass that started before the removal may still hold the pointer. */
  ca__engine_wait_for_mix();
  if (p->thread_started) {
    ca_mutex_lock(&p->lock);
    p->quit = 1;
    ca_cond_broadcast(&p->cond);
    ca_mutex_unlock(&p->lock);
    ca_thread_join(&p->thread);
  }
  ca_fft_destroy(p->fft);
  free(p->analysis);
  free(p->ring);
  free(p->scratch);
  free(p->tap);
  ca_cond_destroy(&p->cond);
  ca_cond_destroy(&p->held_cond);
  ca_mutex_destroy(&p->command_lock);
  ca_mutex_destroy(&p->lock);
  ca_mutex_destroy(&p->ring_lock);
  ca_mutex_destroy(&p->eq_lock);
  ca_mutex_destroy(&p->tap_lock);
  free(p);
}

CA_API int ca_player_get_id(const ca_player *p) {
  return p ? p->id : 0;
}

/* Prepares a newly set current track; returns 1 when the device must be
 * reopened in another format first. Engine lock and player held. */
static int install_current(ca_player *p, ca_decoder *decoder, float gain, int64_t serial) {
  set_item(&p->items[0], decoder, gain, serial);
  memset(&p->items[1], 0, sizeof p->items[1]);
  p->count = 1;
  ca__desired_format(p, &p->items[0].info, &p->items[0].format);
  if (p->is_main) g_engine.current_format = p->items[0].format;
  if (g_engine.device_open && !ca__format_matches_output(&p->items[0].format)) {
    p->restart_at = 0.0;
    return 1;
  }
  if (p->ring) ca__decoder_set_output(decoder, p->rate, p->channels);
  restart_locked(p, 0.0, CA_MARKER_TRACK);
  return 0;
}

CA_API int ca_player_set_source(ca_player *p, ca_decoder *decoder, float gain, int64_t serial) {
  if (!p || !decoder) return ca__fail(CA_ERR_INVALID_ARG, "ca_player_set_source: NULL argument");
  ca_mutex_lock(&g_engine.lock);
  begin_command(p);
  int reopen = install_current(p, decoder, gain, serial);
  ca_output_format format = p->items[0].format;
  end_command(p);
  int status = reopen ? ca__engine_apply_format(&format, 0) : CA_OK;
  ca_mutex_unlock(&g_engine.lock);
  return status;
}

/* Undoes an already started gapless hand-over into items[1] (its audio is
 * still in the ring, unheard). Player held. */
static void rollback_next_locked(ca_player *p) {
  if (p->count < 2) return;
  ca_mutex_lock(&p->ring_lock);
  uint32_t mr = atomic_load(&p->marker_read);
  uint32_t mw = atomic_load(&p->marker_write);
  for (uint32_t m = mr; m != mw; m++) {
    const ca_marker *marker = &p->markers[m % CA_MARKERS];
    if (marker->kind == CA_MARKER_TRACK && marker->serial == p->items[1].serial) {
      atomic_store(&p->write_pos, marker->start);
      atomic_store(&p->marker_write, m);
      break;
    }
  }
  ca_mutex_unlock(&p->ring_lock);
  if (p->decode_index == 1) p->decode_index = 0;
  /* items[0] already reached its end. */
  p->ended = 1;
  atomic_store(&p->ended_flag, 1);
  p->switch_pending = 0;
  atomic_store(&p->switch_flag, 0);
  atomic_store(&p->drained_flag, 0);
}

CA_API int ca_player_queue_next(ca_player *p, ca_decoder *decoder, float gain, int64_t serial) {
  if (!p || !decoder) return ca__fail(CA_ERR_INVALID_ARG, "ca_player_queue_next: NULL argument");
  ca_mutex_lock(&g_engine.lock);
  begin_command(p);
  int status = CA_OK;
  if (p->count == 0) {
    status = ca__fail(CA_ERR_STATE, "nothing is loaded to queue after");
  } else {
    if (p->count == 2 && p->decode_index == 1) rollback_next_locked(p);
    ca_item *next = &p->items[1];
    set_item(next, decoder, gain, serial);
    p->count = 2;
    ca__desired_format(p, &next->info, &next->format);
    if (p->ring && item_compatible(p, next)) ca__decoder_set_output(decoder, p->rate, p->channels);
    if (p->ended) {
      /* items[0] already finished decoding: continue straight into this one. */
      p->ended = 0;
      atomic_store(&p->ended_flag, 0);
      if (item_compatible(p, next)) {
        ca_mutex_lock(&p->ring_lock);
        push_marker(p, CA_MARKER_TRACK, 0.0, next->serial, next->gain);
        ca_mutex_unlock(&p->ring_lock);
        p->decode_index = 1;
      } else {
        p->switch_pending = 1;
        atomic_store(&p->switch_flag, 1);
      }
    }
  }
  end_command(p);
  ca_mutex_unlock(&g_engine.lock);
  return status;
}

CA_API int ca_player_clear_next(ca_player *p) {
  if (!p) return ca__fail(CA_ERR_INVALID_ARG, "ca_player_clear_next: NULL player");
  begin_command(p);
  if (p->count == 2) {
    int was_decoding_next = p->decode_index == 1 || p->switch_pending;
    if (p->decode_index == 1) rollback_next_locked(p);
    memset(&p->items[1], 0, sizeof p->items[1]);
    p->count = 1;
    p->switch_pending = 0;
    atomic_store(&p->switch_flag, 0);
    atomic_store(&p->drained_flag, 0);
    if (was_decoding_next) {
      p->ended = 1;
      atomic_store(&p->ended_flag, 1);
    }
  }
  end_command(p);
  return CA_OK;
}

CA_API int ca_player_skip_to_next(ca_player *p) {
  if (!p) return ca__fail(CA_ERR_INVALID_ARG, "ca_player_skip_to_next: NULL player");
  ca_mutex_lock(&g_engine.lock);
  begin_command(p);
  if (p->count < 2) {
    end_command(p);
    ca_mutex_unlock(&g_engine.lock);
    return ca__fail(CA_ERR_STATE, "nothing is queued");
  }
  ca_item next = p->items[1];
  int reopen = g_engine.device_open && p->is_main && !ca__format_matches_output(&next.format);
  if (reopen) {
    end_command(p);
    int status = ca__engine_apply_format(&next.format, 1);
    if (p->is_main) g_engine.current_format = next.format;
    ca_mutex_unlock(&g_engine.lock);
    return status;
  }
  p->items[0] = next;
  memset(&p->items[1], 0, sizeof p->items[1]);
  p->count = 1;
  if (p->is_main) g_engine.current_format = next.format;
  if (p->ring) ca__decoder_set_output(next.decoder, p->rate, p->channels);
  ca_decoder_seek(next.decoder, 0.0);
  restart_locked(p, 0.0, CA_MARKER_TRACK);
  end_command(p);
  ca_mutex_unlock(&g_engine.lock);
  return CA_OK;
}

CA_API int ca_player_replace_source(ca_player *p, ca_decoder *decoder) {
  if (!p || !decoder) return ca__fail(CA_ERR_INVALID_ARG, "ca_player_replace_source: NULL argument");
  begin_command(p);
  int status = CA_OK;
  if (p->count == 0) {
    status = ca__fail(CA_ERR_STATE, "nothing is loaded");
  } else {
    ca_item *current = &p->items[0];
    /* Continue exactly where the old decoder stopped feeding the ring. */
    double position = ca_decoder_get_position(current->decoder);
    if (p->ring) ca__decoder_set_output(decoder, p->rate, p->channels);
    status = ca_decoder_seek(decoder, position);
    if (status == CA_OK) {
      current->decoder = decoder;
      ca_decoder_get_info(decoder, &current->info);
    }
  }
  end_command(p);
  return status;
}

CA_API int ca_player_detach(ca_player *p) {
  if (!p) return ca__fail(CA_ERR_INVALID_ARG, "ca_player_detach: NULL player");
  begin_command(p);
  memset(p->items, 0, sizeof p->items);
  p->count = 0;
  atomic_store(&p->state, CA_PLAYER_STOPPED);
  ca_mutex_lock(&p->ring_lock);
  ring_flush_locked(p);
  reset_production(p);
  p->cb_valid = 0;
  publish(p, atomic_load(&p->read_pos));
  atomic_store(&p->pending_seek, 0);
  ca_mutex_unlock(&p->ring_lock);
  end_command(p);
  return CA_OK;
}

CA_API int ca_player_play(ca_player *p) {
  if (!p) return ca__fail(CA_ERR_INVALID_ARG, "ca_player_play: NULL player");
  ca_mutex_lock(&p->lock);
  int count = p->count;
  ca_mutex_unlock(&p->lock);
  if (count == 0) return ca__fail(CA_ERR_STATE, "nothing is loaded");
  atomic_store(&p->state, CA_PLAYER_PLAYING);
  return CA_OK;
}

CA_API int ca_player_pause(ca_player *p) {
  if (!p) return ca__fail(CA_ERR_INVALID_ARG, "ca_player_pause: NULL player");
  atomic_store(&p->state, CA_PLAYER_PAUSED);
  return CA_OK;
}

CA_API int ca_player_seek(ca_player *p, double seconds) {
  if (!p || !isfinite(seconds)) return ca__fail(CA_ERR_INVALID_ARG, "ca_player_seek: invalid arguments");
  begin_command(p);
  int status = CA_OK;
  if (p->count == 0) {
    status = ca__fail(CA_ERR_STATE, "nothing is loaded");
  } else {
    if (p->count == 2 && (p->decode_index == 1 || p->switch_pending)) ca_decoder_seek(p->items[1].decoder, 0.0);
    status = ca_decoder_seek(p->items[0].decoder, seconds);
    if (status == CA_OK) {
      double position = seconds < 0 ? 0 : seconds;
      double duration = p->items[0].info.duration;
      if (duration > 0 && position > duration) position = duration;
      restart_locked(p, position, CA_MARKER_SEEK);
    }
  }
  end_command(p);
  return status;
}

CA_API int ca_player_get_status(ca_player *p, ca_player_status *out) {
  if (!p || !out) return ca__fail(CA_ERR_INVALID_ARG, "ca_player_get_status: NULL argument");
  memset(out, 0, sizeof *out);
  out->state = atomic_load(&p->state);
  out->ended = out->state == CA_PLAYER_STOPPED && atomic_load(&p->ended_flag);
  out->position = ca__player_position(p);
  ca_mutex_lock(&p->tap_lock);
  int rate = p->rate;
  ca_mutex_unlock(&p->tap_lock);
  out->buffered_seconds = rate > 0 ? (double)ring_used(p) / rate : 0.0;
  out->serial = atomic_load(&p->played_serial);
  return CA_OK;
}

CA_API int ca_player_set_volume(ca_player *p, float volume) {
  if (!p || !isfinite(volume) || volume < 0) return ca__fail(CA_ERR_INVALID_ARG, "ca_player_set_volume: invalid volume");
  atomic_store(&p->volume_bits, float_bits(volume));
  return CA_OK;
}

CA_API int ca_player_set_gain(ca_player *p, float gain) {
  if (!p || !isfinite(gain) || gain < 0) return ca__fail(CA_ERR_INVALID_ARG, "ca_player_set_gain: invalid gain");
  ca_mutex_lock(&p->lock);
  if (p->count > 0) p->items[0].gain = gain;
  ca_mutex_unlock(&p->lock);
  atomic_store(&p->gain_override_bits, float_bits(gain));
  atomic_fetch_add(&p->gain_override_seq, 1);
  return CA_OK;
}

CA_API int ca_player_set_eq(ca_player *p, int32_t enabled, int32_t count, const float *freqs_hz,
                            const float *gains_db, float bandwidth_octaves) {
  if (!p || count < 0 || count > CA_MAX_EQ_BANDS || (count > 0 && (!freqs_hz || !gains_db))) {
    return ca__fail(CA_ERR_INVALID_ARG, "ca_player_set_eq: invalid bands");
  }
  ca_mutex_lock(&p->eq_lock);
  p->eq_next.enabled = enabled ? 1 : 0;
  p->eq_next.count = count;
  for (int i = 0; i < count; i++) {
    p->eq_next.freqs[i] = freqs_hz[i];
    p->eq_next.gains[i] = gains_db[i];
  }
  p->eq_next.bandwidth = bandwidth_octaves > 0 ? bandwidth_octaves : 1.0f;
  atomic_store(&p->eq_dirty, 1);
  ca_mutex_unlock(&p->eq_lock);
  return CA_OK;
}

/* Copies the newest `frames` tap frames into p->analysis. */
static int copy_tap(ca_player *p, uint32_t frames) {
  if (!p->tap || p->tap_channels <= 0) return 0;
  uint64_t w = atomic_load_explicit(&p->tap_write, memory_order_acquire);
  if (w == 0) return 0;
  if (frames > w) frames = (uint32_t)w;
  uint32_t ch = (uint32_t)p->tap_channels;
  uint64_t start = w - frames;
  for (uint32_t done = 0; done < frames;) {
    uint32_t index = (uint32_t)((start + done) % CA_TAP_FRAMES);
    uint32_t chunk = CA_MIN(frames - done, CA_TAP_FRAMES - index);
    memcpy(p->analysis + (size_t)done * ch, p->tap + (size_t)index * ch, sizeof(float) * chunk * ch);
    done += chunk;
  }
  return (int)frames;
}

CA_API int ca_player_get_fft(ca_player *p, float *out) {
  if (!p || !out) return ca__fail(CA_ERR_INVALID_ARG, "ca_player_get_fft: NULL argument");
  ca_mutex_lock(&p->tap_lock);
  int frames = copy_tap(p, CA_FFT_SIZE);
  int channels = p->tap_channels;
  ca_mutex_unlock(&p->tap_lock);
  if (frames <= 0) {
    memset(out, 0, sizeof(float) * CA_FFT_BINS);
    return CA_OK;
  }
  return ca_fft_run(p->fft, p->analysis, frames, channels, out);
}

CA_API int ca_player_get_levels(ca_player *p, float window_seconds, float *out) {
  if (!p || !out || !(window_seconds > 0)) return ca__fail(CA_ERR_INVALID_ARG, "ca_player_get_levels: invalid arguments");
  memset(out, 0, sizeof(float) * 4);
  ca_mutex_lock(&p->tap_lock);
  int rate = p->rate;
  int channels = p->tap_channels;
  int copied = 0;
  if (rate > 0) copied = copy_tap(p, (uint32_t)CA_MIN((double)CA_TAP_FRAMES, floor(window_seconds * rate)));
  ca_mutex_unlock(&p->tap_lock);
  if (copied > 0) ca_dsp_levels(p->analysis, (uint32_t)copied, channels, out);
  return CA_OK;
}
