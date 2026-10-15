/* FFmpeg-backed decoder: file or in-memory source -> interleaved float/s16. */
#include "ca_decoder_internal.h"

#include <limits.h>
#include <math.h>
#include <stdlib.h>

#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/channel_layout.h>
#include <libavutil/opt.h>
#include <libswresample/swresample.h>

#define CA_AVIO_BUFFER_SIZE (64 * 1024)
#define CA_DSD_DEFAULT_RATE 88200
/* BASSDSD applies +6 dB by default (BASS_CONFIG_DSD_GAIN); keep the same
 * loudness so DSD files don't suddenly play quieter than before. */
#define CA_DSD_GAIN 1.9952623149688795f
/* Lossy codecs need pre-roll after a seek (MDCT overlap, Opus' 80 ms). */
#define CA_LOSSY_SEEK_PREROLL_SEC 0.25
#define CA_MAX_CONSECUTIVE_ERRORS 64
#define CA_MAX_CHANNELS 64

struct ca_decoder {
  AVFormatContext *fmt;
  AVIOContext *avio;
  const uint8_t *mem_data;
  int64_t mem_size;
  int64_t mem_pos;

  AVCodecContext *codec;
  AVStream *stream;
  int stream_index;
  AVPacket *packet;
  AVFrame *frame;

  SwrContext *swr;
  int swr_in_rate;
  int swr_in_format;
  AVChannelLayout swr_in_layout;

  int out_rate;
  int out_channels;
  int out_format;
  float gain;
  int lossless;

  float *fifo;
  int64_t fifo_capacity;
  int64_t fifo_offset;
  int64_t fifo_count;

  int demux_eof;
  int decoder_eof;
  int finished;
  int consecutive_errors;

  int64_t discard_until;   /* source-rate sample index; INT64_MIN when not seeking */
  int64_t next_start;      /* expected start of the next decoded frame, INT64_MIN if unknown */
  int64_t start_ts;        /* stream start, stream time base */
  int64_t position;        /* output frames delivered */

  ca_stream_info info;
};

/* ------------------------------------------------------------ memory I/O */

static int mem_read(void *opaque, uint8_t *buf, int buf_size) {
  ca_decoder *d = opaque;
  int64_t remaining = d->mem_size - d->mem_pos;
  if (remaining <= 0) return AVERROR_EOF;
  int n = (int)CA_MIN((int64_t)buf_size, remaining);
  memcpy(buf, d->mem_data + d->mem_pos, (size_t)n);
  d->mem_pos += n;
  return n;
}

static int64_t mem_seek(void *opaque, int64_t offset, int whence) {
  ca_decoder *d = opaque;
  if (whence & AVSEEK_SIZE) return d->mem_size;
  whence &= ~AVSEEK_FORCE;
  int64_t base;
  switch (whence) {
    case SEEK_SET: base = 0; break;
    case SEEK_CUR: base = d->mem_pos; break;
    case SEEK_END: base = d->mem_size; break;
    default: return AVERROR(EINVAL);
  }
  int64_t target = base + offset;
  if (target < 0 || target > d->mem_size) return AVERROR(EINVAL);
  d->mem_pos = target;
  return target;
}

/* --------------------------------------------------------------- helpers */

static int is_dsd_codec(enum AVCodecID id) {
  return id == AV_CODEC_ID_DSD_LSBF || id == AV_CODEC_ID_DSD_MSBF ||
         id == AV_CODEC_ID_DSD_LSBF_PLANAR || id == AV_CODEC_ID_DSD_MSBF_PLANAR ||
         id == AV_CODEC_ID_DST;
}

static int is_float_pcm_codec(enum AVCodecID id) {
  return id == AV_CODEC_ID_PCM_F32LE || id == AV_CODEC_ID_PCM_F32BE ||
         id == AV_CODEC_ID_PCM_F64LE || id == AV_CODEC_ID_PCM_F64BE;
}

