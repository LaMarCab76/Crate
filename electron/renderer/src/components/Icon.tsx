import { type CSSProperties, type ReactNode } from 'react'

const ICONS: Record<string, ReactNode> = {
  back:   <path d="M11 4l-6 6 6 6" />,
  fwd:    <path d="M5 4l6 6-6 6" />,
  chevR:  <path d="M6 4l4 4-4 4" />,
  chevD:  <path d="M4 6l4 4 4-4" />,
  chevU:  <path d="M4 10l4-4 4 4" />,
  play:   <path d="M5 3.5v13l11-6.5z" fill="currentColor" stroke="none" />,
  pause:  <g><rect x="4.5" y="3.5" width="3.5" height="13" rx="0.5" fill="currentColor" stroke="none" /><rect x="12" y="3.5" width="3.5" height="13" rx="0.5" fill="currentColor" stroke="none" /></g>,
  prev:   <g><path d="M5 4v12" strokeLinecap="round" /><path d="M16 4.5v11l-9-5.5z" fill="currentColor" stroke="none" /></g>,
  next:   <g><path d="M15 4v12" strokeLinecap="round" /><path d="M4 4.5v11l9-5.5z" fill="currentColor" stroke="none" /></g>,
  shuffle:<g><path d="M3 5h3l8 10h3" /><path d="M3 15h3l3-3.75" /><path d="M11.5 8.25L14 5h3" /><path d="M14.5 2.5L17 5l-2.5 2.5" /><path d="M14.5 12.5L17 15l-2.5 2.5" /></g>,
  repeat: <g><path d="M5 7a3 3 0 013-3h7" /><path d="M13 1.5L15.5 4 13 6.5" /><path d="M15 13a3 3 0 01-3 3H5" /><path d="M7 18.5L4.5 16 7 13.5" /></g>,
  volume: <g><path d="M3 7v6h3l4 3V4L6 7z" fill="currentColor" stroke="none" /><path d="M13 7c1.3 1 1.3 5 0 6" /><path d="M15.5 5c2.5 2 2.5 8 0 10" /></g>,
  volumeM:<g><path d="M3 7v6h3l4 3V4L6 7z" fill="currentColor" stroke="none" /><path d="M13 7l4 4M17 7l-4 4" strokeLinecap="round" /></g>,
  search: <g><circle cx="8.5" cy="8.5" r="5.25" /><path d="M12.5 12.5l4 4" strokeLinecap="round" /></g>,
  library:<g><rect x="3" y="3" width="14" height="14" rx="1.5" /><path d="M3 7h14M7 3v14" /></g>,
  sidebarLeft:<g><rect x="3" y="4" width="14" height="12" rx="1.5" /><path d="M7 4v12" /></g>,
  sidebarRight:<g><rect x="3" y="4" width="14" height="12" rx="1.5" /><path d="M13 4v12" /></g>,
  album:  <g><circle cx="10" cy="10" r="6.5" /><circle cx="10" cy="10" r="1.5" fill="currentColor" stroke="none" /></g>,
  artist: <g><circle cx="10" cy="7" r="3" /><path d="M4 17c0-3.5 2.5-6 6-6s6 2.5 6 6" /></g>,
  song:   <g><path d="M7 4v9.5" /><circle cx="5.5" cy="14" r="1.8" fill="currentColor" stroke="none" /><path d="M7 4l8-1.5v9.5" /><circle cx="13.5" cy="12.5" r="1.8" fill="currentColor" stroke="none" /></g>,
  genre:  <g><circle cx="10" cy="10" r="6.5" /><path d="M10 3.5v13M3.5 10h13" /></g>,
  composer: <g><path d="M4 16V4l12 3v9" /><circle cx="6.5" cy="16" r="1.6" fill="currentColor" stroke="none" /><circle cx="14.5" cy="16" r="1.6" fill="currentColor" stroke="none" /></g>,
  heart:  <path d="M10 16s-5.5-3-5.5-7.5A2.75 2.75 0 0110 6a2.75 2.75 0 015.5 2.5C15.5 13 10 16 10 16z" />,
  heartF: <path d="M10 16s-5.5-3-5.5-7.5A2.75 2.75 0 0110 6a2.75 2.75 0 015.5 2.5C15.5 13 10 16 10 16z" fill="currentColor" stroke="none" />,
  recent: <g><circle cx="10" cy="10" r="6.5" /><path d="M10 6v4l2.5 1.5" /></g>,
  download:<g><path d="M10 3v9" /><path d="M6 8l4 4 4-4" /><path d="M4 16h12" /></g>,
  upload: <g><path d="M10 17V8" /><path d="M6 12l4-4 4 4" /><path d="M4 4h12" /></g>,
  external:<g><path d="M8 5H5.5A1.5 1.5 0 004 6.5v8A1.5 1.5 0 005.5 16h8a1.5 1.5 0 001.5-1.5V12" /><path d="M11 4h5v5" /><path d="M16 4l-7 7" /></g>,
  cloud:  <g><path d="M7 15H6a3 3 0 010-6 4.8 4.8 0 019.2-1.6A3.7 3.7 0 1115 15h-2" /><path d="M10 8v8M7 13l3 3 3-3" strokeLinecap="round" strokeLinejoin="round" /></g>,
  folder: <path d="M3 6a1 1 0 011-1h4l1.5 1.5H16a1 1 0 011 1V15a1 1 0 01-1 1H4a1 1 0 01-1-1V6z" />,
  computer: <g><rect x="3" y="4" width="14" height="9" rx="1.5" /><path d="M7 16h6M9 13v3M11 13v3" /></g>,
  airplay: <g><path d="M5 13a6 6 0 010-6m10 0a6 6 0 010 6" /><path d="M7 11a4 4 0 010-4m6 0a4 4 0 010 4" /><path d="M10 11l3 5H7l3-5z" fill="currentColor" stroke="none" /></g>,
  speaker:<g><rect x="5" y="3" width="10" height="14" rx="1.5" /><circle cx="10" cy="12" r="2.5" /><circle cx="10" cy="6" r="0.8" fill="currentColor" stroke="none" /></g>,
  headphones: <g><path d="M4 12V10a6 6 0 0112 0v2" /><path d="M4 12a1.5 1.5 0 011.5-1.5h1V16h-1A1.5 1.5 0 014 14.5v-2.5z" /><path d="M16 12a1.5 1.5 0 00-1.5-1.5h-1V16h1A1.5 1.5 0 0016 14.5v-2.5z" /></g>,
  plus:   <g><path d="M10 4v12M4 10h12" strokeLinecap="round" /></g>,
  ellipsis: <g><circle cx="4.5" cy="10" r="1.2" fill="currentColor" stroke="none"/><circle cx="10" cy="10" r="1.2" fill="currentColor" stroke="none"/><circle cx="15.5" cy="10" r="1.2" fill="currentColor" stroke="none"/></g>,
  filter: <g><path d="M3 5h14M5.5 10h9M8.5 15h3" strokeLinecap="round" /></g>,
  grid:   <g><rect x="3" y="3" width="6" height="6" rx="1"/><rect x="11" y="3" width="6" height="6" rx="1"/><rect x="3" y="11" width="6" height="6" rx="1"/><rect x="11" y="11" width="6" height="6" rx="1"/></g>,
  list:   <g><path d="M3 5h14M3 10h14M3 15h14" strokeLinecap="round" /></g>,
  sortAZ: <g><path d="M4 5v10M2 13l2 2 2-2" strokeLinecap="round" /><path d="M9 5h6M9 10h5M9 15h4" strokeLinecap="round" /></g>,
  close:  <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />,
  expand: <g><path d="M11 4h5v5M9 16H4v-5M16 4l-6 6M4 16l6-6" strokeLinecap="round"/></g>,
  contract: <g><path d="M9 4v5H4M11 16v-5h5M4 9l5-5M16 11l-5 5" strokeLinecap="round"/></g>,
  queue:  <g><path d="M3 6h14M3 10h14M3 14h8" strokeLinecap="round"/><path d="M14 14l4 1.5L14 17v-3z" fill="currentColor" stroke="none"/></g>,
  visualizer: <g><path d="M3 14V8M7 16V5M11 14V7M15 16V4M17 13v-3" strokeLinecap="round" /></g>,
  sliders:<g><path d="M5 3v6M5 13v4M10 3v3M10 11v6M15 3v8M15 14v3" strokeLinecap="round" /><circle cx="5" cy="11" r="1.8" /><circle cx="10" cy="9" r="1.8" /><circle cx="15" cy="12.5" r="1.8" /></g>,
  bluetooth: <g><path d="M7 4l6 5-6 5V4l6 5-6 5" /></g>,
  tag:    <g><path d="M3 3h7l7 7-7 7-7-7z" /><circle cx="6.5" cy="6.5" r="0.9" fill="currentColor" stroke="none" /></g>,
  info:   <g><circle cx="10" cy="10" r="7" /><path d="M10 9v5" strokeLinecap="round" /><circle cx="10" cy="6" r="0.8" fill="currentColor" stroke="none" /></g>,
  bell:   <g><path d="M6 8a4 4 0 018 0v3.5l1.5 2.5h-11L6 11.5V8z" /><path d="M8.5 16a1.7 1.7 0 003 0" strokeLinecap="round" /></g>,
  activity:<g><path d="M3 10h3l1.6-4.5 3.1 9 2-6H17" strokeLinecap="round" strokeLinejoin="round" /><circle cx="10" cy="10" r="7" /></g>,
  loader: <g><path d="M10 3a7 7 0 017 7" strokeLinecap="round" /><path d="M10 17a7 7 0 01-7-7" strokeLinecap="round" /></g>,
  pin:    <g><path d="M8 3h6l-1.5 4 2.5 2.5-2 2-2.5-2.5L6.5 10.5V4.5L8 3z" /><path d="M8.5 11.5L4 16" strokeLinecap="round" /></g>,
  edit:   <g><path d="M4 14.5V17h2.5L15 8.5 12.5 6 4 14.5z" /><path d="M11.5 7l2.5 2.5" /></g>,
  trash:  <g><path d="M4 6h12M8 6V4h4v2M6 6l.7 10h6.6L14 6" /><path d="M9 9v4M11 9v4" strokeLinecap="round" /></g>,
  moon:   <path d="M16 11.5A6 6 0 018.5 4 6 6 0 1016 11.5z" fill="currentColor" stroke="none" />,
  sparkle:<g><path d="M10 3l1.5 4.5L16 9l-4.5 1.5L10 15l-1.5-4.5L4 9l4.5-1.5z" fill="currentColor" stroke="none" /></g>,
  car:    <g><rect x="3" y="9" width="14" height="6" rx="1.5"/><path d="M5 9l1.5-4h7L15 9" /><circle cx="7" cy="15" r="1.5" /><circle cx="13" cy="15" r="1.5" /></g>,
  wave:   <path d="M2 10s2-4 4-4 4 8 6 8 4-8 6-8" />,
  rotate: <g><path d="M16 6V3M16 6h-3" strokeLinecap="round"/><path d="M16 6A7 7 0 003 10a7 7 0 0014 0" /></g>,
  note:   <g><path d="M7 4v9.5" /><circle cx="5.5" cy="14" r="1.8" fill="currentColor" stroke="none" /><path d="M7 4l8-1.5v9.5" /><circle cx="13.5" cy="12.5" r="1.8" fill="currentColor" stroke="none" /></g>,
  check:  <path d="M4 10l4 4 8-9" strokeLinecap="round" strokeLinejoin="round" />,
  drop:   <g><path d="M10 17v-9M6 12l4 5 4-5M5 4h10" strokeLinecap="round" strokeLinejoin="round"/></g>,
  lyrics: <g><rect x="3" y="4" width="14" height="12" rx="2" /><path d="M6 8h8M6 11h5" strokeLinecap="round" /></g>,
  embed:  <g><rect x="4" y="3" width="12" height="14" rx="1.5" /><path d="M10 13V7M7.5 10.5L10 13l2.5-2.5" strokeLinecap="round" strokeLinejoin="round" /></g>,
  save:   <g><path d="M4 4.5A1.5 1.5 0 015.5 3h8L17 6.5v9A1.5 1.5 0 0115.5 17h-11A1.5 1.5 0 013 15.5v-11z" /><rect x="6.5" y="3.5" width="5" height="3.5" rx="0.5" /><rect x="6" y="10" width="8" height="4" rx="0.5" /></g>,
  device: <g><rect x="6" y="2.5" width="8" height="15" rx="1.6" /><path d="M8.5 5h3M9 15h2" strokeLinecap="round" /><circle cx="10" cy="10" r="2.3" /></g>,
  sync:   <g><path d="M16 6V3M16 6h-3" strokeLinecap="round" /><path d="M16 6a6.8 6.8 0 00-11.3 2.7" /><path d="M4 14v3M4 14h3" strokeLinecap="round" /><path d="M4 14a6.8 6.8 0 0011.3-2.7" /></g>,
}

export type IconName = keyof typeof ICONS | string

export interface IconProps {
  name: IconName
  size?: number
  stroke?: number
  title?: string
  style?: CSSProperties
  className?: string
}

export function Icon({ name, size = 16, stroke = 1.5, title, style, className }: IconProps) {
  const node = ICONS[name]
  if (!node) {
    return <span style={{ width: size, height: size, display: 'inline-block', ...style }} className={className} />
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, display: 'block', ...style }}
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title}
    >
      {node}
    </svg>
  )
}
