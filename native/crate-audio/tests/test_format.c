/* Table tests for ca_choose_output_format with simulated DACs (plan §2.4). */
#include "test.h"

#include <string.h>

#include "crate_audio.h"

#define D16 CA_DEPTH_BIT(16)
#define D24 CA_DEPTH_BIT(24)
#define D32 CA_DEPTH_BIT(32)

/* `bits` is the deepest format; `depths` every one the DAC takes (0 = unknown). */
static ca_device_caps make_caps(const int *rates, int count, int bits, uint32_t depths, int channels, int current, int can_set) {
  ca_device_caps caps;
  memset(&caps, 0, sizeof caps);
  for (int i = 0; i < count; i++) {
    caps.rates[i] = rates[i];
    caps.bits[i] = bits;
    caps.depths[i] = depths;
  }
  caps.count = count;
  caps.max_channels = channels;
  caps.current_rate = current;
  caps.current_bits = bits;
  caps.can_set_rate = can_set;
  return caps;
}

static ca_stream_info pcm(int rate, int bits, int channels, int lossless) {
  ca_stream_info info;
  memset(&info, 0, sizeof info);
  info.sample_rate = rate;
  info.source_sample_rate = rate;
  info.channels = channels;
  info.source_channels = channels;
  info.bits_per_sample = lossless ? bits : 0;
  info.is_lossless = lossless;
  return info;
}

static ca_stream_info float_pcm(int rate) {
  ca_stream_info info = pcm(rate, 32, 2, 1);
  info.is_float = 1;
  return info;
}

static ca_stream_info dsd(int dsd_rate) {
  ca_stream_info info = pcm(88200, 1, 2, 1);
  info.source_sample_rate = dsd_rate;
  info.is_dsd = 1;
  return info;
}

typedef struct {
  const char *label;
  ca_stream_info source;
  const ca_device_caps *caps;
  int bit_perfect;
  int rate, bits, channels, resampled, dithered, downmixed, limited_by;
} format_case;

static void check_case(const format_case *tc) {
  ca_output_policy policy = {0, tc->bit_perfect};
  ca_output_format out;
  CHECK(ca_choose_output_format(&tc->source, tc->caps, &policy, &out) == CA_OK, "%s: call", tc->label);
  CHECK(out.sample_rate == tc->rate, "%s: rate %d, expected %d", tc->label, out.sample_rate, tc->rate);
  CHECK(out.bits == tc->bits, "%s: bits %d, expected %d", tc->label, out.bits, tc->bits);
  CHECK(out.channels == tc->channels, "%s: channels %d, expected %d", tc->label, out.channels, tc->channels);
  CHECK(out.resampled == tc->resampled, "%s: resampled %d", tc->label, out.resampled);
  CHECK(out.dithered == tc->dithered, "%s: dithered %d", tc->label, out.dithered);
  CHECK(out.downmixed == tc->downmixed, "%s: downmixed %d", tc->label, out.downmixed);
  CHECK(out.limited_by == tc->limited_by, "%s: limited_by 0x%x, expected 0x%x", tc->label, out.limited_by, tc->limited_by);
}

