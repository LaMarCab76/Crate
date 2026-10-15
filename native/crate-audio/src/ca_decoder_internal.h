/* Decoder functions used by the playback engine but not exported. */
#ifndef CA_DECODER_INTERNAL_H
#define CA_DECODER_INTERNAL_H

#include "ca_internal.h"

/* Switches the decoder to interleaved float at a new rate/channel count and
 * re-seeks to the current position so no audio is skipped or repeated. */
int ca__decoder_set_output(ca_decoder *dec, int sample_rate, int channels);

int ca__decoder_lossless(const ca_decoder *dec);

#endif /* CA_DECODER_INTERNAL_H */
