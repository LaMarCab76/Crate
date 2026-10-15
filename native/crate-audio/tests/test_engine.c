/* Playback engine tests. Most run with CA_INIT_NO_DEVICE and render the mix
 * by hand (deterministic, faster than real time); one runs miniaudio's null
 * backend to exercise the real device path. */
#include "test.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "ca_engine_internal.h"
#include "crate_audio.h"

#define BLOCK 512
#define MAX_EVENTS 256

typedef struct {
  ca_event event;
  long long frame;   /* output frames rendered when the event was polled */
} logged_event;

typedef struct {
  int rate;
  int channels;
  long long frames;
  long long capacity;
  float *data;
} segment;

typedef struct {
  segment segments[4];
  int segment_count;
  logged_event events[MAX_EVENTS];
  int event_count;
  long long total_frames;
} capture;

static void capture_free(capture *c) {
  for (int i = 0; i < c->segment_count; i++) free(c->segments[i].data);
  memset(c, 0, sizeof *c);
}

static segment *current_segment(capture *c, int rate, int channels) {
  segment *s = c->segment_count ? &c->segments[c->segment_count - 1] : NULL;
  if (!s || s->rate != rate || s->channels != channels) {
    if (c->segment_count == 4) return s;
    s = &c->segments[c->segment_count++];
    memset(s, 0, sizeof *s);
    s->rate = rate;
    s->channels = channels;
  }
  return s;
}

static void poll_into(capture *c) {
  ca_event events[64];
  int n = ca_poll_events(events, 64);
  for (int i = 0; i < n && c->event_count < MAX_EVENTS; i++) {
    c->events[c->event_count].event = events[i];
    c->events[c->event_count].frame = c->total_frames;
    c->event_count++;
  }
}

static int has_event(const capture *c, int type, int64_t serial) {
  for (int i = 0; i < c->event_count; i++) {
    if (c->events[i].event.type == type && (serial < 0 || c->events[i].event.serial == serial)) return 1;
  }
  return 0;
}

/* Events from the decode thread (DECODER_RETIRED) are asynchronous. */
static int wait_event(capture *c, int type, int64_t serial) {
  for (int i = 0; i < 500 && !has_event(c, type, serial); i++) {
    ca_sleep_ms(1);
    poll_into(c);
  }
  return has_event(c, type, serial);
}

/* Waits until the player can feed a whole block, has ended, or times out. */
static void wait_for_audio(ca_player *p) {
  for (int i = 0; i < 3000; i++) {
    ca_player_status status;
    ca_player_get_status(p, &status);
    if (status.state != CA_PLAYER_PLAYING) return;
    if (ca__player_buffered_frames(p) >= BLOCK) return;
    if (atomic_load(&p->ended_flag)) return;
    /* A pending format switch needs one render to notice the drained ring;
     * after that, wait for the control thread to reopen the device. */
    if (atomic_load(&p->switch_flag) && !atomic_load(&p->drained_flag)) return;
    ca_sleep_ms(1);
  }
}

/* Renders until `stop_type`/`stop_serial` is seen or max_frames elapse. */
static void render_until(ca_player *p, capture *c, int stop_type, int64_t stop_serial, long long max_frames) {
  static float block[BLOCK * CA_MAX_OUT_CHANNELS];
  while (c->total_frames < max_frames) {
    wait_for_audio(p);
    int rate = 0, channels = 0;
    ca__engine_render(block, BLOCK, &rate, &channels);
    segment *s = current_segment(c, rate, channels);
    if (s->frames + BLOCK > s->capacity) {
      s->capacity = s->capacity ? s->capacity * 2 : 65536;
      s->data = realloc(s->data, sizeof(float) * (size_t)s->capacity * (size_t)s->channels);
    }
    memcpy(s->data + s->frames * s->channels, block, sizeof(float) * BLOCK * (size_t)s->channels);
    s->frames += BLOCK;
    c->total_frames += BLOCK;
    poll_into(c);
    if (stop_type && has_event(c, stop_type, stop_serial)) return;
  }
}

