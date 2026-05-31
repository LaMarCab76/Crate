import { useEffect, useState, type CSSProperties } from 'react'
import type { Artist, Playlist } from '@shared/types/library'
import { Artwork } from './Artwork'
import { DeviceConnectModal, type DeviceConnectTarget } from './DeviceConnectModal'
import { Icon, type IconName } from './Icon'
import type { View } from '@renderer/App'
import { useDeviceStore } from '@renderer/stores/deviceStore'
import {
  useFavoriteArtists,
  useLibraryStore,
  usePlaylists,
  useTrackCount,
} from '@renderer/stores/libraryStore'
import { useTweakStore } from '@renderer/stores/settingsStore'
import { visibleSidebarDevices } from '@renderer/utils/sidebarDevices'
import crateLogo from '@renderer/assets/crate-logo.png'

interface SidebarProps {
  setView: (v: View) => void
  selectedKey: string | null
  translucent: boolean
  isOpen: boolean
  onSelectPlaylist: (p: Playlist) => void
  onSelectArtist: (a: Artist) => void
  onSelectFavoriteTracks: () => void
  favoriteTracksCount: number
}

function SectionLabel({ label, onAdd, title }: { label: string; onAdd?: () => void; title?: string }) {
  return (
    <div className="sb-section-label">
      <span>{label}</span>
      {onAdd && (
        <span className="add" onClick={onAdd} title={title} role="button" tabIndex={0}>
          <Icon name="plus" size={12} stroke={1.8} />
        </span>
      )}
    </div>
  )
}

