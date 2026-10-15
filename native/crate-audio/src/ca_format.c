/* Output format selection (plan §2.4): what rate, depth and channel count a
 * track should be delivered at on a given device. Pure and table-tested. */
#include "ca_internal.h"

#define CA_DSD_MAX_PCM_RATE 352800

static int rate_family(int rate) {
  if (rate % 44100 == 0) return 44100;
  if (rate % 48000 == 0) return 48000;
  if (rate % 11025 == 0) return 44100;
  if (rate % 8000 == 0) return 48000;
  return rate;
}

static int caps_index_of(const ca_device_caps *caps, int rate) {
  for (int i = 0; i < caps->count; i++) if (caps->rates[i] == rate) return i;
  return -1;
}

static int caps_max_rate(const ca_device_caps *caps) {
  int best = 0;
  for (int i = 0; i < caps->count; i++) if (caps->rates[i] > best) best = caps->rates[i];
  return best;
}

/* Best supported rate for a PCM source rate. */
static int pick_rate(const ca_device_caps *caps, int source) {
  if (caps->count <= 0) return caps->current_rate > 0 ? caps->current_rate : source;
  if (caps_index_of(caps, source) >= 0) return source;
  int family = rate_family(source);
  int max = caps_max_rate(caps);
  int best = 0;

  if (source > max) {
    /* Highest integer divisor of the source (192k -> 96k), then the highest
     * rate of the same family, then simply the highest rate. */
    for (int i = 0; i < caps->count; i++) {
      int r = caps->rates[i];
      if (r <= source && source % r == 0 && r > best) best = r;
    }
    if (best) return best;
    for (int i = 0; i < caps->count; i++) {
      int r = caps->rates[i];
      if (rate_family(r) == family && r > best) best = r;
    }
    return best ? best : max;
  }

  /* Smallest integer multiple (44.1k -> 88.2k), then the closest rate above
   * in the same family, then the closest rate above at all. */
  for (int i = 0; i < caps->count; i++) {
    int r = caps->rates[i];
    if (r > source && r % source == 0 && (!best || r < best)) best = r;
  }
  if (best) return best;
  for (int i = 0; i < caps->count; i++) {
    int r = caps->rates[i];
    if (r > source && rate_family(r) == family && (!best || r < best)) best = r;
  }
  if (best) return best;
  for (int i = 0; i < caps->count; i++) {
    int r = caps->rates[i];
    if (r > source && (!best || r < best)) best = r;
  }
  return best ? best : max;
}

/* DSD becomes PCM at the highest 44.1 kHz-family rate the DAC takes, up to
 * 352.8 kHz. */
static int pick_dsd_rate(const ca_device_caps *caps) {
  int best = 0;
  for (int i = 0; i < caps->count; i++) {
    int r = caps->rates[i];
    if (rate_family(r) == 44100 && r <= CA_DSD_MAX_PCM_RATE && r > best) best = r;
  }
  if (best) return best;
  for (int i = 0; i < caps->count; i++) {
    int r = caps->rates[i];
    if (r <= CA_DSD_MAX_PCM_RATE && r > best) best = r;
  }
  if (best) return best;
  return caps->count > 0 ? caps->rates[0] : (caps->current_rate > 0 ? caps->current_rate : 88200);
}

static int bits_at(const ca_device_caps *caps, int rate) {
  int index = caps_index_of(caps, rate);
  if (index >= 0 && caps->bits[index] > 0) return caps->bits[index];
  if (rate == caps->current_rate && caps->current_bits > 0) return caps->current_bits;
  return caps->current_bits > 0 ? caps->current_bits : 32;
}

CA_API int ca_choose_output_format(const ca_stream_info *source, const ca_device_caps *caps,
                                   const ca_output_policy *policy, ca_output_format *out) {
  if (!source || !caps || !policy || !out) return ca__fail(CA_ERR_INVALID_ARG, "ca_choose_output_format: NULL argument");
  memset(out, 0, sizeof *out);

  /* Channels: mono is duplicated to stereo; anything the DAC can't carry is
   * folded down to stereo. */
  int source_channels = source->source_channels > 0 ? source->source_channels : source->channels;
  int device_channels = caps->max_channels > 0 ? caps->max_channels : 2;
  if (source_channels <= 2) {
    out->channels = CA_MIN(2, device_channels);
  } else if (source_channels <= device_channels) {
    out->channels = source_channels;
  } else {
    out->channels = CA_MIN(2, device_channels);
    out->downmixed = 1;
    out->limited_by |= CA_LIMIT_DAC_CHANNELS;
  }
  if (out->channels < 1) out->channels = 1;

  /* Rate. */
  int ideal = source->is_dsd ? CA_MIN(CA_DSD_MAX_PCM_RATE, source->source_sample_rate / 8) : source->source_sample_rate;
  if (ideal <= 0) ideal = source->sample_rate;
  int current = caps->current_rate > 0 ? caps->current_rate : ideal;
  if (!policy->bit_perfect) {
    out->sample_rate = current;
    if (current != ideal) out->limited_by |= CA_LIMIT_SETTING_OFF;
  } else if (!caps->can_set_rate) {
    out->sample_rate = current;
    if (current != ideal) out->limited_by |= CA_LIMIT_FIXED_RATE;
  } else {
    out->sample_rate = source->is_dsd ? pick_dsd_rate(caps) : pick_rate(caps, ideal);
    if (out->sample_rate != ideal) out->limited_by |= CA_LIMIT_DAC_RATE;
  }
  out->resampled = out->sample_rate != ideal;

  /* Depth: the deepest the device offers at that rate. Dither whenever the
   * signal must be requantised to 16 bits or less. */
  out->bits = policy->bit_perfect || caps->current_bits <= 0 ? bits_at(caps, out->sample_rate) : caps->current_bits;
  int source_bits = source->is_dsd ? 24 : (source->is_float ? 32 : source->bits_per_sample);
  if (source_bits > out->bits && source->is_lossless) {
    out->limited_by |= CA_LIMIT_DAC_BITS;
  }
  if (out->bits <= 16 && (source_bits == 0 || source_bits > out->bits || out->resampled || source->is_dsd)) {
    out->dithered = 1;
  }
  return CA_OK;
}
