/* Engine: miniaudio context and device, output format decisions, the audio
 * callback, events and the control thread. */
#include "ca_engine_internal.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>

#include "ca_hal.h"

ca_engine g_engine;

#define CA_MAX_DEVICES 64

typedef struct {
  ma_device_id id;
  ca_device_info info;
} ca_known_device;

static ca_known_device g_devices[CA_MAX_DEVICES];
static int g_device_total;
static ca_device_caps g_caps;          /* caps of the open device */
static int g_expected_stop;

static const int STANDARD_RATES[] = {8000, 11025, 16000, 22050, 32000, 44100, 48000, 88200, 96000,
                                     176400, 192000, 352800, 384000, 705600, 768000};

/* ---------------------------------------------------------------- events */

void ca__push_event(int type, int player_id, int64_t serial, ca_decoder *decoder, int code) {
  ca_mutex_lock(&g_engine.event_lock);
  if (g_engine.event_count < CA_EVENT_CAPACITY) {
    int index = (g_engine.event_head + g_engine.event_count) % CA_EVENT_CAPACITY;
    ca_event *e = &g_engine.events[index];
    memset(e, 0, sizeof *e);
    e->type = type;
    e->player_id = player_id;
    e->serial = serial;
    e->decoder = (uint64_t)(uintptr_t)decoder;
    e->code = code;
    g_engine.event_count++;
  }
  ca_mutex_unlock(&g_engine.event_lock);
}

void ca__push_rt_event(int type, int player_id, int64_t serial) {
  uint32_t w = atomic_load_explicit(&g_engine.rt_write, memory_order_relaxed);
  uint32_t r = atomic_load_explicit(&g_engine.rt_read, memory_order_acquire);
  if (w - r >= CA_EVENT_CAPACITY) return;  /* full: drop rather than block */
  ca_event *e = &g_engine.rt_events[w % CA_EVENT_CAPACITY];
  e->type = type;
  e->player_id = player_id;
  e->serial = serial;
  e->decoder = 0;
  e->code = 0;
  e->reserved = 0;
  atomic_store_explicit(&g_engine.rt_write, w + 1, memory_order_release);
}

CA_API int ca_poll_events(ca_event *out, int32_t max) {
  if (!out || max <= 0) return 0;
  int written = 0;
  /* Callback events first: TRACK_STARTED precedes the DECODER_RETIRED the
   * decode thread emits once it notices the transition. */
  uint32_t r = atomic_load_explicit(&g_engine.rt_read, memory_order_relaxed);
  uint32_t w = atomic_load_explicit(&g_engine.rt_write, memory_order_acquire);
  while (r != w && written < max) out[written++] = g_engine.rt_events[(r++) % CA_EVENT_CAPACITY];
  atomic_store_explicit(&g_engine.rt_read, r, memory_order_release);

  ca_mutex_lock(&g_engine.event_lock);
  while (g_engine.event_count > 0 && written < max) {
    out[written++] = g_engine.events[g_engine.event_head];
    g_engine.event_head = (g_engine.event_head + 1) % CA_EVENT_CAPACITY;
    g_engine.event_count--;
  }
  ca_mutex_unlock(&g_engine.event_lock);
  return written;
}

/* --------------------------------------------------------------- devices */

static void device_id_string(const ma_device_id *id, char *out, size_t size) {
  switch (g_engine.context.backend) {
#if defined(__APPLE__)
    case ma_backend_coreaudio: ca__copy_string(out, size, id->coreaudio); return;
#endif
#if defined(_WIN32)
    case ma_backend_wasapi:
      if (WideCharToMultiByte(CP_UTF8, 0, (const wchar_t *)id->wasapi, -1, out, (int)size, NULL, NULL) <= 0) out[0] = '\0';
      return;
#endif
    case ma_backend_pulseaudio: ca__copy_string(out, size, id->pulse); return;
    case ma_backend_alsa: ca__copy_string(out, size, id->alsa); return;
    case ma_backend_jack: snprintf(out, size, "jack:%d", id->jack); return;
    case ma_backend_null: snprintf(out, size, "null:%d", id->nullbackend); return;
    default: snprintf(out, size, "device"); return;
  }
}

