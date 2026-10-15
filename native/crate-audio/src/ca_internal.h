/* Internal helpers shared by the crate_audio translation units. */
#ifndef CA_INTERNAL_H
#define CA_INTERNAL_H

#include "crate_audio.h"

#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define CA_VERSION_STRING "1.0.0"

#if defined(_MSC_VER)
#  define CA_THREAD_LOCAL __declspec(thread)
#else
#  define CA_THREAD_LOCAL _Thread_local
#endif

#define CA_MIN(a, b) ((a) < (b) ? (a) : (b))
#define CA_MAX(a, b) ((a) > (b) ? (a) : (b))
#define CA_CLAMP(v, lo, hi) CA_MIN(CA_MAX((v), (lo)), (hi))

/* Stores a printf-style message as the calling thread's last error and
 * returns `code` so call sites can `return ca__fail(CA_ERR_X, "...")`. */
int ca__fail(int code, const char *fmt, ...);
void ca__clear_error(void);

/* Copies src into a fixed-size char array, always NUL-terminated. */
void ca__copy_string(char *dst, size_t dst_size, const char *src);

#endif /* CA_INTERNAL_H */
