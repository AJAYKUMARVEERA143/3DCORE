# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

3DCORE is a lightweight, browser-based 3D viewer aimed at architects, interior designers, and civil/mechanical engineers. It runs entirely client-side — no backend, no native CAD install. The stack is intentionally minimal: React + TypeScript on Vite, with Three.js (via `@react-three/fiber`/`@react-three/drei`) for the 3D scene.

## Commands

```bash
npm install       # install dependencies
npm run dev        # start the dev server (Vite)
npm run build       # typecheck (tsc -b) then production build
npm run lint        # lint with oxlint
npm run preview     # serve the production build locally
```

There is no test suite yet. When one is added, update this section with how to run it (and a single test).

## Architecture

- `src/main.tsx` — React entry point, mounts `<App />`.
- `src/App.tsx` — owns app-level state (e.g. current room dimensions) and composes the `Viewer` with `ui/` panels; keep this as a thin composition root, not a place for scene logic.
- `src/viewer/Viewer.tsx` — the `@react-three/fiber` `<Canvas>` scene: camera, lighting, the infinite reference grid, and `OrbitControls`. Takes scene state (e.g. `roomSize`) as props from `App` rather than owning it. This is where new scene-level elements (additional lights, environment, scene graph roots) get wired in.
- `src/viewer/RoomBlock.tsx` — a parametric room-shell primitive: floor slab, opaque ceiling slab, and translucent wall box (+ wireframe edges), sized in meters via `position`/`size` props, with `floorMaterial`/`wallMaterial` props (see `src/materials.ts`). The floor uses a procedural tile texture (`src/textures.ts`) when the material's `pattern` is `'tile'`. This is the seed for what will become the library of architectural primitives — new primitives should follow the same pattern: a typed props object describing real-world dimensions, rendered as plain Three.js meshes.
- `src/viewer/BedBlock.tsx` — furniture primitive (frame, mattress, pillow, headboard), same parametric-primitive pattern; sized to `BED_FOOTPRINT` in `src/furniture.ts`.
- `src/viewer/WindowBlock.tsx` — a window primitive (frame, glass pane, rod, curtain panels) built in a local XY plane and placed against a wall via `position`/`rotationY`.
- `src/viewer/CeilingLight.tsx` — a flush-mount ceiling fixture: an emissive disc plus the `pointLight` it casts.
- Furniture/fixture footprint constants live in `src/furniture.ts` (not the component files) so they can be imported by `Viewer` for placement without breaking Fast Refresh (oxlint's `react/only-export-components` flags exporting a constant alongside a component).
- `src/materials.ts` — procedural color/roughness presets for room surfaces (no texture images — see the no-external-assets convention below). `Viewer` resolves a selected material id to a preset and passes it down to `RoomBlock`.
- `src/textures.ts` — generates simple patterned textures (e.g. floor tiles) on an in-memory `<canvas>` at runtime, wrapped as a `CanvasTexture`. This is how to add surface patterns without violating the no-external-assets rule.
- `src/ui/` — plain HTML/CSS overlay panels rendered on top of the `<Canvas>` (e.g. `DimensionsPanel.tsx`, `MaterialsPanel.tsx`) for controls that don't belong in the 3D scene itself. No UI component library — inline styles, consistent with the lightweight-dependency convention below.
- The `Viewer`'s camera starts inside the room (eye height ~1.6m) rather than outside looking in; `OrbitControls` still lets it orbit/zoom freely from there. Lighting is ambient + hemisphere + a directional "sun" + a couple of point lights (bedside lamp, ceiling fixture), with `ACESFilmicToneMapping` on the renderer for a more realistic (less flat) look — all still plain Three.js lights, no image-based/HDR lighting.

### Conventions

- Scene units are meters; primitives take real-world dimensions as props rather than hardcoded geometry.
- Do not add external asset/CDN dependencies (e.g. drei's `<Environment preset="...">` HDR presets) — they fail in offline/sandboxed environments and go against the "runs entirely in the browser, nothing external required" goal. Light scenes with plain Three.js lights instead.
- Keep the dependency footprint light — this project deliberately avoids a heavier CAD/3D framework in favor of Three.js primitives directly.