static int refresh_devices_locked(void) {
  if (!g_engine.context_ready) {
    g_device_total = 0;
    return 0;
  }
  ma_device_info *playback = NULL;
  ma_uint32 count = 0;
  if (ma_context_get_devices(&g_engine.context, &playback, &count, NULL, NULL) != MA_SUCCESS) {
    return ca__fail(CA_ERR_DEVICE, "cannot enumerate audio devices");
  }
  g_device_total = 0;
  for (ma_uint32 i = 0; i < count && g_device_total < CA_MAX_DEVICES; i++) {
    ca_known_device *d = &g_devices[g_device_total++];
    memset(d, 0, sizeof *d);
    d->id = playback[i].id;
    device_id_string(&playback[i].id, d->info.id, sizeof d->info.id);
    ca__copy_string(d->info.name, sizeof d->info.name, playback[i].name);
    d->info.is_default = playback[i].isDefault ? 1 : 0;
  }
  return g_device_total;
}

static ca_known_device *find_device_locked(const char *device_id) {
  if (!device_id) {
    for (int i = 0; i < g_device_total; i++) if (g_devices[i].info.is_default) return &g_devices[i];
    return g_device_total > 0 ? &g_devices[0] : NULL;
  }
  for (int i = 0; i < g_device_total; i++) if (strcmp(g_devices[i].info.id, device_id) == 0) return &g_devices[i];
  return NULL;
}

static void add_rate(ca_device_caps *caps, int rate, int bits) {
  if (rate <= 0) return;
  for (int i = 0; i < caps->count; i++) {
    if (caps->rates[i] == rate) {
      if (bits > caps->bits[i]) caps->bits[i] = bits;
      return;
    }
  }
  if (caps->count >= CA_MAX_RATES) return;
  int i = caps->count++;
  while (i > 0 && caps->rates[i - 1] > rate) {
    caps->rates[i] = caps->rates[i - 1];
    caps->bits[i] = caps->bits[i - 1];
    i--;
  }
  caps->rates[i] = rate;
  caps->bits[i] = bits;
}

static int format_bits(ma_format format) {
  switch (format) {
    case ma_format_u8: return 8;
    case ma_format_s16: return 16;
    case ma_format_s24: return 24;
    case ma_format_s32: return 32;
    case ma_format_f32: return 32;
    default: return 0;
  }
}

/* Generic capabilities from miniaudio; the platform layer refines them. */
static int miniaudio_caps_locked(const ca_known_device *device, int exclusive, ca_device_caps *caps) {
  memset(caps, 0, sizeof *caps);
  if (!device || !g_engine.context_ready) {
    caps->max_channels = 2;
    return CA_OK;
  }
  ma_device_info info;
  if (ma_context_get_device_info(&g_engine.context, ma_device_type_playback, &device->id, &info) != MA_SUCCESS) {
    caps->max_channels = 2;
    return CA_OK;
  }
  for (ma_uint32 i = 0; i < info.nativeDataFormatCount; i++) {
    int is_exclusive = (info.nativeDataFormats[i].flags & MA_DATA_FORMAT_FLAG_EXCLUSIVE_MODE) != 0;
    if (exclusive != is_exclusive && g_engine.context.backend == ma_backend_wasapi) continue;
    int bits = format_bits(info.nativeDataFormats[i].format);
    if ((int)info.nativeDataFormats[i].channels > caps->max_channels) caps->max_channels = (int)info.nativeDataFormats[i].channels;
    if (info.nativeDataFormats[i].sampleRate == 0) {
      for (size_t r = 0; r < sizeof STANDARD_RATES / sizeof STANDARD_RATES[0]; r++) add_rate(caps, STANDARD_RATES[r], bits);
    } else {
      add_rate(caps, (int)info.nativeDataFormats[i].sampleRate, bits);
    }
  }
  if (caps->max_channels <= 0) caps->max_channels = 2;
  caps->exclusive = exclusive;
  /* Windows' shared mix format is fixed; elsewhere the rate can follow the track. */
  caps->can_set_rate = g_engine.context.backend == ma_backend_wasapi ? exclusive : 1;
  return CA_OK;
}

