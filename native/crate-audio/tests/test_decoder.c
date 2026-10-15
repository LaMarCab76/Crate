#include "test.h"

#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "crate_audio.h"

#if defined(_WIN32)
#  include <windows.h>
#endif

#define ALL_FRAMES (-1)

typedef struct {
  const char *file;
  const char *codec;
  int rate;          /* decoded rate */
  int channels;
  int bits;          /* expected source bits (0 lossy, 1 DSD) */
  int lossless;
  int compare;       /* 0: none, 16/24: integer tone, 32: float tone, -1: lossy tone */
  long long frames;  /* exact frame count, or -1 to skip */
  int source_rate;   /* 0 = same as rate */
} format_case;

static const format_case FORMAT_CASES[] = {
  {"ref-44100-16-stereo.wav", "pcm_s16le", 44100, 2, 16, 1, 16, 44100, 0},
  {"pcm-44100-24-stereo.wav", "pcm_s24le", 44100, 2, 24, 1, 24, 22050, 0},
  {"pcm-48000-f32-stereo.wav", "pcm_f32le", 48000, 2, 32, 1, 32, 24000, 0},
  {"pcm-22050-16-mono.wav", "pcm_s16le", 22050, 1, 16, 1, 16, 11025, 0},
  {"aiff-44100-16-stereo.aiff", "pcm_s16be", 44100, 2, 16, 1, 16, 22050, 0},
  {"aiff-48000-24-stereo.aif", "pcm_s24be", 48000, 2, 24, 1, 24, 12000, 0},
  {"flac-44100-16-stereo.flac", "flac", 44100, 2, 16, 1, 16, 44100, 0},
  {"flac-96000-24-stereo.flac", "flac", 96000, 2, 24, 1, 24, 48000, 0},
  {"flac-192000-24-stereo.flac", "flac", 192000, 2, 24, 1, 24, 48000, 0},
  {"flac-48000-16-5.1.flac", "flac", 48000, 6, 16, 1, 16, 24000, 0},
  {"alac-44100-16-stereo.m4a", "alac", 44100, 2, 16, 1, 16, 44100, 0},
  {"alac-96000-24-stereo.m4a", "alac", 96000, 2, 24, 1, 24, 48000, 0},
  {"ape-44100-16-stereo.ape", "ape", 44100, 2, 16, 1, 16, 44100, 0},
  {"wavpack-44100-16-stereo.wv", "wavpack", 44100, 2, 16, 1, 16, 44100, 0},
  {"tta-44100-16-stereo.tta", "tta", 44100, 2, 16, 1, 16, 44100, 0},
  {"aac-44100-stereo.m4a", "aac", 44100, 2, 0, 0, -1, 44100, 0},
  {"mp3-44100-stereo.mp3", "mp3", 44100, 2, 0, 0, -1, 44100, 0},
  {"vorbis-44100-stereo.ogg", "vorbis", 44100, 2, 0, 0, -1, 44100, 0},
  {"opus-48000-stereo.opus", "opus", 48000, 2, 0, 0, -1, 48000, 0},
  {"opus-48000-stereo.webm", "opus", 48000, 2, 0, 0, -1, -1, 0},
  {"mpc-44100-stereo.mpc", "musepack8", 44100, 2, 0, 0, 0, -1, 0},
  {"speex-32000-mono.spx", "speex", 32000, 1, 0, 0, 0, -1, 0},
  {"dsd64-stereo.dsf", "dsd_lsbf_planar", 88200, 2, 1, 1, 0, 22050, 2822400},
  {"dsd64-stereo.dff", "dsd_msbf", 88200, 2, 1, 1, 0, 22050, 2822400},
  {"dsd128-stereo.dsf", "dsd_lsbf_planar", 88200, 2, 1, 1, 0, 11025, 5644800},
};

typedef struct {
  float *samples;
  long long frames;
  int channels;
  int rate;
} decoded_audio;

static void decoded_free(decoded_audio *audio) {
  free(audio->samples);
  memset(audio, 0, sizeof *audio);
}

