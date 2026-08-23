type DimensionsPanelProps = {
  size: [number, number, number]
  onChange: (size: [number, number, number]) => void
}

const FIELDS: { label: string; index: 0 | 1 | 2; min: number; max: number; step: number }[] = [
  { label: 'Width', index: 0, min: 1, max: 20, step: 0.1 },
  { label: 'Height', index: 1, min: 2, max: 6, step: 0.1 },
  { label: 'Depth', index: 2, min: 1, max: 20, step: 0.1 },
]

export function DimensionsPanel({ size, onChange }: DimensionsPanelProps) {
  const setDimension = (index: 0 | 1 | 2, value: number) => {
    const next: [number, number, number] = [...size]
    next[index] = value
    onChange(next)
  }

  return (
    <div
      style={{
        position: 'absolute',
        top: 16,
        left: 16,
        background: 'rgba(26, 27, 31, 0.85)',
        border: '1px solid #3a3b42',
        borderRadius: 8,
        padding: '12px 16px',
        color: '#e8ecf1',
        fontFamily: 'system-ui, sans-serif',
        fontSize: 13,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Room dimensions (m)</div>
      {FIELDS.map(({ label, index, min, max, step }) => (
        <label key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
          <span style={{ width: 48 }}>{label}</span>
          <input
            type="number"
            value={size[index]}
            min={min}
            max={max}
            step={step}
            onChange={(e) => {
              const value = e.target.valueAsNumber
              if (!Number.isNaN(value)) {
                setDimension(index, Math.min(max, Math.max(min, value)))
              }
            }}
            style={{ width: 64 }}
          />
        </label>
      ))}
    </div>
  )
}
