/* The single translation unit that compiles miniaudio. Only the low-level
 * device API is used: decoding, the node graph and the high-level engine are
 * compiled out, and so are the legacy Windows backends (WASAPI only). */
#define MA_NO_DECODING
#define MA_NO_ENCODING
#define MA_NO_GENERATION
#define MA_NO_RESOURCE_MANAGER
#define MA_NO_NODE_GRAPH
#define MA_NO_ENGINE
#define MA_NO_DSOUND
#define MA_NO_WINMM
#define MA_NO_SNDIO
#define MA_NO_AUDIO4
#define MA_NO_OSS
#define MA_NO_AAUDIO
#define MA_NO_OPENSL
#define MA_NO_WEBAUDIO
#if defined(__APPLE__)
/* Link CoreAudio directly instead of dlopen()ing it at runtime. */
#  define MA_NO_RUNTIME_LINKING
#endif
#define MINIAUDIO_IMPLEMENTATION
#include "miniaudio.h"

#include "ca_wasapi.h"

#if defined(_WIN32)

#include <objbase.h>

void ca__platform_thread_init(void) {
  /* S_FALSE (already initialised) and RPC_E_CHANGED_MODE are both fine. */
  CoInitializeEx(NULL, COINIT_MULTITHREADED);
}

int ca__wasapi_exclusive_caps(ma_context *context, const ma_device_id *id, ca_device_caps *caps) {
  static const ma_uint32 rates[] = {44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000, 705600, 768000, 32000, 22050, 16000, 11025, 8000};
  static const struct { WORD bits; WORD valid; } depths[] = {{32, 32}, {32, 24}, {24, 24}, {16, 16}};
  ma_IMMDevice *device = NULL;
  ma_IAudioClient *client = NULL;
  MA_WAVEFORMATEX *mix = NULL;
  ma_uint32 channels = 2;
  ma_channel channel_map[MA_MAX_CHANNELS];

  ca__platform_thread_init();
  if (ma_context_get_MMDevice__wasapi(context, ma_device_type_playback, id, &device) != MA_SUCCESS) return 0;
  if (FAILED(ma_IMMDevice_Activate(device, &MA_IID_IAudioClient, CLSCTX_ALL, NULL, (void **)&client))) {
    ma_IMMDevice_Release(device);
    return 0;
  }
  if (SUCCEEDED(ma_IAudioClient_GetMixFormat(client, &mix)) && mix) {
    channels = mix->nChannels > 0 ? mix->nChannels : 2;
    caps->current_rate = (int32_t)mix->nSamplesPerSec;
    ma_CoTaskMemFree(context, mix);
  }
  if (channels > MA_MAX_CHANNELS) channels = MA_MAX_CHANNELS;
  ma_channel_map_init_standard(ma_standard_channel_map_microsoft, channel_map, ma_countof(channel_map), channels);

  caps->count = 0;
  for (size_t r = 0; r < sizeof rates / sizeof rates[0] && caps->count < CA_MAX_RATES; r++) {
    int best = 0;
    uint32_t accepted = 0;
    for (size_t d = 0; d < sizeof depths / sizeof depths[0]; d++) {
      MA_WAVEFORMATEXTENSIBLE wf;
      MA_ZERO_OBJECT(&wf);
      wf.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
      wf.nChannels = (WORD)channels;
      wf.nSamplesPerSec = rates[r];
      wf.wBitsPerSample = depths[d].bits;
      wf.nBlockAlign = (WORD)(channels * depths[d].bits / 8);
      wf.nAvgBytesPerSec = wf.nBlockAlign * wf.nSamplesPerSec;
      wf.cbSize = 22;
      wf.Samples.wValidBitsPerSample = depths[d].valid;
      wf.dwChannelMask = ma_channel_map_to_channel_mask__win32(channel_map, channels);
      wf.SubFormat = MA_GUID_KSDATAFORMAT_SUBTYPE_PCM;
      if (ma_IAudioClient_IsFormatSupported(client, MA_AUDCLNT_SHAREMODE_EXCLUSIVE, (MA_WAVEFORMATEX *)&wf, NULL) == S_OK) {
        if ((int)depths[d].valid > best) best = depths[d].valid;
        accepted |= CA_DEPTH_BIT(depths[d].valid);
      }
    }
    if (best > 0) {
      int i = caps->count++;
      while (i > 0 && caps->rates[i - 1] > (int32_t)rates[r]) {
        caps->rates[i] = caps->rates[i - 1];
        caps->bits[i] = caps->bits[i - 1];
        caps->depths[i] = caps->depths[i - 1];
        i--;
      }
      caps->rates[i] = (int32_t)rates[r];
      caps->bits[i] = best;
      caps->depths[i] = accepted;
    }
  }
  caps->max_channels = (int32_t)channels;
  caps->can_set_rate = 1;
  caps->exclusive = 1;
  for (int i = 0; i < caps->count; i++) {
    if (caps->rates[i] == caps->current_rate) caps->current_bits = caps->bits[i];
  }
  ma_IAudioClient_Release(client);
  ma_IMMDevice_Release(device);
  return caps->count > 0;
}

#else

void ca__platform_thread_init(void) {}

#endif