static int device_caps_locked(const ca_known_device *device, int exclusive, ca_device_caps *caps) {
  int status = miniaudio_caps_locked(device, exclusive, caps);
  if (status == CA_OK && device) ca__hal_refine_caps(device->info.id, exclusive, caps);
  return status;
}

CA_API int ca_device_count(void) {
  if (!g_engine.initialized) return ca__fail(CA_ERR_STATE, "ca_init has not been called");
  ca_mutex_lock(&g_engine.lock);
  int count = refresh_devices_locked();
  ca_mutex_unlock(&g_engine.lock);
  return count;
}

CA_API int ca_device_get(int32_t index, ca_device_info *out) {
  if (!out) return ca__fail(CA_ERR_INVALID_ARG, "ca_device_get: NULL out");
  ca_mutex_lock(&g_engine.lock);
  if (index < 0 || index >= g_device_total) {
    ca_mutex_unlock(&g_engine.lock);
    return ca__fail(CA_ERR_INVALID_ARG, "device index out of range");
  }
  ca_known_device *device = &g_devices[index];
  *out = device->info;
  ca_device_caps shared, exclusive;
  device_caps_locked(device, 0, &shared);
  device_caps_locked(device, 1, &exclusive);
  out->max_channels = shared.max_channels;
  for (int i = 0; i < shared.count; i++) {
    if (shared.rates[i] > out->max_sample_rate) out->max_sample_rate = shared.rates[i];
    if (shared.bits[i] > out->max_bits) out->max_bits = shared.bits[i];
  }
  for (int i = 0; i < exclusive.count; i++) {
    if (exclusive.rates[i] > out->max_sample_rate) out->max_sample_rate = exclusive.rates[i];
    if (exclusive.bits[i] > out->max_bits) out->max_bits = exclusive.bits[i];
  }
  out->supports_exclusive = ca__hal_supports_exclusive(device->info.id) ||
                            (g_engine.context.backend == ma_backend_wasapi && exclusive.count > 0);
  ca_mutex_unlock(&g_engine.lock);
  return CA_OK;
}

CA_API int ca_device_get_caps(const char *device_id, int32_t exclusive, ca_device_caps *out) {
  if (!out) return ca__fail(CA_ERR_INVALID_ARG, "ca_device_get_caps: NULL out");
  ca_mutex_lock(&g_engine.lock);
  if (g_device_total == 0) refresh_devices_locked();
  ca_known_device *device = find_device_locked(device_id);
  int status = device_caps_locked(device, exclusive ? 1 : 0, out);
  ca_mutex_unlock(&g_engine.lock);
  return status;
}

/* ---------------------------------------------------------------- mixing */

void ca__engine_mix(float *out, uint32_t frames) {
  int channels = g_engine.out_channels;
  memset(out, 0, sizeof(float) * frames * (size_t)channels);
  atomic_fetch_add_explicit(&g_engine.mix_epoch, 1, memory_order_acq_rel);
  for (int i = 0; i < CA_MAX_PLAYERS; i++) {
    ca_player *p = atomic_load_explicit(&g_engine.players[i], memory_order_acquire);
    if (p) ca__player_consume(p, out, frames, channels);
  }
  atomic_fetch_add_explicit(&g_engine.mix_epoch, 1, memory_order_acq_rel);
}

void ca__engine_wait_for_mix(void) {
  uint32_t epoch = atomic_load(&g_engine.mix_epoch);
  if (!(epoch & 1u)) return;
  for (int spins = 0; spins < 2000 && atomic_load(&g_engine.mix_epoch) == epoch; spins++) ca_sleep_ms(1);
}

