import { Suspense } from 'react'
import { Canvas } from '@react-three/fiber'
import { Grid, OrbitControls } from '@react-three/drei'
import { ACESFilmicToneMapping } from 'three'
import { RoomBlock } from './RoomBlock'
import { BedBlock } from './BedBlock'
import { WindowBlock } from './WindowBlock'
import { CeilingLight } from './CeilingLight'
import { FLOOR_MATERIALS, WALL_MATERIALS } from '../materials'
import { BED_FOOTPRINT } from '../furniture'

type ViewerProps = {
  roomSize: [number, number, number]
  floorMaterialId: string
  wallMaterialId: string
}

const BED_MARGIN = 0.3
const EYE_HEIGHT = 1.6

export function Viewer({ roomSize, floorMaterialId, wallMaterialId }: ViewerProps) {
  const floorMaterial = FLOOR_MATERIALS.find((m) => m.id === floorMaterialId) ?? FLOOR_MATERIALS[0]
  const wallMaterial = WALL_MATERIALS.find((m) => m.id === wallMaterialId) ?? WALL_MATERIALS[0]

  const [roomWidth, roomHeight, roomDepth] = roomSize
  const bedX = -roomWidth / 2 + BED_FOOTPRINT.width / 2 + BED_MARGIN
  const bedZ = -roomDepth / 2 + BED_FOOTPRINT.length / 2 + BED_MARGIN
  const lampPosition: [number, number, number] = [bedX + BED_FOOTPRINT.width / 2 + 0.4, 1, bedZ]

  // Window on the wall opposite the bed's side, letting light in away from the headboard.
  // Centered within the wall's 6" thickness.
  const windowPosition: [number, number, number] = [roomWidth / 2, roomHeight / 2, roomDepth * 0.1]

  // Start the camera inside the room, near the corner opposite the bed, looking toward it.
  const insideCameraPosition: [number, number, number] = [roomWidth / 2 - 1, EYE_HEIGHT, roomDepth / 2 - 1]

  return (
    <Canvas
      shadows
      camera={{ position: insideCameraPosition, fov: 60, near: 0.05 }}
      gl={{ toneMapping: ACESFilmicToneMapping, toneMappingExposure: 1.4 }}
    >
      <Suspense fallback={null}>
        <color attach="background" args={['#1a1b1f']} />
        <ambientLight intensity={0.4} />
        <hemisphereLight args={['#dfe9ff', '#4a4b52', 0.85]} />
        <directionalLight
          position={[5, 8, 5]}
          intensity={1.4}
          castShadow
          shadow-mapSize={[2048, 2048]}
        />
        <pointLight position={lampPosition} color="#ffd9a0" intensity={1} distance={4.5} />
        <CeilingLight position={[0, roomHeight - 0.1, 0]} />

        <Grid
          args={[40, 40]}
          cellSize={0.5}
          cellThickness={0.5}
          sectionSize={5}
          sectionThickness={1}
          fadeDistance={30}
          infiniteGrid
        />

        <RoomBlock
          position={[0, 0, 0]}
          size={roomSize}
          floorMaterial={floorMaterial}
          wallMaterial={wallMaterial}
        />
        <BedBlock position={[bedX, 0, bedZ]} />
        <WindowBlock position={windowPosition} rotationY={Math.PI / 2} />

        <OrbitControls makeDefault target={[0, 1.2, 0]} minDistance={0.5} maxDistance={40} />
      </Suspense>
    </Canvas>
  )
}
