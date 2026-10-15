#include "test.h"

#include <math.h>
#include <string.h>

int g_test_failures = 0;
int g_test_checks = 0;
const char *g_fixtures_dir = "tests/fixtures";

static const double FREQS[] = {440, 660, 880, 550, 330, 990};
static const double AMPS[] = {0.5, 0.4, 0.3, 0.3, 0.3, 0.3};

const char *fixture_path(char *buffer, size_t size, const char *name) {
  snprintf(buffer, size, "%s/%s", g_fixtures_dir, name);
  return buffer;
}

double tone_sample(int channel, long long n, int rate) {
  const double pi = 3.14159265358979323846;
  return AMPS[channel] * sin((2.0 * pi * FREQS[channel] * (double)n) / rate);
}

double tone_quantized(int channel, long long n, int rate, int bits) {
  double scale = ldexp(1.0, bits - 1) - 1.0;
  /* JavaScript's Math.round: halves round up. */
  double q = floor(tone_sample(channel, n, rate) * scale + 0.5);
  return q / ldexp(1.0, bits - 1);
}

int main(int argc, char **argv) {
  if (argc > 1) g_fixtures_dir = argv[1];
  const char *only = argc > 2 ? argv[2] : NULL;

  if (!only || strcmp(only, "decoder") == 0) {
    printf("decoder tests\n");
    run_decoder_tests();
  }
  if (!only || strcmp(only, "golden") == 0) {
    printf("golden (BASS reference) tests\n");
    run_golden_tests();
  }
  if (!only || strcmp(only, "format") == 0) {
    printf("output format tests\n");
    run_format_tests();
  }
  if (!only || strcmp(only, "engine") == 0) {
    printf("engine tests\n");
    run_engine_tests();
  }

  printf("%d checks, %d failures\n", g_test_checks, g_test_failures);
  return g_test_failures == 0 ? 0 : 1;
}