static ca_decoder *open_fixture(const char *name) {
  char path[1024];
  ca_decoder *dec = ca_decoder_open_file(fixture_path(path, sizeof path, name), NULL);
  CHECK(dec != NULL, "%s: open: %s", name, ca_last_error());
  return dec;
}

/* Largest |rendered - quantised tone| over [from, from + count) of a segment. */
static double segment_error(const segment *s, long long from, long long count, long long tone_offset, int bits) {
  double worst = 0;
  for (long long i = 0; i < count && from + i < s->frames; i++) {
    for (int c = 0; c < s->channels && c < 2; c++) {
      double expected = bits ? tone_quantized(c, tone_offset + i, s->rate, bits) : tone_sample(c, tone_offset + i, s->rate);
      double diff = fabs(s->data[(from + i) * s->channels + c] - expected);
      if (diff > worst) worst = diff;
    }
  }
  return worst;
}

/* First frame where the left channel is not silent. */
static long long first_sound(const segment *s) {
  for (long long i = 0; i < s->frames; i++) if (s->data[i * s->channels] != 0.0f || s->data[i * s->channels + 1] != 0.0f) return i;
  return -1;
}

static void open_manual_output(int bit_perfect) {
  ca_output_policy policy = {0, bit_perfect};
  CHECK(ca_output_open(NULL, &policy) == CA_OK, "output open: %s", ca_last_error());
}

static void drain_events(void) {
  ca_event events[64];
  while (ca_poll_events(events, 64) > 0) {}
}

static void test_exact_playback(ca_player *p) {
  drain_events();
  ca_decoder *dec = open_fixture("flac-44100-16-stereo.flac");
  if (!dec) return;
  CHECK(ca_player_set_source(p, dec, 1.0f, 1) == CA_OK, "set_source: %s", ca_last_error());
  ca_output_info output;
  ca_output_get_info(&output);
  CHECK(output.sample_rate == 44100, "bit-perfect output runs at %d Hz", output.sample_rate);
  CHECK(ca_player_play(p) == CA_OK, "play");
  capture c = {0};
  render_until(p, &c, CA_EVENT_TRACK_ENDED, 1, 44100 * 3);
  CHECK(has_event(&c, CA_EVENT_TRACK_STARTED, 1), "TRACK_STARTED for serial 1");
  CHECK(has_event(&c, CA_EVENT_TRACK_ENDED, 1), "TRACK_ENDED for serial 1");
  segment *s = &c.segments[0];
  long long start = first_sound(s);
  CHECK(start == 1, "playback starts at frame %lld (the tone is 0 at frame 0)", start);
  double err = segment_error(s, 0, 44100, 0, 16);
  CHECK(err < 1e-6, "rendered output differs from the source by %g (not bit-exact)", err);
  ca_player_status status;
  ca_player_get_status(p, &status);
  CHECK(status.state == CA_PLAYER_STOPPED && status.ended, "stopped and ended after the track (state %d ended %d)", status.state, status.ended);
  ca_player_detach(p);
  ca_decoder_close(dec);
  capture_free(&c);
}