static void decoder_free(ca_decoder *d) {
  if (!d) return;
  swr_free(&d->swr);
  av_channel_layout_uninit(&d->swr_in_layout);
  av_frame_free(&d->frame);
  av_packet_free(&d->packet);
  avcodec_free_context(&d->codec);
  if (d->fmt) avformat_close_input(&d->fmt);
  if (d->avio) {
    av_freep(&d->avio->buffer);
    avio_context_free(&d->avio);
  }
  free(d->fifo);
  free(d);
}

static int fifo_reserve(ca_decoder *d, int64_t extra_frames) {
  int ch = d->out_channels;
  if (d->fifo_offset > 0) {
    if (d->fifo_count > 0) {
      memmove(d->fifo, d->fifo + d->fifo_offset * ch, (size_t)(d->fifo_count * ch) * sizeof(float));
    }
    d->fifo_offset = 0;
  }
  int64_t needed = d->fifo_count + extra_frames;
  if (needed <= d->fifo_capacity) return CA_OK;
  int64_t capacity = CA_MAX(needed, CA_MAX(d->fifo_capacity * 2, (int64_t)8192));
  float *grown = realloc(d->fifo, (size_t)(capacity * ch) * sizeof(float));
  if (!grown) return ca__fail(CA_ERR_NO_MEMORY, "decoder: out of memory growing the sample buffer");
  d->fifo = grown;
  d->fifo_capacity = capacity;
  return CA_OK;
}

static void input_layout_for(const AVChannelLayout *source, int channels, AVChannelLayout *out) {
  if (source && source->nb_channels == channels &&
      (source->order == AV_CHANNEL_ORDER_NATIVE || source->order == AV_CHANNEL_ORDER_UNSPEC)) {
    if (source->order == AV_CHANNEL_ORDER_NATIVE) {
      av_channel_layout_copy(out, source);
      return;
    }
  }
  av_channel_layout_default(out, channels);
}

/* (Re)creates the resampler whenever the decoded frame format changes. The
 * conversion is exact when only the sample format changes (int -> float). */
static int ensure_swr(ca_decoder *d, const AVFrame *frame) {
  int channels = frame->ch_layout.nb_channels;
  if (channels <= 0 || channels > CA_MAX_CHANNELS) {
    return ca__fail(CA_ERR_DECODE, "decoder: unsupported channel count %d", channels);
  }
  if (d->swr && d->swr_in_rate == frame->sample_rate && d->swr_in_format == frame->format &&
      av_channel_layout_compare(&d->swr_in_layout, &frame->ch_layout) == 0) {
    return CA_OK;
  }

  swr_free(&d->swr);
  av_channel_layout_uninit(&d->swr_in_layout);

  AVChannelLayout in_layout = {0};
  AVChannelLayout out_layout = {0};
  input_layout_for(&frame->ch_layout, channels, &in_layout);
  if (d->out_channels == channels) av_channel_layout_copy(&out_layout, &in_layout);
  else av_channel_layout_default(&out_layout, d->out_channels);

  int ret = swr_alloc_set_opts2(&d->swr, &out_layout, AV_SAMPLE_FMT_FLT, d->out_rate,
                                &in_layout, (enum AVSampleFormat)frame->format, frame->sample_rate, 0, NULL);
  if (ret >= 0) {
    /* Higher quality than the defaults; only matters when resampling. */
    av_opt_set_int(d->swr, "filter_size", 64, 0);
    av_opt_set_int(d->swr, "phase_shift", 12, 0);
    av_opt_set_int(d->swr, "linear_interp", 1, 0);
    /* Normalise downmix matrices so 5.1 -> stereo can't clip. */
    av_opt_set_double(d->swr, "rematrix_maxval", 1.0, 0);
    if (channels == 1 && d->out_channels >= 2) {
      /* Mono plays at full level on both front channels (FFmpeg's default
       * is -3 dB each), which keeps it bit-perfect. */
      double matrix[CA_MAX_CHANNELS] = {0};
      matrix[0] = 1.0;
      matrix[1] = 1.0;
      ret = swr_set_matrix(d->swr, matrix, 1);
    }
    if (ret >= 0) ret = swr_init(d->swr);
  }
  av_channel_layout_uninit(&in_layout);
  av_channel_layout_uninit(&out_layout);
  if (ret < 0) {
    swr_free(&d->swr);
    char message[128];
    av_strerror(ret, message, sizeof message);
    return ca__fail(CA_ERR_DECODE, "decoder: cannot configure the resampler (%s)", message);
  }

  d->swr_in_rate = frame->sample_rate;
  d->swr_in_format = frame->format;
  av_channel_layout_copy(&d->swr_in_layout, &frame->ch_layout);
  return CA_OK;
}

