# Plan: reemplazar BASS por FFmpeg + miniaudio

Estado: **en implementación** en la rama `feat/ffmpeg-audio-engine`. Este
documento es la referencia de trabajo para la migración; se actualiza al
cerrar cada fase (ver §6).

## 0. Decisiones tomadas

| Tema | Decisión |
|---|---|
| Transición | Reemplazo total. Todo se hace en la rama `feat/ffmpeg-audio-engine` y se integra a `main` cuando BASS ya no queda en ningún lado. No hay doble motor. |
| Decodificación | FFmpeg (libavformat + libavcodec + libswresample) compilado como LGPL, solo audio. |
| Salida | miniaudio (dominio público / MIT-0) más código propio de HAL CoreAudio y WASAPI para frecuencia, formato y exclusivo. |
| Bit-perfect | **Interruptor en Ajustes → Audio**, encendido por defecto. Encendido: el dispositivo se adapta a la frecuencia y la profundidad de cada pista, también en modo compartido, **hasta donde llegue el DAC** (§1 y §2.4). Apagado: el dispositivo queda en su frecuencia actual y se remuestrea todo, como hoy con BASS. |
| Exclusivo | macOS (hog, ya existe) y **Windows WASAPI exclusivo** (nuevo). Linux sin exclusivo. Es independiente del interruptor de bit-perfect. |
| Pruebas con audio real | Solo macOS Apple Silicon, más el slice x64 bajo Rosetta. Windows y Linux se prueban por CI, sin dispositivo de audio. |
| Formatos | Los 16 actuales: flac, m4a, mp3, wav, aiff/aif, ogg, opus, ape, wv, tta, dsf, dff, webm, mpc, spx. Se eliminan `bassmidi` y `basshls`, que no se usan. |
| DSD | Se sigue convirtiendo a PCM, como hoy. DoP queda fuera de alcance. |

### Supuestos por defecto (vetables)

- **Bit-perfect no bloquea el procesamiento:** EQ, volumen y nivelador siguen disponibles. El indicador de salida avisa cuando alguno impide el bit-perfect estricto.
- **Restaurar la frecuencia original** del dispositivo en dos momentos: al apagar el interruptor y al cerrar la app (macOS).
- **Frecuencia para DSD:** el múltiplo de 44,1 kHz más alto que soporte el DAC, hasta 352,8 kHz, con la ganancia calibrada contra BASS (hoy BASSDSD aplica +6 dB).
- **Versión:** la migración sale como 0.7.0.

## 1. Limitaciones de bit-perfect

- **El DAC pone el techo.** Si no soporta la frecuencia, la profundidad o los canales de la pista, se usa lo mejor que tenga (§2.4) y el indicador explica qué lo limitó. Ejemplos:
  - un 24/192 en un DAC USB de 96 kHz;
  - un FLAC de 24 bits en auriculares Bluetooth de 16 bits / 48 kHz;
  - AirPlay, fijo a 44,1 kHz;
  - DSD256 en un DAC de 192 kHz.
- **Windows, modo compartido:** no existe API pública para cambiar el formato de mezcla. En compartido se remuestrea al formato configurado en Windows; bit-perfect real solo se logra con WASAPI exclusivo. La UI lo avisa.
- **Linux:** best-effort. Se pide la frecuencia de la pista, pero PipeWire o PulseAudio deciden según su configuración (`default.clock.allowed-rates`).
- **Gapless entre frecuencias distintas:** si la pista siguiente tiene otra frecuencia, hay que reconfigurar el dispositivo y queda un hueco de unos 100–300 ms en ese borde. Entre pistas de igual frecuencia (el caso normal en un disco) el gapless se mantiene.
- **macOS compartido:** cambiar la frecuencia afecta a todas las apps que usan ese dispositivo.
- **Bit-perfect estricto** solo existe con volumen 100 %, EQ apagado, nivelador en 0 dB y el DAC soportando el formato de la pista. Si no se cumple todo eso, el resultado es "sin remuestreo" (cuando se pueda), pero no idéntico bit a bit, y la UI muestra el motivo.

## 2. Arquitectura

```
Proceso main (TS)                            libcrate_audio (C, cargada con koffi)
─────────────────                            ─────────────────────────────────────
AudioEngine ───────────┐                     ┌─ decoder: FFmpeg + swresample
GaplessController ─────┤   llamadas FFI      ├─ player: hilo de decodificación
EQManager ─────────────┼──────────────────►  │    → ring buffer → callback de audio
ExclusiveModeManager ──┤   (sin callbacks    │    (EQ, tap FFT/VU, volumen, mezcla)
DuplicateAudition ─────┤    nativo→JS:       ├─ output: miniaudio
Chromaprint / waveform ┘    JS hace polling) └─ hal: capacidades, frecuencia,
                                                  formato y hog (CoreAudio),
                                                  exclusivo (WASAPI)
```

