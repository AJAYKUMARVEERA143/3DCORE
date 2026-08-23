import { useState } from 'react'
import { Viewer } from './viewer/Viewer'
import { DimensionsPanel } from './ui/DimensionsPanel'
import { MaterialsPanel } from './ui/MaterialsPanel'
import { FLOOR_MATERIALS, WALL_MATERIALS } from './materials'

function App() {
  const [roomSize, setRoomSize] = useState<[number, number, number]>([4, 2.6, 5])
  const [floorMaterialId, setFloorMaterialId] = useState(FLOOR_MATERIALS[0].id)
  const [wallMaterialId, setWallMaterialId] = useState(WALL_MATERIALS[0].id)

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <Viewer roomSize={roomSize} floorMaterialId={floorMaterialId} wallMaterialId={wallMaterialId} />
      <DimensionsPanel size={roomSize} onChange={setRoomSize} />
      <MaterialsPanel
        floorMaterialId={floorMaterialId}
        wallMaterialId={wallMaterialId}
        onFloorChange={setFloorMaterialId}
        onWallChange={setWallMaterialId}
      />
    </div>
  )
}

export default App
