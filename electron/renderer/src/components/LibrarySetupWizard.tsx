import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import crateLogo from '../assets/crate-logo.png'
import { Icon } from './Icon'
import { LibraryLocationPicker } from './LibraryLocationsPanel'
import type { LibraryLocation } from '../stores/libraryLocationsStore'

interface LibrarySetupWizardProps {
  onComplete: () => void | Promise<void>
}

type SetupStep = 'library' | 'backup' | 'ready'

function StepMark({
  number,
  label,
  state,
}: {
  number: number
  label: string
  state: 'upcoming' | 'active' | 'complete'
}) {
  return (
    <li className={`library-setup-step ${state}`} aria-current={state === 'active' ? 'step' : undefined}>
      <span>{state === 'complete' ? <Icon name="check" size={12} /> : number}</span>
      <small>{label}</small>
    </li>
  )
}

function LocationSummary({ location, backup = false }: { location: LibraryLocation; backup?: boolean }) {
  return (
    <div className={`library-setup-summary-node ${backup ? 'backup' : 'library'}`}>
      <span className={`loc-kind-icon ${location.provider}`} aria-hidden="true">
        <Icon name={location.provider === 'onedrive' ? 'cloud' : 'folder'} size={17} />
      </span>
      <span>
        <small>{backup ? 'Backup espejo' : 'Biblioteca base'}</small>
        <strong>{location.name}</strong>
        <em>{location.path}</em>
      </span>
      <span className={`loc-badge provider ${location.provider}`}>
        {location.provider === 'onedrive' ? 'OneDrive' : 'Local'}
      </span>
    </div>
  )
}

