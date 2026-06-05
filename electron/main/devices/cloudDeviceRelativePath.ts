// Pure helpers (no electron/fs imports) that derive a device-relative path for a
// OneDrive-backed track. Cloud tracks have a synthetic `onedrive://…` path with
// no real hierarchy, so the device layout is rebuilt from `cloud_remote_path`
// (human-readable Graph path) anchored on the selected cloud folder's name.

// Sanitize one path segment for a device filesystem: collapse any run of
// filesystem-reserved punctuation or control characters into a single "-",
// collapse whitespace, drop leading/trailing dots, and cap length. Spaces are
// preserved (collapsed to one) so names read the same as locally-imported files.
export function sanitizeSegment(value: string): string {
  return value
    .normalize('NFC')
    .replace(/(?:[<>:"/\\|?*]|\p{Cc})+/gu, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 80)
}

// Reduce a OneDrive cloud_remote_path to the part after the drive root marker,
// returned as NFC-normalized, non-empty path segments. Examples:
//   "/drives/b!x/root:/Music/Artist/Album/01.flac" -> [Music, Artist, Album, 01.flac]
//   "Music/Artist/01.flac"                          -> [Music, Artist, 01.flac]
export function stripRemotePrefix(remotePath: string): string[] {
  const marker = 'root:'
  const idx = remotePath.indexOf(marker)
  const tail = idx >= 0 ? remotePath.slice(idx + marker.length) : remotePath
  return tail
    .split('/')
    .map(segment => segment.trim())
    .filter(Boolean)
    .map(segment => segment.normalize('NFC'))
}

// Derive the device-relative path for a cloud track, preserving the folder
// hierarchy below the selected cloud folder. Anchors on folderName: keeps the
// segments AFTER the last (case-insensitive) occurrence of folderName. Falls back
// to a flat, sanitized filename when there is no usable remote path or anchor.
export function cloudDeviceRelativePath(args: {
  remotePath: string | null
  filename: string
  folderName: string
}): string {
  const { remotePath, filename, folderName } = args
  const flat = sanitizeSegment(filename) || 'track'
  if (!remotePath) return flat

  const segments = stripRemotePrefix(remotePath)
  if (segments.length === 0) return flat

  let startIndex = 0
  const anchor = folderName ? folderName.normalize('NFC').toLowerCase() : ''
  if (anchor) {
    const matchIdx = segments.map(segment => segment.toLowerCase()).lastIndexOf(anchor)
    if (matchIdx >= 0) startIndex = matchIdx + 1
  }

  const relSegments = segments.slice(startIndex).map(sanitizeSegment).filter(Boolean)
  if (relSegments.length === 0) return flat

  // The remote name and track.filename are the same field upstream; force the
  // last segment to the canonical filename so the extension/name is reliable.
  relSegments[relSegments.length - 1] = flat
  return relSegments.join('/')
}