static void test_gapless(ca_player *p, const char *ext, int exact, long long total, const char *prefix) {
  drain_events();
  char a_name[64], b_name[64];
  snprintf(a_name, sizeof a_name, "%s-a.%s", prefix, ext);
  snprintf(b_name, sizeof b_name, "%s-b.%s", prefix, ext);
  ca_decoder *a = open_fixture(a_name);
  ca_decoder *b = open_fixture(b_name);
  if (!a || !b) return;
  ca_stream_info a_info;
  ca_decoder_get_info(a, &a_info);
  CHECK(ca_player_set_source(p, a, 1.0f, 10) == CA_OK, "%s: set_source", ext);
  CHECK(ca_player_queue_next(p, b, 1.0f, 11) == CA_OK, "%s: queue_next: %s", ext, ca_last_error());
  ca_player_play(p);
  capture c = {0};
  render_until(p, &c, CA_EVENT_TRACK_ENDED, 11, total * 3);
  CHECK(c.segment_count == 1, "%s: the output format changed mid-way", ext);
  CHECK(has_event(&c, CA_EVENT_TRACK_STARTED, 11), "%s: no TRACK_STARTED for the queued track", ext);
  CHECK(wait_event(&c, CA_EVENT_DECODER_RETIRED, 10), "%s: first decoder not retired", ext);
  CHECK(!has_event(&c, CA_EVENT_TRACK_ENDED, 10), "%s: the first track reported an end (gap)", ext);
  segment *s = &c.segments[0];
  if (exact) {
    double err = segment_error(s, 0, total, 0, 16);
    CHECK(err < 1e-6, "%s: gapless output differs from the continuous tone by %g", ext, err);
  } else {
    /* Lossy: the seam must look like the rest of the stream. */
    long long seam = (long long)llround(a_info.duration * s->rate);
    double seam_err = 0, sum = 0;
    long long count = 0;
    for (long long i = seam - s->rate / 50; i < seam + s->rate / 50; i++) {
      double d = s->data[i * 2] - tone_sample(0, i, s->rate);
      sum += d * d;
      count++;
    }
    seam_err = sqrt(sum / (double)count);
    CHECK(seam_err < 0.03, "%s: seam RMS error %g", ext, seam_err);
  }
  ca_player_detach(p);
  ca_decoder_close(a);
  ca_decoder_close(b);
  capture_free(&c);
}

static void test_format_switch(ca_player *p) {
  drain_events();
  ca_decoder *a = open_fixture("flac-44100-16-stereo.flac");
  ca_decoder *b = open_fixture("flac-96000-24-stereo.flac");
  if (!a || !b) return;
  CHECK(ca_player_set_source(p, a, 1.0f, 20) == CA_OK, "set_source 44.1k");
  CHECK(ca_player_queue_next(p, b, 1.0f, 21) == CA_OK, "queue 96k");
  ca_player_play(p);
  capture c = {0};
  render_until(p, &c, CA_EVENT_TRACK_ENDED, 21, 400000);
  CHECK(has_event(&c, CA_EVENT_OUTPUT_CHANGED, -1), "no OUTPUT_CHANGED for the 96 kHz track");
  CHECK(has_event(&c, CA_EVENT_TRACK_STARTED, 21), "no TRACK_STARTED for the 96 kHz track");
  CHECK(c.segment_count == 2, "expected a 44.1 kHz and a 96 kHz segment, got %d", c.segment_count);
  if (c.segment_count == 2) {
    CHECK(c.segments[0].rate == 44100 && c.segments[1].rate == 96000, "segment rates %d / %d", c.segments[0].rate, c.segments[1].rate);
    double err_a = segment_error(&c.segments[0], 0, 44100, 0, 16);
    CHECK(err_a < 1e-6, "44.1 kHz part not exact (%g)", err_a);
    long long start_b = first_sound(&c.segments[1]);
    CHECK(start_b == 1, "96 kHz part starts at frame %lld (the tone is 0 at frame 0)", start_b);
    double err_b = segment_error(&c.segments[1], 0, 48000, 0, 24);
    CHECK(err_b < 1e-6, "96 kHz part not bit-exact (%g)", err_b);
  }
  ca_output_info info;
  ca_output_get_info(&info);
  CHECK(info.current.sample_rate == 96000 && !info.current.resampled, "output info %d Hz resampled %d", info.current.sample_rate, info.current.resampled);
  ca_player_detach(p);
  ca_decoder_close(a);
  ca_decoder_close(b);
  capture_free(&c);
}

/* Bit-perfect follows the depth too: a 24-bit track after a 16-bit one at the
 * same rate reopens the device at 24 bits instead of carrying on at 16. */
