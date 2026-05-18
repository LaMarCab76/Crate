import type { CSSProperties } from 'react'

export function EQBars({ style }: { style?: CSSProperties }) {
  return (
    <span className="eq-bars" style={style}>
      <i /><i /><i />
    </span>
  )
}
