import { useEffect, useState } from 'react'

export type Layout = 'classic' | 'editorial' | 'dense'
export type Density = 'compact' | 'regular' | 'comfy'

export interface Tweak {
  dark: boolean
  layout: Layout
  density: Density
  translucent: boolean
  showMini: boolean
  crossfade: number
  gapless: boolean
  soundcheck: boolean
}

const TWEAK_DEFAULTS: Tweak = {
  dark: true,
  layout: 'classic',
  density: 'regular',
  translucent: true,
  showMini: false,
  crossfade: 4,
  gapless: true,
  soundcheck: false,
}

const STORAGE_KEY = 'hifidelity.tweaks.v1'

function load(): Tweak {
  if (typeof window === 'undefined') return TWEAK_DEFAULTS
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return TWEAK_DEFAULTS
    return { ...TWEAK_DEFAULTS, ...JSON.parse(raw) }
  } catch {
    return TWEAK_DEFAULTS
  }
}

export function useTweaks(): [Tweak, <K extends keyof Tweak>(k: K, v: Tweak[K]) => void] {
  const [tweak, setTweakState] = useState<Tweak>(load)

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tweak))
    } catch {
      // ignore quota / privacy errors
    }
  }, [tweak])

  function setTweak<K extends keyof Tweak>(key: K, value: Tweak[K]) {
    setTweakState(prev => ({ ...prev, [key]: value }))
  }

  return [tweak, setTweak]
}
