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
- `src/App.tsx` — renders the `Viewer`; keep this as a thin composition root.
- `src/viewer/Viewer.tsx` — the `@react-three/fiber` `<Canvas>` scene: camera, lighting, the infinite reference grid, and `OrbitControls`. This is where new scene-level elements (additional lights, environment, scene graph roots) get wired in.
- `src/viewer/RoomBlock.tsx` — a parametric room-shell primitive (floor slab + translucent wall box + wireframe edges), sized in meters via `position`/`size` props. This is the seed for what will become the library of architectural primitives (walls, rooms, furniture, etc.) — new primitives should follow the same pattern: a typed props object describing real-world dimensions, rendered as plain Three.js meshes.

### Conventions

- Scene units are meters; primitives take real-world dimensions as props rather than hardcoded geometry.
- Do not add external asset/CDN dependencies (e.g. drei's `<Environment preset="...">` HDR presets) — they fail in offline/sandboxed environments and go against the "runs entirely in the browser, nothing external required" goal. Light scenes with plain Three.js lights instead.
- Keep the dependency footprint light — this project deliberately avoids a heavier CAD/3D framework in favor of Three.js primitives directly.