static void test_depth_switch(ca_player *p) {
  drain_events();
  ca_decoder *a = open_fixture("flac-44100-16-stereo.flac");
  ca_decoder *b = open_fixture("pcm-44100-24-stereo.wav");
  if (!a || !b) return;
  CHECK(ca_player_set_source(p, a, 1.0f, 25) == CA_OK, "set_source 16-bit");
  ca_output_info info;
  ca_output_get_info(&info);
  CHECK(info.bits == 16 && info.current.bits == 16 && info.current.limited_by == 0,
        "16-bit track: device %d bits, reported %d (limited 0x%x)", info.bits, info.current.bits, info.current.limited_by);
  CHECK(ca_player_queue_next(p, b, 1.0f, 26) == CA_OK, "queue 24-bit");
  ca_player_play(p);
  capture c = {0};
  render_until(p, &c, CA_EVENT_TRACK_ENDED, 26, 200000);
  CHECK(has_event(&c, CA_EVENT_OUTPUT_CHANGED, -1), "no OUTPUT_CHANGED for the 24-bit track");
  CHECK(has_event(&c, CA_EVENT_TRACK_STARTED, 26), "no TRACK_STARTED for the 24-bit track");
  ca_output_get_info(&info);
  CHECK(info.bits == 24 && info.current.bits == 24 && !info.current.resampled && info.current.limited_by == 0,
        "24-bit track: device %d bits, reported %d (resampled %d, limited 0x%x)",
        info.bits, info.current.bits, info.current.resampled, info.current.limited_by);
  CHECK(c.segment_count == 1, "the rate changed (%d segments)", c.segment_count);
  if (c.segment_count == 1) {
    segment *s = &c.segments[0];
    double err_a = segment_error(s, 0, 44100, 0, 16);
    CHECK(err_a < 1e-6, "16-bit part not exact (%g)", err_a);
    long long start_b = 44100;
    while (start_b < s->frames && s->data[start_b * 2] == 0.0f && s->data[start_b * 2 + 1] == 0.0f) start_b++;
    double err_b = segment_error(s, start_b - 1, 22050, 0, 24);
    CHECK(err_b < 1e-6, "24-bit part not bit-exact (%g)", err_b);
  }
  ca_player_detach(p);
  ca_decoder_close(a);
  ca_decoder_close(b);
  capture_free(&c);
}

static void test_seek(ca_player *p) {
  drain_events();
  ca_decoder *dec = open_fixture("ref-44100-16-stereo.wav");
  if (!dec) return;
  ca_player_set_source(p, dec, 1.0f, 30);
  CHECK(ca_player_seek(p, 0.5) == CA_OK, "seek");
  ca_player_status status;
  ca_player_get_status(p, &status);
  CHECK(fabs(status.position - 0.5) < 1e-9, "position right after seek: %f", status.position);
  ca_player_play(p);
  capture c = {0};
  render_until(p, &c, 0, 0, 4096);
  double err = segment_error(&c.segments[0], 0, 4096, 22050, 16);
  CHECK(err < 1e-6, "audio after seek is not the tone at 0.5 s (%g)", err);
  ca_player_get_status(p, &status);
  CHECK(fabs(status.position - (0.5 + 4096.0 / 44100.0)) < 1e-6, "position after rendering: %f", status.position);
  ca_player_detach(p);
  ca_decoder_close(dec);
  capture_free(&c);
}

/* Seek back into the current track after its decoder already moved on to the
 * queued one (the ring holds ~1 s of look-ahead). */
static void test_seek_after_handover(ca_player *p) {
  drain_events();
  ca_decoder *a = open_fixture("gapless-a.flac");
  ca_decoder *b = open_fixture("gapless-b.flac");
  if (!a || !b) return;
  ca_player_set_source(p, a, 1.0f, 40);
  ca_player_queue_next(p, b, 1.0f, 41);
  ca_player_play(p);
  capture c = {0};
  render_until(p, &c, 0, 0, 2048);
  int handed_over = 0;
  for (int i = 0; i < 2000 && !handed_over; i++) {
    ca_mutex_lock(&p->lock);
    handed_over = p->decode_index == 1;
    ca_mutex_unlock(&p->lock);
    if (!handed_over) ca_sleep_ms(1);
  }
  CHECK(handed_over, "the decoder did not hand over to the queued track early");
  CHECK(ca_player_seek(p, 0.1) == CA_OK, "seek after handover");
  capture after = {0};
  render_until(p, &after, CA_EVENT_TRACK_ENDED, 41, 200000);
  segment *s = &after.segments[0];
  long long expected = 44100 - 4410;
  CHECK(s->frames >= expected, "rendered %lld frames after the seek", s->frames);
  double err = segment_error(s, 0, expected, 4410, 16);
  CHECK(err < 1e-6, "after seeking back, A then B are not the continuous tone (%g)", err);
  CHECK(has_event(&after, CA_EVENT_TRACK_STARTED, 41), "B never started after the seek");
  ca_player_detach(p);
  ca_decoder_close(a);
  ca_decoder_close(b);
  capture_free(&c);
  capture_free(&after);
}

