import { useEffect, useState } from 'react'
import type { DownloadProvider, DownloadQuality, HarImportPreview } from '@shared/types/downloads'
import { Icon } from './Icon'
import { useDownloadStore } from '@renderer/stores/downloadStore'
import { useFolders } from '@renderer/stores/libraryStore'

const PROVIDERS: Array<{ provider: DownloadProvider; label: string; detail: string }> = [
  { provider: 'qobuz', label: 'Qobuz', detail: 'Catalog search and authorized account downloads.' },
  { provider: 'tidal', label: 'TIDAL', detail: 'Catalog search; file downloads remain unavailable unless official delivery is exposed.' },
]

const QUALITY_OPTIONS: Array<{ value: DownloadQuality; label: string }> = [
  { value: 'best', label: 'Best available' },
  { value: 'hires', label: 'Hi-Res' },
  { value: 'lossless', label: 'Lossless' },
  { value: 'mp3-320', label: 'MP3 320' },
]

function providerLabel(provider: DownloadProvider): string {
  return provider === 'qobuz' ? 'Qobuz' : 'TIDAL'
}

function TutorialContent() {
  return (
    <div className="service-tutorial">
      <div className="service-tutorial-hero">
        <Icon name="cloud" size={30} stroke={1.2} />
        <div>
          <h2>Set up a music service</h2>
          <p>Use manual credentials or import a browser HAR. Crate extracts only the allowed credential fields and never stores the HAR file.</p>
        </div>
      </div>
      <div className="service-tutorial-grid">
        <div>
          <strong>1. Open the provider web player</strong>
          <span>Sign in to Qobuz or TIDAL in your browser.</span>
        </div>
        <div>
          <strong>2. Capture network activity</strong>
          <span>Open DevTools, use the Network tab, then search or play a track.</span>
        </div>
        <div>
          <strong>3. Export HAR</strong>
          <span>Use Export HAR and import the file here. Delete it after import because it can contain secrets.</span>
        </div>
      </div>
    </div>
  )
}