static int decode_all(ca_decoder *dec, decoded_audio *out) {
  ca_stream_info info;
  if (ca_decoder_get_info(dec, &info) != CA_OK) return 0;
  out->channels = info.channels;
  out->rate = info.sample_rate;
  long long capacity = 4096;
  out->samples = malloc(sizeof(float) * (size_t)capacity * (size_t)info.channels);
  out->frames = 0;
  for (;;) {
    if (out->frames + 1024 > capacity) {
      capacity *= 2;
      out->samples = realloc(out->samples, sizeof(float) * (size_t)capacity * (size_t)info.channels);
    }
    int64_t n = ca_decoder_read(dec, out->samples + out->frames * info.channels, 1024);
    if (n < 0) return 0;
    if (n == 0) break;
    out->frames += n;
  }
  return 1;
}

static int decode_file(const char *name, const ca_decode_opts *opts, decoded_audio *out) {
  char path[1024];
  ca_decoder *dec = ca_decoder_open_file(fixture_path(path, sizeof path, name), opts);
  if (!dec) return 0;
  int ok = decode_all(dec, out);
  ca_decoder_close(dec);
  return ok;
}

/* Largest |decoded - expected tone| over the given range. */
static double tone_error(const decoded_audio *audio, int bits, long long first_frame, long long frames, long long tone_offset) {
  double worst = 0;
  for (long long i = 0; i < frames && first_frame + i < audio->frames; i++) {
    for (int c = 0; c < audio->channels; c++) {
      long long n = first_frame + i + tone_offset;
      double expected = bits >= 16 && bits <= 24 ? tone_quantized(c, n, audio->rate, bits) : tone_sample(c, n, audio->rate);
      double diff = fabs(audio->samples[(first_frame + i) * audio->channels + c] - expected);
      if (diff > worst) worst = diff;
    }
  }
  return worst;
}

static double rms_error(const decoded_audio *audio, long long first_frame, long long frames, long long tone_offset) {
  double sum = 0;
  long long count = 0;
  for (long long i = 0; i < frames && first_frame + i < audio->frames; i++) {
    for (int c = 0; c < audio->channels; c++) {
      double expected = tone_sample(c, first_frame + i + tone_offset, audio->rate);
      double diff = audio->samples[(first_frame + i) * audio->channels + c] - expected;
      sum += diff * diff;
      count++;
    }
  }
  return count ? sqrt(sum / (double)count) : 1.0;
}

static double channel_rms(const decoded_audio *audio, int channel, long long first_frame) {
  double sum = 0;
  long long count = 0;
  for (long long i = first_frame; i < audio->frames; i++) {
    double v = audio->samples[i * audio->channels + channel];
    sum += v * v;
    count++;
  }
  return count ? sqrt(sum / (double)count) : 0;
}

/* Fraction of the channel's energy at `freq` (Goertzel over the range). */
static double tone_purity(const decoded_audio *audio, int channel, double freq, long long first_frame) {
  const double pi = 3.14159265358979323846;
  double s_prev = 0, s_prev2 = 0, total = 0;
  double coeff = 2.0 * cos(2.0 * pi * freq / audio->rate);
  long long count = 0;
  for (long long i = first_frame; i < audio->frames; i++) {
    double x = audio->samples[i * audio->channels + channel];
    double s = x + coeff * s_prev - s_prev2;
    s_prev2 = s_prev;
    s_prev = s;
    total += x * x;
    count++;
  }
  if (count == 0 || total == 0) return 0;
  double power = s_prev2 * s_prev2 + s_prev * s_prev - coeff * s_prev * s_prev2;
  return (2.0 * power / (double)count) / total;
}

static double tolerance_for_bits(int bits) {
  return bits == 32 ? 1e-6 : 1.01 / ldexp(1.0, bits - 1);
}

