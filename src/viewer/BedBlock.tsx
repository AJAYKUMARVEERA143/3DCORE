import { BED_FOOTPRINT } from '../furniture'

const FRAME_HEIGHT = 0.35
const MATTRESS_HEIGHT = 0.25

type BedBlockProps = {
  position: [number, number, number]
}

/** A parametric single bed: frame, mattress, pillow, and headboard. */
export function BedBlock({ position }: BedBlockProps) {
  const [x, y, z] = position
  const { width, length } = BED_FOOTPRINT

  return (
    <group position={[x, y, z]}>
      <mesh position={[0, FRAME_HEIGHT / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[width, FRAME_HEIGHT, length]} />
        <meshStandardMaterial color="#6b4a35" roughness={0.7} />
      </mesh>

      <mesh position={[0, FRAME_HEIGHT + MATTRESS_HEIGHT / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[width * 0.96, MATTRESS_HEIGHT, length * 0.97]} />
        <meshStandardMaterial color="#f2f0ea" roughness={0.9} />
      </mesh>

      <mesh position={[0, FRAME_HEIGHT + MATTRESS_HEIGHT + 0.05, -length / 2 + 0.28]} castShadow>
        <boxGeometry args={[width * 0.8, 0.12, 0.4]} />
        <meshStandardMaterial color="#ffffff" roughness={0.85} />
      </mesh>

      <mesh position={[0, FRAME_HEIGHT + 0.4, -length / 2 - 0.03]} castShadow>
        <boxGeometry args={[width, 0.8, 0.06]} />
        <meshStandardMaterial color="#6b4a35" roughness={0.7} />
      </mesh>
    </group>
  )
}