export function Sidebar({
  setView,
  selectedKey,
  translucent,
  isOpen,
  onSelectPlaylist,
  onSelectArtist,
  onSelectFavoriteTracks,
  favoriteTracksCount,
}: SidebarProps) {
  const artists = useFavoriteArtists()
  const playlists = usePlaylists()
  const trackCount = useTrackCount()
  const pickFolder = useLibraryStore(s => s.pickFolder)
  const addFolder = useLibraryStore(s => s.addFolder)
  const devices = useDeviceStore(s => s.devices)
  const candidates = useDeviceStore(s => s.candidates)
  const loadDevices = useDeviceStore(s => s.load)
  const refreshVolumes = useDeviceStore(s => s.refreshVolumes)
  const defaultArtworkMaxEdge = useTweakStore(s => s.tweak.deviceArtworkMaxEdge)
  const [connectTarget, setConnectTarget] = useState<DeviceConnectTarget | null>(null)

  useEffect(() => {
    void loadDevices()
    void refreshVolumes()
  }, [loadDevices, refreshVolumes])

  const addLibrary = async () => {
    const picked = await pickFolder()
    if (picked) await addFolder(picked)
  }
  const addDevice = () => setView({ kind: 'settings' })

  const Item = ({ id, icon, label, badge, onClick }: { id: string; icon: IconName; label: string; badge?: string | number; onClick: () => void }) => (
    <div className={`sb-item ${selectedKey === id ? 'active' : ''}`} onClick={onClick} role="button" tabIndex={0}>
      <span className="ic"><Icon name={icon} size={14} /></span>
      <span>{label}</span>
      {badge != null && <span className="badge">{badge}</span>}
    </div>
  )
  const connectedRoots = new Set(devices.map(device => device.rootPath))
  const visibleDevices = visibleSidebarDevices(devices)
  const visibleCandidates = candidates.filter(candidate => !connectedRoots.has(candidate.rootPath))

  return (
    <div
      className={`sidebar ${translucent ? '' : 'solid'} ${isOpen ? 'sidebar-open' : 'sidebar-collapsed'}`}
      aria-hidden={!isOpen}
    >
      {/* Spacer so the macOS traffic lights have room above the sidebar content. */}
      <div className="sb-header" style={{ WebkitAppRegion: 'drag' } as CSSProperties} />

      <div className="sb-scroll">
        <div style={{ padding: '0 0 4px' }}>
          <div className="sb-item" style={{ height: 32, fontSize: 14, fontWeight: 700, padding: '0 10px', gap: 8 }}>
            <img
              src={crateLogo}
              alt=""
              width={28}
              height={28}
              style={{ borderRadius: 7, display: 'block', objectFit: 'contain' }}
            />
            Crate
          </div>
        </div>

        <SectionLabel label="Library" onAdd={addLibrary} title="Add library folder" />
        <Item id="songs"     icon="song"     label="Songs"           badge={trackCount > 0 ? trackCount : undefined} onClick={() => setView({ kind: 'library' })} />
        <Item id="albums"    icon="album"    label="Albums"          onClick={() => setView({ kind: 'albums' })} />
        <Item id="artists"   icon="artist"   label="Artists"         onClick={() => setView({ kind: 'artists' })} />
        <Item id="genres"    icon="genre"    label="Genres"          onClick={() => setView({ kind: 'genres' })} />
        <Item id="recent"    icon="recent"   label="Recently Added"  onClick={() => setView({ kind: 'recent' })} />

        <SectionLabel label="Devices" onAdd={addDevice} title="Administrar dispositivos" />
        {visibleDevices.length === 0 && (
          <Item id="devices" icon="device" label="Ajustes de dispositivos" onClick={() => setView({ kind: 'settings' })} />
        )}
        {visibleDevices.map(device => {
          const deviceKeyPrefix = `dev-${device.id}-`
          return (
            <div className="sb-device-group" key={device.id}>
              <div
                className={`sb-item sb-device-row ${selectedKey?.startsWith(deviceKeyPrefix) ? 'active' : ''}`}
                onClick={() => setView({ kind: 'device', deviceId: device.id, section: 'dashboard' })}
                role="button"
                tabIndex={0}
                title={device.rootPath}
              >
                <span className="ic"><Icon name="device" size={14} /></span>
                <span>{device.name}</span>
                <span className={`badge ${device.isAvailable ? 'online' : ''}`}>{device.isAvailable ? 'on' : 'off'}</span>
              </div>
            </div>
          )
        })}
        {visibleCandidates.map(candidate => (
          <div
            className="sb-item sb-candidate"
            key={candidate.rootPath}
            onClick={() => setConnectTarget({ rootPath: candidate.rootPath, name: candidate.name })}
            role="button"
            tabIndex={0}
            title={candidate.rootPath}
          >
            <span className="ic"><Icon name="plus" size={13} /></span>
            <span>{candidate.name}</span>
            <span className="badge">{candidate.hasRockbox ? 'RB' : 'Crate'}</span>
          </div>
        ))}

        <SectionLabel label="Playlists" onAdd={() => {}} title="New playlist" />

        <div
          className={`sb-item ${selectedKey === 'pfavorites' ? 'active' : ''}`}
          onClick={() => onSelectFavoriteTracks()}
          role="button"
          tabIndex={0}
        >
          <span className="ic">
            <Icon name="heartF" size={14} />
          </span>
          <span>Temas favoritos</span>
          <span className="badge">{favoriteTracksCount}</span>
        </div>

        {playlists.map(p => (
          <div
            key={p.id}
            className={`sb-item ${selectedKey === 'pl-' + p.id ? 'active' : ''}`}
            onClick={() => onSelectPlaylist(p)}
            role="button"
            tabIndex={0}
          >
            <span className="ic">
              <Icon name={p.kind === 'smart' ? 'sparkle' : p.icon || 'note'} size={14} />
            </span>
            <span>{p.name}</span>
            <span className="badge">{p.count}</span>
          </div>
        ))}

        <SectionLabel label="Favorite Artists" onAdd={() => setView({ kind: 'artists' })} title="Manage favorites" />
        {artists.length === 0 ? (
          <div className="sb-item">
            <span style={{ color: 'var(--text-tertiary)' }}>No tienes artistas favoritos</span>
          </div>
        ) : (
          artists.slice(0, 5).map(ar => (
            <div
              key={ar.id}
              className={`sb-item ${selectedKey === 'ar-' + ar.id ? 'active' : ''}`}
              onClick={() => onSelectArtist(ar)}
              role="button"
              tabIndex={0}
            >
              {ar.artworkPath ? (
                <div className="sb-artist-art">
                  <Artwork album={ar} radius={3} />
                </div>
              ) : (
                <div className="sb-artist-art swatch" style={{ background: `linear-gradient(135deg, ${ar.palette[1]}, ${ar.palette[0]})` }} />
              )}
              <span>{ar.name}</span>
            </div>
          ))
        )}
      </div>
      {connectTarget && (
        <DeviceConnectModal
          target={connectTarget}
          artworkMaxEdge={defaultArtworkMaxEdge}
          onConnected={device => setView({ kind: 'device', deviceId: device.id, section: 'dashboard' })}
          onClose={() => setConnectTarget(null)}
        />
      )}
    </div>
  )
}
