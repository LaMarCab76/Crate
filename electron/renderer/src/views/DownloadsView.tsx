import { useEffect, useMemo, useState } from 'react'
import type { DownloadJob, DownloadProvider, DownloadQuality, DownloadStatus, OnlineTrackResult } from '@shared/types/downloads'
import { Icon } from '@renderer/components/Icon'
import { ServiceSetupWizard, ServiceTutorialPanel } from '@renderer/components/ServiceSetup'
import { useDownloadStore } from '@renderer/stores/downloadStore'
import { useFolders } from '@renderer/stores/libraryStore'

const PROVIDERS: Array<{ provider: DownloadProvider; label: string }> = [
  { provider: 'qobuz', label: 'Qobuz' },
  { provider: 'tidal', label: 'TIDAL' },
]

const QUALITY_OPTIONS: Array<{ value: DownloadQuality; label: string }> = [
  { value: 'best', label: 'Best' },
  { value: 'hires', label: 'Hi-Res' },
  { value: 'lossless', label: 'Lossless' },
  { value: 'mp3-320', label: 'MP3 320' },
]

const STATUS_LABELS: Record<DownloadStatus, string> = {
  queued: 'Queued',
  authenticating: 'Auth',
  resolving: 'Resolving',
  downloading: 'Downloading',
  verifying: 'Verifying',
  tagging: 'Tagging',
  importing: 'Importing',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  unavailable: 'Unavailable',
  already_exists: 'Exists',
}

function fmtDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return '--:--'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${String(secs).padStart(2, '0')}`
}

function fmtBytes(value: number): string {
  if (value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = value
  let idx = 0
  while (size >= 1024 && idx < units.length - 1) {
    size /= 1024
    idx += 1
  }
  return `${size.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`
}

function progress(job: DownloadJob): number {
  if (!job.bytesTotal || job.bytesTotal <= 0) return 0
  return Math.max(0, Math.min(100, (job.bytesReceived / job.bytesTotal) * 100))
}

function providerBadge(provider: DownloadProvider): string {
  return provider === 'qobuz' ? 'QZ' : 'TD'
}

function ResultRow({
  track,
  canDownload,
  onDownload,
}: {
  track: OnlineTrackResult
  canDownload: boolean
  onDownload: (track: OnlineTrackResult) => void
}) {
  const unavailable = track.availability !== 'downloadable'
  return (
    <div className={`online-result-row ${unavailable ? 'unavailable' : ''}`}>
      <div className="online-art">
        {track.artworkUrl ? <img src={track.artworkUrl} alt="" /> : <Icon name="album" size={18} />}
      </div>
      <div className="online-main">
        <strong>{track.title}</strong>
        <span>{track.artist} · {track.album}</span>
      </div>
      <span>{track.qualityLabel ?? '-'}</span>
      <span className="mono">{fmtDuration(track.durationSec)}</span>
      <div className="online-row-actions">
        {track.sourceUrl && (
          <button className="btn icon" onClick={() => window.open(track.sourceUrl ?? '', '_blank')} title="Open provider page">
            <Icon name="external" size={13} />
          </button>
        )}
        <button
          className="btn primary"
          disabled={!canDownload || unavailable}
          onClick={() => onDownload(track)}
          title={track.unavailableReason ?? 'Download'}
        >
          <Icon name="download" size={13} />
          Download
        </button>
      </div>
    </div>
  )
}

function JobRow({ job, onCancel, onRetry }: { job: DownloadJob; onCancel: (id: string) => void; onRetry: (id: string) => void }) {
  const pct = progress(job)
  const active = !['completed', 'failed', 'cancelled', 'unavailable', 'already_exists'].includes(job.status)
  return (
    <div className={`download-job ${job.status}`}>
      <div className="download-job-head">
        <span className="download-provider-badge">{providerBadge(job.provider)}</span>
        <div className="download-job-main">
          <strong>{job.title}</strong>
          <span>{job.artist} · {job.album}</span>
        </div>
        <span className="download-status">{STATUS_LABELS[job.status]}</span>
      </div>
      <div className="download-progress-track" aria-hidden="true">
        <i style={{ width: `${pct}%` }} />
      </div>
      <div className="download-job-foot">
        <span>{job.error ?? (job.bytesTotal ? `${fmtBytes(job.bytesReceived)} / ${fmtBytes(job.bytesTotal)}` : fmtBytes(job.bytesReceived))}</span>
        <div>
          {active ? (
            <button className="btn sm ghost" onClick={() => onCancel(job.id)}>Cancel</button>
          ) : (job.status === 'failed' || job.status === 'cancelled' || job.status === 'unavailable') ? (
            <button className="btn sm" onClick={() => onRetry(job.id)}>Retry</button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export function DownloadsView() {
  const [provider, setProvider] = useState<DownloadProvider>('qobuz')
  const [query, setQuery] = useState('')
  const [showTutorial, setShowTutorial] = useState(false)
  const folders = useFolders()
  const settings = useDownloadStore(s => s.settings)
  const jobs = useDownloadStore(s => s.jobs)
  const results = useDownloadStore(s => s.results)
  const auth = useDownloadStore(s => s.auth)
  const loading = useDownloadStore(s => s.loading)
  const searching = useDownloadStore(s => s.searching)
  const error = useDownloadStore(s => s.error)
  const load = useDownloadStore(s => s.load)
  const setSettings = useDownloadStore(s => s.setSettings)
  const search = useDownloadStore(s => s.search)
  const enqueue = useDownloadStore(s => s.enqueue)
  const cancel = useDownloadStore(s => s.cancel)
  const retry = useDownloadStore(s => s.retry)

  useEffect(() => {
    void load()
  }, [load])

  const activeAuth = auth[provider]
  const canDownload = Boolean(activeAuth?.canDownload && settings?.folderId)
  const authLoaded = Boolean(auth.qobuz && auth.tidal)
  const needsProviderSetup = authLoaded && !auth.qobuz?.canSearch && !auth.tidal?.canSearch
  const recentJobs = useMemo(() => jobs.slice(0, 80), [jobs])

  const handleSearch = (event: React.FormEvent) => {
    event.preventDefault()
    void search({ provider, query, limit: 25 })
  }

  const handleDownload = (track: OnlineTrackResult) => {
    if (!settings?.folderId) return
    void enqueue({
      provider: track.provider,
      providerTrackIds: [track.providerTrackId],
      folderId: settings.folderId,
      quality: settings.quality,
    })
  }

  return (
    <div className="downloads-page">
      <div className="downloads-header">
        <div>
          <h1>Online</h1>
          <div className="sub">
            {activeAuth?.reason ?? 'Qobuz and TIDAL catalog search'}
          </div>
        </div>
        <div className="downloads-header-controls">
          <button className="btn" onClick={() => setShowTutorial(value => !value)}>
            <Icon name="info" size={13} />
            Tutorial
          </button>
          <select
            className="list-select"
            value={settings?.folderId ?? ''}
            onChange={e => void setSettings({ folderId: e.target.value ? Number(e.target.value) : null })}
            aria-label="Destination library"
          >
            <option value="">Destination</option>
            {folders.map(folder => (
              <option key={folder.id} value={folder.id}>{folder.name}</option>
            ))}
          </select>
          <select
            className="list-select"
            value={settings?.quality ?? 'lossless'}
            onChange={e => void setSettings({ quality: e.target.value as DownloadQuality })}
            aria-label="Download quality"
          >
            {QUALITY_OPTIONS.map(option => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
      </div>

      {showTutorial && <ServiceTutorialPanel onClose={() => setShowTutorial(false)} />}

      {!authLoaded && loading ? (
        <div className="online-empty">
          <Icon name="cloud" size={34} stroke={1.2} />
          <span>Loading services</span>
        </div>
      ) : needsProviderSetup ? (
        <ServiceSetupWizard onDone={() => { void load() }} />
      ) : (
        <div className="downloads-layout">
          <div className="online-search-panel">
            <div className="online-provider-tabs">
              {PROVIDERS.map(item => (
                <button
                  key={item.provider}
                  className={provider === item.provider ? 'active' : ''}
                  onClick={() => setProvider(item.provider)}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <form className="online-search-form" onSubmit={handleSearch}>
              <Icon name="search" size={14} />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={`Search ${provider === 'qobuz' ? 'Qobuz' : 'TIDAL'}…`}
              />
              <button className="btn primary" disabled={!query.trim() || searching}>
                {searching ? 'Searching' : 'Search'}
              </button>
            </form>

            {error && <div className="online-error">{error}</div>}

            <div className="online-results">
              {results.length === 0 ? (
                <div className="online-empty">
                  <Icon name="cloud" size={34} stroke={1.2} />
                  <span>No online results</span>
                </div>
              ) : (
                results.map(track => (
                  <ResultRow
                    key={`${track.provider}-${track.providerTrackId}`}
                    track={track}
                    canDownload={canDownload}
                    onDownload={handleDownload}
                  />
                ))
              )}
            </div>
          </div>

          <aside className="download-queue-panel">
            <div className="download-queue-head">
              <h2>Queue</h2>
              <span>{recentJobs.length}</span>
            </div>
            <div className="download-job-list">
              {recentJobs.length === 0 ? (
                <div className="online-empty compact">No downloads yet</div>
              ) : (
                recentJobs.map(job => (
                  <JobRow
                    key={job.id}
                    job={job}
                    onCancel={id => { void cancel(id) }}
                    onRetry={id => { void retry(id) }}
                  />
                ))
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}
