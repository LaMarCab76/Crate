// CoreAudio HAL constants used by the exclusive-mode (hog) bindings. Values
// are derived from AudioHardware.h / AudioHardwareBase.h. Most CoreAudio
// selectors and scopes are FourCC codes — four-byte ASCII tags packed into a
// uint32_t — so we decode them via fourCC() to keep the source readable.

// Convert a 4-char ASCII string into the big-endian uint32_t CoreAudio uses
// for selector/scope identifiers.
export function fourCC(s: string): number {
  if (s.length !== 4) throw new Error(`fourCC needs exactly 4 chars, got "${s}"`)
  return (
    (s.charCodeAt(0) << 24) |
    (s.charCodeAt(1) << 16) |
    (s.charCodeAt(2) << 8) |
    s.charCodeAt(3)
  ) >>> 0
}

// ----- Selectors -----
export const kAudioHardwarePropertyDevices             = fourCC('dev#')
export const kAudioHardwarePropertyDefaultOutputDevice = fourCC('dOut')
export const kAudioObjectPropertyName                  = fourCC('lnam')
export const kAudioDevicePropertyDeviceUID             = fourCC('uid ')
export const kAudioDevicePropertyHogMode               = fourCC('oink')
// Stream configuration count > 0 (in output scope) tells us a device can play
// audio out. We use it to skip input-only devices during enumeration.
export const kAudioDevicePropertyStreamConfiguration   = fourCC('slay')

// ----- Scopes -----
export const kAudioObjectPropertyScopeGlobal = fourCC('glob')
export const kAudioObjectPropertyScopeOutput = fourCC('outp')

// ----- Elements -----
// kAudioObjectPropertyElementMain (renamed from kAudioObjectPropertyElementMaster
// in macOS 12). Always 0.
export const kAudioObjectPropertyElementMain = 0

// ----- Well-known objects -----
export const kAudioObjectSystemObject = 1

// CFString encoding for CFStringGetCString. We always read UTF-8.
export const kCFStringEncodingUTF8 = 0x08000100

// ----- Error helper -----
// Most CoreAudio errors are FourCC packed into an OSStatus. Decode the
// printable form when possible, fall back to hex.
export function coreAudioErrorName(code: number): string {
  if (code === 0) return 'OK'
  const u = code >>> 0
  const c1 = (u >> 24) & 0xff
  const c2 = (u >> 16) & 0xff
  const c3 = (u >> 8) & 0xff
  const c4 = u & 0xff
  const printable = [c1, c2, c3, c4].every(c => c >= 0x20 && c <= 0x7e)
  if (printable) {
    return `'${String.fromCharCode(c1, c2, c3, c4)}' (0x${u.toString(16).padStart(8, '0')})`
  }
  return `0x${u.toString(16).padStart(8, '0')}`
}
