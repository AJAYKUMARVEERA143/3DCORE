# AGENTS.md

Guidance for working in this repository.

## What this is

**3D Core Studio** is a browser-based CAD/3D editor (SketchUp-style drawing, Blender-style mesh/sculpt, small BIM set, WebGL rendering). The editor is **client-side**. A dependency-free Python server only hosts files, local asset catalogs, an AI API-key proxy, and LAN WebRTC signaling.

Authoritative feature history and known limitations: `docs/ROADMAP.md`.
Full architecture audit and recommended next features: `docs/AUDIT_AND_PLAN.md`.
Latest bug audit and fixes: `docs/BUG_AUDIT.md`.
Lightweight render engine + VR/AR plan: `docs/RENDER_XR_PLAN.md`.
User-facing product flow (Present, outputs, formats): `docs/PRODUCT_FLOW.md`.

## How to run

Requires Python 3 (standard library only — no `pip install` for the app).

```bash
./scripts/run.sh                 # macOS/Linux → http://127.0.0.1:8000
# Windows: scripts\run.ps1
```

Optional env: `PORT` (default 8000), `THREED_CORE_HOST` (default `0.0.0.0` for LAN P2P). Signaling WebSocket listens on `PORT + 1`.

**Desktop (Electron) build** — an additive packaging layer, not a second implementation of the editor: `web/` is loaded completely unchanged; `electron/server.js` is a Node port of `server.py`'s real endpoints (static files, the AI proxy, the TexVerse catalog, LAN WS signaling) so the packaged app needs no Python at end-user runtime. `npm install` once, then `npm run electron` (dev) or `npm run dist:win`/`dist:mac`/`dist:linux` (real installers via electron-builder). This is the **only** place npm is used — the web app itself still has no build step.

There is **no** npm build or linter config for the web app itself (the Electron packaging layer is separate — see above). Integrity checks:

```bash
python3 -m unittest tests.test_integrity
```

ROADMAP also refers to Playwright scripts that are not in this tree.

## Where the real code is

| Path | What |
| --- | --- |
| `web/js/app.js` | All application logic (scene, tools, CSG, sculpt, persist, AI client, P2P, Present mode) |
| `web/js/render_adapter.js` | Quality ladder (Draft / Balanced / Present) + still supersample math |
| `web/js/bim_kit.js` | Rooms / schedule CSV / plan DXF helpers (no Three.js) |
| `web/js/format_io.js` | OBJ / STL / ASCII DXF helpers |
| `web/js/zip_store.js` | Client ZIP pack |
| `web/index.html` | UI shell |
| `web/css/style.css` | Styles |
| `server.py` | HTTP + WebSocket signaling (browser mode) |
| `electron/main.js`, `electron/server.js` | Desktop (Electron) packaging — loads the same `web/` unchanged; `server.js` is server.py's endpoints ported to Node |
| `assets/` | Local GLBs / texture datasets |
| `scripts/` | Launchers |

CDN Three.js r128 is loaded from `index.html`. Do not add a second renderer implementation.

## What is not the product

`main.py` and everything under `src/` (Python snapper, DXF extruder, GPU collector, `engine.cpp`, etc.) are **print-based prototypes**. They are not imported by `server.py` and do not drive the browser. Do not extend them as if they were the editor. Prefer implementing features in `web/js/app.js` (or modules split from it) and real HTTP APIs only when the UI calls them.

Unused `server.py` POSTs (`/api/snap`, `/api/extrude`, `/api/ai-generate`, `/api/gpu-render`, `/api/boolean`, `/api/export`) return **501** `NOT_IMPLEMENTED`. `GET /api/status` reports `renderer: webgl-pbr` (not a GPU farm / Cycles). Do not wire new UI to stub POSTs until they do real work.

## Design rules (from ROADMAP)

- Not a fork of Blender / Cycles / Chili3D. References only.
- Core editing must work offline; cloud (AI) is optional and key stays in local `ai_config.json` (gitignored).
- Do not claim path tracing, VRAM telemetry, or a global GPU pool. WebGL + optional LAN P2P tile render is the honest stack.
- Prefer exact-value verification over “it didn’t crash.”
