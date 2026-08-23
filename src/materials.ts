export type MaterialPreset = {
  id: string
  name: string
  color: string
  roughness: number
}

/** Procedural color presets (no external texture assets — keeps the app offline-capable). */
export const FLOOR_MATERIALS: MaterialPreset[] = [
  { id: 'light-wood', name: 'Light Wood', color: '#c9a876', roughness: 0.6 },
  { id: 'dark-wood', name: 'Dark Wood', color: '#5c3d2e', roughness: 0.6 },
  { id: 'tile', name: 'Tile', color: '#d8d8d8', roughness: 0.2 },
  { id: 'concrete', name: 'Concrete', color: '#9a9a9a', roughness: 0.9 },
]

export const WALL_MATERIALS: MaterialPreset[] = [
  { id: 'white', name: 'White', color: '#f2f0eb', roughness: 0.9 },
  { id: 'beige', name: 'Beige', color: '#e8ddc7', roughness: 0.9 },
  { id: 'sage', name: 'Sage', color: '#a9b79e', roughness: 0.9 },
  { id: 'slate', name: 'Slate', color: '#6b7686', roughness: 0.9 },
]