static void test_clear_next_rollback(ca_player *p) {
  drain_events();
  ca_decoder *a = open_fixture("gapless-a.flac");
  ca_decoder *b = open_fixture("gapless-b.flac");
  if (!a || !b) return;
  ca_player_set_source(p, a, 1.0f, 50);
  ca_player_queue_next(p, b, 1.0f, 51);
  ca_player_play(p);
  capture c = {0};
  render_until(p, &c, 0, 0, 2048);
  for (int i = 0, done = 0; i < 2000 && !done; i++) {
    ca_mutex_lock(&p->lock);
    done = p->decode_index == 1;
    ca_mutex_unlock(&p->lock);
    if (!done) ca_sleep_ms(1);
  }
  CHECK(ca_player_clear_next(p) == CA_OK, "clear_next");
  render_until(p, &c, CA_EVENT_TRACK_ENDED, 50, 200000);
  CHECK(has_event(&c, CA_EVENT_TRACK_ENDED, 50), "A did not end after clearing the queue");
  CHECK(!has_event(&c, CA_EVENT_TRACK_STARTED, 51), "B played although it was cleared");
  long long last = c.segments[0].frames - 1;
  while (last > 0 && c.segments[0].data[last * 2] == 0.0f) last--;
  CHECK(llabs(last - 26496) <= 1, "A's audio ends at frame %lld, expected 26496", last);
  ca_player_detach(p);
  ca_decoder_close(a);
  ca_decoder_close(b);
  capture_free(&c);
}

static void test_skip_to_next(ca_player *p) {
  drain_events();
  ca_decoder *a = open_fixture("flac-44100-16-stereo.flac");
  ca_decoder *b = open_fixture("gapless-b.flac");
  if (!a || !b) return;
  ca_player_set_source(p, a, 1.0f, 60);
  ca_player_queue_next(p, b, 1.0f, 61);
  ca_player_play(p);
  capture c = {0};
  render_until(p, &c, 0, 0, 4096);
  CHECK(ca_player_skip_to_next(p, 99) == CA_ERR_STATE, "skip_to_next with a wrong serial must fail");
  CHECK(ca_player_skip_to_next(p, 61) == CA_OK, "skip_to_next");
  CHECK(ca_player_skip_to_next(p, 61) == CA_OK, "skip_to_next to the already current track is a no-op");
  capture after = {0};
  render_until(p, &after, CA_EVENT_TRACK_ENDED, 61, 100000);
  CHECK(has_event(&after, CA_EVENT_TRACK_STARTED, 61), "skip did not start B");
  double err = segment_error(&after.segments[0], 0, 44100 - 26497, 26497, 16);
  CHECK(err < 1e-6, "B after skip is not exact from its start (%g)", err);
  ca_player_detach(p);
  ca_decoder_close(a);
  ca_decoder_close(b);
  capture_free(&c);
  capture_free(&after);
}

