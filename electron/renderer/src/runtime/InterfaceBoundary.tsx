import { Component, type ReactNode } from 'react'

export class InterfaceBoundary extends Component<{ children: ReactNode; onRecover: () => void }, { error: boolean }> {
  state = { error: false }
  static getDerivedStateFromError() { return { error: true } }
  componentDidCatch(error: unknown) { console.error('[interface] presentation failed:', error) }
  render() {
    if (this.state.error) return <div className="if-recovery" role="alert"><h2>No se pudo mostrar esta interfaz</h2><p>Podés recuperar el diseño anterior conservando tu biblioteca y reproducción.</p><button onClick={this.props.onRecover}>Restaurar interfaz</button></div>
    return this.props.children
  }
}