static void data_callback(ma_device *device, void *output, const void *input, ma_uint32 frames) {
  (void)device;
  (void)input;
  int channels = g_engine.out_channels;
  uint8_t *dst = output;
  uint32_t bytes_per_sample = ma_get_bytes_per_sample(g_engine.out_format);
  while (frames > 0) {
    uint32_t n = CA_MIN(frames, (uint32_t)CA_MIX_FRAMES);
    float *mix = g_engine.out_format == ma_format_f32 ? (float *)dst : g_engine.mix;
    ca__engine_mix(mix, n);
    uint32_t samples = n * (uint32_t)channels;
    if (g_engine.dither_bits > 0) ca_dsp_dither(mix, samples, g_engine.dither_bits, &g_engine.rng);
    switch (g_engine.out_format) {
      case ma_format_s16: ca_dsp_to_s16(mix, (int16_t *)dst, samples); break;
      case ma_format_s24: ca_dsp_to_s24(mix, dst, samples); break;
      case ma_format_s32: ca_dsp_to_s32(mix, (int32_t *)dst, samples); break;
      default: break;
    }
    dst += (size_t)samples * bytes_per_sample;
    frames -= n;
  }
}

static void notification_callback(const ma_device_notification *notification) {
  switch (notification->type) {
    case ma_device_notification_type_rerouted:
      atomic_store(&g_engine.notify_rerouted, 1);
      break;
    case ma_device_notification_type_stopped:
      if (!g_expected_stop) atomic_store(&g_engine.notify_stopped, 1);
      break;
    default:
      break;
  }
}

void ca__engine_render(float *out, uint32_t frames, int *rate, int *channels_out) {
  ca_mutex_lock(&g_engine.render_lock);
  int channels = g_engine.out_channels;
  if (rate) *rate = g_engine.out_rate;
  if (channels_out) *channels_out = channels;
  while (frames > 0) {
    uint32_t n = CA_MIN(frames, (uint32_t)CA_MIX_FRAMES);
    ca__engine_mix(out, n);
    out += (size_t)n * (size_t)channels;
    frames -= n;
  }
  ca_mutex_unlock(&g_engine.render_lock);
}

/* --------------------------------------------------------------- output */

static ca_player *main_player(void) {
  for (int i = 0; i < CA_MAX_PLAYERS; i++) if (g_engine.players[i] && g_engine.players[i]->is_main) return g_engine.players[i];
  return NULL;
}

void ca__desired_format(const ca_player *p, const ca_stream_info *info, ca_output_format *out) {
  memset(out, 0, sizeof *out);
  if (!g_engine.device_open) return;
  if (!p->is_main) {
    out->sample_rate = g_engine.out_rate;
    out->channels = g_engine.out_channels;
    out->bits = g_engine.out_bits;
    return;
  }
  ca_device_caps caps = g_caps;
  if (caps.current_rate <= 0) caps.current_rate = g_engine.native_rate;
  ca_choose_output_format(info, &caps, &g_engine.policy, out);
}

int ca__format_matches_output(const ca_output_format *format) {
  return format->sample_rate == g_engine.out_rate && format->channels == g_engine.out_channels;
}

static ma_format device_format_for_bits(int bits) {
  if (!g_engine.policy.exclusive) return ma_format_f32;
  switch (bits) {
    case 16: return ma_format_s16;
    case 24: return ma_format_s24;
    case 32: return ma_format_s32;
    default: return ma_format_f32;
  }
}

static void stop_device_locked(void) {
  if (!g_engine.device_open || (g_engine.flags & CA_INIT_NO_DEVICE)) return;
  g_expected_stop = 1;
  ma_device_uninit(&g_engine.device);
  g_expected_stop = 0;
  atomic_store(&g_engine.device_running, 0);
}