static void test_formats(void) {
  for (size_t i = 0; i < sizeof FORMAT_CASES / sizeof FORMAT_CASES[0]; i++) {
    const format_case *tc = &FORMAT_CASES[i];
    char path[1024];
    ca_decoder *dec = ca_decoder_open_file(fixture_path(path, sizeof path, tc->file), NULL);
    CHECK(dec != NULL, "%s: open failed: %s", tc->file, ca_last_error());
    if (!dec) continue;

    ca_stream_info info;
    CHECK(ca_decoder_get_info(dec, &info) == CA_OK, "%s: get_info", tc->file);
    CHECK(strcmp(info.codec, tc->codec) == 0, "%s: codec %s, expected %s", tc->file, info.codec, tc->codec);
    CHECK(info.sample_rate == tc->rate, "%s: rate %d, expected %d", tc->file, info.sample_rate, tc->rate);
    CHECK(info.channels == tc->channels, "%s: channels %d", tc->file, info.channels);
    CHECK(info.bits_per_sample == tc->bits, "%s: bits %d, expected %d", tc->file, info.bits_per_sample, tc->bits);
    CHECK(info.is_lossless == tc->lossless, "%s: lossless %d", tc->file, info.is_lossless);
    CHECK(info.source_sample_rate == (tc->source_rate ? tc->source_rate : tc->rate),
          "%s: source rate %d", tc->file, info.source_sample_rate);
    CHECK(info.is_dsd == (tc->bits == 1), "%s: is_dsd %d", tc->file, info.is_dsd);
    CHECK(info.duration > 0, "%s: duration %f", tc->file, info.duration);

    decoded_audio audio = {0};
    CHECK(decode_all(dec, &audio), "%s: decode failed: %s", tc->file, ca_last_error());
    ca_decoder_close(dec);

    if (tc->frames >= 0) {
      CHECK(audio.frames == tc->frames, "%s: %lld frames, expected %lld", tc->file, audio.frames, tc->frames);
    }
    if (tc->compare >= 16) {
      double err = tone_error(&audio, tc->compare, 0, audio.frames, 0);
      CHECK(err <= tolerance_for_bits(tc->compare), "%s: max error %g", tc->file, err);
    } else if (tc->compare == -1) {
      /* Lossy: compare after the first 10 ms to stay clear of codec start-up. */
      long long skip = audio.rate / 100;
      double err = rms_error(&audio, skip, audio.frames - 2 * skip, 0);
      CHECK(err < 0.02, "%s: RMS error %g (wrong delay/padding handling?)", tc->file, err);
    } else {
      double purity = tone_purity(&audio, 0, 440, audio.rate / 20);
      CHECK(purity > 0.8, "%s: 440 Hz purity %g", tc->file, purity);
    }
    if (tc->bits == 1) {
      /* Generated at -12 dB SACD (0.25 amplitude); +6 dB gain -> ~0.5. */
      double rms = channel_rms(&audio, 0, audio.rate / 20);
      CHECK(rms > 0.3 && rms < 0.42, "%s: DSD channel RMS %g, expected ~0.354", tc->file, rms);
    }
    decoded_free(&audio);
  }
}

static void test_seek(void) {
  static const struct { const char *file; int bits; } lossless[] = {
    {"ref-44100-16-stereo.wav", 16}, {"flac-44100-16-stereo.flac", 16}, {"alac-44100-16-stereo.m4a", 16},
    {"ape-44100-16-stereo.ape", 16}, {"wavpack-44100-16-stereo.wv", 16}, {"tta-44100-16-stereo.tta", 16},
    {"flac-96000-24-stereo.flac", 24}, {"aiff-48000-24-stereo.aif", 24},
  };
  for (size_t i = 0; i < sizeof lossless / sizeof lossless[0]; i++) {
    char path[1024];
    ca_decoder *dec = ca_decoder_open_file(fixture_path(path, sizeof path, lossless[i].file), NULL);
    CHECK(dec != NULL, "%s: open", lossless[i].file);
    if (!dec) continue;
    ca_stream_info info;
    ca_decoder_get_info(dec, &info);
    double target = info.duration * 0.37;
    CHECK(ca_decoder_seek(dec, target) == CA_OK, "%s: seek: %s", lossless[i].file, ca_last_error());
    long long first = llround(target * info.sample_rate);
    CHECK(fabs(ca_decoder_get_position(dec) - (double)first / info.sample_rate) < 1e-9, "%s: position after seek", lossless[i].file);
    float buffer[2000 * 2];
    int64_t n = ca_decoder_read(dec, buffer, 2000);
    CHECK(n == 2000, "%s: read after seek returned %lld", lossless[i].file, (long long)n);
    decoded_audio view = {buffer, n, info.channels, info.sample_rate};
    double err = tone_error(&view, lossless[i].bits, 0, n, first);
    CHECK(err <= tolerance_for_bits(lossless[i].bits), "%s: seek is not sample-accurate (error %g)", lossless[i].file, err);
    ca_decoder_close(dec);
  }

  static const char *lossy[] = {"aac-44100-stereo.m4a", "mp3-44100-stereo.mp3", "vorbis-44100-stereo.ogg", "opus-48000-stereo.opus"};
  for (size_t i = 0; i < sizeof lossy / sizeof lossy[0]; i++) {
    char path[1024];
    ca_decoder *dec = ca_decoder_open_file(fixture_path(path, sizeof path, lossy[i]), NULL);
    CHECK(dec != NULL, "%s: open", lossy[i]);
    if (!dec) continue;
    ca_stream_info info;
    ca_decoder_get_info(dec, &info);
    double target = 0.5;
    CHECK(ca_decoder_seek(dec, target) == CA_OK, "%s: seek", lossy[i]);
    float buffer[4096 * 2];
    int64_t n = ca_decoder_read(dec, buffer, 4096);
    CHECK(n == 4096, "%s: read after seek returned %lld", lossy[i], (long long)n);
    decoded_audio view = {buffer, n, info.channels, info.sample_rate};
    double err = rms_error(&view, 0, n, llround(target * info.sample_rate));
    CHECK(err < 0.02, "%s: RMS error after seek %g (pre-roll or offset wrong)", lossy[i], err);
    ca_decoder_close(dec);
  }
}

