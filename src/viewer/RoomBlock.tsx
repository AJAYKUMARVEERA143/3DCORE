import { useMemo } from 'react'
import { BoxGeometry } from 'three'

type RoomBlockProps = {
  position: [number, number, number]
  size: [number, number, number]
}

/** A parametric room shell: a floor slab plus a translucent wall box, sized in meters. */
export function RoomBlock({ position, size }: RoomBlockProps) {
  const [width, height, depth] = size
  const [x, y, z] = position
  const wallGeometry = useMemo(() => new BoxGeometry(width, height, depth), [width, height, depth])

  return (
    <group position={[x, y, z]}>
      <mesh position={[0, 0.02, 0]} receiveShadow>
        <boxGeometry args={[width, 0.04, depth]} />
        <meshStandardMaterial color="#c9c2b4" />
      </mesh>

      <mesh position={[0, height / 2, 0]} castShadow>
        <boxGeometry args={[width, height, depth]} />
        <meshStandardMaterial color="#7fb0e0" transparent opacity={0.18} />
      </mesh>

      <lineSegments position={[0, height / 2, 0]}>
        <edgesGeometry args={[wallGeometry]} />
        <lineBasicMaterial color="#e8ecf1" />
      </lineSegments>
    </group>
  )
}