static void test_replace_source(ca_player *p) {
  drain_events();
  char path[1024];
  fixture_path(path, sizeof path, "ref-44100-16-stereo.wav");
  FILE *file = fopen(path, "rb");
  fseek(file, 0, SEEK_END);
  long size = ftell(file);
  fseek(file, 0, SEEK_SET);
  unsigned char *data = malloc((size_t)size);
  CHECK(fread(data, 1, (size_t)size, file) == (size_t)size, "read fixture");
  fclose(file);

  ca_decoder *from_file = open_fixture("ref-44100-16-stereo.wav");
  ca_decoder *from_memory = ca_decoder_open_memory(data, size, "ref.wav", NULL);
  CHECK(from_memory != NULL, "memory decoder");
  ca_player_set_source(p, from_file, 1.0f, 70);
  ca_player_play(p);
  capture c = {0};
  render_until(p, &c, 0, 0, 8192);
  CHECK(ca_player_replace_source(p, from_memory, 71) == CA_ERR_STATE, "replace_source with a stale serial must fail");
  CHECK(ca_player_replace_source(p, from_memory, 70) == CA_OK, "replace_source: %s", ca_last_error());
  render_until(p, &c, CA_EVENT_TRACK_ENDED, 70, 100000);
  double err = segment_error(&c.segments[0], 0, 44100, 0, 16);
  CHECK(err < 1e-6, "swapping to the RAM copy was audible (error %g)", err);
  ca_player_detach(p);
  ca_decoder_close(from_file);
  ca_decoder_close(from_memory);
  free(data);
  capture_free(&c);
}

static void test_volume_eq_and_analysis(ca_player *p) {
  drain_events();
  ca_decoder *dec = open_fixture("ref-44100-16-stereo.wav");
  if (!dec) return;
  ca_player_set_source(p, dec, 1.0f, 80);
  ca_player_set_volume(p, 0.5f);
  ca_player_play(p);
  capture c = {0};
  render_until(p, &c, 0, 0, 8192);
  /* The first block ramps from the previous level; check after it. */
  double worst = 0;
  segment *s = &c.segments[0];
  for (long long i = BLOCK; i < 8192; i++) worst = fmax(worst, fabs(s->data[i * 2] - 0.5 * tone_quantized(0, i, 44100, 16)));
  CHECK(worst < 1e-6, "volume 0.5 not applied exactly (%g)", worst);

  float levels[4];
  CHECK(ca_player_get_levels(p, 0.035f, levels) == CA_OK, "levels");
  /* Pre-volume, like BASS: 0.5 and 0.4 amplitude sines. */
  CHECK(fabs(levels[0] - 0.5) < 0.01 && fabs(levels[2] - 0.5 / sqrt(2.0)) < 0.01, "left levels %g %g", levels[0], levels[2]);
  CHECK(fabs(levels[1] - 0.4) < 0.01 && fabs(levels[3] - 0.4 / sqrt(2.0)) < 0.01, "right levels %g %g", levels[1], levels[3]);
  float fft[CA_FFT_BINS];
  CHECK(ca_player_get_fft(p, fft) == CA_OK, "fft");
  int peak = 1;
  for (int k = 1; k < CA_FFT_BINS; k++) if (fft[k] > fft[peak]) peak = k;
  CHECK(peak == 20 || peak == 21, "FFT peak at bin %d (440 Hz is bin 20.4)", peak);

  /* EQ: compare against the offline filter on the same samples. */
  float freqs[1] = {1000.0f};
  float gains[1] = {6.0f};
  ca_player_set_volume(p, 1.0f);
  ca_player_set_eq(p, 1, 1, freqs, gains, 1.0f);
  ca_player_seek(p, 0.0);
  capture eq = {0};
  render_until(p, &eq, 0, 0, 8192);
  ca_biquad_coeffs coeffs;
  ca_biquad_state state[2] = {{0, 0}, {0, 0}};
  ca_dsp_peaking_coeffs(&coeffs, 44100, 1000, 6, 1.0);
  static float expected[8192 * 2];
  for (int i = 0; i < 8192; i++) {
    expected[i * 2] = (float)tone_quantized(0, i, 44100, 16);
    expected[i * 2 + 1] = (float)tone_quantized(1, i, 44100, 16);
  }
  ca_dsp_biquad_process(&coeffs, state, expected, 8192, 2);
  /* Skip the volume ramp and the filter's transient from before the seek. */
  worst = 0;
  for (int i = 4096 * 2; i < 8192 * 2; i++) worst = fmax(worst, fabs(eq.segments[0].data[i] - expected[i]));
  CHECK(worst < 1e-5, "EQ in the player differs from the offline filter (%g)", worst);
  ca_player_set_eq(p, 0, 0, NULL, NULL, 1.0f);

  ca_player_detach(p);
  ca_decoder_close(dec);
  capture_free(&c);
  capture_free(&eq);
}