static void apply_gain(ca_decoder *d, int64_t first_frame, int64_t frames) {
  if (d->gain == 1.0f || frames <= 0) return;
  float *p = d->fifo + (d->fifo_offset + first_frame) * d->out_channels;
  int64_t samples = frames * d->out_channels;
  for (int64_t i = 0; i < samples; i++) p[i] *= d->gain;
}

static int convert_into_fifo(ca_decoder *d, const uint8_t **input, int input_frames) {
  int capacity = swr_get_out_samples(d->swr, input_frames);
  if (capacity < 0) capacity = input_frames;
  capacity += 32;
  int ret = fifo_reserve(d, capacity);
  if (ret != CA_OK) return ret;

  uint8_t *output = (uint8_t *)(d->fifo + (d->fifo_offset + d->fifo_count) * d->out_channels);
  int produced = swr_convert(d->swr, &output, capacity, input, input_frames);
  if (produced < 0) return ca__fail(CA_ERR_DECODE, "decoder: resampling failed");
  apply_gain(d, d->fifo_count, produced);
  d->fifo_count += produced;
  return CA_OK;
}

static int handle_frame(ca_decoder *d, AVFrame *frame) {
  int ret = ensure_swr(d, frame);
  if (ret != CA_OK) return ret;

  /* Decoders that split one packet into several frames (APE, for one) only
   * timestamp the first; continue from the previous frame for the rest. */
  int64_t start = INT64_MIN;
  int64_t pts = frame->best_effort_timestamp != AV_NOPTS_VALUE ? frame->best_effort_timestamp : frame->pts;
  if (pts != AV_NOPTS_VALUE && frame->sample_rate > 0) {
    start = av_rescale_q(pts, d->stream->time_base, (AVRational){1, frame->sample_rate});
  }
  if (d->next_start != INT64_MIN && (start == INT64_MIN || start < d->next_start)) start = d->next_start;
  d->next_start = start == INT64_MIN ? INT64_MIN : start + frame->nb_samples;

  int skip = 0;
  if (d->discard_until != INT64_MIN) {
    if (start == INT64_MIN) {
      d->discard_until = INT64_MIN;  /* no timestamps: best effort */
    } else {
      int64_t end = start + frame->nb_samples;
      if (end <= d->discard_until) return CA_OK;      /* entirely before the seek target */
      if (start < d->discard_until) skip = (int)(d->discard_until - start);
      d->discard_until = INT64_MIN;
    }
  }

  const uint8_t *planes[CA_MAX_CHANNELS];
  int channels = frame->ch_layout.nb_channels;
  int planar = av_sample_fmt_is_planar((enum AVSampleFormat)frame->format);
  int bytes = av_get_bytes_per_sample((enum AVSampleFormat)frame->format);
  int plane_count = planar ? channels : 1;
  for (int i = 0; i < plane_count; i++) {
    size_t offset = (size_t)skip * (size_t)bytes * (size_t)(planar ? 1 : channels);
    planes[i] = frame->extended_data[i] + offset;
  }
  return convert_into_fifo(d, planes, frame->nb_samples - skip);
}

static int flush_resampler(ca_decoder *d) {
  if (!d->swr) return CA_OK;
  return convert_into_fifo(d, NULL, 0);
}

/* Advances the decode pipeline by one step. Returns CA_OK (possibly without
 * producing frames) or a negative code on unrecoverable errors. */
