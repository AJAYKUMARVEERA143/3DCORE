import { Suspense } from 'react'
import { Canvas } from '@react-three/fiber'
import { Grid, OrbitControls } from '@react-three/drei'
import { RoomBlock } from './RoomBlock'

type ViewerProps = {
  roomSize: [number, number, number]
}

export function Viewer({ roomSize }: ViewerProps) {
  return (
    <Canvas shadows camera={{ position: [6, 6, 8], fov: 50 }}>
      <Suspense fallback={null}>
        <color attach="background" args={['#1a1b1f']} />
        <hemisphereLight args={['#dfe9ff', '#2a2a30', 0.6]} />
        <directionalLight
          position={[5, 8, 5]}
          intensity={1.2}
          castShadow
          shadow-mapSize={[2048, 2048]}
        />

        <Grid
          args={[40, 40]}
          cellSize={0.5}
          cellThickness={0.5}
          sectionSize={5}
          sectionThickness={1}
          fadeDistance={30}
          infiniteGrid
        />

        <RoomBlock position={[0, 0, 0]} size={roomSize} />

        <OrbitControls makeDefault minDistance={2} maxDistance={40} />
      </Suspense>
    </Canvas>
  )
}