export function LibrarySetupWizard({ onComplete }: LibrarySetupWizardProps) {
  const [step, setStep] = useState<SetupStep>('library')
  const [library, setLibrary] = useState<LibraryLocation | null>(null)
  const [backup, setBackup] = useState<LibraryLocation | null>(null)
  const [finishing, setFinishing] = useState(false)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    headingRef.current?.focus()
  }, [step])

  const complete = async () => {
    setFinishing(true)
    try {
      await onComplete()
    } finally {
      setFinishing(false)
    }
  }

  const stepState = (target: SetupStep): 'upcoming' | 'active' | 'complete' => {
    const order: SetupStep[] = ['library', 'backup', 'ready']
    const currentIndex = order.indexOf(step)
    const targetIndex = order.indexOf(target)
    if (targetIndex < currentIndex) return 'complete'
    return targetIndex === currentIndex ? 'active' : 'upcoming'
  }

  const trapFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return
    const overlay = overlayRef.current
    if (!overlay) return
    const focusable = Array.from(overlay.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
    )).filter(element => element.getAttribute('aria-hidden') !== 'true')
    if (focusable.length === 0) return
    const activeIndex = focusable.indexOf(document.activeElement as HTMLElement)
    if (activeIndex === -1) {
      event.preventDefault()
      const target = event.shiftKey ? focusable[focusable.length - 1] : focusable[0]
      target.focus()
    } else if (event.shiftKey && activeIndex === 0) {
      event.preventDefault()
      focusable[focusable.length - 1].focus()
    } else if (!event.shiftKey && activeIndex === focusable.length - 1) {
      event.preventDefault()
      focusable[0].focus()
    }
  }

  return (
    <div
      className="library-setup-overlay"
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="library-setup-title"
      onKeyDown={trapFocus}
    >
      <div className="library-setup-atmosphere" aria-hidden="true">
        <i />
        <i />
      </div>
      <section className="library-setup-shell">
        <header className="library-setup-header">
          <div className="library-setup-brand">
            <img src={crateLogo} alt="" />
            <span><strong>Crate</strong><small>Configuración inicial</small></span>
          </div>
          <ol className="library-setup-steps" aria-label="Progreso de configuración">
            <StepMark number={1} label="Biblioteca" state={stepState('library')} />
            <StepMark number={2} label="Backup" state={stepState('backup')} />
            <StepMark number={3} label="Listo" state={stepState('ready')} />
          </ol>
        </header>

        <main className="library-setup-main">
          {step === 'library' && (
            <div className="library-setup-stage">
              <div className="library-setup-intro">
                <span className="library-setup-kicker">01 · Origen</span>
                <h1 id="library-setup-title" ref={headingRef} tabIndex={-1}>¿Dónde vive tu música?</h1>
                <p>
                  Elegí una carpeta local o de OneDrive. Ambas se comportan como bibliotecas normales:
                  aparecen juntas en canciones, álbumes, búsquedas y playlists.
                </p>
              </div>
              <LibraryLocationPicker
                role="library"
                onCreated={location => {
                  setLibrary(location)
                  setStep('backup')
                }}
              />
            </div>
          )}

          {step === 'backup' && library && (
            <div className="library-setup-stage">
              <div className="library-setup-intro with-source">
                <span className="library-setup-kicker">02 · Resguardo opcional</span>
                <h1 id="library-setup-title" ref={headingRef} tabIndex={-1}>¿Querés mantener un espejo?</h1>
                <p>
                  El backup replica la estructura exacta de la biblioteca base y queda fuera del catálogo.
                  Crate nunca cambia la fuente y pausa ante modificaciones inesperadas en el destino.
                </p>
                <div className="library-setup-source-chip">
                  <Icon name={library.provider === 'onedrive' ? 'cloud' : 'folder'} size={14} />
                  <span><small>Biblioteca base</small><strong>{library.name}</strong></span>
                </div>
              </div>
              <LibraryLocationPicker
                role="backup"
                source={library}
                onCreated={location => {
                  setBackup(location)
                  setStep('ready')
                }}
              />
              <div className="library-setup-skip">
                <span>Podés configurar un backup más adelante desde Ajustes.</span>
                <button className="btn ghost" type="button" onClick={() => setStep('ready')}>
                  Continuar sin backup <Icon name="chevR" size={12} />
                </button>
              </div>
            </div>
          )}

          {step === 'ready' && library && (
            <div className="library-setup-stage ready">
              <div className="library-setup-intro">
                <span className="library-setup-kicker">03 · Todo listo</span>
                <h1 id="library-setup-title" ref={headingRef} tabIndex={-1}>Tu biblioteca ya tiene una ruta clara.</h1>
                <p>
                  Crate empezará a indexar la biblioteca base. Podés cambiar estas ubicaciones y revisar
                  cada ejecución del espejo desde Ajustes → Bibliotecas.
                </p>
              </div>
              <div className={`library-setup-route ${backup ? 'with-backup' : ''}`}>
                <LocationSummary location={library} />
                <div className="library-setup-route-line" aria-hidden="true">
                  <i />
                  <Icon name={backup ? 'sync' : 'check'} size={14} />
                </div>
                {backup ? (
                  <LocationSummary location={backup} backup />
                ) : (
                  <div className="library-setup-no-backup">
                    <span><Icon name="plus" size={15} /></span>
                    <strong>Sin backup por ahora</strong>
                    <small>Tu biblioteca sigue funcionando normalmente.</small>
                  </div>
                )}
              </div>
              <div className="library-setup-finish">
                <div><Icon name="info" size={14} /><span>El primer análisis puede continuar en segundo plano.</span></div>
                <button className="btn primary" type="button" disabled={finishing} onClick={() => { void complete() }}>
                  {finishing ? 'Preparando Crate…' : 'Entrar a Crate'} <Icon name="chevR" size={12} />
                </button>
              </div>
            </div>
          )}
        </main>

        <footer className="library-setup-footer">
          <span><Icon name="computer" size={12} /> Los archivos de origen permanecen donde están.</span>
          <span>Bibliotecas normales por defecto · Backup solo por elección explícita</span>
        </footer>
      </section>
    </div>
  )
}