static unsigned char *read_whole_file(const char *path, long *size) {
  FILE *file = fopen(path, "rb");
  if (!file) return NULL;
  fseek(file, 0, SEEK_END);
  *size = ftell(file);
  fseek(file, 0, SEEK_SET);
  unsigned char *data = malloc((size_t)*size);
  if (data && fread(data, 1, (size_t)*size, file) != (size_t)*size) {
    free(data);
    data = NULL;
  }
  fclose(file);
  return data;
}

static void test_memory(void) {
  static const char *files[] = {"flac-44100-16-stereo.flac", "mp3-44100-stereo.mp3", "aac-44100-stereo.m4a", "dsd64-stereo.dsf", "ape-44100-16-stereo.ape"};
  for (size_t i = 0; i < sizeof files / sizeof files[0]; i++) {
    char path[1024];
    long size = 0;
    unsigned char *data = read_whole_file(fixture_path(path, sizeof path, files[i]), &size);
    CHECK(data != NULL, "%s: read", files[i]);
    if (!data) continue;
    decoded_audio from_file = {0}, from_memory = {0};
    CHECK(decode_file(files[i], NULL, &from_file), "%s: file decode", files[i]);
    ca_decoder *dec = ca_decoder_open_memory(data, size, files[i], NULL);
    CHECK(dec != NULL, "%s: memory open: %s", files[i], ca_last_error());
    if (dec) {
      CHECK(decode_all(dec, &from_memory), "%s: memory decode", files[i]);
      CHECK(from_memory.frames == from_file.frames, "%s: memory frames %lld vs file %lld", files[i], from_memory.frames, from_file.frames);
      long long n = from_memory.frames < from_file.frames ? from_memory.frames : from_file.frames;
      CHECK(n > 0 && memcmp(from_memory.samples, from_file.samples, sizeof(float) * (size_t)(n * from_file.channels)) == 0,
            "%s: memory decode differs from file decode", files[i]);
      ca_decoder_close(dec);
    }
    /* Without a name hint the format must still be probed from the bytes. */
    dec = ca_decoder_open_memory(data, size, NULL, NULL);
    CHECK(dec != NULL, "%s: memory open without hint: %s", files[i], ca_last_error());
    ca_decoder_close(dec);
    decoded_free(&from_file);
    decoded_free(&from_memory);
    free(data);
  }
}