function ProviderCredentialCard({
  provider,
  onSaved,
}: {
  provider: DownloadProvider
  onSaved?: () => void
}) {
  const auth = useDownloadStore(s => s.auth[provider])
  const error = useDownloadStore(s => s.error)
  const saveCredentials = useDownloadStore(s => s.saveCredentials)
  const clearCredentials = useDownloadStore(s => s.clearCredentials)
  const inspectHar = useDownloadStore(s => s.inspectHar)
  const applyHarImport = useDownloadStore(s => s.applyHarImport)
  const [qobuzAppId, setQobuzAppId] = useState('')
  const [qobuzSecret, setQobuzSecret] = useState('')
  const [qobuzToken, setQobuzToken] = useState('')
  const [tidalClientId, setTidalClientId] = useState('')
  const [tidalSecret, setTidalSecret] = useState('')
  const [preview, setPreview] = useState<HarImportPreview | null>(null)
  const [busy, setBusy] = useState(false)

  const saveManual = async () => {
    setBusy(true)
    try {
      if (provider === 'qobuz') {
        await saveCredentials({
          provider,
          appId: qobuzAppId || undefined,
          appSecret: qobuzSecret || undefined,
          userAuthToken: qobuzToken || undefined,
          source: 'manual',
          importedAt: Date.now(),
        })
        setQobuzSecret('')
        setQobuzToken('')
      } else {
        await saveCredentials({
          provider,
          clientId: tidalClientId || undefined,
          clientSecret: tidalSecret || undefined,
          source: 'manual',
          importedAt: Date.now(),
        })
        setTidalSecret('')
      }
      onSaved?.()
    } finally {
      setBusy(false)
    }
  }

  const importHar = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setBusy(true)
    try {
      const nextPreview = await inspectHar(provider, Array.from(files))
      setPreview(nextPreview)
    } finally {
      setBusy(false)
    }
  }

  const applyPreview = async () => {
    if (!preview) return
    setBusy(true)
    try {
      await applyHarImport(provider, preview.previewId)
      setPreview(null)
      onSaved?.()
    } finally {
      setBusy(false)
    }
  }

  const readyLabel = auth?.canDownload
    ? 'Download ready'
    : auth?.canSearch ? 'Search ready' : 'Not configured'

  return (
    <div className="service-provider">
      <div className="service-provider-head">
        <div>
          <strong>{providerLabel(provider)}</strong>
          <span>{auth?.source === 'har' ? 'Imported from HAR' : auth?.source === 'manual' ? 'Manual credentials' : readyLabel}</span>
        </div>
        <span className={auth?.canSearch ? 'ok' : ''}>{readyLabel}</span>
      </div>

      {provider === 'qobuz' ? (
        <>
          <input className="list-input" value={qobuzAppId} onChange={e => setQobuzAppId(e.target.value)} placeholder="App ID" />
          <input className="list-input" type="password" value={qobuzSecret} onChange={e => setQobuzSecret(e.target.value)} placeholder="App Secret" />
          <input className="list-input" type="password" value={qobuzToken} onChange={e => setQobuzToken(e.target.value)} placeholder="User Auth Token" />
        </>
      ) : (
        <>
          <input className="list-input" value={tidalClientId} onChange={e => setTidalClientId(e.target.value)} placeholder="Client ID" />
          <input className="list-input" type="password" value={tidalSecret} onChange={e => setTidalSecret(e.target.value)} placeholder="Client Secret" />
        </>
      )}

      <div className="service-actions">
        <button className="btn primary" disabled={busy} onClick={saveManual}>Save manual</button>
        <label className="btn">
          <Icon name="upload" size={13} />
          Import HAR
          <input type="file" accept=".har" onChange={e => { void importHar(e.target.files) }} hidden />
        </label>
        <button className="btn ghost" disabled={busy} onClick={() => { void clearCredentials(provider) }}>Clear</button>
      </div>

      {preview && (
        <div className="har-preview">
          <div className="har-preview-head">
            <strong>{preview.summary}</strong>
            <span>{preview.missingFields.length > 0 ? `Missing: ${preview.missingFields.join(', ')}` : 'Ready'}</span>
          </div>
          <div className="har-fields">
            {preview.fields.map(item => (
              <div key={item.key} className={item.status === 'found' ? 'found' : 'missing'}>
                <span>{item.label}</span>
                <strong>{item.status === 'found' ? item.valuePreview : 'Missing'}</strong>
                <em>{item.sourceHint ?? '-'}</em>
              </div>
            ))}
          </div>
          <button className="btn primary" disabled={!preview.canApply || busy} onClick={applyPreview}>
            Apply extracted fields
          </button>
        </div>
      )}

      {(auth?.reason || error) && <div className="service-note">{error ?? auth?.reason}</div>}
    </div>
  )
}

