type CeilingLightProps = {
  position: [number, number, number]
}

/** A flush-mount ceiling fixture: a glowing disc plus the point light it casts. */
export function CeilingLight({ position }: CeilingLightProps) {
  const [x, y, z] = position

  return (
    <group position={[x, y, z]}>
      <mesh>
        <cylinderGeometry args={[0.18, 0.18, 0.04, 24]} />
        <meshStandardMaterial color="#f5f4ef" roughness={0.5} emissive="#fff6df" emissiveIntensity={0.5} />
      </mesh>
      <pointLight position={[0, -0.05, 0]} color="#fff3d6" intensity={1.8} distance={8} decay={2} castShadow />
    </group>
  )
}
