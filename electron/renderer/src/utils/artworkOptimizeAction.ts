export type ArtworkOptimizeActionMode = 'analyze' | 'apply'

export interface ArtworkOptimizeActionState {
  mode: ArtworkOptimizeActionMode
  label: string
  icon: 'search' | 'sparkle'
  disabled: boolean
  primary: boolean
}

export function artworkOptimizeActionState({
  analyzing,
  optimizing,
  refreshing = false,
  hasAnalysis,
  oversizedCount,
  selectedCount = oversizedCount,
}: {
  analyzing: boolean
  optimizing: boolean
  refreshing?: boolean
  hasAnalysis: boolean
  oversizedCount: number
  selectedCount?: number
}): ArtworkOptimizeActionState {
  if (optimizing) {
    return {
      mode: 'apply',
      label: 'Optimizando...',
      icon: 'sparkle',
      disabled: true,
      primary: true,
    }
  }

  if (refreshing) {
    return {
      mode: 'analyze',
      label: 'Actualizando...',
      icon: 'search',
      disabled: true,
      primary: false,
    }
  }

  if (analyzing) {
    return {
      mode: 'analyze',
      label: 'Analizando...',
      icon: 'search',
      disabled: true,
      primary: false,
    }
  }

  if (hasAnalysis && oversizedCount > 0) {
    if (selectedCount <= 0) {
      return {
        mode: 'apply',
        label: 'Aplicar optimización (0)',
        icon: 'sparkle',
        disabled: true,
        primary: true,
      }
    }
    return {
      mode: 'apply',
      label: `Aplicar optimización (${selectedCount})`,
      icon: 'sparkle',
      disabled: false,
      primary: true,
    }
  }

  return {
    mode: 'analyze',
    label: hasAnalysis ? 'Volver a analizar' : 'Analizar artwork',
    icon: 'search',
    disabled: false,
    primary: false,
  }
}
