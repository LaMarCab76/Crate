import { useMemo } from 'react'
import type { Artist } from '@shared/types/library'
import { Artwork } from '@renderer/components/Artwork'
import { Icon } from '@renderer/components/Icon'
import { toggleArtistFavorite, useArtists } from '@renderer/stores/libraryStore'
import { useTweakStore } from '@renderer/stores/settingsStore'

export function ArtistsView({ onSelect }: { onSelect?: (ar: Artist) => void }) {
  const principalOnly = useTweakStore(s => s.tweak.artistsPrincipalOnly)
  const setTweak = useTweakStore(s => s.setTweak)
  const all = useArtists()

  const list = useMemo(
    () => (principalOnly ? all.filter(ar => ar.trackCount > 0) : all),
    [all, principalOnly],
  )

  if (all.length === 0) {
    return (
      <div style={{ padding: 48, color: 'var(--text-secondary)' }}>
        No artists yet. Import a folder from Preferences → Library to populate your collection.
      </div>
    )
  }

  return (
    <>
      <div className="lib-head">
        <div>
          <h1>Artists</h1>
          <div className="sub">
            {list.length} artist{list.length === 1 ? '' : 's'}
            {principalOnly && all.length !== list.length ? ` · filtered from ${all.length}` : ''}
          </div>
        </div>
        <div className="actions">
          <div className="view-toggle">
            <button
              className={!principalOnly ? 'on' : ''}
              onClick={() => setTweak('artistsPrincipalOnly', false)}
              title="Show every artist in the library"
            >
              All
            </button>
            <button
              className={principalOnly ? 'on' : ''}
              onClick={() => setTweak('artistsPrincipalOnly', true)}
              title="Only artists who are the primary artist of at least one track"
            >
              Principal
            </button>
          </div>
        </div>
      </div>
      {list.length === 0 ? (
        <div style={{ padding: 48, color: 'var(--text-secondary)' }}>
          No principal artists in your library yet.{' '}
          <button
            className="btn sm"
            style={{ marginLeft: 8 }}
            onClick={() => setTweak('artistsPrincipalOnly', false)}
          >
            Show all
          </button>
        </div>
      ) : (
        <div style={{ padding: '4px 12px 24px' }}>
          {list.map(ar => (
            <div
              key={ar.id}
              className="sb-item"
              style={{ height: 56, margin: '2px 0', padding: '0 12px', gap: 14 }}
              onClick={() => onSelect?.(ar)}
              role="button"
              tabIndex={0}
            >
              <div style={{ width: 40, height: 40, borderRadius: '50%', overflow: 'hidden', flexShrink: 0 }}>
                <Artwork album={{ seed: ar.seed, palette: ar.palette, pattern: ar.pattern }} radius={20} />
              </div>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{ar.name}</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  {ar.albums.length} album{ar.albums.length === 1 ? '' : 's'}
                </div>
              </div>
              {ar.dbId != null && (
                <button
                  className="tb-icon-btn"
                  style={{ marginLeft: 'auto' }}
                  onClick={e => {
                    e.stopPropagation()
                    void toggleArtistFavorite(ar.dbId!, !ar.favorite)
                  }}
                  title={ar.favorite ? 'Remove from favorites' : 'Mark as favorite'}
                >
                  <Icon name={ar.favorite ? 'heartF' : 'heart'} size={14} />
                </button>
              )}
              <Icon
                name="chevR"
                size={14}
                style={{ color: 'var(--text-tertiary)' }}
              />
            </div>
          ))}
        </div>
      )}
    </>
  )
}
