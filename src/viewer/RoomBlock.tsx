import { useMemo } from 'react'
import { BoxGeometry } from 'three'
import type { MaterialPreset } from '../materials'
import { createTileTexture } from '../textures'

type RoomBlockProps = {
  position: [number, number, number]
  size: [number, number, number]
  floorMaterial: MaterialPreset
  wallMaterial: MaterialPreset
}

/** A parametric room shell: floor, ceiling, and a translucent wall box, sized in meters. */
export function RoomBlock({ position, size, floorMaterial, wallMaterial }: RoomBlockProps) {
  const [width, height, depth] = size
  const [x, y, z] = position
  const wallGeometry = useMemo(() => new BoxGeometry(width, height, depth), [width, height, depth])

  const floorTexture = useMemo(() => {
    if (floorMaterial.pattern !== 'tile') return null
    const texture = createTileTexture(floorMaterial.color, '#8c8a84')
    texture.repeat.set(width, depth)
    return texture
  }, [floorMaterial.pattern, floorMaterial.color, width, depth])

  return (
    <group position={[x, y, z]}>
      <mesh position={[0, 0.02, 0]} receiveShadow>
        <boxGeometry args={[width, 0.04, depth]} />
        {floorTexture ? (
          <meshStandardMaterial map={floorTexture} roughness={floorMaterial.roughness} />
        ) : (
          <meshStandardMaterial color={floorMaterial.color} roughness={floorMaterial.roughness} />
        )}
      </mesh>

      <mesh position={[0, height - 0.02, 0]} receiveShadow>
        <boxGeometry args={[width, 0.04, depth]} />
        <meshStandardMaterial color="#f7f5ef" roughness={0.95} />
      </mesh>

      <mesh position={[0, height / 2, 0]} castShadow>
        <boxGeometry args={[width, height, depth]} />
        <meshStandardMaterial
          color={wallMaterial.color}
          roughness={wallMaterial.roughness}
          transparent
          opacity={0.22}
        />
      </mesh>

      <lineSegments position={[0, height / 2, 0]}>
        <edgesGeometry args={[wallGeometry]} />
        <lineBasicMaterial color="#e8ecf1" />
      </lineSegments>
    </group>
  )
}