static void test_resampled_when_bit_perfect_off(ca_player *p) {
  drain_events();
  ca_output_policy policy = {0, 0};
  CHECK(ca_output_set_policy(&policy) == CA_OK, "policy off");
  ca_decoder *dec = open_fixture("flac-44100-16-stereo.flac");
  if (!dec) return;
  ca_player_set_source(p, dec, 1.0f, 90);
  ca_output_info info;
  ca_output_get_info(&info);
  CHECK(info.sample_rate == 48000, "bit-perfect off keeps the device rate (got %d)", info.sample_rate);
  CHECK(info.current.resampled && (info.current.limited_by & CA_LIMIT_SETTING_OFF), "output info says resampled/setting-off");
  ca_player_play(p);
  capture c = {0};
  render_until(p, &c, CA_EVENT_TRACK_ENDED, 90, 200000);
  segment *s = &c.segments[0];
  long long sounding = s->frames;
  while (sounding > 0 && s->data[(sounding - 1) * 2] == 0.0f) sounding--;
  CHECK(llabs(sounding - 48000) < 64, "resampled length %lld, expected ~48000", sounding);
  ca_player_detach(p);
  ca_decoder_close(dec);
  capture_free(&c);
  policy.bit_perfect = 1;
  ca_output_set_policy(&policy);
}

static void test_null_backend_device(void) {
  CHECK(ca_init(CA_INIT_NULL_BACKEND) == CA_OK, "null backend init: %s", ca_last_error());
  ca_player *p = ca_player_create(1);
  CHECK(p != NULL, "player");
  if (!p) return;
  ca_output_policy policy = {0, 1};
  CHECK(ca_output_open(NULL, &policy) == CA_OK, "null device open: %s", ca_last_error());
  ca_decoder *dec = open_fixture("flac-44100-16-stereo.flac");
  if (dec) {
    ca_player_set_source(p, dec, 1.0f, 100);
    ca_player_play(p);
    ca_sleep_ms(300);
    ca_player_status status;
    ca_player_get_status(p, &status);
    CHECK(status.position > 0.1 && status.position < 0.6, "null device advanced to %f s", status.position);
    ca_player_pause(p);
    ca_sleep_ms(50);
    ca_player_get_status(p, &status);
    double paused_at = status.position;
    ca_sleep_ms(100);
    ca_player_get_status(p, &status);
    CHECK(fabs(status.position - paused_at) < 1e-9, "position moved while paused");
    ca_player_detach(p);
    ca_decoder_close(dec);
  }
  ca_player_destroy(p);
  ca_shutdown();
}

void run_engine_tests(void) {
  CHECK(ca_init(CA_INIT_NO_DEVICE) == CA_OK, "init");
  ca_player *p = ca_player_create(1);
  CHECK(p != NULL, "player create: %s", ca_last_error());
  if (!p) return;
  open_manual_output(1);

  test_exact_playback(p);
  test_gapless(p, "wav", 1, 44100, "gapless");
  test_gapless(p, "flac", 1, 44100, "gapless");
  test_gapless(p, "mp3", 0, 44100, "gapless");
  test_gapless(p, "m4a", 0, 44100, "gapless");
  test_gapless(p, "ogg", 0, 132300, "gapless-long");
  test_format_switch(p);
  test_depth_switch(p);
  test_seek(p);
  test_seek_after_handover(p);
  test_clear_next_rollback(p);
  test_skip_to_next(p);
  test_replace_source(p);
  test_volume_eq_and_analysis(p);
  test_resampled_when_bit_perfect_off(p);

  ca_player_destroy(p);
  ca_shutdown();
  test_null_backend_device();
}
