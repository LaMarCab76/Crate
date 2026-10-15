/* macOS platform layer (see ca_hal.h): device capabilities from the HAL,
 * nominal rate and physical format changes for bit-perfect output, hog mode
 * for exclusive access, and restoring everything the user had before.
 *
 * Devices are identified by their CoreAudio UID, the same string miniaudio
 * uses as the device id, so there is no fuzzy name matching. All functions
 * run under the engine lock. */
#include "ca_hal.h"

#if defined(CA_HAL_COREAUDIO)

#include <CoreAudio/CoreAudio.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "ca_internal.h"
#include "ca_thread.h"

#define CA_HAL_WAIT_MS 2000
#define CA_HAL_MAX_TOUCHED 16

static const int STANDARD_RATES[] = {8000, 11025, 16000, 22050, 32000, 44100, 48000, 88200, 96000,
                                     176400, 192000, 352800, 384000, 705600, 768000};

typedef struct {
  AudioObjectID device;
  Float64 original_rate;
  int has_format;
  AudioStreamBasicDescription original_format;
} touched_device;

static touched_device g_touched[CA_HAL_MAX_TOUCHED];
static int g_touched_count;
static AudioObjectID g_hog_device = kAudioObjectUnknown;

static AudioObjectPropertyAddress address(AudioObjectPropertySelector selector, AudioObjectPropertyScope scope) {
  AudioObjectPropertyAddress result = {selector, scope, kAudioObjectPropertyElementMain};
  return result;
}

static int uid_of(AudioObjectID device, char *out, size_t size) {
  AudioObjectPropertyAddress a = address(kAudioDevicePropertyDeviceUID, kAudioObjectPropertyScopeGlobal);
  CFStringRef uid = NULL;
  UInt32 bytes = sizeof uid;
  if (AudioObjectGetPropertyData(device, &a, 0, NULL, &bytes, &uid) != noErr || !uid) return 0;
  Boolean ok = CFStringGetCString(uid, out, (CFIndex)size, kCFStringEncodingUTF8);
  CFRelease(uid);
  return ok ? 1 : 0;
}

static AudioObjectID default_output_device(void) {
  AudioObjectPropertyAddress a = address(kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeGlobal);
  AudioObjectID device = kAudioObjectUnknown;
  UInt32 bytes = sizeof device;
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &a, 0, NULL, &bytes, &device) != noErr) return kAudioObjectUnknown;
  return device;
}

static AudioObjectID device_for_uid(const char *uid) {
  if (!uid || !*uid) return default_output_device();
  AudioObjectPropertyAddress a = address(kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal);
  UInt32 bytes = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &a, 0, NULL, &bytes) != noErr || bytes == 0) return kAudioObjectUnknown;
  AudioObjectID *devices = malloc(bytes);
  if (!devices) return kAudioObjectUnknown;
  AudioObjectID found = kAudioObjectUnknown;
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &a, 0, NULL, &bytes, devices) == noErr) {
    UInt32 count = bytes / sizeof(AudioObjectID);
    char candidate[512];
    for (UInt32 i = 0; i < count; i++) {
      if (uid_of(devices[i], candidate, sizeof candidate) && strcmp(candidate, uid) == 0) {
        found = devices[i];
        break;
      }
    }
  }
  free(devices);
  return found;
}

static Float64 nominal_rate(AudioObjectID device) {
  AudioObjectPropertyAddress a = address(kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal);
  Float64 rate = 0;
  UInt32 bytes = sizeof rate;
  if (AudioObjectGetPropertyData(device, &a, 0, NULL, &bytes, &rate) != noErr) return 0;
  return rate;
}

static AudioStreamID output_stream(AudioObjectID device) {
  AudioObjectPropertyAddress a = address(kAudioDevicePropertyStreams, kAudioObjectPropertyScopeOutput);
  UInt32 bytes = 0;
  if (AudioObjectGetPropertyDataSize(device, &a, 0, NULL, &bytes) != noErr || bytes < sizeof(AudioStreamID)) return kAudioObjectUnknown;
  AudioStreamID *streams = malloc(bytes);
  if (!streams) return kAudioObjectUnknown;
  AudioStreamID stream = kAudioObjectUnknown;
  if (AudioObjectGetPropertyData(device, &a, 0, NULL, &bytes, streams) == noErr) stream = streams[0];
  free(streams);
  return stream;
}

