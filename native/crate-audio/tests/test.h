/* Minimal test harness for crate_audio (no external framework). */
#ifndef CA_TEST_H
#define CA_TEST_H

#include <stdio.h>

extern int g_test_failures;
extern int g_test_checks;
extern const char *g_fixtures_dir;

#define CHECK(cond, ...)                                                   \
  do {                                                                     \
    g_test_checks++;                                                       \
    if (!(cond)) {                                                         \
      g_test_failures++;                                                   \
      fprintf(stderr, "  FAIL %s:%d: ", __FILE__, __LINE__);               \
      fprintf(stderr, __VA_ARGS__);                                        \
      fprintf(stderr, "\n");                                               \
    }                                                                      \
  } while (0)

/* Writes "<fixtures>/<name>" into buffer and returns it. */
const char *fixture_path(char *buffer, size_t size, const char *name);

/* Tone used by tests/fixtures/generate.mjs. */
double tone_sample(int channel, long long n, int rate);
/* Same tone quantised like the generator, as a float in [-1, 1). */
double tone_quantized(int channel, long long n, int rate, int bits);

/* Reference data captured from BASS (tests/golden). */
const char *golden_path(char *buffer, size_t size, const char *name);
float *read_f32(const char *name, long *count);

void run_decoder_tests(void);
void run_golden_tests(void);
void run_engine_tests(void);
void run_format_tests(void);

#endif