static void test_output_conversions(void) {
  /* s16 output is bit-exact for 16-bit sources. */
  char path[1024];
  ca_decode_opts s16 = {CA_SAMPLE_S16, 0, 0, 0};
  ca_decoder *dec = ca_decoder_open_file(fixture_path(path, sizeof path, "flac-44100-16-stereo.flac"), &s16);
  CHECK(dec != NULL, "s16 open");
  if (dec) {
    int16_t buffer[1024 * 2];
    int64_t n = ca_decoder_read(dec, buffer, 1024);
    CHECK(n == 1024, "s16 read %lld", (long long)n);
    int mismatches = 0;
    for (int i = 0; i < n; i++) {
      for (int c = 0; c < 2; c++) {
        int expected = (int)lround(tone_quantized(c, i, 44100, 16) * 32768.0);
        if (buffer[i * 2 + c] != expected) mismatches++;
      }
    }
    CHECK(mismatches == 0, "s16 output has %d mismatching samples", mismatches);
    ca_decoder_close(dec);
  }

  /* Resampling to 48 kHz keeps the tone and the duration. */
  ca_decode_opts resample = {CA_SAMPLE_F32, 48000, 0, 0};
  decoded_audio audio = {0};
  CHECK(decode_file("ref-44100-16-stereo.wav", &resample, &audio), "resample decode");
  CHECK(llabs(audio.frames - 48000) <= 2, "resampled frames %lld", audio.frames);
  CHECK(audio.rate == 48000, "resampled rate %d", audio.rate);
  double err = rms_error(&audio, 200, audio.frames - 400, 0);
  CHECK(err < 0.002, "resampled RMS error %g", err);
  decoded_free(&audio);

  /* 5.1 -> stereo downmix never clips. */
  ca_decode_opts downmix = {CA_SAMPLE_F32, 0, 2, 0};
  CHECK(decode_file("flac-48000-16-5.1.flac", &downmix, &audio), "downmix decode");
  CHECK(audio.channels == 2 && audio.frames == 24000, "downmix shape %d ch %lld frames", audio.channels, audio.frames);
  float peak = 0;
  for (long long i = 0; i < audio.frames * 2; i++) peak = fmaxf(peak, fabsf(audio.samples[i]));
  CHECK(peak <= 1.0f && peak > 0.2f, "downmix peak %g", peak);
  decoded_free(&audio);
}

static void test_gapless(void) {
  static const struct { const char *prefix; const char *ext; int rate; long long total; int exact; } pairs[] = {
    {"gapless", "wav", 44100, 44100, 1}, {"gapless", "flac", 44100, 44100, 1}, {"gapless", "mp3", 44100, 44100, 0},
    {"gapless", "m4a", 44100, 44100, 0}, {"gapless-long", "ogg", 44100, 132300, 0}, {"gapless", "opus", 48000, 48000, 0},
  };
  for (size_t i = 0; i < sizeof pairs / sizeof pairs[0]; i++) {
    char a_name[64], b_name[64];
    snprintf(a_name, sizeof a_name, "%s-a.%s", pairs[i].prefix, pairs[i].ext);
    snprintf(b_name, sizeof b_name, "%s-b.%s", pairs[i].prefix, pairs[i].ext);
    decoded_audio a = {0}, b = {0};
    CHECK(decode_file(a_name, NULL, &a) && decode_file(b_name, NULL, &b), "%s: decode", a_name);
    long long total = a.frames + b.frames;
    CHECK(total == pairs[i].total, "%s: A+B is %lld frames, expected %lld (gapless trimming)", pairs[i].ext, total, pairs[i].total);
    decoded_audio joined = {0};
    joined.channels = a.channels;
    joined.rate = a.rate;
    joined.frames = total;
    joined.samples = malloc(sizeof(float) * (size_t)(total * a.channels));
    memcpy(joined.samples, a.samples, sizeof(float) * (size_t)(a.frames * a.channels));
    memcpy(joined.samples + a.frames * a.channels, b.samples, sizeof(float) * (size_t)(b.frames * b.channels));
    if (pairs[i].exact) {
      double err = tone_error(&joined, 16, 0, total, 0);
      CHECK(err <= tolerance_for_bits(16), "%s: joined parts differ from the tone (%g)", pairs[i].ext, err);
    } else {
      /* Around the seam (±20 ms) the error must look like the rest of the file. */
      long long window = joined.rate / 50;
      double seam = rms_error(&joined, a.frames - window, 2 * window, 0);
      CHECK(seam < 0.03, "%s: seam RMS error %g", pairs[i].ext, seam);
    }
    decoded_free(&a);
    decoded_free(&b);
    decoded_free(&joined);
  }
}

static void test_broken_inputs(void) {
  char path[1024];
  ca_decoder *dec = ca_decoder_open_file(fixture_path(path, sizeof path, "broken-empty.flac"), NULL);
  CHECK(dec == NULL, "empty file must not open");
  ca_decoder_close(dec);

  dec = ca_decoder_open_file(fixture_path(path, sizeof path, "missing-file.flac"), NULL);
  CHECK(dec == NULL && strlen(ca_last_error()) > 0, "missing file must fail with a message");

  dec = ca_decoder_open_file(fixture_path(path, sizeof path, "broken-garbage.mp3"), NULL);
  if (dec) {
    decoded_audio audio = {0};
    decode_all(dec, &audio);  /* must terminate without crashing */
    decoded_free(&audio);
    ca_decoder_close(dec);
  }

  dec = ca_decoder_open_file(fixture_path(path, sizeof path, "broken-truncated.flac"), NULL);
  CHECK(dec != NULL, "truncated FLAC still opens");
  if (dec) {
    decoded_audio audio = {0};
    decode_all(dec, &audio);
    CHECK(audio.frames > 10000 && audio.frames < 44100, "truncated FLAC decoded %lld frames", audio.frames);
    decoded_free(&audio);
    ca_decoder_close(dec);
  }
}

