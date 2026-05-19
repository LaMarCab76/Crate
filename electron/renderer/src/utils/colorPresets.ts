export interface ColorPreset {
  id: string
  label: string
  hex: string
}

export const COLOR_PRESETS: ColorPreset[] = [
  { id: 'blue',     label: 'Azul',     hex: '#0a84ff' },
  { id: 'purple',   label: 'Violeta',  hex: '#bf5af2' },
  { id: 'pink',     label: 'Rosa',     hex: '#ff375f' },
  { id: 'red',      label: 'Rojo',     hex: '#ff453a' },
  { id: 'orange',   label: 'Naranja',  hex: '#ff9f0a' },
  { id: 'yellow',   label: 'Amarillo', hex: '#ffd60a' },
  { id: 'green',    label: 'Verde',    hex: '#30d158' },
  { id: 'teal',     label: 'Teal',     hex: '#64d2ff' },
  { id: 'graphite', label: 'Grafito',  hex: '#8e8e93' },
]
