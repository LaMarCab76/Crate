export function sanitizeSegment(value: string): string {
  return value
    .normalize('NFC')
    .replace(/(?:[<>:"/\\|?*]|\p{Cc})+/gu, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 80)
}

export function stripRemotePrefix(remotePath: string): string[] {
  const marker = 'root:'
  const markerIndex = remotePath.indexOf(marker)
  const tail = markerIndex >= 0 ? remotePath.slice(markerIndex + marker.length) : remotePath
  return tail
    .split('/')
    .map(segment => segment.trim())
    .filter(Boolean)
    .map(segment => segment.normalize('NFC'))
}

export function cloudDeviceRelativePath(args: {
  remotePath: string | null
  filename: string
  folderName: string
}): string {
  const flat = sanitizeSegment(args.filename) || 'track'
  if (!args.remotePath) return flat
  const segments = stripRemotePrefix(args.remotePath)
  if (segments.length === 0) return flat

  let startIndex = 0
  const anchor = args.folderName.normalize('NFC').toLowerCase()
  if (anchor) {
    const anchorIndex = segments.map(segment => segment.toLowerCase()).lastIndexOf(anchor)
    if (anchorIndex >= 0) startIndex = anchorIndex + 1
  }
  const relative = segments.slice(startIndex).map(sanitizeSegment).filter(Boolean)
  if (relative.length === 0) return flat
  relative[relative.length - 1] = flat
  return relative.join('/')
}
