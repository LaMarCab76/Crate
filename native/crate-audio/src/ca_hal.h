/* Platform audio layer: what miniaudio does not do for bit-perfect output —
 * device capabilities (physical formats), changing the nominal rate and
 * physical format, exclusive access (CoreAudio hog mode) and restoring the
 * user's settings afterwards. ca_hal_coreaudio.c implements it on macOS;
 * ca_hal_generic.c is the no-op used elsewhere (WASAPI exclusive formats are
 * handled through miniaudio). */
#ifndef CA_HAL_H
#define CA_HAL_H

#include "crate_audio.h"

void ca__hal_init(void);
void ca__hal_shutdown(void);

/* Adds what the platform knows to miniaudio's capabilities. */
void ca__hal_refine_caps(const char *device_id, int exclusive, ca_device_caps *caps);
int ca__hal_supports_exclusive(const char *device_id);
/* Current nominal rate, or 0 when unknown. NULL = default device. */
int ca__hal_current_rate(const char *device_id);
/* Depth of the device's physical format, or 0 when unknown. */
int ca__hal_current_bits(const char *device_id);

/* Called with the device closed, right before it is reopened: switch the
 * device to `rate`/`bits` and take or release exclusive access. Waits until
 * the device reports the change (or gives up after a timeout). */
int ca__hal_prepare_device(const char *device_id, int rate, int bits, int exclusive);
void ca__hal_release_exclusive(void);
/* Puts every device Crate changed back to its original rate and format. */
void ca__hal_restore_rates(void);

#endif /* CA_HAL_H */
