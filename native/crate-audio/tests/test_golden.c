/* Comparisons against reference data captured from BASS (tests/golden). */
#include "test.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "crate_audio.h"
#include "ca_dsp.h"

const char *golden_path(char *buffer, size_t size, const char *name) {
  snprintf(buffer, size, "%s/../golden/%s", g_fixtures_dir, name);
  return buffer;
}

float *read_f32(const char *name, long *count) {
  char path[1024];
  FILE *file = fopen(golden_path(path, sizeof path, name), "rb");
  if (!file) return NULL;
  fseek(file, 0, SEEK_END);
  long bytes = ftell(file);
  fseek(file, 0, SEEK_SET);
  float *data = malloc((size_t)bytes);
  if (data && fread(data, 1, (size_t)bytes, file) != (size_t)bytes) {
    free(data);
    data = NULL;
  }
  fclose(file);
  *count = bytes / (long)sizeof(float);
  return data;
}

static void test_fft_matches_bass(void) {
  static const char *names[] = {"bin46-fullscale", "bin46-left-only", "1khz-quarter", "noise"};
  ca_fft *fft = ca_fft_create();
  CHECK(fft != NULL, "fft create");
  if (!fft) return;
  for (size_t i = 0; i < sizeof names / sizeof names[0]; i++) {
    char in_name[128], bass_name[128];
    snprintf(in_name, sizeof in_name, "fft-%s.in.f32", names[i]);
    snprintf(bass_name, sizeof bass_name, "fft-%s.bass.f32", names[i]);
    long in_count = 0, bass_count = 0;
    float *input = read_f32(in_name, &in_count);
    float *bass = read_f32(bass_name, &bass_count);
    CHECK(input && bass && in_count == CA_FFT_SIZE * 2 && bass_count == CA_FFT_BINS, "%s: golden files", names[i]);
    if (input && bass) {
      float ours[CA_FFT_BINS];
      ca_fft_run(fft, input, CA_FFT_SIZE, 2, ours);
      double worst = 0;
      for (int k = 0; k < CA_FFT_BINS; k++) worst = fmax(worst, fabs(ours[k] - bass[k]));
      CHECK(worst < 1e-5, "%s: FFT differs from BASS by %g", names[i], worst);
    }
    free(input);
    free(bass);
  }
  ca_fft_destroy(fft);
}

static void test_dsd_level_matches_bass(void) {
  char path[1024];
  FILE *file = fopen(golden_path(path, sizeof path, "dsd.txt"), "r");
  CHECK(file != NULL, "dsd.txt");
  if (!file) return;
  char line[256];
  while (fgets(line, sizeof line, file)) {
    if (line[0] == '#') continue;
    char fixture[128];
    int rate = 0;
    double bass_rms[2];
    if (sscanf(line, "%127s %d %lf %lf", fixture, &rate, &bass_rms[0], &bass_rms[1]) != 4) continue;
    ca_decoder *dec = ca_decoder_open_file(fixture_path(path, sizeof path, fixture), NULL);
    CHECK(dec != NULL, "%s: open", fixture);
    if (!dec) continue;
    ca_stream_info info;
    ca_decoder_get_info(dec, &info);
    CHECK(info.sample_rate == rate, "%s: DSD PCM rate %d, BASS used %d", fixture, info.sample_rate, rate);
    double sum[2] = {0, 0};
    long long count = 0, frame = 0;
    long long skip = llround(info.sample_rate * 0.05);
    float buffer[4096 * 2];
    for (;;) {
      int64_t n = ca_decoder_read(dec, buffer, 4096);
      if (n <= 0) break;
      for (int64_t i = 0; i < n; i++, frame++) {
        if (frame < skip) continue;
        sum[0] += buffer[i * 2] * buffer[i * 2];
        sum[1] += buffer[i * 2 + 1] * buffer[i * 2 + 1];
        count++;
      }
    }
    ca_decoder_close(dec);
    for (int c = 0; c < 2; c++) {
      double ours = sqrt(sum[c] / (double)count);
      double db = 20.0 * log10(ours / bass_rms[c]);
      printf("  %s ch%d: RMS %.4f vs BASS %.4f (%+.2f dB)\n", fixture, c, ours, bass_rms[c], db);
      CHECK(fabs(db) < 0.5, "%s ch%d: DSD level differs from BASS by %.2f dB", fixture, c, db);
    }
  }
  fclose(file);
}

