import { useMemo } from 'react'
import { BoxGeometry } from 'three'
import type { MaterialPreset } from '../materials'
import { createTileTexture } from '../textures'

/** Standard interior wall thickness: 6 inches, in meters. */
export const WALL_THICKNESS = 0.1524

type RoomBlockProps = {
  position: [number, number, number]
  size: [number, number, number]
  floorMaterial: MaterialPreset
  wallMaterial: MaterialPreset
}

/** A parametric room shell: floor, ceiling, and four walls (6" thick), sized in meters. */
export function RoomBlock({ position, size, floorMaterial, wallMaterial }: RoomBlockProps) {
  const [width, height, depth] = size
  const [x, y, z] = position
  const outlineGeometry = useMemo(() => new BoxGeometry(width, height, depth), [width, height, depth])

  const floorTexture = useMemo(() => {
    if (floorMaterial.pattern !== 'tile') return null
    const texture = createTileTexture(floorMaterial.color, '#8c8a84')
    texture.repeat.set(width, depth)
    return texture
  }, [floorMaterial.pattern, floorMaterial.color, width, depth])

  const wallMaterialProps = {
    color: wallMaterial.color,
    roughness: wallMaterial.roughness,
    transparent: true,
    opacity: 0.22,
  } as const

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

      {/* front & back walls (centered on the room's z boundary) */}
      <mesh position={[0, height / 2, depth / 2]} castShadow>
        <boxGeometry args={[width, height, WALL_THICKNESS]} />
        <meshStandardMaterial {...wallMaterialProps} />
      </mesh>
      <mesh position={[0, height / 2, -depth / 2]} castShadow>
        <boxGeometry args={[width, height, WALL_THICKNESS]} />
        <meshStandardMaterial {...wallMaterialProps} />
      </mesh>

      {/* left & right walls (centered on the room's x boundary) */}
      <mesh position={[width / 2, height / 2, 0]} castShadow>
        <boxGeometry args={[WALL_THICKNESS, height, depth]} />
        <meshStandardMaterial {...wallMaterialProps} />
      </mesh>
      <mesh position={[-width / 2, height / 2, 0]} castShadow>
        <boxGeometry args={[WALL_THICKNESS, height, depth]} />
        <meshStandardMaterial {...wallMaterialProps} />
      </mesh>

      <lineSegments position={[0, height / 2, 0]}>
        <edgesGeometry args={[outlineGeometry]} />
        <lineBasicMaterial color="#e8ecf1" />
      </lineSegments>
    </group>
  )
}