void run_format_tests(void) {
  static const int USB96[] = {44100, 48000, 88200, 96000};
  static const int USB384[] = {44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000};
  static const int BT[] = {48000};
  static const int AIRPLAY[] = {44100};
  static const int FAMILY48[] = {48000, 96000, 192000};
  ca_device_caps usb96 = make_caps(USB96, 4, 24, D16 | D24, 2, 48000, 1);
  ca_device_caps usb384 = make_caps(USB384, 8, 32, D16 | D24 | D32, 2, 44100, 1);
  ca_device_caps only24 = make_caps(USB96, 4, 24, D24, 2, 48000, 1);
  ca_device_caps only16_32 = make_caps(USB96, 4, 32, D16 | D32, 2, 48000, 1);
  ca_device_caps unknown_depths = make_caps(USB96, 4, 24, 0, 2, 48000, 1);
  ca_device_caps bluetooth = make_caps(BT, 1, 16, D16, 2, 48000, 1);
  ca_device_caps airplay = make_caps(AIRPLAY, 1, 16, D16, 2, 44100, 1);
  ca_device_caps family48 = make_caps(FAMILY48, 3, 24, D16 | D24, 2, 48000, 1);
  ca_device_caps windows_shared = make_caps(BT, 1, 32, D32, 2, 48000, 0);
  ca_device_caps surround = make_caps(USB96, 4, 24, D16 | D24, 8, 48000, 1);

  const format_case cases[] = {
    /* Bit-perfect: the device gets exactly the track's rate and depth. */
    {"16/44.1 on USB 16-24/96 is bit-perfect", pcm(44100, 16, 2, 1), &usb96, 1, 44100, 16, 2, 0, 0, 0, 0},
    {"24/88.2 on USB 16-24/96 is bit-perfect", pcm(88200, 24, 2, 1), &usb96, 1, 88200, 24, 2, 0, 0, 0, 0},
    {"24/192 on USB 32/384 stays 24 bits", pcm(192000, 24, 2, 1), &usb384, 1, 192000, 24, 2, 0, 0, 0, 0},
    {"16/44.1 on AirPlay is bit-perfect", pcm(44100, 16, 2, 1), &airplay, 1, 44100, 16, 2, 0, 0, 0, 0},
    {"5.1 on an 8-channel DAC", pcm(48000, 24, 6, 1), &surround, 1, 48000, 24, 6, 0, 0, 0, 0},
    /* A deeper format keeps every bit but is not bit-perfect. */
    {"16/44.1 on a 24-bit-only DAC -> 24", pcm(44100, 16, 2, 1), &only24, 1, 44100, 24, 2, 0, 0, 0, CA_LIMIT_DAC_BITS},
    {"24/44.1 on a 16/32 DAC -> 32", pcm(44100, 24, 2, 1), &only16_32, 1, 44100, 32, 2, 0, 0, 0, CA_LIMIT_DAC_BITS},
    {"16/44.1 with unknown depths -> deepest", pcm(44100, 16, 2, 1), &unknown_depths, 1, 44100, 24, 2, 0, 0, 0, CA_LIMIT_DAC_BITS},
    /* The DAC tops out below the track. */
    {"24/192 on USB 16-24/96 -> 96k", pcm(192000, 24, 2, 1), &usb96, 1, 96000, 24, 2, 1, 0, 0, CA_LIMIT_DAC_RATE},
    {"32f/352.8 on USB 16-24/96 -> 88.2k", float_pcm(352800), &usb96, 1, 88200, 24, 2, 1, 0, 0, CA_LIMIT_DAC_RATE | CA_LIMIT_DAC_BITS},
    {"DSD64 on USB 16-24/96 -> 88.2k", dsd(2822400), &usb96, 1, 88200, 24, 2, 1, 0, 0, CA_LIMIT_DAC_RATE},
    {"5.1 on a stereo DAC", pcm(48000, 24, 6, 1), &usb96, 1, 48000, 24, 2, 0, 0, 1, CA_LIMIT_DAC_CHANNELS},
    {"lossy 44.1 on USB 16-24/96 -> deepest", pcm(44100, 0, 2, 0), &usb96, 1, 44100, 24, 2, 0, 0, 0, 0},
    {"mono 22.05 -> 44.1 stereo at the deepest", pcm(22050, 16, 1, 1), &usb96, 1, 44100, 24, 2, 1, 0, 0, CA_LIMIT_DAC_RATE},
    {"DSD128 on USB 32/384", dsd(5644800), &usb384, 1, 352800, 32, 2, 0, 0, 0, 0},
    {"32f/96 on USB 32/384", float_pcm(96000), &usb384, 1, 96000, 32, 2, 0, 0, 0, 0},
    {"16/44.1 on Bluetooth 16/48", pcm(44100, 16, 2, 1), &bluetooth, 1, 48000, 16, 2, 1, 1, 0, CA_LIMIT_DAC_RATE},
    {"24/88.2 on Bluetooth 16/48", pcm(88200, 24, 2, 1), &bluetooth, 1, 48000, 16, 2, 1, 1, 0, CA_LIMIT_DAC_RATE | CA_LIMIT_DAC_BITS},
    {"24/44.1 on AirPlay is dithered", pcm(44100, 24, 2, 1), &airplay, 1, 44100, 16, 2, 0, 1, 0, CA_LIMIT_DAC_BITS},
    {"24/192 on AirPlay", pcm(192000, 24, 2, 1), &airplay, 1, 44100, 16, 2, 1, 1, 0, CA_LIMIT_DAC_RATE | CA_LIMIT_DAC_BITS},
    {"lossy on AirPlay is dithered", pcm(44100, 0, 2, 0), &airplay, 1, 44100, 16, 2, 0, 1, 0, 0},
    {"16/44.1 on a 48k-family DAC", pcm(44100, 16, 2, 1), &family48, 1, 48000, 24, 2, 1, 0, 0, CA_LIMIT_DAC_RATE},
    {"24/88.2 on a 48k-family DAC", pcm(88200, 24, 2, 1), &family48, 1, 96000, 24, 2, 1, 0, 0, CA_LIMIT_DAC_RATE},
    /* The format can't follow the track. */
    {"Windows shared mode keeps the mix rate", pcm(44100, 16, 2, 1), &windows_shared, 1, 48000, 32, 2, 1, 0, 0, CA_LIMIT_FIXED_RATE},
    {"Windows shared mode, same rate, other depth", pcm(48000, 16, 2, 1), &windows_shared, 1, 48000, 32, 2, 0, 0, 0, CA_LIMIT_FIXED_RATE},
    {"bit-perfect off keeps the device rate", pcm(44100, 16, 2, 1), &usb96, 0, 48000, 24, 2, 1, 0, 0, CA_LIMIT_SETTING_OFF},
    {"bit-perfect off, same rate, other depth", pcm(48000, 16, 2, 1), &usb96, 0, 48000, 24, 2, 0, 0, 0, CA_LIMIT_SETTING_OFF},
    {"bit-perfect off, same format", pcm(48000, 24, 2, 1), &usb96, 0, 48000, 24, 2, 0, 0, 0, 0},
  };
  for (size_t i = 0; i < sizeof cases / sizeof cases[0]; i++) check_case(&cases[i]);
}
