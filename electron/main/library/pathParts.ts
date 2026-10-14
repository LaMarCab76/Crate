const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const MAX_PATH_PART_LENGTH = 80

// Turns a free-form name (artist, album, title) into one safe path segment:
// strips characters that are invalid on Windows or macOS, collapses
// whitespace, drops trailing dots and spaces, bounds the length and escapes
// Windows reserved device names. Pure: loaded directly by node --test.
export function sanitizePathPart(value: string, fallback: string): string {
  let cleaned = value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .slice(0, MAX_PATH_PART_LENGTH)
    .trim()
  if (WINDOWS_RESERVED_NAME.test(cleaned)) cleaned = `_${cleaned}`
  return cleaned || fallback
}
