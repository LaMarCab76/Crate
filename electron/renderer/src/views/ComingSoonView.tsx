interface Props {
  title: string
  hint: string
}

export function ComingSoonView({ title, hint }: Props) {
  return (
    <div style={{ padding: 36, color: 'var(--text-secondary)' }}>
      <h1 style={{ color: 'var(--text-primary)', fontSize: 24, margin: '0 0 8px' }}>{title}</h1>
      <p>{hint}</p>
    </div>
  )
}