static ca_known_device *current_device_locked(void) {
  if (g_device_total == 0) refresh_devices_locked();
  ca_known_device *device = find_device_locked(g_engine.follow_default ? NULL : g_engine.device_id);
  if (!device && !g_engine.follow_default) {
    refresh_devices_locked();
    device = find_device_locked(g_engine.device_id);
  }
  return device;
}

/* Opens (but does not start) the device at `rate` (0 = whatever it runs at
 * now). Players are rebuilt for the actual format before it starts. */
static int open_device_locked(int rate, int channels, int bits) {
  if (g_engine.flags & CA_INIT_NO_DEVICE) {
    g_engine.out_rate = rate > 0 ? rate : (g_engine.native_rate > 0 ? g_engine.native_rate : 48000);
    g_engine.out_channels = channels > 0 ? channels : 2;
    g_engine.out_bits = bits > 0 ? bits : 32;
    g_engine.out_format = ma_format_f32;
    return CA_OK;
  }
  ca_known_device *device = current_device_locked();
  ma_device_config config = ma_device_config_init(ma_device_type_playback);
  config.playback.pDeviceID = g_engine.follow_default || !device ? NULL : &device->id;
  config.playback.format = device_format_for_bits(bits);
  config.playback.channels = (ma_uint32)(channels > 0 ? channels : 2);
  config.playback.shareMode = g_engine.policy.exclusive ? ma_share_mode_exclusive : ma_share_mode_shared;
  config.sampleRate = (ma_uint32)(rate > 0 ? rate : 0);
  config.dataCallback = data_callback;
  config.notificationCallback = notification_callback;
  config.periodSizeInMilliseconds = 20;
  config.periods = 3;
  config.noClip = MA_FALSE;
  /* Rate changes are done by the platform layer (it waits for the device);
   * never let the OS or miniaudio resample behind our back. */
  config.coreaudio.allowNominalSampleRateChange = MA_FALSE;
  config.wasapi.noAutoConvertSRC = MA_TRUE;
  config.wasapi.noDefaultQualitySRC = MA_TRUE;

  ma_result result = ma_device_init(&g_engine.context, &config, &g_engine.device);
  if (result != MA_SUCCESS && g_engine.policy.exclusive) {
    /* Exclusive mode refused: fall back to shared output and report it. */
    config.playback.shareMode = ma_share_mode_shared;
    config.playback.format = ma_format_f32;
    result = ma_device_init(&g_engine.context, &config, &g_engine.device);
    if (result == MA_SUCCESS) {
      g_engine.policy.exclusive = 0;
      ca__push_event(CA_EVENT_OUTPUT_CHANGED, 0, 0, NULL, CA_ERR_UNSUPPORTED);
    }
  }
  if (result != MA_SUCCESS) {
    return ca__fail(CA_ERR_DEVICE, "cannot open the audio device (%s)", ma_result_description(result));
  }
  g_engine.out_rate = (int)g_engine.device.sampleRate;
  g_engine.out_channels = (int)g_engine.device.playback.channels;
  g_engine.out_format = g_engine.device.playback.format;
  g_engine.out_bits = bits > 0 ? bits : 32;
  ca__copy_string(g_engine.device_name, sizeof g_engine.device_name, g_engine.device.playback.name);
  if (device) ca__copy_string(g_engine.device_id, sizeof g_engine.device_id, device->info.id);
  return CA_OK;
}

static int start_device_locked(void) {
  if (g_engine.flags & CA_INIT_NO_DEVICE) return CA_OK;
  ma_result result = ma_device_start(&g_engine.device);
  if (result != MA_SUCCESS) {
    ma_device_uninit(&g_engine.device);
    return ca__fail(CA_ERR_DEVICE, "cannot start the audio device (%s)", ma_result_description(result));
  }
  atomic_store(&g_engine.device_running, 1);
  return CA_OK;
}

static void hold_players_locked(void) {
  for (int i = 0; i < CA_MAX_PLAYERS; i++) {
    ca_player *p = g_engine.players[i];
    if (!p) continue;
    ca_mutex_lock(&p->command_lock);
    ca_mutex_lock(&p->lock);
    ca__player_hold(p);
  }
}

