#include "ca_internal.h"

#include <stdio.h>

#include <libavutil/avutil.h>

#include "miniaudio.h"

static CA_THREAD_LOCAL char g_last_error[512];

int ca__fail(int code, const char *fmt, ...) {
  va_list args;
  va_start(args, fmt);
  vsnprintf(g_last_error, sizeof g_last_error, fmt, args);
  va_end(args);
  return code;
}

void ca__clear_error(void) {
  g_last_error[0] = '\0';
}

void ca__copy_string(char *dst, size_t dst_size, const char *src) {
  if (!dst || dst_size == 0) return;
  if (!src) src = "";
  size_t length = strlen(src);
  if (length >= dst_size) length = dst_size - 1;
  memcpy(dst, src, length);
  dst[length] = '\0';
}

CA_API const char *ca_last_error(void) {
  return g_last_error;
}

CA_API int ca_get_build_info(ca_build_info *out) {
  if (!out) return ca__fail(CA_ERR_INVALID_ARG, "ca_get_build_info: out is NULL");
  memset(out, 0, sizeof *out);
  out->api_version = CA_API_VERSION;
  ca__copy_string(out->version, sizeof out->version, CA_VERSION_STRING);
  ca__copy_string(out->ffmpeg_version, sizeof out->ffmpeg_version, av_version_info());
  ca__copy_string(out->ffmpeg_license, sizeof out->ffmpeg_license, avutil_license());
  ca__copy_string(out->miniaudio_version, sizeof out->miniaudio_version, MA_VERSION_STRING);
  return CA_OK;
}