static int physical_format(AudioStreamID stream, AudioStreamBasicDescription *out) {
  AudioObjectPropertyAddress a = address(kAudioStreamPropertyPhysicalFormat, kAudioObjectPropertyScopeGlobal);
  UInt32 bytes = sizeof *out;
  return AudioObjectGetPropertyData(stream, &a, 0, NULL, &bytes, out) == noErr;
}

static AudioStreamRangedDescription *physical_formats(AudioStreamID stream, UInt32 *count) {
  AudioObjectPropertyAddress a = address(kAudioStreamPropertyAvailablePhysicalFormats, kAudioObjectPropertyScopeGlobal);
  UInt32 bytes = 0;
  *count = 0;
  if (AudioObjectGetPropertyDataSize(stream, &a, 0, NULL, &bytes) != noErr || bytes == 0) return NULL;
  AudioStreamRangedDescription *formats = malloc(bytes);
  if (!formats) return NULL;
  if (AudioObjectGetPropertyData(stream, &a, 0, NULL, &bytes, formats) != noErr) {
    free(formats);
    return NULL;
  }
  *count = bytes / sizeof(AudioStreamRangedDescription);
  return formats;
}

static int format_covers(const AudioStreamRangedDescription *f, double rate) {
  double min = f->mSampleRateRange.mMinimum;
  double max = f->mSampleRateRange.mMaximum;
  if (min == 0 && max == 0) return f->mFormat.mSampleRate == 0 || f->mFormat.mSampleRate == rate;
  return rate >= min - 0.5 && rate <= max + 0.5;
}

static int usable_pcm(const AudioStreamBasicDescription *f, int exclusive) {
  if (f->mFormatID != kAudioFormatLinearPCM) return 0;
  if (!exclusive && (f->mFormatFlags & kAudioFormatFlagIsNonMixable)) return 0;
  return f->mBitsPerChannel > 0;
}

static int format_depth(const AudioStreamBasicDescription *f) {
  return (int)f->mBitsPerChannel;
}

static void add_rate(ca_device_caps *caps, int rate) {
  for (int i = 0; i < caps->count; i++) if (caps->rates[i] == rate) return;
  if (caps->count >= CA_MAX_RATES) return;
  int i = caps->count++;
  while (i > 0 && caps->rates[i - 1] > rate) {
    caps->rates[i] = caps->rates[i - 1];
    i--;
  }
  caps->rates[i] = rate;
}

static int wait_until(int (*done)(AudioObjectID, const void *), AudioObjectID object, const void *target) {
  uint64_t deadline = ca_now_ms() + CA_HAL_WAIT_MS;
  while (ca_now_ms() < deadline) {
    if (done(object, target)) return 1;
    ca_sleep_ms(10);
  }
  return done(object, target);
}

static int rate_applied(AudioObjectID device, const void *target) {
  return (int)(nominal_rate(device) + 0.5) == (int)(*(const Float64 *)target + 0.5);
}

static int format_applied(AudioObjectID stream, const void *target) {
  const AudioStreamBasicDescription *want = target;
  AudioStreamBasicDescription now;
  return physical_format(stream, &now) && now.mBitsPerChannel == want->mBitsPerChannel &&
         (int)(now.mSampleRate + 0.5) == (int)(want->mSampleRate + 0.5);
}

static touched_device *remember_device(AudioObjectID device) {
  for (int i = 0; i < g_touched_count; i++) if (g_touched[i].device == device) return &g_touched[i];
  if (g_touched_count >= CA_HAL_MAX_TOUCHED) return NULL;
  touched_device *t = &g_touched[g_touched_count++];
  memset(t, 0, sizeof *t);
  t->device = device;
  t->original_rate = nominal_rate(device);
  AudioStreamID stream = output_stream(device);
  if (stream != kAudioObjectUnknown) t->has_format = physical_format(stream, &t->original_format);
  return t;
}

/* ------------------------------------------------------------- ca_hal.h */

void ca__hal_init(void) {
  g_touched_count = 0;
  g_hog_device = kAudioObjectUnknown;
}

void ca__hal_shutdown(void) {
  ca__hal_release_exclusive();
  ca__hal_restore_rates();
}