static void test_eq_matches_bass(void) {
  char path[1024];
  FILE *file = fopen(golden_path(path, sizeof path, "eq.txt"), "r");
  CHECK(file != NULL, "eq.txt");
  if (!file) return;
  char line[256];
  while (fgets(line, sizeof line, file)) {
    if (line[0] == '#') continue;
    char name[128];
    double rate, center, gain, bandwidth;
    if (sscanf(line, "%127s %lf %lf %lf %lf", name, &rate, &center, &gain, &bandwidth) != 5) continue;
    char ir_name[192];
    snprintf(ir_name, sizeof ir_name, "eq-%s.ir.f32", name);
    long count = 0;
    float *bass = read_f32(ir_name, &count);
    CHECK(bass != NULL && count == 4096, "%s: golden impulse response", name);
    if (!bass) continue;
    ca_biquad_coeffs coeffs;
    ca_biquad_state state = {0, 0};
    ca_dsp_peaking_coeffs(&coeffs, rate, center, gain, bandwidth);
    static float ours[4096];
    memset(ours, 0, sizeof ours);
    ours[0] = 1.0f;
    ca_dsp_biquad_process(&coeffs, &state, ours, 4096, 1);
    double worst = 0;
    for (int i = 0; i < 4096; i++) worst = fmax(worst, fabs(ours[i] - bass[i]));
    printf("  EQ %s: max impulse-response difference %g\n", name, worst);
    CHECK(worst < 1e-4, "%s: EQ differs from BASS_FX by %g", name, worst);
    free(bass);
  }
  fclose(file);
}

static void test_levels_match_bass(void) {
  char path[1024];
  FILE *file = fopen(golden_path(path, sizeof path, "levels.txt"), "r");
  CHECK(file != NULL, "levels.txt");
  if (!file) return;
  char line[256];
  while (fgets(line, sizeof line, file)) {
    if (line[0] == '#') continue;
    char name[64];
    int window = 0;
    float bass[4];
    if (sscanf(line, "%63s %d %f %f %f %f", name, &window, &bass[0], &bass[1], &bass[2], &bass[3]) != 6) continue;
    char in_name[128];
    snprintf(in_name, sizeof in_name, "levels-%s.in.f32", name);
    long count = 0;
    float *input = read_f32(in_name, &count);
    CHECK(input != NULL, "%s: golden input", name);
    if (!input) continue;
    float ours[4];
    ca_dsp_levels(input, (uint32_t)window, 2, ours);
    /* Crate's old bass-constants.ts swapped BASS_LEVEL_RMS and _STEREO, so
     * both captured pairs are RMS values; compare them with our RMS. */
    for (int side = 0; side < 2; side++) {
      CHECK(fabs(ours[2 + side] - bass[2 + side]) < 1e-4, "%s: RMS side %d %g vs BASS %g", name, side, ours[2 + side], bass[2 + side]);
      CHECK(fabs(ours[2 + side] - bass[side]) < 1e-4, "%s: RMS side %d %g vs BASS 'peak' %g", name, side, ours[2 + side], bass[side]);
      CHECK(ours[side] >= ours[2 + side], "%s: peak below RMS", name);
    }
    free(input);
  }
  fclose(file);
}

void run_golden_tests(void) {
  test_eq_matches_bass();
  test_levels_match_bass();
  test_fft_matches_bass();
  test_dsd_level_matches_bass();
}