static void release_players_locked(void) {
  for (int i = 0; i < CA_MAX_PLAYERS; i++) {
    ca_player *p = g_engine.players[i];
    if (!p) continue;
    ca__player_release(p);
    ca_mutex_unlock(&p->lock);
    ca_mutex_unlock(&p->command_lock);
  }
}

static void update_dither_locked(void) {
  g_engine.dither_bits = g_engine.current_format.dithered ? g_engine.current_format.bits : 0;
  if (g_engine.dither_bits >= 24) g_engine.dither_bits = 0;
}

int ca__engine_apply_format(const ca_output_format *format, int advance_main) {
  /* Without a device the test harness renders on its own thread. */
  if (g_engine.flags & CA_INIT_NO_DEVICE) ca_mutex_lock(&g_engine.render_lock);
  hold_players_locked();
  stop_device_locked();

  int rate = format && format->sample_rate > 0 ? format->sample_rate : 0;
  int channels = format && format->channels > 0 ? format->channels : 2;
  int bits = format ? format->bits : 0;
  ca_known_device *device = (g_engine.flags & CA_INIT_NO_DEVICE) ? NULL : current_device_locked();
  if (rate > 0 && device) ca__hal_prepare_device(device->info.id, rate, bits, g_engine.policy.exclusive);

  int status = open_device_locked(rate, channels, bits);
  if (status != CA_OK && rate > 0) status = open_device_locked(0, channels, 0);
  if (status == CA_OK) {
    if (format) {
      g_engine.current_format = *format;
      if (g_engine.out_rate != format->sample_rate) {
        g_engine.current_format.sample_rate = g_engine.out_rate;
        g_engine.current_format.resampled = 1;
      }
    }
    update_dither_locked();
    for (int i = 0; i < CA_MAX_PLAYERS; i++) {
      ca_player *p = g_engine.players[i];
      if (p) ca__player_reconfigure(p, g_engine.out_rate, g_engine.out_channels, advance_main && p->is_main);
    }
    status = start_device_locked();
  }
  if (status != CA_OK) g_engine.device_open = 0;
  release_players_locked();
  if (g_engine.flags & CA_INIT_NO_DEVICE) ca_mutex_unlock(&g_engine.render_lock);
  if (status == CA_OK) ca__push_event(CA_EVENT_OUTPUT_CHANGED, 0, 0, NULL, 0);
  return status;
}

CA_API int ca_output_open(const char *device_id, const ca_output_policy *policy) {
  if (!g_engine.initialized) return ca__fail(CA_ERR_STATE, "ca_init has not been called");
  ca_mutex_lock(&g_engine.lock);
  hold_players_locked();
  stop_device_locked();
  release_players_locked();
  g_engine.device_open = 0;
  if (policy) g_engine.policy = *policy;
  g_engine.follow_default = device_id == NULL;
  ca__copy_string(g_engine.device_id, sizeof g_engine.device_id, device_id ? device_id : "");
  refresh_devices_locked();
  ca_known_device *device = current_device_locked();
  if (!device && !g_engine.follow_default && !(g_engine.flags & CA_INIT_NO_DEVICE)) {
    ca_mutex_unlock(&g_engine.lock);
    return ca__fail(CA_ERR_DEVICE, "audio device not found: %s", device_id);
  }

  /* Capabilities, and the rate the device runs at before we touch it. */
  if (g_engine.flags & CA_INIT_NO_DEVICE) {
    memset(&g_caps, 0, sizeof g_caps);
    for (size_t r = 0; r < sizeof STANDARD_RATES / sizeof STANDARD_RATES[0]; r++) add_rate(&g_caps, STANDARD_RATES[r], 24);
    g_caps.max_channels = 8;
    g_caps.can_set_rate = 1;
    g_caps.current_rate = 48000;
    g_caps.current_bits = 24;
    g_engine.native_rate = 48000;
  } else {
    device_caps_locked(device, g_engine.policy.exclusive, &g_caps);
    int native = ca__hal_current_rate(device ? device->info.id : NULL);
    if (native > 0) g_caps.current_rate = native;
    g_engine.native_rate = g_caps.current_rate;
  }
  g_engine.device_open = 1;

  /* Run at the main track's format if one is loaded, else as the device is. */
  ca_output_format format;
  memset(&format, 0, sizeof format);
  ca_player *main = main_player();
  if (main && main->count > 0) {
    ca__desired_format(main, &main->items[0].info, &format);
    main->items[0].format = format;
  } else {
    format.sample_rate = g_engine.native_rate;
    format.channels = 2;
    format.bits = g_caps.current_bits;
  }
  int status = ca__engine_apply_format(&format, 0);
  if (status != CA_OK) g_engine.device_open = 0;
  ca_mutex_unlock(&g_engine.lock);
  return status;
}

