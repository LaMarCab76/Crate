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
