const FRAME_DEPTH = 0.06
const CURTAIN_WIDTH = 0.35
const CURTAIN_TOP_GAP = 0.25

type WindowBlockProps = {
  position: [number, number, number]
  /** Rotate the window to face outward from a side wall instead of a front/back wall. */
  rotationY?: number
  /** [width, height] of the window opening, in meters. */
  size?: [number, number]
}

/** A parametric window: frame, glass pane, curtain rod, and two curtain panels. */
export function WindowBlock({ position, rotationY = 0, size = [1.2, 1.4] }: WindowBlockProps) {
  const [x, y, z] = position
  const [width, height] = size
  const curtainHeight = height + CURTAIN_TOP_GAP + 0.15

  return (
    <group position={[x, y, z]} rotation={[0, rotationY, 0]}>
      <mesh castShadow>
        <boxGeometry args={[width + 0.1, height + 0.1, FRAME_DEPTH]} />
        <meshStandardMaterial color="#eef1f4" roughness={0.7} />
      </mesh>

      <mesh position={[0, 0, FRAME_DEPTH / 2 + 0.005]}>
        <planeGeometry args={[width - 0.05, height - 0.05]} />
        <meshPhysicalMaterial color="#bcd7e6" transparent opacity={0.35} roughness={0.05} />
      </mesh>

      <mesh
        position={[0, height / 2 + CURTAIN_TOP_GAP / 2, FRAME_DEPTH / 2 + 0.08]}
        rotation={[0, 0, Math.PI / 2]}
        castShadow
      >
        <cylinderGeometry args={[0.015, 0.015, width + CURTAIN_WIDTH * 1.6, 12]} />
        <meshStandardMaterial color="#3a3b42" metalness={0.6} roughness={0.4} />
      </mesh>

      <mesh
        position={[-(width / 2 + CURTAIN_WIDTH / 2 - 0.05), -0.1, FRAME_DEPTH / 2 + 0.08]}
        castShadow
      >
        <boxGeometry args={[CURTAIN_WIDTH, curtainHeight, 0.04]} />
        <meshStandardMaterial color="#a85c3f" roughness={0.9} />
      </mesh>
      <mesh
        position={[width / 2 + CURTAIN_WIDTH / 2 - 0.05, -0.1, FRAME_DEPTH / 2 + 0.08]}
        castShadow
      >
        <boxGeometry args={[CURTAIN_WIDTH, curtainHeight, 0.04]} />
        <meshStandardMaterial color="#a85c3f" roughness={0.9} />
      </mesh>
    </group>
  )
}
