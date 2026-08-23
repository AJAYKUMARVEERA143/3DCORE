# CLAUDE.md

Guidance for working in this repository.

## What this is

**3D Core Studio** is a browser-based CAD/3D editor (SketchUp-style drawing, Blender-style mesh/sculpt, small BIM set, WebGL rendering). The editor is **client-side**. A dependency-free Python server only hosts files, local asset catalogs, an AI API-key proxy, and LAN WebRTC signaling.

Authoritative feature history and known limitations: `docs/ROADMAP.md`.
Full architecture audit and recommended next features: `docs/AUDIT_AND_PLAN.md`.
Latest bug audit and fixes: `docs/BUG_AUDIT.md`.

## How to run

Requires Python 3 (standard library only — no `pip install` for the app).

```bash
./scripts/run.sh                 # macOS/Linux → http://127.0.0.1:8000
# Windows: scripts\run.ps1
```

Optional env: `PORT` (default 8000), `THREED_CORE_HOST` (default `0.0.0.0` for LAN P2P). Signaling WebSocket listens on `PORT + 1`.

There is **no** npm build or linter config. Integrity checks:

```bash
python3 -m unittest tests.test_integrity
```

ROADMAP also refers to Playwright scripts that are not in this tree.

## Where the real code is

| Path | What |
| --- | --- |
| `web/js/app.js` | All application logic (scene, tools, CSG, sculpt, persist, AI client, P2P) |
| `web/index.html` | UI shell |
| `web/css/style.css` | Styles |
| `server.py` | HTTP + WebSocket signaling |
| `assets/` | Local GLBs / texture datasets |
| `scripts/` | Launchers |

CDN Three.js r128 is loaded from `index.html`. Do not add a second renderer implementation.

## What is not the product

`main.py` and everything under `src/` (Python snapper, DXF extruder, GPU collector, `engine.cpp`, etc.) are **print-based prototypes**. They are not imported by `server.py` and do not drive the browser. Do not extend them as if they were the editor. Prefer implementing features in `web/js/app.js` (or modules split from it) and real HTTP APIs only when the UI calls them.

Unused `server.py` POSTs (`/api/snap`, `/api/extrude`, `/api/ai-generate`, `/api/gpu-render`, `/api/boolean`, `/api/export`) return canned success JSON. Do not wire new UI to them until they do real work; prefer deleting them or returning 501.

## Design rules (from ROADMAP)

- Not a fork of Blender / Cycles / Chili3D. References only.
- Core editing must work offline; cloud (AI) is optional and key stays in local `ai_config.json` (gitignored).
- Do not claim path tracing, VRAM telemetry, or a global GPU pool. WebGL + optional LAN P2P tile render is the honest stack.
- Prefer exact-value verification over “it didn’t crash.”
