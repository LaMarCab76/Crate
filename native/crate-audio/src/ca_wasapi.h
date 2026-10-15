/* Windows helpers compiled inside ca_miniaudio.c, next to miniaudio's own
 * WASAPI/COM definitions. */
#ifndef CA_WASAPI_H
#define CA_WASAPI_H

#include "crate_audio.h"
#include "miniaudio.h"

/* Makes sure COM is usable on the calling thread (koffi runs async calls on
 * its own worker threads). No-op outside Windows. */
void ca__platform_thread_init(void);

#if defined(_WIN32)
/* Rates and depths the device accepts in WASAPI exclusive mode, probed with
 * IAudioClient::IsFormatSupported. Returns 1 when the probe ran. */
int ca__wasapi_exclusive_caps(ma_context *context, const ma_device_id *id, ca_device_caps *caps);
#endif

#endif /* CA_WASAPI_H */