static int decode_more(ca_decoder *d) {
  for (;;) {
    int ret = avcodec_receive_frame(d->codec, d->frame);
    if (ret >= 0) {
      d->consecutive_errors = 0;
      int handled = handle_frame(d, d->frame);
      av_frame_unref(d->frame);
      return handled;
    }
    if (ret == AVERROR_EOF) {
      d->decoder_eof = 1;
      int flushed = flush_resampler(d);
      d->finished = 1;
      return flushed;
    }
    if (ret != AVERROR(EAGAIN)) {
      if (++d->consecutive_errors > CA_MAX_CONSECUTIVE_ERRORS) {
        return ca__fail(CA_ERR_DECODE, "decoder: too many consecutive decode errors");
      }
      continue;
    }

    if (d->demux_eof) {
      /* The decoder wants input but the demuxer is done: drain it. */
      avcodec_send_packet(d->codec, NULL);
      continue;
    }

    ret = av_read_frame(d->fmt, d->packet);
    if (ret < 0) {
      if (ret != AVERROR_EOF && d->fmt->pb && d->fmt->pb->error < 0) {
        char message[128];
        av_strerror(d->fmt->pb->error, message, sizeof message);
        return ca__fail(CA_ERR_DECODE, "decoder: read error (%s)", message);
      }
      d->demux_eof = 1;
      avcodec_send_packet(d->codec, NULL);
      continue;
    }
    if (d->packet->stream_index != d->stream_index) {
      av_packet_unref(d->packet);
      continue;
    }
    ret = avcodec_send_packet(d->codec, d->packet);
    av_packet_unref(d->packet);
    if (ret < 0 && ret != AVERROR(EAGAIN)) {
      /* Corrupt packet: skip it, like BASS does, instead of failing. */
      if (++d->consecutive_errors > CA_MAX_CONSECUTIVE_ERRORS) {
        return ca__fail(CA_ERR_DECODE, "decoder: too many corrupt packets");
      }
    }
  }
}

static const char *short_format_name(const char *name, char *buffer, size_t size) {
  ca__copy_string(buffer, size, name);
  char *comma = strchr(buffer, ',');
  if (comma) *comma = '\0';
  return buffer;
}

/* VBR MP3 without a seek header only has a bitrate-based duration estimate.
 * Scanning the packets gives the exact length (and fills the generic index,
 * which also makes later seeks cheaper). */
static void measure_exact_duration(ca_decoder *d) {
  if (d->fmt->duration_estimation_method != AVFMT_DURATION_FROM_BITRATE && d->info.duration > 0) return;
  int64_t end = AV_NOPTS_VALUE;
  while (av_read_frame(d->fmt, d->packet) >= 0) {
    if (d->packet->stream_index == d->stream_index && d->packet->pts != AV_NOPTS_VALUE) {
      int64_t packet_end = d->packet->pts + d->packet->duration;
      if (end == AV_NOPTS_VALUE || packet_end > end) end = packet_end;
    }
    av_packet_unref(d->packet);
  }
  avformat_seek_file(d->fmt, d->stream_index, INT64_MIN, d->start_ts, d->start_ts, 0);
  avcodec_flush_buffers(d->codec);
  if (end != AV_NOPTS_VALUE && end > d->start_ts) {
    d->info.duration = (double)(end - d->start_ts) * av_q2d(d->stream->time_base);
  }
}

static int64_t read_mpc_varlen(const uint8_t *data, int size, int *offset) {
  int64_t value = 0;
  for (int i = 0; i < 9 && *offset < size; i++) {
    uint8_t byte = data[(*offset)++];
    value = (value << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) return value;
  }
  return -1;
}

/* FFmpeg rounds Musepack SV8 durations down to whole packets (up to 1.7 s),
 * so read the exact sample count from the stream header ("SH") ourselves. */
