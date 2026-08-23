import { CanvasTexture, RepeatWrapping, SRGBColorSpace } from 'three'

/**
 * Procedurally draws a tiled-floor pattern (square tiles + grout lines) onto a canvas
 * and wraps it as a Three.js texture — generated in-code, no external image files.
 */
export function createTileTexture(baseColor: string, groutColor: string, tilesPerMeter = 2): CanvasTexture {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return new CanvasTexture(canvas)

  ctx.fillStyle = groutColor
  ctx.fillRect(0, 0, size, size)

  const tileSize = size / tilesPerMeter
  const inset = 3
  ctx.fillStyle = baseColor
  for (let row = 0; row < tilesPerMeter; row++) {
    for (let col = 0; col < tilesPerMeter; col++) {
      ctx.fillRect(col * tileSize + inset, row * tileSize + inset, tileSize - inset * 2, tileSize - inset * 2)
    }
  }

  const texture = new CanvasTexture(canvas)
  texture.wrapS = RepeatWrapping
  texture.wrapT = RepeatWrapping
  texture.colorSpace = SRGBColorSpace
  return texture
}