CA_API int ca_output_set_policy(const ca_output_policy *policy) {
  if (!policy) return ca__fail(CA_ERR_INVALID_ARG, "ca_output_set_policy: NULL policy");
  ca_mutex_lock(&g_engine.lock);
  int was_bit_perfect = g_engine.policy.bit_perfect;
  int exclusive_changed = g_engine.policy.exclusive != policy->exclusive;
  g_engine.policy = *policy;
  int status = CA_OK;
  if (g_engine.device_open) {
    if (exclusive_changed) {
      ca_known_device *device = current_device_locked();
      device_caps_locked(device, policy->exclusive, &g_caps);
      if (g_engine.native_rate > 0) g_caps.current_rate = g_engine.native_rate;
    }
    if (was_bit_perfect && !policy->bit_perfect) ca__hal_restore_rates();
    ca_output_format format;
    memset(&format, 0, sizeof format);
    ca_player *main = main_player();
    if (main && main->count > 0) {
      ca__desired_format(main, &main->items[0].info, &format);
      main->items[0].format = format;
      if (main->count > 1) ca__desired_format(main, &main->items[1].info, &main->items[1].format);
    } else {
      format.sample_rate = g_engine.native_rate;
      format.channels = 2;
      format.bits = g_caps.current_bits;
    }
    if (exclusive_changed || !ca__format_matches_output(&format)) {
      status = ca__engine_apply_format(&format, 0);
    } else {
      g_engine.current_format = format;
      update_dither_locked();
    }
  }
  ca_mutex_unlock(&g_engine.lock);
  return status;
}

CA_API void ca_output_close(void) {
  if (!g_engine.initialized) return;
  ca_mutex_lock(&g_engine.lock);
  hold_players_locked();
  stop_device_locked();
  g_engine.device_open = 0;
  release_players_locked();
  ca__hal_release_exclusive();
  ca__hal_restore_rates();
  ca_mutex_unlock(&g_engine.lock);
}

CA_API int ca_output_get_info(ca_output_info *out) {
  if (!out) return ca__fail(CA_ERR_INVALID_ARG, "ca_output_get_info: NULL out");
  memset(out, 0, sizeof *out);
  ca_mutex_lock(&g_engine.lock);
  out->open = g_engine.device_open;
  out->sample_rate = g_engine.out_rate;
  out->bits = g_engine.out_bits;
  out->channels = g_engine.out_channels;
  out->exclusive = g_engine.policy.exclusive;
  out->bit_perfect = g_engine.policy.bit_perfect;
  out->original_rate = g_engine.native_rate;
  out->current = g_engine.current_format;
  ca__copy_string(out->device_id, sizeof out->device_id, g_engine.device_id);
  ca__copy_string(out->device_name, sizeof out->device_name, g_engine.device_name);
  ca_mutex_unlock(&g_engine.lock);
  return CA_OK;
}

/* --------------------------------------------------------- control thread */