static double musepack8_duration(ca_decoder *d) {
  AVIOContext *pb = d->fmt->pb;
  int sample_rate = d->stream->codecpar->sample_rate;
  if (!pb || sample_rate <= 0) return -1;
  int64_t saved = avio_tell(pb);
  uint8_t header[1024];
  if (avio_seek(pb, 0, SEEK_SET) < 0) return -1;
  int size = avio_read(pb, header, sizeof header);
  avio_seek(pb, saved, SEEK_SET);
  if (size < 8 || memcmp(header, "MPCK", 4) != 0) return -1;

  int offset = 4;
  while (offset + 3 <= size) {
    int packet_start = offset;
    char key[2] = {(char)header[offset], (char)header[offset + 1]};
    offset += 2;
    int64_t packet_size = read_mpc_varlen(header, size, &offset);
    if (packet_size <= 0) return -1;
    if (key[0] == 'S' && key[1] == 'H') {
      offset += 5;  /* CRC32 + stream version */
      int64_t samples = read_mpc_varlen(header, size, &offset);
      int64_t silence = read_mpc_varlen(header, size, &offset);
      if (samples <= 0 || silence < 0 || silence >= samples) return -1;
      return (double)(samples - silence) / sample_rate;
    }
    offset = packet_start + (int)packet_size;
  }
  return -1;
}

static void fill_info(ca_decoder *d, const ca_decode_opts *opts) {
  AVCodecParameters *par = d->stream->codecpar;
  const AVCodecDescriptor *desc = avcodec_descriptor_get(par->codec_id);
  int dsd = is_dsd_codec(par->codec_id);
  int props = desc ? desc->props : 0;

  ca_stream_info *info = &d->info;
  info->is_dsd = dsd;
  info->source_channels = par->ch_layout.nb_channels;
  info->source_sample_rate = dsd ? par->sample_rate * 8 : par->sample_rate;

  d->lossless = dsd || par->codec_id == AV_CODEC_ID_WAVPACK ||
                ((props & AV_CODEC_PROP_LOSSLESS) && !(props & AV_CODEC_PROP_LOSSY));
  info->is_lossless = d->lossless;
  info->is_float = is_float_pcm_codec(par->codec_id) ||
                   (d->lossless && !dsd &&
                    (d->codec->sample_fmt == AV_SAMPLE_FMT_FLT || d->codec->sample_fmt == AV_SAMPLE_FMT_FLTP ||
                     d->codec->sample_fmt == AV_SAMPLE_FMT_DBL || d->codec->sample_fmt == AV_SAMPLE_FMT_DBLP));

  int bits = 0;
  if (dsd) bits = 1;
  else if (d->lossless) {
    if (d->codec->bits_per_raw_sample > 0) bits = d->codec->bits_per_raw_sample;
    else if (par->bits_per_raw_sample > 0) bits = par->bits_per_raw_sample;
    else if (av_get_bits_per_sample(par->codec_id) > 0) bits = av_get_bits_per_sample(par->codec_id);
    else if (par->bits_per_coded_sample > 0) bits = par->bits_per_coded_sample;
    else if (d->codec->sample_fmt != AV_SAMPLE_FMT_NONE) bits = av_get_bytes_per_sample(d->codec->sample_fmt) * 8;
  }
  info->bits_per_sample = bits;

  d->out_rate = opts && opts->sample_rate > 0 ? opts->sample_rate
                                               : (dsd ? CA_DSD_DEFAULT_RATE : par->sample_rate);
  d->out_channels = opts && opts->channels > 0 ? opts->channels : par->ch_layout.nb_channels;
  d->out_format = opts && opts->sample_format == CA_SAMPLE_S16 ? CA_SAMPLE_S16 : CA_SAMPLE_F32;
  d->gain = dsd ? CA_DSD_GAIN : 1.0f;
  info->sample_rate = d->out_rate;
  info->channels = d->out_channels;

  info->bit_rate = d->fmt->bit_rate > 0 ? d->fmt->bit_rate : par->bit_rate;
  info->duration = -1;
  if (d->stream->duration != AV_NOPTS_VALUE && d->stream->duration > 0) {
    info->duration = (double)d->stream->duration * av_q2d(d->stream->time_base);
  } else if (d->fmt->duration != AV_NOPTS_VALUE && d->fmt->duration > 0) {
    info->duration = (double)d->fmt->duration / AV_TIME_BASE;
  }

  if (par->codec_id == AV_CODEC_ID_MUSEPACK8) {
    double exact = musepack8_duration(d);
    if (exact > 0) info->duration = exact;
  }

  ca__copy_string(info->codec, sizeof info->codec, avcodec_get_name(par->codec_id));
  char format_name[64];
  ca__copy_string(info->container, sizeof info->container,
                  short_format_name(d->fmt->iformat ? d->fmt->iformat->name : "", format_name, sizeof format_name));
}