static int copy_file(const char *from, const char *to) {
  long size = 0;
  unsigned char *data = read_whole_file(from, &size);
  if (!data) return 0;
#if defined(_WIN32)
  wchar_t wide[1024];
  MultiByteToWideChar(CP_UTF8, 0, to, -1, wide, 1024);
  FILE *file = _wfopen(wide, L"wb");
#else
  FILE *file = fopen(to, "wb");
#endif
  int ok = file && fwrite(data, 1, (size_t)size, file) == (size_t)size;
  if (file) fclose(file);
  free(data);
  return ok;
}

static void remove_utf8(const char *path) {
#if defined(_WIN32)
  wchar_t wide[1024];
  MultiByteToWideChar(CP_UTF8, 0, path, -1, wide, 1024);
  _wremove(wide);
#else
  remove(path);
#endif
}

static void test_unicode_path(void) {
  char source[1024], target[1024];
  const char *tmp = getenv("TMPDIR");
  if (!tmp) tmp = getenv("TEMP");
  if (!tmp) tmp = "/tmp";
  snprintf(target, sizeof target, "%s/crate-audio \xC3\xB1" "and\xC3\xBA \xE6\x9D\xB1\xE4\xBA\xAC \xF0\x9F\x8E\xB5 a:b.flac", tmp);
#if defined(_WIN32)
  /* ':' is not allowed in Windows file names. */
  snprintf(target, sizeof target, "%s\\crate-audio \xC3\xB1" "and\xC3\xBA \xE6\x9D\xB1\xE4\xBA\xAC \xF0\x9F\x8E\xB5.flac", tmp);
#endif
  CHECK(copy_file(fixture_path(source, sizeof source, "flac-44100-16-stereo.flac"), target), "copy to unicode path");
  ca_decoder *dec = ca_decoder_open_file(target, NULL);
  CHECK(dec != NULL, "unicode path open: %s", ca_last_error());
  if (dec) {
    decoded_audio audio = {0};
    CHECK(decode_all(dec, &audio) && audio.frames == 44100, "unicode path decode");
    decoded_free(&audio);
    ca_decoder_close(dec);
  }
  remove_utf8(target);
}

static void test_fft(void) {
  ca_fft *fft = ca_fft_create();
  CHECK(fft != NULL, "fft create");
  if (!fft) return;
  const double pi = 3.14159265358979323846;
  static float frames[CA_FFT_SIZE * 2];
  float out[CA_FFT_BINS];
  const int bin = 46;
  for (int i = 0; i < CA_FFT_SIZE; i++) {
    float v = (float)sin(2.0 * pi * bin * i / CA_FFT_SIZE);
    frames[i * 2] = v;
    frames[i * 2 + 1] = v;
  }
  CHECK(ca_fft_run(fft, frames, CA_FFT_SIZE, 2, out) == CA_OK, "fft run");
  int peak = 0;
  for (int k = 1; k < CA_FFT_BINS; k++) if (out[k] > out[peak]) peak = k;
  CHECK(peak == bin, "fft peak at bin %d, expected %d", peak, bin);
  printf("  fft: full-scale sine at bin %d -> %g (neighbours %g %g)\n", bin, out[bin], out[bin - 1], out[bin + 1]);
  ca_fft_destroy(fft);
}

static void test_build_info(void) {
  ca_build_info info;
  CHECK(ca_get_build_info(&info) == CA_OK, "build info");
  CHECK(strncmp(info.ffmpeg_license, "LGPL", 4) == 0, "FFmpeg must be LGPL, got %s", info.ffmpeg_license);
  printf("  crate_audio %s, FFmpeg %s (%s), miniaudio %s\n", info.version, info.ffmpeg_version, info.ffmpeg_license, info.miniaudio_version);
}

void run_decoder_tests(void) {
  test_build_info();
  test_formats();
  test_seek();
  test_memory();
  test_output_conversions();
  test_gapless();
  test_broken_inputs();
  test_unicode_path();
  test_fft();
}