static void handle_pending_switch(void) {
  ca_player *main = main_player();
  if (!main || !atomic_load(&main->drained_flag) || !atomic_load(&main->switch_flag)) return;
  ca_output_format format;
  ca_mutex_lock(&main->lock);
  int ready = main->count == 2 && main->switch_pending;
  if (ready) format = main->items[1].format;
  ca_mutex_unlock(&main->lock);
  if (ready) ca__engine_apply_format(&format, 1);
}

static void control_thread(void *arg) {
  (void)arg;
  ca_mutex_lock(&g_engine.lock);
  while (!g_engine.control_quit) {
    ca_cond_timedwait(&g_engine.control_cond, &g_engine.lock, 10);
    if (g_engine.control_quit) break;
    if (g_engine.device_open) handle_pending_switch();
    if (atomic_exchange(&g_engine.notify_rerouted, 0)) {
      ca__push_event(CA_EVENT_DEVICE_REROUTED, 0, 0, NULL, 0);
    }
    if (atomic_exchange(&g_engine.notify_stopped, 0)) {
      ca__push_event(CA_EVENT_DEVICE_LOST, 0, 0, NULL, 0);
    }
  }
  ca_mutex_unlock(&g_engine.lock);
}

/* ------------------------------------------------------------ lifecycle */

CA_API int ca_init(int32_t flags) {
  if (g_engine.initialized) return CA_OK;
  memset(&g_engine, 0, sizeof g_engine);
  ca_mutex_init(&g_engine.lock);
  ca_mutex_init(&g_engine.event_lock);
  ca_mutex_init(&g_engine.render_lock);
  ca_cond_init(&g_engine.control_cond);
  g_engine.flags = flags;
  g_engine.rng = 0x9e3779b9u;

  if (!(flags & CA_INIT_NO_DEVICE)) {
    ma_context_config config = ma_context_config_init();
    ma_backend null_backend[] = {ma_backend_null};
    ma_result result = (flags & CA_INIT_NULL_BACKEND)
                           ? ma_context_init(null_backend, 1, &config, &g_engine.context)
                           : ma_context_init(NULL, 0, &config, &g_engine.context);
    if (result != MA_SUCCESS) return ca__fail(CA_ERR_DEVICE, "cannot initialise audio (%s)", ma_result_description(result));
    g_engine.context_ready = 1;
  }
  size_t floats = (size_t)CA_MIX_FRAMES * CA_MAX_OUT_CHANNELS;
  g_engine.mix = calloc(floats, sizeof(float));
  g_engine.work = calloc(floats, sizeof(float));
  if (!g_engine.mix || !g_engine.work) {
    if (g_engine.context_ready) ma_context_uninit(&g_engine.context);
    free(g_engine.mix);
    free(g_engine.work);
    return ca__fail(CA_ERR_NO_MEMORY, "out of memory");
  }
  ca__hal_init();
  g_engine.initialized = 1;
  if (ca_thread_start(&g_engine.control, control_thread, NULL) == 0) g_engine.control_started = 1;
  return CA_OK;
}

CA_API void ca_shutdown(void) {
  if (!g_engine.initialized) return;
  if (g_engine.control_started) {
    ca_mutex_lock(&g_engine.lock);
    g_engine.control_quit = 1;
    ca_cond_broadcast(&g_engine.control_cond);
    ca_mutex_unlock(&g_engine.lock);
    ca_thread_join(&g_engine.control);
  }
  ca_output_close();
  for (int i = 0; i < CA_MAX_PLAYERS; i++) {
    if (g_engine.players[i]) ca_player_destroy(g_engine.players[i]);
  }
  ca__hal_shutdown();
  if (g_engine.context_ready) ma_context_uninit(&g_engine.context);
  free(g_engine.mix);
  free(g_engine.work);
  ca_cond_destroy(&g_engine.control_cond);
  ca_mutex_destroy(&g_engine.event_lock);
  ca_mutex_destroy(&g_engine.render_lock);
  ca_mutex_destroy(&g_engine.lock);
  g_engine.initialized = 0;
}