export function ServiceConfigPanel({ onOpenTutorial }: { onOpenTutorial?: () => void }) {
  const folders = useFolders()
  const settings = useDownloadStore(s => s.settings)
  const load = useDownloadStore(s => s.load)
  const setSettings = useDownloadStore(s => s.setSettings)

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="set-card service-card">
      <div className="service-card-head">
        <div>
          <strong>Qobuz / TIDAL</strong>
          <span>Manual setup or local HAR import.</span>
        </div>
        {onOpenTutorial && (
          <button className="btn sm" onClick={onOpenTutorial}>
            <Icon name="info" size={12} />
            Tutorial
          </button>
        )}
      </div>
      <div className="service-settings-grid">
        <label>
          <span>Destination library</span>
          <select
            className="list-select service-select"
            value={settings?.folderId ?? ''}
            onChange={e => { void setSettings({ folderId: e.target.value ? Number(e.target.value) : null }) }}
            aria-label="Downloads destination library"
          >
            <option value="">None</option>
            {folders.map(folder => (
              <option key={folder.id} value={folder.id}>{folder.name}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Default quality</span>
          <select
            className="list-select service-select"
            value={settings?.quality ?? 'lossless'}
            onChange={e => { void setSettings({ quality: e.target.value as DownloadQuality }) }}
            aria-label="Default download quality"
          >
            {QUALITY_OPTIONS.map(option => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Concurrent downloads</span>
          <input
            type="number"
            className="number-input"
            min={1}
            max={4}
            value={settings?.concurrency ?? 2}
            onChange={e => { void setSettings({ concurrency: Number(e.target.value) }) }}
            aria-label="Concurrent downloads"
          />
        </label>
      </div>
      <div className="service-credentials">
        <ProviderCredentialCard provider="qobuz" />
        <ProviderCredentialCard provider="tidal" />
      </div>
    </div>
  )
}

export function ServiceSetupWizard({ onDone }: { onDone?: () => void }) {
  const tutorial = useDownloadStore(s => s.tutorial)
  const auth = useDownloadStore(s => s.auth)
  const load = useDownloadStore(s => s.load)
  const setTutorialState = useDownloadStore(s => s.setTutorialState)
  const [step, setStep] = useState<'tutorial' | 'provider' | 'method' | 'confirm'>('tutorial')
  const [provider, setProvider] = useState<DownloadProvider>('qobuz')

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (tutorial?.seen && step === 'tutorial') setStep('provider')
  }, [tutorial?.seen, step])

  const markTutorialSeen = async () => {
    await setTutorialState({ seen: true, lastShownAt: Date.now() })
    setStep('provider')
  }

  const activeAuth = auth[provider]

  return (
    <div className="service-setup-wizard">
      <div className="wizard-steps" aria-hidden="true">
        {['Tutorial', 'Provider', 'Method', 'Confirm'].map((label, idx) => (
          <span key={label} className={idx <= ['tutorial', 'provider', 'method', 'confirm'].indexOf(step) ? 'active' : ''}>
            {label}
          </span>
        ))}
      </div>

      {step === 'tutorial' && (
        <>
          <TutorialContent />
          <div className="wizard-actions">
            <button className="btn primary" onClick={() => { void markTutorialSeen() }}>Continue</button>
          </div>
        </>
      )}

      {step === 'provider' && (
        <div className="wizard-provider-select">
          <h2>Choose a provider</h2>
          <div className="wizard-provider-grid">
            {PROVIDERS.map(item => (
              <button
                key={item.provider}
                className={provider === item.provider ? 'active' : ''}
                onClick={() => {
                  setProvider(item.provider)
                  setStep('method')
                }}
              >
                <strong>{item.label}</strong>
                <span>{item.detail}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {step === 'method' && (
        <div className="wizard-method">
          <div className="wizard-method-head">
            <div>
              <h2>{providerLabel(provider)} setup</h2>
              <span>{activeAuth?.reason ?? 'Save credentials manually or import a HAR.'}</span>
            </div>
            <button className="btn sm" onClick={() => setStep('provider')}>Change</button>
          </div>
          <ProviderCredentialCard provider={provider} onSaved={() => setStep('confirm')} />
        </div>
      )}

      {step === 'confirm' && (
        <div className="wizard-confirm">
          <Icon name="check" size={34} />
          <h2>{providerLabel(provider)} configured</h2>
          <p>{activeAuth?.reason ?? 'You can now search the online catalog.'}</p>
          <div className="wizard-actions">
            <button className="btn" onClick={() => setStep('method')}>Adjust</button>
            <button className="btn primary" onClick={onDone}>Open Online</button>
          </div>
        </div>
      )}
    </div>
  )
}

export function ServiceTutorialPanel({ onClose }: { onClose?: () => void }) {
  const setTutorialState = useDownloadStore(s => s.setTutorialState)
  return (
    <div className="service-setup-wizard compact">
      <TutorialContent />
      <div className="wizard-actions">
        <button
          className="btn primary"
          onClick={() => {
            void setTutorialState({ seen: true, lastShownAt: Date.now() })
            onClose?.()
          }}
        >
          Done
        </button>
      </div>
    </div>
  )
}