static void finish_info(ca_decoder *d) {
  if (d->info.duration > 0) d->info.frames = (int64_t)llround(d->info.duration * d->out_rate);
  else d->info.frames = -1;
}

static ca_decoder *open_common(ca_decoder *d, const char *url, const ca_decode_opts *opts) {
  av_log_set_level(AV_LOG_ERROR);
  d->discard_until = INT64_MIN;
  d->next_start = INT64_MIN;

  int ret = avformat_open_input(&d->fmt, url, NULL, NULL);
  if (ret < 0) {
    char message[128];
    av_strerror(ret, message, sizeof message);
    ca__fail(CA_ERR_OPEN, "cannot open input (%s)", message);
    decoder_free(d);
    return NULL;
  }
  ret = avformat_find_stream_info(d->fmt, NULL);
  if (ret < 0) {
    ca__fail(CA_ERR_OPEN, "cannot read stream information");
    decoder_free(d);
    return NULL;
  }

  const AVCodec *decoder = NULL;
  ret = av_find_best_stream(d->fmt, AVMEDIA_TYPE_AUDIO, -1, -1, &decoder, 0);
  if (ret < 0 || !decoder) {
    ca__fail(ret == AVERROR_DECODER_NOT_FOUND ? CA_ERR_UNSUPPORTED : CA_ERR_NO_AUDIO,
             ret == AVERROR_DECODER_NOT_FOUND ? "unsupported audio codec" : "no audio stream");
    decoder_free(d);
    return NULL;
  }
  d->stream_index = ret;
  d->stream = d->fmt->streams[ret];
  for (unsigned i = 0; i < d->fmt->nb_streams; i++) {
    if ((int)i != d->stream_index) d->fmt->streams[i]->discard = AVDISCARD_ALL;
  }

  d->codec = avcodec_alloc_context3(decoder);
  d->packet = av_packet_alloc();
  d->frame = av_frame_alloc();
  if (!d->codec || !d->packet || !d->frame) {
    ca__fail(CA_ERR_NO_MEMORY, "out of memory");
    decoder_free(d);
    return NULL;
  }
  ret = avcodec_parameters_to_context(d->codec, d->stream->codecpar);
  if (ret >= 0) {
    d->codec->pkt_timebase = d->stream->time_base;
    d->codec->thread_count = 1;
    ret = avcodec_open2(d->codec, decoder, NULL);
  }
  if (ret < 0) {
    char message[128];
    av_strerror(ret, message, sizeof message);
    ca__fail(CA_ERR_UNSUPPORTED, "cannot open the %s decoder (%s)", decoder->name, message);
    decoder_free(d);
    return NULL;
  }
  if (d->stream->codecpar->sample_rate <= 0 || d->stream->codecpar->ch_layout.nb_channels <= 0) {
    ca__fail(CA_ERR_NO_AUDIO, "audio stream has no sample rate or channels");
    decoder_free(d);
    return NULL;
  }
  if (d->stream->codecpar->ch_layout.nb_channels > CA_MAX_CHANNELS) {
    ca__fail(CA_ERR_UNSUPPORTED, "too many channels (%d)", d->stream->codecpar->ch_layout.nb_channels);
    decoder_free(d);
    return NULL;
  }

  d->start_ts = d->stream->start_time != AV_NOPTS_VALUE ? d->stream->start_time : 0;
  fill_info(d, opts);
  /* Unknown durations are always measured: the player needs one to seek. */
  if ((opts && (opts->flags & CA_DECODE_EXACT_DURATION)) || d->info.duration <= 0) measure_exact_duration(d);
  finish_info(d);

  if (d->out_rate <= 0 || d->out_channels <= 0 || d->out_channels > CA_MAX_CHANNELS) {
    ca__fail(CA_ERR_INVALID_ARG, "invalid output format (%d Hz, %d channels)", d->out_rate, d->out_channels);
    decoder_free(d);
    return NULL;
  }
  ca__clear_error();
  return d;
}

