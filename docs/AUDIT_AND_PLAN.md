# 3D Core Studio — Full audit + feature plan

Audit date: 2026-08-23. This is a read of the repo as it exists on `main`, not a marketing summary.

---

## 1. What this project actually is

**3D Core Studio** is a **browser-first CAD / 3D modeling app**. You start a tiny Python HTTP server (`server.py`), open `http://127.0.0.1:8000`, and the whole editor runs in the browser (Three.js r128 from CDNs). No npm, no native installer.

Product intent (from `docs/ROADMAP.md`): a compact editor for **civil, mechanical, and asset-placement** work — SketchUp-style drawing + Blender-style mesh/sculpt tools + a small BIM set — **not** a Blender fork and **not** a real Cycles path tracer.

The **real product** lives here:

| Path | Role | Size |
| --- | --- | --- |
| `web/js/app.js` | Entire client: scene, tools, CSG, sculpt, materials, P2P, persistence | ~9,500 lines (one file) |
| `web/index.html` | Full Blender-like chrome (menus, workspaces, panels) | ~950 lines |
| `web/css/style.css` | Dark UI | ~1,100 lines |
| `server.py` | Stdlib static host + asset catalog + AI proxy + WebSocket P2P signaling | ~675 lines |
| `scripts/run.sh` / `run.ps1` | Launchers | small |
| `assets/TexVerse/` | 10 real `.glb` models for the Asset Library | on disk |
| `docs/ROADMAP.md` | Authoritative running log of real features and real bugs | ~300 lines |

---

## 2. Two codebases — only one is the app

This is the most important audit finding.

### Layer A — real (use this)

The browser app. Drawing, mesh edit, sculpt, CSG booleans, walls/slabs/openings, materials, lights, SSAO/bloom/HDRI, IndexedDB save, GLB I/O, LAN WebRTC tile render, AI tool-calling (with a user API key). Documented in the README and ROADMAP as independently verified (often Playwright exact-value checks).

### Layer B — demo / fiction (do not treat as product)

These print success and return fake JSON. They are **not** wired to the browser:

- `main.py` — orchestrator that claims “all 5 phases operating successfully”
- `src/rendering/viewport_renderer.py` — print-only “HYBRID raytrace”
- `src/ai_engine/smart_drawing_snapper.py` — toy stroke classifier
- `src/ai_engine/prompt_builder.py` — fake mesh synthesis (`mesh_polygon_count: 12400`)
- `src/cad_parser/dxf_extruder.py` — **hardcoded** 4 walls + 2 openings; never reads a DXF file
- `src/ui/asset_library.py` — print-only “cloud hub”
- `src/p2p_network/gpu_collector.py` — claims **128 GPU nodes** and 0.8s raytrace
- `src/core/engine.cpp` — cout “Vulkan/WebGPU” stub, not compiled or used

`server.py` still exposes unused prototype POSTs that return canned success: `/api/snap`, `/api/extrude`, `/api/ai-generate`, `/api/gpu-render`, `/api/boolean`, `/api/export`. ROADMAP already warns these must stay labelled as prototypes or be removed.

`CLAUDE.md` is **stale**: it still says the repo is a one-line README scaffold. That will mislead any future agent.

`download_datasets.py` hardcodes `LOCAL_ASSETS = r'd:\3D_Core\assets'` (a Windows path). It cannot run as-is on this Linux checkout.

**Playwright tests are described in ROADMAP (`test.js`, `test_sculpt_and_edit.js`, …) but none of those files are in this git tree.** Verification history exists as prose, not as runnable CI.

---

## 3. What is already real (do not rebuild)

Keep these; they are the product:

- SketchUp drawing: Line, Rectangle, Circle, Arc, Polygon, Pie, Wall, Slab, Opening; on-face drawing; axis lock; VCB numeric entry; inference (vertex/edge/axis/tangent); auto-face on closed loops
- Mesh edit: extrude variants, inset, bevel, shrink/fatten, to-sphere, subdivide, smooth, randomize, spin, follow-me, slides, bisect/knife/loop-cut (scoped), poly build, CSG union/subtract/intersect/hollow, combinable V/E/F select
- 16 distinct sculpt brushes + picker UI
- 96 PBR materials, per-face paint, drag-and-drop, animated thumbs
- Lights (point/spot/dir/area), day/night sun, shadow tiers, SSAO, bloom, procedural IBL
- Persistence: undo/redo, `.3dcore.json`, IndexedDB quick save vs session autosave, GLB import/export
- LAN P2P tile render over WebRTC (signaling on `PORT+1`)
- AI Assistant: curated tools only, key stays on disk
- Dockable layout, ViewCube, command line, asset library of real GLBs

Honest limitations already documented: Bevel is extrude+inset not a half-edge chamfer; Bisect/Knife/Loop Cut are scoped; Cloth sculpt is not a physics solver; “Cycles Render” / “RAYTRACE” is enhanced WebGL, not path tracing; object-mode box/circle select is **single-object**; AI does not yet tag provenance.

---

## 4. Decorative or incomplete UI (looks like a feature, isn’t)

These should be completed or removed so the app does not lie:

| Control | Reality |
| --- | --- |
| Mode dropdown **Texture Paint** | Sets `currentInteractionMode` only. No paint engine. ROADMAP lists Weight/Texture Paint as out of scope. |
| Header **Scene \| ViewLayer** | Static text |
| Viewport **View / Select / Object** | No menus. **Add** only adds a cube |
| **🌐 Global** and **🧲 Snap: 3D Grid** | Labels only. Grid snap is listed as **still open** in Phase 2 |
| Shading sphere titled **Rendered (Cycles Path Tracer)** | Tone mapping + post, not Cycles |
| Workspace tab **Cycles Render** | Marketing name vs WebGL quality panel |
| Python `src/` + `main.py` | Demo prints |

---

## 5. What the product should become (features I recommend)

The user asked: *inka em em kavali — nuvve alochinchi plan cheyyi* (what else is needed — you decide).

The identity is **fast architectural / interior / mechanical layout in a browser**, not “Blender in a tab.” Next work should deepen **precision + BIM + honesty**, not add more fake render claims.

### Pillar 0 — Integrity (do this first)

Without this, every new feature sits on a confusing dual story.

1. Update `CLAUDE.md` to match the real stack (how to run, where code lives, what not to trust).
2. Isolate or delete Layer B (`src/`, `main.py`) **or** mark them `prototype/` with a README that says they are not the app.
3. Remove unused `/api/snap|extrude|ai-generate|gpu-render|boolean|export` **or** return 501 with an explicit “not implemented” body (never `"SUCCESS"`).
4. Check Playwright tests into the repo and add a minimal CI job (Python compile + JS syntax + one smoke test).
5. Split `app.js` by domain (scene, sketch, mesh, sculpt, render, persist, ai, p2p) **without** changing behavior — the 9.5k-line file is the main maintenance risk.

### Pillar 1 — Precision CAD (highest user value)

The UI already advertises snap. Civil/mechanical users cannot work without it.

1. **Real grid + increment snap** — toggle, grid size in current units, snap transforms and sketch points. Wire the “Snap: 3D Grid” chip.
2. **Object multi-select** — Shift-click, box/circle select all hits, inspector shows count; boolean/group/align operate on the set. ROADMAP already calls this an architecture change (`selectedObject` is singular).
3. **Dimension annotations** — persistent linear/aligned/angular dims that update when geometry moves (Tape Measure is a one-shot guide today).
4. **DXF import → walls** — parse real LINE/LWPOLYLINE/CIRCLE; map to existing Wall/Slab/Opening tools. **Do not** ship the current hardcoded four-wall fake parser as if it were CAD.
5. Edit-mode gaps that matter daily: **loop/ring select**, **Fill (F)**, **proportional editing** (falloff while transform).

Leave out for now (ROADMAP already scoped out): Grease Pencil, node editor, sequencer, full half-edge Knife, OCCT/STEP until a lazy WASM adapter is justified.

### Pillar 2 — BIM / interiors (matches civil + furniture placement)

Walls/slabs/openings exist; a building workflow does not.

