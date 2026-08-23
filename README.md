# 3D Core Studio

A browser-based CAD/3D editor styled after Blender, SketchUp, AutoCAD, and V-Ray — real modeling, sculpting, materials, and rendering tools running entirely client-side, served by a dependency-free Python backend.

No build step. No `npm install`. No native app to install — open a browser tab and start modeling.

## Highlights

- **SketchUp-style drawing** — Line, Rectangle, Circle, Arc, Polygon, Pie, Wall/Slab/Opening (BIM), with real on-face detection (drawing directly on a tilted/rotated surface follows that face's own plane), axis inference, arrow-key direction lock, and typed numeric length entry.
- **Full mesh-edit toolset** — Extrude (Region/Along Normals/Individual/to Cursor), Inset, Bevel, Shrink/Fatten, To Sphere, Subdivide, Smooth, Randomize, Spin, Follow Me, Vertex/Edge Slide, Bisect, Knife, Loop Cut, Poly Build, real boolean CSG (Union/Subtract/Intersect), and combinable Vertex/Face/Edge selection modes.
- **Real sculpting** — all 16 Blender-style brushes (Draw, Clay, Grab, Snake Hook, Smooth, Flatten, Mask, Draw Face Sets, and more), each a genuinely distinct algorithm.
- **Materials** — a 96-material PBR library across 12 categories, real per-face application (paint one surface without recoloring the whole object), animated preview thumbnails, drag-and-drop.
- **Lighting & rendering** — Point/Spot/Directional/Area lights, a Day/Night sun system, shadow quality tiers, SSAO, Bloom, procedural HDRI environment lighting.
- **Present mode** — F5 / Present tab: hide modeling chrome, camera slides, 2×/4× PNG stills, slide-path WebM. Draft / Balanced / Present quality ladder cuts GPU load while you model.
- **Real-time LAN P2P render pool** — distribute a render job across multiple machines on the same network over genuine WebRTC data channels.
- **AI Assistant** — natural-language modeling commands that call real tool functions (via a user-supplied Anthropic or OpenAI API key).
- **Document persistence** — Quick Save/Load (IndexedDB), Save/Open Project (`.3dcore.json`), GLB import/export, full undo/redo.

## Quick start

Requires Python 3 (standard library only — nothing to `pip install`).

```bash
# macOS/Linux
./scripts/run.sh

# Windows
scripts\run.ps1
```

Then open **http://127.0.0.1:8000** in a browser.

The server also starts a WebSocket signaling relay on `PORT + 1` for the LAN P2P render pool. Both the port and bind address are configurable via the `PORT` and `THREED_CORE_HOST` environment variables (or the `-Port`/`-HostAddress` parameters on `run.ps1`).

## Project structure

```
server.py       Dependency-free Python HTTP + WebSocket server (static hosting, asset catalog, AI proxy)
web/            The entire client application
  index.html    UI layout
  css/style.css Styling
  js/app.js     Application logic — scene, tools, rendering, persistence
assets/         Local asset catalogs (materials, sample models) used by the Asset Library
docs/           Project documentation
  ROADMAP.md    The real running log — architecture, every feature, every bug found and fixed, with verification notes
scripts/        Launch scripts (run.sh / run.ps1)
```

## Documentation

- **How the product is supposed to work** (Present, images/video/VR/AR, import/export): `docs/PRODUCT_FLOW.md`
- Running log of what is built and what is still open: `docs/ROADMAP.md`
- Render quality + VR/AR build plan: `docs/RENDER_XR_PLAN.md`

## Design philosophy

This is not a fork of Blender, Chili3D, or any other reference project — those inform the design but aren't embedded or required. Every feature listed above is real and independently verified (typically via scripted browser tests asserting exact values, not just "it didn't crash"); features that turned out to be approximations or scoped-down versions of their real-world counterparts are documented as such in the roadmap rather than presented as complete.