Por qué una librería C propia cargada con koffi, y no un addon N-API:

- Mantiene el patrón actual (`koffi.load` + firmas).
- No hay que recompilarla con cada versión de Electron.
- Se compila y distribuye por el mismo camino que Chromaprint.
- El trabajo de tiempo real queda en C. JS solo controla y consulta.

### 2.1 Librería nativa `libcrate_audio`

- **Código:** `native/crate-audio/` con `CMakeLists.txt`, `include/crate_audio.h`, `src/` y `tests/`. Es código GPL-3 del repo.
- **Dependencias:** fijadas por SHA-256 y descargadas por el script de build; no se commitean.
  - FFmpeg 9.0.2 (la última estable al empezar; incluye el arreglo del decodificador nativo de Speex en ultra-wideband, trac #11495).
  - miniaudio 0.11.25.
- **Enlace:** FFmpeg se enlaza estático dentro de la librería y solo se exportan los símbolos `ca_*`. Esto evita choques con el `libffmpeg` que trae Electron:
  - macOS: two-level namespace y `-fvisibility=hidden`.
  - Linux: version script, `-Wl,--exclude-libs,ALL` y `-Bsymbolic`.
  - Windows: `.def`.
- **Licencia:** FFmpeg se compila sin `--enable-gpl` ni `--enable-nonfree` y con `--disable-autodetect`. La verificación comprueba en tiempo de ejecución que `avutil_license()` devuelva LGPL. Como Crate es GPL-3 y publicamos el código completo más el tarball de FFmpeg, el enlace estático cumple la LGPL.

Configuración de FFmpeg (borrador):

```
--disable-everything --disable-programs --disable-doc --disable-network
--disable-autodetect --disable-avdevice --disable-avfilter --disable-swscale
--disable-x86asm            # evita depender de nasm; impacto despreciable en audio
--enable-static --disable-shared --enable-pic
--enable-avcodec --enable-avformat --enable-swresample
--enable-protocol=file
--enable-demuxer=flac,mp3,mov,wav,aiff,ogg,matroska,ape,wv,tta,dsf,iff,mpc,mpc8
--enable-decoder=flac,alac,aac,mp3float,vorbis,opus,speex,ape,wavpack,tta,
                 mpc7,mpc8,dsd_lsbf,dsd_msbf,dsd_lsbf_planar,dsd_msbf_planar,dst,
                 pcm_u8,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,
                 pcm_s32be,pcm_f32le,pcm_f32be,pcm_f64le,pcm_f64be,
                 pcm_alaw,pcm_mulaw,adpcm_ms,adpcm_ima_wav
--enable-parser=flac,aac,mpegaudio,opus,vorbis
```

| Extensión | Demuxer | Decoders |
|---|---|---|
| .flac | flac | flac |
| .m4a | mov | aac, alac |
| .mp3 | mp3 | mp3float (respeta el header LAME de gapless) |
| .wav | wav | pcm_*, adpcm |
| .aiff / .aif | aiff | pcm_* big-endian, pcm_s16le (sowt) |
| .ogg / .opus | ogg | vorbis, opus, flac, speex |
| .spx | ogg | speex |
| .webm | matroska | opus, vorbis |
| .ape | ape | ape |
| .wv | wv | wavpack (sin `.wvc`; ver riesgos) |
| .tta | tta | tta |
| .dsf | dsf | dsd_lsbf_planar |
| .dff | iff | dsd_msbf, dst |
| .mpc | mpc, mpc8 | mpc7, mpc8 |

### 2.2 API C (borrador)

```c
/* Global */
int  ca_init(void);                 void ca_shutdown(void);
const char *ca_last_error(void);    /* thread-local */
int  ca_build_info(ca_build_info *out);   /* versión, FFmpeg, licencia */

/* Decoder: no necesita dispositivo; sirve para análisis y para reproducir */
ca_decoder *ca_decoder_open_file(const char *utf8_path, const ca_decode_opts *o);
ca_decoder *ca_decoder_open_memory(const void *data, uint64_t size, const ca_decode_opts *o);
int     ca_decoder_info(ca_decoder *, ca_stream_info *out); /* rate, chans, codec, bits, frames */
int64_t ca_decoder_read(ca_decoder *, void *out, int64_t frames); /* f32 o s16; 0 = EOF */
int     ca_decoder_seek(ca_decoder *, double seconds);          /* exacto a la muestra */
void    ca_decoder_close(ca_decoder *);

/* Análisis offline */
int ca_fft_magnitudes(const float *mono, int n, float *out); /* escala calibrada contra BASS FFT2048 */

/* Dispositivos, capacidades y salida */
int  ca_device_list(ca_device_info *out, int max);  /* id = UID / endpoint id, nombre, por defecto */
int  ca_device_caps(const char *device_id, int exclusive, ca_device_caps *out);
     /* frecuencias soportadas × profundidades × canales; se cachea */
int  ca_choose_output_format(const ca_stream_info *src, const ca_device_caps *caps,
                             const ca_output_policy *policy, ca_output_format *out);
     /* función pura (§2.4), con tests de tabla */
int  ca_output_open(const char *device_id, const ca_output_policy *policy);
     /* policy = { exclusive, bit_perfect } */
int  ca_output_set_policy(const ca_output_policy *policy); /* interruptor en caliente */
void ca_output_close(void);
int  ca_output_info(ca_output_info *out);  /* formato de la pista y de salida, flags y motivo (§2.4) */

/* Players: uno principal y dos para la audición de duplicados */
ca_player *ca_player_create(void);
int  ca_player_set_source(ca_player *, ca_decoder *, float gain);
int  ca_player_queue_next(ca_player *, ca_decoder *, float gain);  /* gapless */
int  ca_player_clear_next(ca_player *);
int  ca_player_skip_to_next(ca_player *);
int  ca_player_replace_source(ca_player *, ca_decoder *); /* promoción a memoria sin corte */
int  ca_player_play / pause / stop (ca_player *);
int  ca_player_seek(ca_player *, double seconds);
double ca_player_position(ca_player *);   int ca_player_state(ca_player *);
int  ca_player_set_volume(ca_player *, float);  int ca_player_set_item_gain(ca_player *, float);
int  ca_player_set_eq(ca_player *, int enabled, int count, const float *freqs,
                      const float *gains_db, float bandwidth_oct);
int  ca_player_fft(ca_player *, float *out1024);               /* = BASS_DATA_FFT2048 */
int  ca_player_levels(ca_player *, float window_sec, float out[4]); /* peakL, peakR, rmsL, rmsR */
void ca_player_destroy(ca_player *);

/* Eventos: cola lock-free; JS consulta */
int ca_poll_events(ca_event *out, int max);
/* TRACK_STARTED(serial) TRACK_ENDED QUEUE_EMPTY DECODER_RETIRED(dec)
   OUTPUT_FORMAT_CHANGED DEVICE_LOST DEVICE_REROUTED ERROR */
```

**Propiedad de los recursos:**

- JS es dueño de los decoders y de los `Buffer` de memoria.
- El código nativo nunca libera un decoder. Lo marca como retirado y emite `DECODER_RETIRED`; recién ahí JS llama `ca_decoder_close` y suelta el `Buffer`.
- Así se elimina el riesgo actual de que el GC libere callbacks koffi mientras BASS todavía los usa (ver `GaplessController.ts`).

### 2.3 Modelo de hilos

- **Hilo de decodificación (uno por player):**
  - Lee con FFmpeg y convierte al formato de salida elegido (§2.4): remuestreo, dither o downmix solo si hacen falta.
  - Escribe en un ring buffer SPSC de aproximadamente 1 s.
  - Encadena el `next` al llegar al EOF y marca el frame donde cambia la pista.
- **Callback de miniaudio (tiempo real):**
  - Lee el ring de cada player activo y aplica el EQ: biquads peaking RBJ con el ancho en octavas, la misma fórmula que BASS_FX BQF.
  - Copia la señal al tap de análisis antes del volumen. Así funciona hoy `BASS_ChannelGetData`, que no incluye `BASS_ATTRIB_VOL`.
  - Aplica volumen × ganancia del nivelador por ítem, mezcla los players y escribe la salida.
  - Emite los eventos en el frame exacto del cambio.
  - Sin malloc, locks ni I/O.
- **Main de JS (vía koffi):** manda comandos sobre estado protegido y lee posición, FFT y niveles.
- **Lecturas offline** (forma de onda, table bars, Chromaprint): usan las llamadas `async` de koffi para no bloquear el hilo principal.

### 2.4 Bit-perfect: interruptor y capacidades del DAC

**Interruptor.** Está en Ajustes → Audio → "Bit-perfect" y viene encendido por defecto. Se guarda en el renderer, igual que el EQ y el nivelador, y se envía al main por `audio:setOutputPolicy`. Se combina con el exclusivo así:

| Bit-perfect | Exclusivo | Comportamiento |
|---|---|---|
| Apagado | Apagado | Como hoy: el dispositivo queda en su frecuencia y se remuestrea todo. |
| Apagado | Encendido | Dispositivo tomado en exclusivo, pero a su frecuencia actual. |
| Encendido | Apagado | **macOS:** cambia la frecuencia y la profundidad del dispositivo en cada pista. **Windows:** en compartido no se puede, así que la UI avisa que bit-perfect requiere el exclusivo. **Linux:** pide la frecuencia (best-effort). |
| Encendido | Encendido | Lo más fiel posible: el formato de la pista sin pasar por la mezcla del sistema. |

Al apagar el interruptor se restaura la frecuencia original del dispositivo.

**1. Capacidades reales por dispositivo** (se cachean):

- **macOS:** `kAudioDevicePropertyAvailableNominalSampleRates`, y `kAudioStreamPropertyAvailablePhysicalFormats` para saber qué profundidades hay en cada frecuencia.
- **Windows:** en exclusivo, se sondea con `IsFormatSupported` cada frecuencia contra f32, s32, s24 y s16. En compartido solo existe el formato de mezcla.
- **Linux:** los `nativeDataFormats` que informa miniaudio.
- **Invalidación:** la caché se descarta en hotplug y reroute. Si el dispositivo anuncia un formato y después falla al abrirlo, ese formato se marca como no soportado y se pasa a la opción siguiente.

**2. Elección de frecuencia** (en `ca_choose_output_format`):

1. La frecuencia de la pista, si el DAC la soporta.
2. Si la pista supera el máximo del DAC: la más alta soportada de la misma familia con relación entera (192k → 96k, 176,4k → 88,2k). Si el DAC no tiene ninguna de esa familia, la más alta que soporte.
3. Si la pista está en una frecuencia que el DAC no tiene, pero por debajo de su máximo: el múltiplo entero más chico de la misma familia que soporte (44,1k → 88,2k). Si no hay, la más cercana por encima.
4. DSD: la frecuencia PCM más alta de la familia de 44,1 kHz que soporte el DAC, hasta 352,8 kHz.

**3. Profundidad:** la mayor que el DAC ofrezca en esa frecuencia. En macOS se fija el formato físico del stream; en Windows exclusivo se abre con ese formato. Si es menor que la de la pista (24 bits en un DAC de 16), se aplica dither TPDF a la profundidad del DAC en vez de truncar.

**4. Canales:** si la pista tiene más canales que el dispositivo (5.1 en estéreo), se hace downmix con la matriz estándar de libswresample.

**5. Sin conversión:** si la frecuencia coincide y la profundidad alcanza, la señal no se toca, salvo por EQ, volumen o nivelador si están activos.

**Transición entre pistas**, cuando el formato elegido para la pista nueva difiere del actual:

1. Se drena el ring y se detiene el `ma_device`. Si es un `next`, esto ocurre al llegar al borde.
2. Se reconfigura:
   - macOS: se fijan la frecuencia nominal y el formato físico, y se espera la confirmación del listener (timeout de 2 s; si no llega, se remuestrea a la frecuencia vigente).
   - Windows exclusivo: se reabre WASAPI con el formato nuevo.
3. Se reabre el `ma_device` y se emite `OUTPUT_FORMAT_CHANGED`.
4. **Windows exclusivo, si todo falla:** se vuelve a compartido y se avisa a la UI con el motivo.
5. **`DEVICE_REROUTED`** (cambia el dispositivo por defecto, se desconectan auriculares): se releen las capacidades y se vuelve a elegir el formato.
6. **Al salir o al apagar el interruptor:** se restaura la frecuencia original de cada dispositivo que se tocó (macOS).

**Indicador para el renderer** (`audio:output-changed`):

```ts
{
  source: { rate, bits, channels, codec },
  output: { rate, bits, channels },
  resampled, dithered, downmixed, exclusive, bitPerfect,
  limitedBy: 'dac-rate' | 'dac-bits' | 'dac-channels'
           | 'windows-shared' | 'setting-off' | 'processing' | null,
}
```

Ejemplos en el player:

- "24/96 · bit-perfect"
- "24/192 → 24/96 · el DAC llega a 96 kHz"
- "24 → 16 bits con dither · el DAC llega a 16 bits"
- "remuestreado a 48 kHz · bit-perfect apagado"

### 2.5 Modo exclusivo

- **macOS:** el hog mode pasa a C, dentro de `ca_output_open` con `exclusive`, y se borra `coreaudio-ffi.ts`.
  - Como los decoders no dependen del dispositivo, activar o desactivar el exclusivo ya no recarga el archivo: pausa → cerrar salida → hog → abrir → seguir en la misma muestra.
  - El mapeo de dispositivos es por UID exacto (miniaudio usa el UID de CoreAudio como id), así que desaparece la heurística por nombre de `resolveCoreAudioId`.
- **Windows:** WASAPI exclusivo de miniaudio con el formato elegido en la §2.4. Se marca "experimental" en la UI hasta probarlo en hardware real, con fallback automático a compartido.
- **Linux:** sin exclusivo; el toggle queda deshabilitado como hoy.

### 2.6 Cambios en TypeScript

| Archivo | Cambio |
|---|---|
| `audio/native/crate-audio-ffi.ts` (nuevo) | Bindings koffi y rutas. Reemplaza `bass-ffi.ts`, `bass-fx-ffi.ts`, `bass-constants.ts`, `bass-paths.ts`, `PluginLoader.ts`, `coreaudio-ffi.ts` y `coreaudio-constants.ts`. |
| `AudioEngine.ts` | Los handles `HSTREAM` pasan a ser `PlaybackItem { decoder, buffer, path, info }`. Se mantiene intacta la lógica de presupuesto de memoria, OneDrive y telemetría. FFT y VU salen del player nativo y se agrega un loop de eventos (50 ms mientras hay reproducción o cola). Se suma la política de salida (bit-perfect y exclusivo). |
| `audio/PlaybackDecode.ts` (nuevo) | Forma de onda y table bars sobre la API de decoder. Las table bars pasan a una decodificación lineal con ventanas, en lugar de ~18.000 `SetPosition` por tema. |
| `GaplessController.ts` | Sin `koffi.register`. Usa `queue_next` y `skip_to_next`; las transiciones llegan por eventos. Se revisan `endSyncOwnership.ts` y su test. |
| `EQManager.ts` | Solo guarda estado y llama a `set_eq`. El EQ vive en el player y sobrevive a los cambios de pista, así que desaparecen los `reapply`. |
| `ipc/audio-channel.ts` | Se van los hooks `onBeforeSwap` / `onAfterSwap`. La ganancia del nivelador viaja con cada ítem al encolarlo. Nuevo handler `audio:setOutputPolicy` y broadcast de `audio:output-changed`. |
| `ExclusiveModeManager.ts` | Multiplataforma, delega en la política de salida nativa. `exclusivePlaybackSnapshot.ts` queda solo como fallback si falla reabrir. |
| `duplicates/DuplicateAuditionService.ts` | Usa dos players propios. Su test de seguridad deja de exigir `BASS_UNICODE`, porque FFmpeg recibe UTF-8 también en Windows. |
| `BassChromaprintPcmDecoder.ts` | Pasa a `FfmpegChromaprintPcmDecoder.ts`, con los ajustes en `duplicates/native/index.ts` y `DeviceSyncService.ts`. |
| `shared/types/ipc-contract.ts` | `StreamInfoPayload`: salen `ctype`, `durationBytes` y `bytesPerSecond` (el renderer no los usa) y entran `codec` y `bitsPerSample`. `AudioOutputDevice`: el id sigue siendo numérico mediante un mapa estable por sesión; se agregan `uid` y un resumen de capacidades (frecuencia y bits máximos). Nuevos `OutputPolicy` y `OutputInfo` (§2.4). |
| Renderer | En Ajustes → Audio, el interruptor "Bit-perfect" (con la aclaración de que en Windows requiere el exclusivo). En el player, el indicador de salida con el motivo cuando el DAC limita. Marca "experimental" para el exclusivo en Windows. |

### 2.7 Build, CI y distribución

- **Scripts nuevos**, calcados de los de Chromaprint:
  - `scripts/crate-audio-config.mjs`: versiones, SHA-256 y flags.
  - `scripts/build-crate-audio.mjs`: descarga, configure/make de FFmpeg, CMake y, en macOS, `lipo` x64+arm64; escribe el manifest y las licencias.
  - `scripts/verify-crate-audio.mjs` comprueba:
    - manifest y arquitecturas;
    - que solo se exporten símbolos `ca_*`;
    - que no haya dependencias dinámicas fuera del sistema;
    - que `avutil_license()` sea LGPL;
    - con `--load`: decodificación de las fixtures y una reproducción con el backend nulo de miniaudio.
  - `scripts/fetch-crate-audio.mjs`: baja el asset verificado.
- **Workflow nuevo `crate-audio-native.yml`** (copia de `chromaprint-native.yml`):
  - macOS-14 universal;
  - windows-2022 con MSYS2 UCRT64 (MinGW-w64, libgcc y winpthread estáticos);
  - ubuntu-24.04.
  - Tag `crate-audio-native-v<versión>-<rev>`.
- **Repo de los assets:** el mismo que Chromaprint (`CHROMAPRINT_NATIVE_REPOSITORY`). **Pendiente de la auditoría:** LocalLibrary es privado y Crate es público, así que hay que decidir dónde viven los assets nativos antes de publicar.
- **`fetch:native`, `verify:native`, cache de `release.yml` y `smoke-chromaprint-pipeline`:** cambian BASS por crate-audio.
- **`electron-builder.yml`:** sin cambios (sigue copiando `native/libs`).
- **Licencias:**
  - `native/libs/licenses/ffmpeg/`: texto LGPL-2.1, tarball fuente y línea de configure.
  - `native/libs/licenses/miniaudio/`.

### 2.8 Calibración contra BASS (antes de borrarlo)

Mientras BASS sigue instalado localmente, un script descartable graba datos de referencia:

- FFT2048 y niveles pico/RMS sobre señales sintéticas: senos de varias frecuencias y niveles, y ruido rosa.
- Respuesta en frecuencia del EQ BQF para varias configuraciones.
- Nivel de salida de DSD.
- Forma de onda y table bars de las fixtures.
- Huellas Chromaprint de 30–50 temas de tu biblioteca, en formatos mixtos.

Dónde se guarda cada cosa:

- Las referencias de señales sintéticas se commitean (`native/crate-audio/tests/golden/`).
- Las huellas de tu biblioteca quedan en una carpeta local ignorada por git.

Criterios de aceptación:

- FFT dentro de tolerancia, ajustando la escala.
- EQ con ±0,1 dB de diferencia.
- Forma de onda idéntica en formatos lossless.
- Similitud de huella ≥ el umbral que usa la detección de duplicados.

`PLAYBACK_ANALYSIS_VERSION` solo se sube si las diferencias superan la tolerancia.

### 2.9 Fixtures y tests

- **Clips sintéticos** de 3–5 s en los 16 formatos. Se generan con encoders de Homebrew (flac, lame, opus-tools, wavpack, monkeys-audio, musepack, speex) y un script propio para DSF/DFF, y se commitean (~1–2 MB).
- **Casos límite:**
  - mono, 5.1, 24/192, 32 bits float;
  - DSD64/128/256 y DFF con DST;
  - MP3 con header LAME, AAC con `iTunSMPB`, Opus con pre-skip;
  - ruta Unicode;
  - archivos corruptos, vacíos y truncados.
- **Tests C (ctest, en los 3 SO en CI):**
  - frames y PCM (md5 en lossless) contra la referencia;
  - seek exacto a la muestra;
  - **continuidad gapless** renderizando offline con el backend nulo: ni huecos ni solapamientos, y la cantidad de muestras es exactamente la suma;
  - respuesta del EQ y escala del FFT;
  - stress del ring buffer;
  - orden de eventos.
- **`ca_choose_output_format` con tests de tabla.** Perfiles de DAC simulados:
  - USB 24/96;
  - USB 32/384;
  - Bluetooth 16/48;
  - AirPlay 16/44,1;
  - salida integrada de la Mac;
  - un dispositivo que solo tiene la familia de 48k.
  - Se cruzan contra pistas 16/44,1, 24/88,2, 24/192, 32f/352,8, DSD64/128/256 y 5.1, y se comprueban frecuencia, bits, dither, downmix y `limitedBy` esperados.
- **Cambio de formato** con una salida simulada que acepta, rechaza o tarda en confirmar.
- **TS:** se adaptan `node --test` y los tests de integración.
- **Manual:** checklist en macOS arm64 y en x64 bajo Rosetta (§4).

## 3. Fases (todas en la rama)

| Fase | Contenido | Se cierra cuando |
|---|---|---|
| **F1 · Librería y decoder** | `native/crate-audio`, scripts de build/verify/fetch, workflow de CI, API de decoder, fixtures y captura de referencias de BASS | `npm run build:crate-audio` funciona en la Mac y los tests de decoder pasan en CI en los 3 SO |
| **F2 · Decodificación offline** | Chromaprint, forma de onda, table bars y smoke pipeline sobre crate-audio | Las referencias coinciden y las huellas superan el umbral |
| **F3 · Motor de reproducción** | Salida compartida, players, hilo de decodificación + ring, gapless, EQ, tap FFT/VU, eventos | Pasan los tests con backend nulo (gapless exacto) |
| **F4 · Integración TS** | AudioEngine, Gapless, EQ, audio-channel, audición, contrato IPC y renderer | La app reproduce todo en la Mac sin BASS en el camino de reproducción |
| **F5 · Bit-perfect y exclusivo** | Capacidades del DAC, `ca_choose_output_format`, dither, downmix, frecuencia y formato en macOS (compartido y hog nativo), WASAPI exclusivo, interruptor en Ajustes, indicador de salida, restaurar frecuencia, reroute de dispositivo | Checklist macOS completo; tests de tabla y Windows verdes en CI |
| **F6 · Eliminar BASS** | Borrar ffi, scripts y licencias de BASS; actualizar `THIRD_PARTY_NOTICES`, README, `native/libs/README.md`, `release.yml` y la excepción GPL en Crate | `grep -ri bass` vacío (salvo historial y changelog) |
| **F7 · Validación y release** | Checklist final, CI completo, 0.7.0, port al repo público | Merge a `main` |

Tamaño estimado: unas 3.500–4.500 líneas de C (incluye bit-perfect, capacidades del DAC y WASAPI) y unas 1.700 líneas de TS cambiadas, con más de 1.000 borradas.

## 4. Checklist de validación manual (macOS Apple Silicon)

- [ ] Los 16 formatos reproducen; seek al principio, al medio y al final.
- [ ] Disco gapless (live o clásica) sin clicks, en FLAC, MP3 (LAME) y AAC.
- [ ] Interruptor de bit-perfect:
  - apagado: frecuencia fija y remuestreo, como hoy, y se restaura la frecuencia original;
  - encendido: vuelve a adaptarse en la pista siguiente.
- [ ] Cambio de frecuencia entre pistas (44,1 → 96 → 44,1): suena bien y el indicador lo refleja.
- [ ] Archivo de mayor calidad que el DAC: un 24/192 o 32/384 en la salida integrada o en un DAC de 96 kHz → baja a la frecuencia más alta con relación entera y el indicador dice "el DAC llega a …".
- [ ] 24 bits en un dispositivo de 16 bits (auriculares Bluetooth) → dither, con el indicador correspondiente.
- [ ] AirPlay y Bluetooth no se rompen (frecuencia fija).
- [ ] 5.1 en estéreo → downmix.
- [ ] DSD64, 128 y 256 en un dispositivo limitado.
- [ ] Bit-perfect estricto con volumen 100 %, EQ apagado y nivelador en 0, y se pierde (con el motivo) al tocar cualquiera de los tres.
- [ ] Entrar y salir de hog sin recargar ni perder posición; otra app no puede usar el dispositivo mientras dura.
- [ ] Al cerrar la app se restaura la frecuencia original.
- [ ] Desconectar auriculares o DAC durante la reproducción; cambiar el dispositivo por defecto.
- [ ] Sacar la tarjeta SD durante la reproducción (memoria vs. streaming desde archivo).
- [ ] Tema de OneDrive (memoria) y promoción de archivo a memoria sin corte.
- [ ] EQ: 5/10/N bandas, presets y preview en vivo.
- [ ] Visualizador, VU y table bars se ven como con BASS.
- [ ] Audición A/B de duplicados y restauración de la reproducción principal.
- [ ] Huellas: escaneo de duplicados sobre la biblioteca de prueba.
- [ ] Slice x64 bajo Rosetta: humo de reproducción y decodificación.
- [ ] CPU y memoria en reproducción contra BASS (Monitor de Actividad).

## 5. Riesgos

| Riesgo | Mitigación |
|---|---|
| Windows y Linux sin prueba con hardware real (en especial WASAPI exclusivo y el sondeo de formatos) | Fallback automático a compartido, logs de diagnóstico y marca "experimental". Para humo básico, una VM con Windows 11 ARM (Parallels/UTM) corre el build x64. |
| DAC que anuncia formatos que después no acepta, o drivers que mienten | Sondeo y caché por dispositivo; si falla al abrir, se marca el formato como no soportado y se pasa a la opción siguiente. |
| Carreras al cambiar la frecuencia o el formato en CoreAudio | Esperar el listener de la propiedad, con timeout y fallback a remuestreo. |
| Glitches de tiempo real | Callback sin malloc ni locks, ring dimensionado y tests de stress. |
| Compilar FFmpeg en Windows (lo más frágil del CI) | MSYS2 UCRT64; alternativa: cross-compile con mingw-w64 desde Linux. |
| Choque de símbolos con el `libffmpeg` de Electron | Símbolos ocultos y un paso de verify que lo comprueba. |
| Diferencias con BASS en casos raros (`.wvc` de WavPack, MP3 con headers rotos, APE viejos) | Fixtures de casos límite y un mensaje de error claro. |
| Nivel de salida de DSD distinto | Calibrar la ganancia contra la referencia de BASS. |
| Firma y notarización de la dylib nueva | Mismo camino que `libchromaprint.dylib`, que ya funciona. |

## 6. Avance

### F1 · Librería y decoder — completa

- `native/crate-audio/` (C11): decoder sobre FFmpeg (archivo/memoria, f32/s16, seek exacto con pre-roll para formatos con pérdida, ganancia DSD), FFT compatible con BASS, build info. Solo exporta `ca_*`.
- `scripts/build-crate-audio.mjs`, `verify-crate-audio.mjs`, `fetch-crate-audio.mjs`, `crate-audio-config.mjs`; `scripts/native-binary.mjs` compartido con Chromaprint.
- Workflow `crate-audio-native.yml` (macOS universal, Windows con MSYS2 UCRT64, Linux). **Todavía no se ejecutó en GitHub.**
- Fixtures sintéticas (2,2 MB) generadas con `tests/fixtures/generate.mjs`; tests en C: 478 verificaciones en arm64.
- Referencias de BASS capturadas en `tests/golden/` (`capture-bass.mjs`).

Hallazgos:

- FFmpeg no compila fuera del árbol en rutas con espacios: los objetos van a `$CRATE_AUDIO_BUILD_DIR` o a un temporal.
- FFmpeg recorta mal el final de Ogg Vorbis cuando todo el audio entra en una sola página (archivos de menos de ~1 s). El par gapless de Vorbis usa 3 s; en temas reales no ocurre.
- FFmpeg redondea la duración de Musepack SV8 a paquetes de 1,7 s; se lee la cantidad exacta de muestras del header `SH`.
- APE solo pone timestamp al primer frame de cada paquete: el decoder continúa la posición del frame anterior.
- FFT: BASS usa Hann periódica y normaliza para que un seno a fondo de escala dé 1,0 (bin DC sin duplicar). Con eso coincide con BASS a 6e-8.
- DSD: la ganancia de +6 dB reproduce el nivel de BASSDSD a 0,00 dB.
- Bug previo: en `bass-constants.ts` `BASS_LEVEL_RMS` y `BASS_LEVEL_STEREO` estaban intercambiados, así que el "pico" de los medidores era RMS. Ningún componente del renderer consume hoy esos medidores; el motor nuevo entrega pico y RMS reales.
- El slice x86_64 compila pero no se puede ejecutar en esta Mac (no hay Rosetta instalado).

### F2 · Decodificación offline — completa

- `electron/main/audio/native/crateAudio.ts`: bindings koffi (decoder con lecturas async en hilos de koffi, FFT). `crateAudioPaths.ts` resuelve la librería (o `CRATE_AUDIO_NATIVE_DIR`).
- `PlaybackDecode.ts`: forma de onda y table bars. Las table bars decodifican el archivo una sola vez en lugar de ~18.000 seeks. `PlaybackAnalysisService` lo usa directamente; `AudioEngine` ya no decodifica análisis.
- `FfmpegChromaprintPcmDecoder.ts` reemplaza a `BassChromaprintPcmDecoder.ts`.
- `smoke-chromaprint-pipeline.mjs` usa crate-audio y pasó al workflow `crate-audio-native.yml`; `chromaprint-native.yml` ya no depende de BASS.

Validación contra BASS:

- Forma de onda idéntica (error < 1e-6) y table bars dentro de 1e-3 en mono, estéreo y 5.1 (`PlaybackDecode.test.mjs`).
- Huella Chromaprint congelada del smoke: mismo digest que con BASS.
- Biblioteca real (30 FLAC al azar de 16 y 24 bits, hasta 192 kHz): PCM de 16 bits **idéntico bit a bit** y huellas idénticas. Para lograrlo la conversión a 16 bits trunca como BASS (desplazamiento aritmético) en vez de redondear. Las huellas ya guardadas siguen siendo válidas, así que no hace falta recalcularlas ni subir `PLAYBACK_ANALYSIS_VERSION`.

Hallazgos:

- Al final del stream BASS no rellena con ceros la ventana de la FFT: estira la ventana Hann sobre las muestras que quedan y normaliza por esa cantidad. Se replica con una tabla de 2048 puntos (exacto en potencias de 2; en el resto difiere < 0,05 solo en los ~33 ms finales de cada tema).
- BASS posicionaba las table bars en bytes de float (`floor(segundos × bytes por segundo)`); se replica para que cada frame empiece en la misma muestra.

### F3 · Motor de reproducción — completa (nativo)

- `ca_engine.c` (contexto y dispositivo miniaudio, callback, eventos, hilo de control, reconfiguración de formato), `ca_player.c` (cola de dos ítems, hilo de decodificación, ring SPSC con marcadores, consumo desde el callback), `ca_dsp.c` (EQ RBJ, medidores, dither TPDF, conversión entera exacta), `ca_format.c` (selector de formato), `ca_thread.c` y `ca_hal.h` (+ `ca_hal_generic.c` vacío hasta F5).
- Sin callbacks de C a JS: los eventos se consultan con `ca_poll_events`. El callback solo usa `trylock` y atómicos.
- La reconfiguración de dispositivo abre el dispositivo, reconstruye los players y **después** arranca (lo detectó ThreadSanitizer).

Tests (788 verificaciones, también bajo ASan/UBSan y ThreadSanitizer sin reportes):

- Reproducción bit-exacta; gapless exacto en WAV/FLAC y sin costura audible en MP3/AAC/Vorbis.
- Cambio de formato 44,1 → 96 kHz en el borde de pista, con el tramo de 96 kHz bit-exacto.
- Seek (incluso después de que el decoder pasó a la pista siguiente), rollback de la cola, skip, reemplazo de fuente sin corte.
- Volumen, EQ (igual al filtro offline), FFT y medidores en vivo; remuestreo con bit-perfect apagado; dispositivo nulo de miniaudio.
- EQ igual a BASS_FX BQF (respuesta al impulso a 5e-6) y RMS de los medidores igual a BASS.
- Selector de formato: 21 casos con DAC simulados (USB 24/96 y 32/384, Bluetooth, AirPlay, familia 48k, Windows compartido, 5.1, DSD).
- Mono → estéreo a ganancia unitaria (FFmpeg reparte a −3 dB por defecto).