/* ------------------------------------------------------------ public API */

CA_API ca_decoder *ca_decoder_open_file(const char *utf8_path, const ca_decode_opts *opts) {
  if (!utf8_path || !*utf8_path) {
    ca__fail(CA_ERR_INVALID_ARG, "ca_decoder_open_file: empty path");
    return NULL;
  }
  ca_decoder *d = calloc(1, sizeof *d);
  if (!d) {
    ca__fail(CA_ERR_NO_MEMORY, "out of memory");
    return NULL;
  }
  /* The explicit file: scheme stops FFmpeg from treating "name:rest" paths
   * as protocol URLs. */
  size_t length = strlen(utf8_path);
  char *url = malloc(length + 6);
  if (!url) {
    free(d);
    ca__fail(CA_ERR_NO_MEMORY, "out of memory");
    return NULL;
  }
  memcpy(url, "file:", 5);
  memcpy(url + 5, utf8_path, length + 1);
  ca_decoder *opened = open_common(d, url, opts);
  free(url);
  return opened;
}

CA_API ca_decoder *ca_decoder_open_memory(const void *data, int64_t size, const char *name_hint,
                                          const ca_decode_opts *opts) {
  if (!data || size <= 0) {
    ca__fail(CA_ERR_INVALID_ARG, "ca_decoder_open_memory: empty buffer");
    return NULL;
  }
  ca_decoder *d = calloc(1, sizeof *d);
  if (!d) {
    ca__fail(CA_ERR_NO_MEMORY, "out of memory");
    return NULL;
  }
  d->mem_data = data;
  d->mem_size = size;

  unsigned char *buffer = av_malloc(CA_AVIO_BUFFER_SIZE);
  d->fmt = avformat_alloc_context();
  if (buffer) d->avio = avio_alloc_context(buffer, CA_AVIO_BUFFER_SIZE, 0, d, mem_read, NULL, mem_seek);
  if (!buffer || !d->fmt || !d->avio) {
    if (!d->avio) av_free(buffer);
    ca__fail(CA_ERR_NO_MEMORY, "out of memory");
    decoder_free(d);
    return NULL;
  }
  d->fmt->pb = d->avio;
  d->fmt->flags |= AVFMT_FLAG_CUSTOM_IO;
  return open_common(d, name_hint ? name_hint : "", opts);
}

CA_API int ca_decoder_get_info(const ca_decoder *d, ca_stream_info *out) {
  if (!d || !out) return ca__fail(CA_ERR_INVALID_ARG, "ca_decoder_get_info: NULL argument");
  *out = d->info;
  return CA_OK;
}

CA_API int64_t ca_decoder_read(ca_decoder *d, void *out, int64_t max_frames) {
  if (!d || (!out && max_frames > 0) || max_frames < 0) {
    return ca__fail(CA_ERR_INVALID_ARG, "ca_decoder_read: invalid arguments");
  }
  int ch = d->out_channels;
  int64_t done = 0;
  while (done < max_frames) {
    if (d->fifo_count > 0) {
      int64_t n = CA_MIN(d->fifo_count, max_frames - done);
      const float *src = d->fifo + d->fifo_offset * ch;
      if (d->out_format == CA_SAMPLE_F32) {
        memcpy((float *)out + done * ch, src, (size_t)(n * ch) * sizeof(float));
      } else {
        /* Truncate like BASS (an arithmetic shift for 24-bit sources), so
         * Chromaprint fingerprints match the ones BASS produced. */
        int16_t *dst = (int16_t *)out + done * ch;
        int64_t samples = n * ch;
        for (int64_t i = 0; i < samples; i++) {
          float v = floorf(src[i] * 32768.0f);
          if (v > 32767.0f) v = 32767.0f;
          else if (v < -32768.0f) v = -32768.0f;
          dst[i] = (int16_t)v;
        }
      }
      d->fifo_offset += n;
      d->fifo_count -= n;
      d->position += n;
      done += n;
      continue;
    }
    if (d->finished) break;
    int ret = decode_more(d);
    if (ret < 0) {
      if (done > 0) break;  /* hand out what we have; the error repeats next call */
      return ret;
    }
  }
  return done;
}

