import { Suspense } from 'react'
import { Canvas } from '@react-three/fiber'
import { Grid, OrbitControls } from '@react-three/drei'
import { RoomBlock } from './RoomBlock'
import { BedBlock } from './BedBlock'
import { FLOOR_MATERIALS, WALL_MATERIALS } from '../materials'
import { BED_FOOTPRINT } from '../furniture'

type ViewerProps = {
  roomSize: [number, number, number]
  floorMaterialId: string
  wallMaterialId: string
}

const BED_MARGIN = 0.3

export function Viewer({ roomSize, floorMaterialId, wallMaterialId }: ViewerProps) {
  const floorMaterial = FLOOR_MATERIALS.find((m) => m.id === floorMaterialId) ?? FLOOR_MATERIALS[0]
  const wallMaterial = WALL_MATERIALS.find((m) => m.id === wallMaterialId) ?? WALL_MATERIALS[0]

  const [roomWidth, , roomDepth] = roomSize
  const bedX = -roomWidth / 2 + BED_FOOTPRINT.width / 2 + BED_MARGIN
  const bedZ = -roomDepth / 2 + BED_FOOTPRINT.length / 2 + BED_MARGIN
  const lampPosition: [number, number, number] = [bedX + BED_FOOTPRINT.width / 2 + 0.4, 1, bedZ]

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
        <pointLight position={lampPosition} color="#ffd9a0" intensity={0.8} distance={4} />

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

        <OrbitControls makeDefault minDistance={2} maxDistance={40} />
      </Suspense>
    </Canvas>
  )
}
