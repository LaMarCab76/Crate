import { useState } from 'react'
import type {
  LibraryProvider,
  SourceBadgePresentation,
  SourceIdentityMode,
} from '@shared/types/library-locations'
import type { LibraryLocation } from '@renderer/stores/libraryLocationsStore'
import { useLibraryLocationsStore } from '@renderer/stores/libraryLocationsStore'
import { useTweakStore } from '@renderer/stores/settingsStore'
import { Icon } from './Icon'
import { ModalShell } from './ModalShell'
import { SOURCE_ICON_OPTIONS, SourceBadge } from './SourceBadge'

const IDENTITY_OPTIONS: Array<{ value: SourceIdentityMode; label: string }> = [
  { value: 'both', label: 'Ubicación y proveedor' },
  { value: 'location', label: 'Solo ubicación' },
  { value: 'provider', label: 'Solo proveedor' },
]

const PRESENTATION_OPTIONS: Array<{ value: SourceBadgePresentation; label: string }> = [
  { value: 'both', label: 'Logo y nombre' },
  { value: 'icon', label: 'Solo logo' },
  { value: 'name', label: 'Solo nombre' },
]

function IconSelector({ value, onChange, includeAutomatic = false }: {
  value: string | null
  onChange: (value: string | null) => void
  includeAutomatic?: boolean
}) {
  return (
    <div className="source-icon-selector" role="radiogroup" aria-label="Icono monocromo">
      {includeAutomatic && (
        <button className={value == null ? 'selected' : ''} type="button" onClick={() => onChange(null)} aria-label="Icono automático" title="Automático">
          <Icon name="sparkle" size={15} />
        </button>
      )}
      {SOURCE_ICON_OPTIONS.map(icon => (
        <button className={value === icon ? 'selected' : ''} type="button" key={icon} onClick={() => onChange(icon)} aria-label={`Usar icono ${icon}`} title={icon}>
          <Icon name={icon} size={15} />
        </button>
      ))}
    </div>
  )
}

export function SourceDisplaySettings() {
  const prefs = useTweakStore(state => state.tweak.sourceDisplay)
  const setTweak = useTweakStore(state => state.setTweak)
  const previewLocation = useLibraryLocationsStore(state => (
    state.locations.find(location => location.role === 'library') ?? state.locations[0] ?? null
  ))
  const update = (patch: Partial<typeof prefs>) => setTweak('sourceDisplay', { ...prefs, ...patch })
  const updateProvider = (provider: LibraryProvider, patch: Partial<(typeof prefs.providers)[LibraryProvider]>) => {
    update({
      providers: {
        ...prefs.providers,
        [provider]: { ...prefs.providers[provider], ...patch },
      },
    })
  }
  return (
    <div className="source-display-settings">
      <div className="source-display-head">
        <div><strong>Etiquetas de fuente</strong><small>La agrupación sigue usando la ubicación real aunque muestres solo el proveedor.</small></div>
        <SourceBadge folderId={previewLocation?.id} provider={previewLocation?.provider ?? 'local'} />
      </div>
      <div className="source-display-grid">
        <label><span>Identidad visual</span><select className="settings-select" value={prefs.identity} onChange={event => update({ identity: event.target.value as SourceIdentityMode })}>
          {IDENTITY_OPTIONS.map(option => <option value={option.value} key={option.value}>{option.label}</option>)}
        </select></label>
        <label><span>Ubicación</span><select className="settings-select" value={prefs.locationPresentation} onChange={event => update({ locationPresentation: event.target.value as SourceBadgePresentation })}>
          {PRESENTATION_OPTIONS.map(option => <option value={option.value} key={option.value}>{option.label}</option>)}
        </select></label>
        <label><span>Proveedor</span><select className="settings-select" value={prefs.providerPresentation} onChange={event => update({ providerPresentation: event.target.value as SourceBadgePresentation })}>
          {PRESENTATION_OPTIONS.map(option => <option value={option.value} key={option.value}>{option.label}</option>)}
        </select></label>
      </div>
      <div className="source-provider-customization">
        {(['local', 'onedrive'] as const).map(provider => (
          <div className="source-provider-row" key={provider}>
            <Icon name={prefs.providers[provider].icon} size={16} />
            <label><span>Nombre de {provider === 'local' ? 'Local' : 'OneDrive'}</span><input className="settings-input" value={prefs.providers[provider].name} onChange={event => updateProvider(provider, { name: event.target.value })} /></label>
            <IconSelector value={prefs.providers[provider].icon} onChange={icon => { if (icon) updateProvider(provider, { icon }) }} />
          </div>
        ))}
      </div>
    </div>
  )
}

export function LocationPresentationDialog({
  location,
  onSave,
  onClose,
}: {
  location: LibraryLocation
  onSave: (input: { name: string; displayIcon: string | null }) => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState(location.name)
  const [displayIcon, setDisplayIcon] = useState<string | null>(location.displayIcon)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    if (!name.trim()) return
    setBusy(true)
    setError(null)
    try {
      await onSave({ name: name.trim(), displayIcon })
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <ModalShell
      title="Presentación de la ubicación"
      onClose={onClose}
      footer={(
        <>
          <button className="btn ghost" type="button" disabled={busy} onClick={onClose}>Cancelar</button>
          <button className="btn primary" type="button" disabled={busy || !name.trim()} onClick={() => { void save() }}>Guardar</button>
        </>
      )}
    >
      <div className="location-presentation-dialog">
        <label><span>Nombre</span><input className="settings-input" value={name} onChange={event => setName(event.target.value)} /></label>
        <div><span>Icono</span><IconSelector value={displayIcon} includeAutomatic onChange={setDisplayIcon} /></div>
        <div className="location-presentation-preview">
          <span>Preview</span>
          <SourceBadge
            folderId={location.id}
            provider={location.provider}
            locationOverride={{ ...location, name: name.trim() || location.name, displayIcon }}
          />
        </div>
        {error && <div className="loc-inline-error"><Icon name="info" size={13} />{error}</div>}
      </div>
    </ModalShell>
  )
}
