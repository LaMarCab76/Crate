// Source patches applied to the pinned miniaudio.h by build-crate-audio.mjs.
// Each `find` must occur exactly once, so an upstream change fails the build
// instead of silently skipping a patch.
//
// WASAPI exclusive format: miniaudio always opens exclusive streams in the
// device's default format (Sound settings > Advanced). For bit-perfect output
// Crate needs the track's rate and depth, so the requested format is tried
// first — 32-bit, 24-in-32, packed 24, 16-bit or float — and the default is
// only used when the device refuses all of them.

export const MINIAUDIO_PATCHES = Object.freeze([
  {
    name: 'wasapi-exclusive-requested-format-helper',
    find: 'static ma_result ma_device_init_internal__wasapi(ma_context* pContext, ma_device_type deviceType, const ma_device_id* pDeviceID, ma_device_init_internal_data__wasapi* pData)\n{',
    replace: `/* crate-audio patch: try the caller's format in exclusive mode first. */
static ma_bool32 ma_crate_try_exclusive_format(ma_device_init_internal_data__wasapi* pData, MA_WAVEFORMATEXTENSIBLE* pOut)
{
    ma_uint16 bits[3];
    ma_uint16 valid[3];
    ma_bool32 isFloat = MA_FALSE;
    int count = 0;
    int i;
    ma_uint32 channels;
    ma_channel channelMap[MA_MAX_CHANNELS];

    if (pData->pAudioClient == NULL || pData->formatIn == ma_format_unknown || pData->channelsIn == 0 || pData->sampleRateIn == 0) {
        return MA_FALSE;
    }
    switch (pData->formatIn) {
        case ma_format_f32: bits[count] = 32; valid[count] = 32; count++; isFloat = MA_TRUE; break;
        case ma_format_s32:
        case ma_format_s24:
            bits[count] = 32; valid[count] = 32; count++;
            bits[count] = 32; valid[count] = 24; count++;
            bits[count] = 24; valid[count] = 24; count++;
            break;
        case ma_format_s16: bits[count] = 16; valid[count] = 16; count++; break;
        default: return MA_FALSE;
    }

    channels = pData->channelsIn > MA_MAX_CHANNELS ? MA_MAX_CHANNELS : pData->channelsIn;
    ma_channel_map_init_standard(ma_standard_channel_map_microsoft, channelMap, ma_countof(channelMap), channels);
    for (i = 0; i < count; i++) {
        MA_WAVEFORMATEXTENSIBLE wf;
        MA_ZERO_OBJECT(&wf);
        wf.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
        wf.nChannels = (WORD)channels;
        wf.nSamplesPerSec = pData->sampleRateIn;
        wf.wBitsPerSample = bits[i];
        wf.nBlockAlign = (WORD)(channels * bits[i] / 8);
        wf.nAvgBytesPerSec = wf.nBlockAlign * wf.nSamplesPerSec;
        wf.cbSize = 22;
        wf.Samples.wValidBitsPerSample = valid[i];
        wf.dwChannelMask = ma_channel_map_to_channel_mask__win32(channelMap, channels);
        wf.SubFormat = isFloat ? MA_GUID_KSDATAFORMAT_SUBTYPE_IEEE_FLOAT : MA_GUID_KSDATAFORMAT_SUBTYPE_PCM;
        if (ma_IAudioClient_IsFormatSupported((ma_IAudioClient*)pData->pAudioClient, MA_AUDCLNT_SHAREMODE_EXCLUSIVE, (MA_WAVEFORMATEX*)&wf, NULL) == S_OK) {
            *pOut = wf;
            return MA_TRUE;
        }
    }
    return MA_FALSE;
}

static ma_result ma_device_init_internal__wasapi(ma_context* pContext, ma_device_type deviceType, const ma_device_id* pDeviceID, ma_device_init_internal_data__wasapi* pData)
{`,
  },
  {
    name: 'wasapi-exclusive-requested-format-use',
    find: `        /* In exclusive mode on desktop we always use the backend's native format. */
        ma_IPropertyStore* pStore = NULL;
        hr = ma_IMMDevice_OpenPropertyStore(pDeviceInterface, STGM_READ, &pStore);
        if (SUCCEEDED(hr)) {`,
    replace: `        /* In exclusive mode on desktop we always use the backend's native format. */
        /* crate-audio patch: unless the device accepts the requested one. */
        ma_IPropertyStore* pStore = NULL;
        ma_bool32 crateRequestedFormat = ma_crate_try_exclusive_format(pData, &wf);
        hr = crateRequestedFormat ? S_OK : ma_IMMDevice_OpenPropertyStore(pDeviceInterface, STGM_READ, &pStore);
        if (!crateRequestedFormat && SUCCEEDED(hr)) {`,
  },
])

export function applyMiniaudioPatches(source) {
  let patched = source
  for (const patch of MINIAUDIO_PATCHES) {
    const first = patched.indexOf(patch.find)
    if (first < 0 || patched.indexOf(patch.find, first + 1) >= 0) {
      throw new Error(`miniaudio patch "${patch.name}" does not match exactly once`)
    }
    patched = patched.slice(0, first) + patch.replace + patched.slice(first + patch.find.length)
  }
  return patched
}
