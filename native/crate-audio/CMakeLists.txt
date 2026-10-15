cmake_minimum_required(VERSION 3.16)
project(crate_audio C)

# Built by scripts/build-crate-audio.mjs, which first compiles a static,
# LGPL-only FFmpeg and downloads the pinned miniaudio header.

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

set(CA_FFMPEG_PREFIX "" CACHE PATH "Install prefix of the static FFmpeg build")
set(CA_MINIAUDIO_DIR "" CACHE PATH "Directory containing miniaudio.h")
option(CA_BUILD_TESTS "Build the crate_audio test runner" ON)

if(NOT EXISTS "${CA_FFMPEG_PREFIX}/include/libavcodec/avcodec.h")
  message(FATAL_ERROR "CA_FFMPEG_PREFIX must point at a static FFmpeg install")
endif()
if(NOT EXISTS "${CA_MINIAUDIO_DIR}/miniaudio.h")
  message(FATAL_ERROR "CA_MINIAUDIO_DIR must contain miniaudio.h")
endif()

set(CA_SOURCES
  src/ca_common.c
  src/ca_decoder.c
  src/ca_fft.c
  src/ca_dsp.c
  src/ca_thread.c
  src/ca_format.c
  src/ca_player.c
  src/ca_engine.c
  src/ca_hal_generic.c
  src/ca_miniaudio.c
)

add_library(crate_audio_objects OBJECT ${CA_SOURCES})
target_include_directories(crate_audio_objects
  PUBLIC include
  PRIVATE src "${CA_FFMPEG_PREFIX}/include" "${CA_MINIAUDIO_DIR}")
target_compile_definitions(crate_audio_objects PRIVATE CA_BUILDING_LIBRARY)
set_target_properties(crate_audio_objects PROPERTIES C_VISIBILITY_PRESET hidden)
if(NOT MSVC)
  target_compile_options(crate_audio_objects PRIVATE -Wall -Wextra -Wno-unused-parameter -Wno-missing-field-initializers)
  # miniaudio is third-party code; keep its warnings out of our build log.
  set_source_files_properties(src/ca_miniaudio.c PROPERTIES COMPILE_OPTIONS "-w")
endif()

set(CA_FFMPEG_LIBS
  "${CA_FFMPEG_PREFIX}/lib/libavformat.a"
  "${CA_FFMPEG_PREFIX}/lib/libavcodec.a"
  "${CA_FFMPEG_PREFIX}/lib/libswresample.a"
  "${CA_FFMPEG_PREFIX}/lib/libavutil.a")

function(ca_link_dependencies target)
  target_link_libraries(${target} PRIVATE ${CA_FFMPEG_LIBS})
  if(APPLE)
    target_link_libraries(${target} PRIVATE
      "-framework CoreAudio" "-framework AudioToolbox" "-framework AudioUnit" "-framework CoreFoundation")
  elseif(WIN32)
    target_link_libraries(${target} PRIVATE ole32 uuid -static-libgcc -Wl,-Bstatic -lwinpthread -Wl,-Bdynamic)
  else()
    target_link_libraries(${target} PRIVATE m dl pthread)
  endif()
endfunction()

add_library(crate_audio SHARED $<TARGET_OBJECTS:crate_audio_objects>)
ca_link_dependencies(crate_audio)
if(APPLE)
  target_link_options(crate_audio PRIVATE
    "LINKER:-exported_symbols_list,${CMAKE_CURRENT_SOURCE_DIR}/exports/crate_audio.exp"
    "LINKER:-dead_strip"
    "LINKER:-install_name,@rpath/libcrate_audio.dylib")
elseif(WIN32)
  set_target_properties(crate_audio PROPERTIES PREFIX "" IMPORT_PREFIX "")
  target_link_options(crate_audio PRIVATE -static-libgcc "LINKER:--gc-sections")
else()
  # Keep the statically linked FFmpeg symbols private so they can never bind
  # to the libffmpeg.so that Electron loads into the same process.
  target_link_options(crate_audio PRIVATE
    "LINKER:--version-script=${CMAKE_CURRENT_SOURCE_DIR}/exports/crate_audio.map"
    "LINKER:--exclude-libs,ALL"
    "LINKER:-Bsymbolic"
    "LINKER:--gc-sections"
    "LINKER:-z,defs")
endif()

if(CA_BUILD_TESTS)
  enable_testing()
  add_executable(crate_audio_tests tests/test_main.c tests/test_decoder.c tests/test_golden.c tests/test_format.c tests/test_engine.c $<TARGET_OBJECTS:crate_audio_objects>)
  target_include_directories(crate_audio_tests PRIVATE include src tests "${CA_FFMPEG_PREFIX}/include" "${CA_MINIAUDIO_DIR}")
  target_compile_definitions(crate_audio_tests PRIVATE CA_BUILDING_LIBRARY)
  ca_link_dependencies(crate_audio_tests)
  add_test(NAME crate_audio_tests
    COMMAND crate_audio_tests "${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures")
endif()
