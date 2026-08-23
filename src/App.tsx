import { useState } from 'react'
import { Viewer } from './viewer/Viewer'
import { DimensionsPanel } from './ui/DimensionsPanel'

function App() {
  const [roomSize, setRoomSize] = useState<[number, number, number]>([4, 2.6, 5])

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <Viewer roomSize={roomSize} />
      <DimensionsPanel size={roomSize} onChange={setRoomSize} />
    </div>
  )
}

export default App
