import type { LibraryProvider, SourceBadgePresentation } from '@shared/types/library-locations'
import { useLibraryLocationsStore, type LibraryLocation } from '@renderer/stores/libraryLocationsStore'
import { useTweakStore } from '@renderer/stores/settingsStore'
import { Icon } from './Icon'

export const SOURCE_ICON_OPTIONS = [
  'folder',
  'library',
  'computer',
  'cloud',
  'album',
  'song',
  'device',
  'headphones',
  'speaker',
] as const

interface SourceBadgeProps {
  folderId?: number | null
  folderIds?: readonly (number | null | undefined)[]
  provider?: LibraryProvider
  className?: string
  compact?: boolean
  appearance?: 'badge' | 'plain' | 'icon'
  locationOverride?: LibraryLocation
}

function ProviderPart({
  provider,
  presentation,
}: {
  provider: LibraryProvider
  presentation: SourceBadgePresentation
}) {
  const config = useTweakStore(state => state.tweak.sourceDisplay.providers[provider])
  return (
    <span className="source-badge-part">
      {(presentation === 'icon' || presentation === 'both') && <Icon name={config.icon} size={12} />}
      {(presentation === 'name' || presentation === 'both') && <span>{config.name}</span>}
    </span>
  )
}

export function SourceBadge({
  folderId,
  folderIds,
  provider: providerFallback = 'local',
  className = '',
  compact = false,
  appearance = 'badge',
  locationOverride,
}: SourceBadgeProps) {
  const locations = useLibraryLocationsStore(state => state.locations)
  const prefs = useTweakStore(state => state.tweak.sourceDisplay)
  const ids = [...new Set((folderIds ?? [folderId]).filter((id): id is number => id != null))]
  const appearanceClass = appearance === 'plain' ? ' plain' : ''

  const location = locationOverride
    ?? (ids[0] == null ? null : locations.find(candidate => candidate.id === ids[0]) ?? null)
  const provider = location?.provider ?? providerFallback
  const providerConfig = prefs.providers[provider]
  const fullName = location?.name ?? providerConfig.name
  const fullPath = location?.remotePath ?? location?.path ?? 'Ubicación no disponible'
  const accessibleName = `${fullName} · ${providerConfig.name} · ${fullPath}`

  if (appearance === 'icon') {
    return (
      <span
        className={`source-badge icon-only ${className}`}
        title={accessibleName}
        aria-label={accessibleName}
      >
        <Icon name={provider === 'onedrive' ? 'cloud' : 'folder'} size={14} />
      </span>
    )
  }

  if (ids.length > 1) {
    const selected = ids.map(id => locations.find(location => location.id === id)).filter(Boolean)
    const title = selected.length > 0
      ? selected.map(location => `${location!.name} · ${prefs.providers[location!.provider].name} · ${location!.remotePath ?? location!.path}`).join('\n')
      : 'Varias ubicaciones de biblioteca'
    return (
      <span className={`source-badge${compact ? ' compact' : ''}${appearanceClass} mixed ${className}`} title={title} aria-label={`Varias fuentes. ${title}`}>
        <Icon name="library" size={12} />
        <span>Varias fuentes</span>
      </span>
    )
  }

  const showLocation = prefs.identity === 'location' || prefs.identity === 'both'
  const showProvider = prefs.identity === 'provider' || prefs.identity === 'both'
  const locationIcon = location?.displayIcon ?? (provider === 'onedrive' ? 'cloud' : 'folder')

  return (
    <span
      className={`source-badge${compact ? ' compact' : ''}${appearanceClass} ${className}`}
      title={accessibleName}
      aria-label={accessibleName}
    >
      {showLocation && (
        <span className="source-badge-part">
          {(prefs.locationPresentation === 'icon' || prefs.locationPresentation === 'both') && (
            <Icon name={locationIcon} size={12} />
          )}
          {(prefs.locationPresentation === 'name' || prefs.locationPresentation === 'both') && <span>{fullName}</span>}
        </span>
      )}
      {showLocation && showProvider && <span className="source-badge-separator" aria-hidden>·</span>}
      {showProvider && <ProviderPart provider={provider} presentation={prefs.providerPresentation} />}
    </span>
  )
}