1. **Levels / storeys** — Z-height layers, isolate floor, duplicate storey.
2. **Rooms** — closed wall loops → room volume, floor area, ceiling height readout.
3. **Door/window as components** — opening already cuts a hole; add a real door/window mesh instance with width/height/sill from presets, swap-able.
4. **Schedules** — table of walls (length), openings (count/size), rooms (area). Export CSV.
5. **Align / distribute** furniture from the Asset Library on a floor face (snap to floor + wall).

### Pillar 3 — Materials & look (honest photoreal, not “Cycles”)

1. Rename **Cycles / path tracer** copy to **Rendered / Quality** everywhere.
2. Use **Dream Textures** as real image maps if the parquet can yield PNGs; otherwise drop the unused catalog API.
3. Interior lighting presets (overcast, dusk, studio three-point) on top of the existing sun/area lights.
4. Simple **camera objects** + saved views (the 3D cursor was removed because it was fake; a real cursor + spawn point is still useful).

### Pillar 4 — AI that matches the tools you already have

The assistant is real but narrow (`add_primitive`, a few mesh ops, 8 legacy material names).

1. Tools for **Wall / Opening / Boolean / import asset / set units**.
2. Point the material tool at the **96-material library**, not only the old 8 presets.
3. Tag AI-created objects in `userData` (provenance — already listed as not done).
4. Do **not** add “text-to-mesh synthesis” unless a real generator is integrated. The Python prompt builder is fiction.

### Pillar 5 — Platform

1. **PWA** (manifest + service worker) after assets are cacheable — Phase 5 in ROADMAP.
2. Fix `download_datasets.py` to use repo-relative `assets/`.
3. Optional Tauri wrapper **only** if desktop file-association is required; same web bundle.
4. Touch: wall/draw tools already matter on tablet; test Android Chrome / iPad Safari for VCB and docking.

---

## 6. Suggested delivery order

Do not estimate calendar time. Order is dependency-based.

| Wave | Scope | Why this order |
| --- | --- | --- |
| **A** | Docs honesty + delete/501 stub APIs + quarantine `src/` + `CLAUDE.md` | Stops fake SUCCESS and dual-architecture confusion |
| **B** | Check in tests + CI smoke | Every later mesh/BIM change needs a regression net |
| **C** | Grid snap + multi-select | Unlocks precise CAD and BIM ops |
| **D** | Split `app.js` modules | Makes C/E/F reviewable |
| **E** | Dimensions + DXF → Wall | Core civil workflow |
| **F** | Levels, rooms, door/window components, schedules | Product differentiation vs generic mesh editor |
| **G** | AI tool expansion + rename Cycles | Same power, honest labels |
| **H** | PWA + dataset script + lighting presets | Distribution and polish |

Wave A is small and should land before any large feature PR.

**Rendering / VR / AR** is planned separately in `docs/RENDER_XR_PLAN.md` (Draft/Balanced/Present GPU ladder, WebXR VR, ARCore + iOS Quick Look). That plan does **not** add a second native engine.

**User-facing flow** (Present mode, stills/video/VR/AR, import/export): `docs/PRODUCT_FLOW.md`.

---

## 7. Explicitly out of scope (do not build)

- Claiming **Cycles GPU / 128 P2P nodes / VRAM telemetry / OIDN** in the browser
- Copying Blender, Chili3D, or Pascal Editor source
- Full OCCT/STEP in v1
- Texture/weight paint (dropdown should go until a real brush exists)
- A second native C++/Vulkan engine (`engine.cpp`)

---

## 8. How to run (for the next implementer)

```bash
./scripts/run.sh          # then http://127.0.0.1:8000
# optional: PORT=8000 THREED_CORE_HOST=127.0.0.1
```

Python 3 stdlib only. Do not run `main.py` expecting the editor — it is the demo layer.

---

## 9. One-line Telugu summary

Ippudu unnadi **browser lo nijamaina SketchUp+Blender-style 3D editor**. Python `src/` files **fake demos**. Mundu **honesty + grid snap + multi-select + DXF/BIM rooms**; Cycles ane peru **maarchali**; path tracer / 128 GPUs **vaddu**.