CA_API int ca_decoder_seek(ca_decoder *d, double seconds) {
  if (!d || !isfinite(seconds)) return ca__fail(CA_ERR_INVALID_ARG, "ca_decoder_seek: invalid arguments");
  if (seconds < 0) seconds = 0;
  if (d->info.duration > 0 && seconds > d->info.duration) seconds = d->info.duration;

  AVRational tb = d->stream->time_base;
  int64_t target_ts = d->start_ts + (int64_t)llround(seconds / av_q2d(tb));
  double preroll = d->lossless ? 0.0 : CA_LOSSY_SEEK_PREROLL_SEC;
  if (d->stream->codecpar->seek_preroll > 0 && d->stream->codecpar->sample_rate > 0) {
    preroll = CA_MAX(preroll, (double)d->stream->codecpar->seek_preroll / d->stream->codecpar->sample_rate);
  }
  int64_t seek_ts = target_ts - (int64_t)llround(preroll / av_q2d(tb));
  if (seek_ts < d->start_ts) seek_ts = d->start_ts;

  int ret = avformat_seek_file(d->fmt, d->stream_index, INT64_MIN, seek_ts, seek_ts, 0);
  if (ret < 0) {
    /* Fall back to the start and decode forward to the target. */
    ret = avformat_seek_file(d->fmt, d->stream_index, INT64_MIN, d->start_ts, d->start_ts, 0);
    if (ret < 0) ret = av_seek_frame(d->fmt, d->stream_index, d->start_ts, AVSEEK_FLAG_BACKWARD);
    if (ret < 0) return ca__fail(CA_ERR_SEEK, "seek failed");
  }

  avcodec_flush_buffers(d->codec);
  swr_free(&d->swr);
  av_channel_layout_uninit(&d->swr_in_layout);
  d->fifo_offset = 0;
  d->fifo_count = 0;
  d->demux_eof = 0;
  d->decoder_eof = 0;
  d->finished = 0;
  d->consecutive_errors = 0;
  int source_rate = d->codec->sample_rate > 0 ? d->codec->sample_rate : d->stream->codecpar->sample_rate;
  d->discard_until = av_rescale_q(target_ts, tb, (AVRational){1, source_rate});
  d->next_start = INT64_MIN;
  d->position = (int64_t)llround(seconds * d->out_rate);
  return CA_OK;
}

CA_API double ca_decoder_get_position(const ca_decoder *d) {
  if (!d || d->out_rate <= 0) return 0.0;
  return (double)d->position / d->out_rate;
}

CA_API void ca_decoder_close(ca_decoder *d) {
  decoder_free(d);
}

/* ------------------------------------------------- engine-internal API */

int ca__decoder_set_output(ca_decoder *d, int sample_rate, int channels) {
  if (!d || sample_rate <= 0 || channels <= 0 || channels > CA_MAX_CHANNELS) {
    return ca__fail(CA_ERR_INVALID_ARG, "invalid decoder output format");
  }
  if (d->out_rate == sample_rate && d->out_channels == channels) return CA_OK;
  double position = ca_decoder_get_position(d);
  free(d->fifo);
  d->fifo = NULL;
  d->fifo_capacity = 0;
  d->out_rate = sample_rate;
  d->out_channels = channels;
  d->out_format = CA_SAMPLE_F32;
  d->info.sample_rate = sample_rate;
  d->info.channels = channels;
  finish_info(d);
  return ca_decoder_seek(d, position);
}

int ca__decoder_lossless(const ca_decoder *d) {
  return d ? d->lossless : 0;
}