void ca__hal_refine_caps(const char *device_id, int exclusive, ca_device_caps *caps) {
  AudioObjectID device = device_for_uid(device_id);
  if (device == kAudioObjectUnknown) return;

  /* Rates: the nominal rates the device accepts. */
  AudioObjectPropertyAddress a = address(kAudioDevicePropertyAvailableNominalSampleRates, kAudioObjectPropertyScopeGlobal);
  UInt32 bytes = 0;
  if (AudioObjectGetPropertyDataSize(device, &a, 0, NULL, &bytes) == noErr && bytes >= sizeof(AudioValueRange)) {
    AudioValueRange *ranges = malloc(bytes);
    if (ranges && AudioObjectGetPropertyData(device, &a, 0, NULL, &bytes, ranges) == noErr) {
      caps->count = 0;
      UInt32 count = bytes / sizeof(AudioValueRange);
      for (UInt32 r = 0; r < count; r++) {
        for (size_t s = 0; s < sizeof STANDARD_RATES / sizeof STANDARD_RATES[0]; s++) {
          if (STANDARD_RATES[s] >= ranges[r].mMinimum - 0.5 && STANDARD_RATES[s] <= ranges[r].mMaximum + 0.5) add_rate(caps, STANDARD_RATES[s]);
        }
      }
    }
    free(ranges);
  }

  /* Depth: the deepest physical PCM format at each rate. */
  AudioStreamID stream = output_stream(device);
  UInt32 format_count = 0;
  AudioStreamRangedDescription *formats = stream != kAudioObjectUnknown ? physical_formats(stream, &format_count) : NULL;
  for (int i = 0; i < caps->count; i++) {
    int best = 0;
    for (UInt32 f = 0; f < format_count; f++) {
      if (!usable_pcm(&formats[f].mFormat, exclusive) || !format_covers(&formats[f], caps->rates[i])) continue;
      int depth = format_depth(&formats[f].mFormat);
      if (depth > best) best = depth;
      if ((int)formats[f].mFormat.mChannelsPerFrame > caps->max_channels) caps->max_channels = (int)formats[f].mFormat.mChannelsPerFrame;
    }
    caps->bits[i] = best > 0 ? best : 24;
  }
  free(formats);

  AudioStreamBasicDescription current;
  if (stream != kAudioObjectUnknown && physical_format(stream, &current)) {
    caps->current_bits = format_depth(&current);
  }
  caps->current_rate = (int)(nominal_rate(device) + 0.5);
  Boolean settable = false;
  AudioObjectPropertyAddress rate_address = address(kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal);
  caps->can_set_rate = AudioObjectIsPropertySettable(device, &rate_address, &settable) == noErr && settable ? 1 : 0;
  caps->exclusive = exclusive;
  if (caps->max_channels <= 0) caps->max_channels = 2;
}

int ca__hal_supports_exclusive(const char *device_id) {
  AudioObjectID device = device_for_uid(device_id);
  if (device == kAudioObjectUnknown) return 0;
  AudioObjectPropertyAddress a = address(kAudioDevicePropertyHogMode, kAudioObjectPropertyScopeGlobal);
  Boolean settable = false;
  return AudioObjectHasProperty(device, &a) && AudioObjectIsPropertySettable(device, &a, &settable) == noErr && settable;
}

int ca__hal_current_rate(const char *device_id) {
  AudioObjectID device = device_for_uid(device_id);
  return device == kAudioObjectUnknown ? 0 : (int)(nominal_rate(device) + 0.5);
}

static pid_t hog_owner(AudioObjectID device) {
  AudioObjectPropertyAddress a = address(kAudioDevicePropertyHogMode, kAudioObjectPropertyScopeGlobal);
  pid_t owner = -1;
  UInt32 bytes = sizeof owner;
  if (AudioObjectGetPropertyData(device, &a, 0, NULL, &bytes, &owner) != noErr) return -1;
  return owner;
}

static int set_hog(AudioObjectID device, pid_t owner) {
  AudioObjectPropertyAddress a = address(kAudioDevicePropertyHogMode, kAudioObjectPropertyScopeGlobal);
  return AudioObjectSetPropertyData(device, &a, 0, NULL, sizeof owner, &owner) == noErr;
}

void ca__hal_release_exclusive(void) {
  if (g_hog_device == kAudioObjectUnknown) return;
  if (hog_owner(g_hog_device) == getpid()) set_hog(g_hog_device, -1);
  g_hog_device = kAudioObjectUnknown;
}

