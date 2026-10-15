/* No-op platform layer for systems without a dedicated implementation. */
#include "ca_hal.h"

#if !defined(CA_HAL_COREAUDIO)

void ca__hal_init(void) {}
void ca__hal_shutdown(void) {}
void ca__hal_refine_caps(const char *device_id, int exclusive, ca_device_caps *caps) {
  (void)device_id;
  (void)exclusive;
  (void)caps;
}
int ca__hal_supports_exclusive(const char *device_id) {
  (void)device_id;
  return 0;
}
int ca__hal_current_rate(const char *device_id) {
  (void)device_id;
  return 0;
}
int ca__hal_current_bits(const char *device_id) {
  (void)device_id;
  return 0;
}
int ca__hal_prepare_device(const char *device_id, int rate, int bits, int exclusive) {
  (void)device_id;
  (void)rate;
  (void)bits;
  (void)exclusive;
  return 0;
}
void ca__hal_release_exclusive(void) {}
void ca__hal_restore_rates(void) {}

#endif
