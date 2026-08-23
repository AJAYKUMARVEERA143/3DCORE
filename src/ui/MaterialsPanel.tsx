import { FLOOR_MATERIALS, WALL_MATERIALS } from '../materials'

type MaterialsPanelProps = {
  floorMaterialId: string
  wallMaterialId: string
  onFloorChange: (id: string) => void
  onWallChange: (id: string) => void
}

export function MaterialsPanel({
  floorMaterialId,
  wallMaterialId,
  onFloorChange,
  onWallChange,
}: MaterialsPanelProps) {
  return (
    <div
      style={{
        position: 'absolute',
        top: 168,
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
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Materials</div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
        <span style={{ width: 48 }}>Floor</span>
        <select value={floorMaterialId} onChange={(e) => onFloorChange(e.target.value)}>
          {FLOOR_MATERIALS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
        <span style={{ width: 48 }}>Wall</span>
        <select value={wallMaterialId} onChange={(e) => onWallChange(e.target.value)}>
          {WALL_MATERIALS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}