int ca__hal_prepare_device(const char *device_id, int rate, int bits, int exclusive) {
  AudioObjectID device = device_for_uid(device_id);
  if (device == kAudioObjectUnknown) return ca__fail(CA_ERR_DEVICE, "CoreAudio device not found");

  /* Exclusive access first: only the hog owner may change a hogged device. */
  if (g_hog_device != kAudioObjectUnknown && (!exclusive || g_hog_device != device)) ca__hal_release_exclusive();
  if (exclusive && g_hog_device != device) {
    pid_t owner = hog_owner(device);
    if (owner != -1 && owner != getpid()) {
      return ca__fail(CA_ERR_DEVICE, "the device is in exclusive use by another process (pid %d)", (int)owner);
    }
    if (owner != getpid() && !set_hog(device, getpid())) {
      return ca__fail(CA_ERR_DEVICE, "CoreAudio refused exclusive access");
    }
    g_hog_device = device;
  }

  /* Nominal rate. */
  if (rate > 0 && (int)(nominal_rate(device) + 0.5) != rate) {
    if (!remember_device(device)) return ca__fail(CA_ERR_DEVICE, "too many devices changed");
    Float64 target = rate;
    AudioObjectPropertyAddress a = address(kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal);
    if (AudioObjectSetPropertyData(device, &a, 0, NULL, sizeof target, &target) == noErr) {
      wait_until(rate_applied, device, &target);
    }
  }

  /* Physical format: the deepest PCM format at that rate (up to `bits`). */
  AudioStreamID stream = output_stream(device);
  if (bits > 0 && rate > 0 && stream != kAudioObjectUnknown) {
    AudioStreamBasicDescription current;
    UInt32 count = 0;
    AudioStreamRangedDescription *formats = physical_formats(stream, &count);
    if (formats && physical_format(stream, &current)) {
      const AudioStreamRangedDescription *best = NULL;
      for (UInt32 f = 0; f < count; f++) {
        const AudioStreamBasicDescription *candidate = &formats[f].mFormat;
        if (!usable_pcm(candidate, exclusive) || !format_covers(&formats[f], rate)) continue;
        if (candidate->mChannelsPerFrame != current.mChannelsPerFrame) continue;
        if (format_depth(candidate) > bits) continue;
        if (!best || format_depth(candidate) > format_depth(&best->mFormat)) best = &formats[f];
      }
      if (best && format_depth(&best->mFormat) != format_depth(&current)) {
        if (remember_device(device)) {
          AudioStreamBasicDescription target = best->mFormat;
          target.mSampleRate = rate;
          AudioObjectPropertyAddress a = address(kAudioStreamPropertyPhysicalFormat, kAudioObjectPropertyScopeGlobal);
          if (AudioObjectSetPropertyData(stream, &a, 0, NULL, sizeof target, &target) == noErr) {
            wait_until(format_applied, stream, &target);
          }
        }
      }
    }
    free(formats);
  }
  return CA_OK;
}

void ca__hal_restore_rates(void) {
  for (int i = 0; i < g_touched_count; i++) {
    touched_device *t = &g_touched[i];
    AudioStreamID stream = output_stream(t->device);
    if (t->has_format && stream != kAudioObjectUnknown) {
      AudioObjectPropertyAddress a = address(kAudioStreamPropertyPhysicalFormat, kAudioObjectPropertyScopeGlobal);
      AudioStreamBasicDescription now;
      if (physical_format(stream, &now) && now.mBitsPerChannel != t->original_format.mBitsPerChannel) {
        AudioStreamBasicDescription target = t->original_format;
        target.mSampleRate = t->original_rate > 0 ? t->original_rate : target.mSampleRate;
        AudioObjectSetPropertyData(stream, &a, 0, NULL, sizeof target, &target);
      }
    }
    if (t->original_rate > 0 && (int)(nominal_rate(t->device) + 0.5) != (int)(t->original_rate + 0.5)) {
      AudioObjectPropertyAddress a = address(kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal);
      AudioObjectSetPropertyData(t->device, &a, 0, NULL, sizeof t->original_rate, &t->original_rate);
      wait_until(rate_applied, t->device, &t->original_rate);
    }
  }
  g_touched_count = 0;
}

#endif /* CA_HAL_COREAUDIO */
